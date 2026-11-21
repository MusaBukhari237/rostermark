// Rostermark — attendance, shifts and leave for multi-site teams. Cloud server + REST API.
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, createSessions, startServer, serveStatic, fail, hashPassword, verifyPassword, RawResponse, toCsv, rateLimiter, clientIp } from './lib/http.js';
import { addDays, hhmm, parseHHMM, zonedTs, dateRange, weekday } from './lib/time.js';
import { openDb, getSettings, setSettings, audit, currentState, allowedActions, haversine, workDate, assignDates, buildDays, summarize, leaveBalances } from './db.js';
import { seedDemo } from './seed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const BRAND_DIR = resolve(process.env.BRAND_DIR || join(ROOT, 'brand'));
const DEMO = ['1', 'true'].includes(process.env.DEMO);
const DEMO_RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 0);
const DB_FILE = join(DATA_DIR, 'rostermark.db');
mkdirSync(DATA_DIR, { recursive: true });

const brand = (() => { const f = join(BRAND_DIR, 'brand.json'); try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { return {}; } })();
const APP_NAME = process.env.APP_NAME || brand.appName || 'Rostermark';
const secret = process.env.SESSION_SECRET || (() => { const f = join(DATA_DIR, '.session-secret'); if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 }); return readFileSync(f, 'utf8').trim(); })();

let db;
function init() {
  db = openDb(DB_FILE);
  const empty = !db.prepare('SELECT 1 FROM employees LIMIT 1').get();
  if (empty && brand.companyName) setSettings(db, { company_name: brand.companyName });
  if (empty && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    db.prepare("INSERT INTO employees (code, name, email, role, password_hash, created_at) VALUES ('ADMIN', 'Administrator', ?, 'admin', ?, ?)").run(process.env.ADMIN_EMAIL, hashPassword(process.env.ADMIN_PASSWORD), Date.now());
  }
  if (empty && DEMO) { seedDemo(db, { companyName: brand.companyName }); console.log('Seeded demo data.'); }
}
init();
if (DEMO && DEMO_RESET_HOURS > 0) setInterval(() => { try { db.close(); for (const x of ['', '-wal', '-shm']) rmSync(DB_FILE + x, { force: true }); init(); } catch (e) { console.error(e); } }, DEMO_RESET_HOURS * 3600e3).unref();

const sessions = createSessions(secret, 'rm_sid');
const loginLimiter = rateLimiter(10, 10 * 60e3), pinLimiter = rateLimiter(15, 5 * 60e3);
const r = createRouter();
const S = () => getSettings(db);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const today = () => { const s = S(); return workDate(Date.now(), s.timezone, parseHHMM(s.day_cutoff)); };

/* ---------- guards ---------- */
const auth = (c) => {
  const sess = sessions.read(c.req); if (!sess) fail(401, 'Please sign in');
  const u = db.prepare('SELECT id, code, name, email, role, active FROM employees WHERE id = ?').get(sess.id);
  if (!u || !u.active) fail(401, 'Your account is inactive');
  c.user = u;
};
const staff = (c) => { auth(c); if (!['admin', 'manager'].includes(c.user.role)) fail(403, 'Managers only'); };
const admin = (c) => { auth(c); if (c.user.role !== 'admin') fail(403, 'Admins only'); };
const device = (c) => {
  const tok = c.req.headers['x-device-token'];
  const d = tok && db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0').get(sha(String(tok)));
  if (!d) fail(401, 'This kiosk is not paired');
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), d.id);
  c.device = d;
};
const apiKey = (scope) => (c) => {
  const m = /^Bearer\s+(rk_\w+)$/.exec(c.req.headers.authorization || '');
  const k = m && db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(sha(m[1]));
  if (!k) fail(401, 'Invalid API key');
  if (scope === 'write' && k.scopes !== 'write') fail(403, 'This key is read-only');
  db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(Date.now(), k.id);
};
const actor = (c) => c.user?.email || c.user?.code || 'api';

/* ---------- webhooks ---------- */
function emit(event, data) {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all().filter((h) => h.events.split(',').includes(event) || h.events === '*');
  for (const h of hooks) {
    const body = JSON.stringify({ event, at: new Date().toISOString(), data });
    const sig = 'sha256=' + createHmac('sha256', h.secret).update(body).digest('hex');
    fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rostermark-Event': event, 'X-Rostermark-Signature': sig }, body, signal: AbortSignal.timeout(8000) })
      .then((res) => db.prepare('UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?').run(String(res.status), Date.now(), h.id))
      .catch((e) => db.prepare('UPDATE webhooks SET last_status = ?, last_at = ? WHERE id = ?').run('error: ' + e.message.slice(0, 60), Date.now(), h.id));
  }
}

/* ---------- meta & auth ---------- */
r.get('/api/meta', () => {
  const s = S();
  return {
    appName: APP_NAME, companyName: s.company_name, tagline: brand.tagline || 'Attendance, shifts and leave for every site.',
    logo: s.logo || (brand.logo ? '/brand/' + brand.logo : '/logo.svg'), accent: s.accent || brand.accent || '', accentInk: brand.accentInk || '', theme: brand.theme || '',
    timezone: s.timezone, needsSetup: !db.prepare("SELECT 1 FROM employees WHERE role = 'admin' LIMIT 1").get(), requirePhoto: s.require_photo === '1',
    enforceGeofence: s.enforce_geofence === '1', allowWebClock: s.allow_web_clock === '1', today: today(),
    demo: DEMO ? { admin: { email: 'admin@demo.local', password: 'demo1234' }, manager: { email: 'manager@demo.local', password: 'demo1234' }, employee: { code: 'E204', pin: '1234' } } : null
  };
});
r.post('/api/setup', (c) => {
  if (db.prepare("SELECT 1 FROM employees WHERE role = 'admin'").get()) fail(409, 'Setup is already complete');
  const { name, email, password, company_name, timezone } = c.body;
  if (!email || String(password || '').length < 8) fail(400, 'Enter an email and a password of at least 8 characters');
  const id = db.prepare("INSERT INTO employees (code, name, email, role, password_hash, created_at, joined) VALUES ('ADMIN', ?, ?, 'admin', ?, ?, ?)").run(name || 'Administrator', email, hashPassword(password), Date.now(), today()).lastInsertRowid;
  setSettings(db, { company_name: company_name || 'My Company', timezone: timezone || 'UTC' });
  sessions.issue(c.res, { id: Number(id) });
  return { ok: true };
});
r.post('/api/auth/login', (c) => {
  if (!loginLimiter('l:' + clientIp(c.req))) fail(429, 'Too many attempts. Try again in a few minutes.');
  const u = db.prepare('SELECT * FROM employees WHERE email = ? AND active = 1').get(String(c.body.email || '').trim());
  if (!u || !verifyPassword(c.body.password, u.password_hash)) fail(401, 'Email or password is incorrect');
  sessions.issue(c.res, { id: u.id }); audit(db, u.email, 'auth.login');
  return { role: u.role };
});
r.post('/api/auth/pin', (c) => {
  if (!pinLimiter('p:' + clientIp(c.req))) fail(429, 'Too many attempts. Try again in a few minutes.');
  const u = db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(String(c.body.code || '').trim());
  if (!u || !verifyPassword(c.body.pin, u.pin_hash)) fail(401, 'Employee ID or PIN is incorrect');
  sessions.issue(c.res, { id: u.id });
  return { role: u.role };
});
r.post('/api/auth/logout', (c) => { sessions.clear(c.res); return { ok: true }; });
r.get('/api/auth/me', (c) => { const s = sessions.read(c.req); if (!s) return { user: null }; const u = db.prepare('SELECT id, code, name, email, role, photo, active FROM employees WHERE id = ?').get(s.id); return { user: u?.active ? u : null }; });

/* ---------- clocking ---------- */
function nearestLocation(lat, lng) {
  let best = null;
  for (const l of db.prepare('SELECT * FROM locations WHERE lat IS NOT NULL').all()) {
    const d = haversine({ lat, lng }, l);
    if (!best || d < best.distance) best = { ...l, distance: Math.round(d) };
  }
  return best;
}
function doPunch(empId, type, { source, lat, lng, accuracy, photo, device, locationId, note, by }) {
  const s = S();
  const e = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(empId);
  if (!e) fail(404, 'Employee not found');
  const { state } = currentState(db, empId);
  const allowed = allowedActions(state);
  type = type || allowed[0];
  if (!allowed.includes(type)) fail(409, `That isn't possible right now — current status: ${state === 'out' ? 'clocked out' : state === 'break' ? 'on break' : 'clocked in'}.`);
  if (photo && (!String(photo).startsWith('data:image/') || photo.length > 400_000)) fail(400, 'Photo is invalid or too large');
  if (s.require_photo === '1' && ['mobile', 'web', 'kiosk'].includes(source) && (type === 'in' || type === 'out') && !photo) fail(400, 'A photo is required to clock in or out.');
  let distance = null, inFence = null, loc = locationId ?? e.location_id;
  if (lat != null && lng != null) {
    const assigned = e.location_id && db.prepare('SELECT * FROM locations WHERE id = ?').get(e.location_id);
    const near = nearestLocation(lat, lng);
    const target = near && (!assigned || assigned.lat == null || near.distance <= near.radius_m) ? near : assigned && { ...assigned, distance: Math.round(haversine({ lat, lng }, assigned)) };
    if (target) { distance = target.distance; inFence = target.distance <= (target.radius_m || 150) + Math.min(Number(accuracy) || 0, 100) ? 1 : 0; loc = target.id;
      if (!inFence && s.enforce_geofence === '1' && ['mobile', 'web'].includes(source)) fail(403, `You're about ${distance >= 1000 ? (distance / 1000).toFixed(1) + ' km' : distance + ' m'} from ${target.name}. Move closer to clock ${type === 'out' ? 'out' : 'in'}.`); }
  } else if (s.enforce_geofence === '1' && ['mobile', 'web'].includes(source) && db.prepare('SELECT 1 FROM locations WHERE lat IS NOT NULL').get()) {
    fail(400, 'Location is required. Allow location access and try again.');
  }
  const ts = Date.now();
  const id = db.prepare('INSERT INTO punches (employee_id, type, ts, source, location_id, lat, lng, accuracy, distance_m, in_fence, photo, device, note, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(empId, type, ts, source, loc ?? null, lat ?? null, lng ?? null, accuracy ?? null, distance, inFence, photo ?? null, device ?? null, note ?? null, by ?? null, ts).lastInsertRowid;
  emit('punch.created', { id: Number(id), employee: { id: e.id, code: e.code, name: e.name }, type, ts: new Date(ts).toISOString(), source, location_id: loc, in_fence: inFence });
  const d = today();
  const [day] = buildDays(db, s, { from: d, to: d, employeeIds: [empId] });
  return { type, ts, employee: { id: e.id, name: e.name, photo: e.photo }, state: currentState(db, empId), today: day, distance, in_fence: inFence };
}
const clientSource = (c) => ({ desktop: 'desktop', mobile: 'mobile' }[c.req.headers['x-client']] || (/Mobile|Android|iPhone/i.test(c.req.headers['user-agent'] || '') ? 'mobile' : 'web'));
r.post('/api/clock', auth, (c) => {
  const src = clientSource(c);
  if (S().allow_web_clock !== '1' && src !== 'desktop') fail(403, 'Personal clock-in is turned off. Use a kiosk.');
  const { type, lat, lng, accuracy, photo } = c.body;
  return doPunch(c.user.id, type, { source: src, lat, lng, accuracy, photo });
});

/* ---------- kiosk devices ---------- */
r.post('/api/devices', admin, (c) => {
  const token = 'kd_' + randomBytes(18).toString('base64url');
  const id = db.prepare('INSERT INTO devices (name, location_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(c.body.name || 'Kiosk', c.body.location_id || null, sha(token), Date.now()).lastInsertRowid;
  audit(db, actor(c), 'device.create', { id: Number(id), name: c.body.name });
  return { id: Number(id), token };
});
r.get('/api/devices', admin, () => db.prepare('SELECT d.id, d.name, d.location_id, l.name location, d.last_seen, d.created_at, d.revoked FROM devices d LEFT JOIN locations l ON l.id = d.location_id ORDER BY d.id DESC').all());
r.delete('/api/devices/:id', admin, (c) => { db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(c.params.id); audit(db, actor(c), 'device.revoke', { id: +c.params.id }); return { ok: true }; });
r.get('/api/kiosk/info', device, (c) => ({ device: { name: c.device.name, location: c.device.location_id && db.prepare('SELECT name FROM locations WHERE id = ?').get(c.device.location_id)?.name } }));
r.get('/api/kiosk/roster', device, (c) => {
  const where = c.device.location_id ? 'AND (location_id = ? OR location_id IS NULL)' : '';
  const emps = db.prepare(`SELECT id, code, name, title, photo FROM employees WHERE active = 1 AND pin_hash IS NOT NULL ${where} ORDER BY name`).all(...(c.device.location_id ? [c.device.location_id] : []));
  return emps.map((e) => ({ ...e, ...currentState(db, e.id) }));
});
r.post('/api/kiosk/punch', device, (c) => {
  const { employee_id, code, pin, type, photo, check } = c.body;
  const e = employee_id ? db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(employee_id) : db.prepare('SELECT * FROM employees WHERE code = ? AND active = 1').get(String(code || '').trim());
  if (!pinLimiter('k:' + (e?.id ?? clientIp(c.req)))) fail(429, 'Too many wrong PINs. Ask a manager for help.');
  if (!e || !verifyPassword(pin, e.pin_hash)) fail(401, 'Wrong ID or PIN. Try again.');
  if (check) { const st = currentState(db, e.id); return { employee: { id: e.id, name: e.name, photo: e.photo, title: e.title }, state: st, actions: allowedActions(st.state) }; }
  return doPunch(e.id, type, { source: 'kiosk', photo, device: c.device.name, locationId: c.device.location_id });
});

/* ---------- self service ---------- */
r.get('/api/me', auth, (c) => {
  const s = S(); const t = today();
  const e = db.prepare(`SELECT e.*, d.name department, l.name location, l.lat loc_lat, l.lng loc_lng, l.radius_m, sh.name shift_name FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN shifts sh ON sh.id = e.shift_id WHERE e.id = ?`).get(c.user.id);
  const st = currentState(db, e.id);
  const days = buildDays(db, s, { from: addDays(t, -13), to: t, employeeIds: [e.id] }).reverse();
  const upcoming = scheduleFor(e.id, t, addDays(t, 6));
  return {
    employee: { id: e.id, code: e.code, name: e.name, email: e.email, title: e.title, role: e.role, photo: e.photo, department: e.department, location: e.location, shift: e.shift_name },
    site: e.loc_lat != null ? { lat: e.loc_lat, lng: e.loc_lng, radius_m: e.radius_m, name: e.location } : null,
    state: st, actions: allowedActions(st.state), days, upcoming, balances: leaveBalances(db, e.id, t.slice(0, 4)),
    leave: db.prepare('SELECT lr.*, lt.name type, lt.color FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.type_id WHERE employee_id = ? ORDER BY created_at DESC LIMIT 20').all(e.id),
    corrections: db.prepare('SELECT * FROM corrections WHERE employee_id = ? ORDER BY created_at DESC LIMIT 10').all(e.id),
    leaveTypes: db.prepare('SELECT id, name, color FROM leave_types ORDER BY id').all()
  };
});
function scheduleFor(empId, from, to) {
  const e = db.prepare('SELECT shift_id FROM employees WHERE id = ?').get(empId);
  const shifts = new Map(db.prepare('SELECT * FROM shifts').all().map((x) => [x.id, x]));
  const ros = new Map(db.prepare('SELECT date, shift_id FROM roster WHERE employee_id = ? AND date BETWEEN ? AND ?').all(empId, from, to).map((x) => [x.date, x.shift_id]));
  const hol = new Map(db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map((x) => [x.date, x.name]));
  return dateRange(from, to).map((d) => {
    const sid = ros.has(d) ? ros.get(d) : e.shift_id && String(shifts.get(e.shift_id)?.days || '').split(',').map(Number).includes(weekday(d)) ? e.shift_id : null;
    const sh = sid && shifts.get(sid);
    return { date: d, holiday: hol.get(d) || null, shift: sh ? { name: sh.name, start: sh.start, end: sh.end, color: sh.color } : null };
  });
}
r.post('/api/me/leave', auth, (c) => {
  const { type_id, date_from, date_to, half_day, reason } = c.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date_to || '') || date_to < date_from) fail(400, 'Choose a valid date range');
  if (!db.prepare('SELECT 1 FROM leave_types WHERE id = ?').get(type_id)) fail(400, 'Choose a leave type');
  const id = db.prepare('INSERT INTO leave_requests (employee_id, type_id, date_from, date_to, half_day, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(c.user.id, type_id, date_from, date_to, half_day ? 1 : 0, reason || null, Date.now()).lastInsertRowid;
  emit('leave.requested', { id: Number(id), employee_id: c.user.id, date_from, date_to });
  return { id: Number(id) };
});
r.delete('/api/me/leave/:id', auth, (c) => { db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND employee_id = ? AND status = 'pending'").run(c.params.id, c.user.id); return { ok: true }; });
r.post('/api/me/corrections', auth, (c) => {
  const { date, type, time, reason } = c.body;
  if (!['in', 'out', 'break_start', 'break_end'].includes(type) || !/^\d{2}:\d{2}$/.test(time || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(400, 'Fill in the date, type and time');
  if (date > today()) fail(400, "You can't correct a future date");
  db.prepare('INSERT INTO corrections (employee_id, date, type, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(c.user.id, date, type, time, reason || null, Date.now());
  emit('correction.requested', { employee_id: c.user.id, date, type, time });
  return { ok: true };
});
r.put('/api/me/pin', auth, (c) => {
  if (!/^\d{4,8}$/.test(String(c.body.pin || ''))) fail(400, 'PIN must be 4–8 digits');
  db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashPassword(c.body.pin), c.user.id); return { ok: true };
});
r.put('/api/me/password', auth, (c) => {
  if (DEMO) fail(403, 'Passwords cannot be changed in the demo');
  const u = db.prepare('SELECT password_hash FROM employees WHERE id = ?').get(c.user.id);
  if (u.password_hash && !verifyPassword(c.body.current, u.password_hash)) fail(401, 'Current password is incorrect');
  if (String(c.body.next || '').length < 8) fail(400, 'Use at least 8 characters');
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(hashPassword(c.body.next), c.user.id); return { ok: true };
});

/* ---------- dashboard ---------- */
r.get('/api/dashboard', staff, (c) => {
  const s = S(), t = today(), now = Date.now();
  const rows = buildDays(db, s, { from: t, to: t, locationId: c.query.location, now });
  const count = (f) => rows.filter(f).length;
  const expected = count((x) => x.expected);
  const from = addDays(t, -13);
  const hist = buildDays(db, s, { from, to: t, locationId: c.query.location, now });
  const trend = dateRange(from, t).map((d) => { const day = hist.filter((x) => x.date === d); const exp = day.filter((x) => x.expected).length; const pres = day.filter((x) => x.first_in).length; return { date: d, expected: exp, present: pres, late: day.filter((x) => x.late).length, rate: exp ? pres / exp : null }; });
  const locations = db.prepare('SELECT id, name, radius_m FROM locations ORDER BY id').all().map((l) => ({ ...l, onsite: rows.filter((x) => x.open && x.location_id === l.id).length, staff: rows.filter((x) => x.location_id === l.id).length }));
  const depts = db.prepare('SELECT id, name, color FROM departments ORDER BY name').all().map((d) => { const dr = rows.filter((x) => x.department_id === d.id); return { ...d, expected: dr.filter((x) => x.expected).length, present: dr.filter((x) => x.first_in).length }; });
  const activity = db.prepare(`SELECT p.id, p.type, p.ts, p.source, p.in_fence, p.distance_m, e.name, e.photo, l.name location FROM punches p JOIN employees e ON e.id = p.employee_id LEFT JOIN locations l ON l.id = p.location_id ORDER BY p.ts DESC, p.id DESC LIMIT 12`).all();
  const alerts = {
    pendingLeave: db.prepare("SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending'").get().n,
    pendingCorrections: db.prepare("SELECT COUNT(*) n FROM corrections WHERE status = 'pending'").get().n,
    missingOut: buildDays(db, s, { from: addDays(t, -7), to: addDays(t, -1) }).filter((x) => x.missing_out).length,
    outsideFence: hist.filter((x) => x.outside_fence && x.date >= addDays(t, -6)).length
  };
  return {
    today: t, expected, onsite: count((x) => x.open), onBreak: count((x) => x.status === 'on_break'), arrived: count((x) => x.first_in), late: count((x) => x.late),
    absent: count((x) => x.status === 'pending'), onLeave: count((x) => x.status === 'leave'), headcount: db.prepare('SELECT COUNT(*) n FROM employees WHERE active = 1').get().n,
    live: rows.filter((x) => x.first_in).sort((a, b) => (b.open - a.open) || (a.first_in - b.first_in)),
    waiting: rows.filter((x) => x.status === 'pending').map((x) => ({ employee_id: x.employee_id, name: x.name, photo: x.photo, department: x.department, shift: x.shift })),
    leaveToday: rows.filter((x) => x.status === 'leave').map((x) => ({ name: x.name, photo: x.photo, leave: x.leave })),
    trend, locations, depts, activity, alerts
  };
});

/* ---------- people ---------- */
const empCols = 'e.id, e.code, e.name, e.email, e.phone, e.title, e.role, e.department_id, e.location_id, e.shift_id, e.manager_id, e.photo, e.active, e.joined, d.name department, d.color dept_color, l.name location, sh.name shift, m.name manager';
const empJoin = 'FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN shifts sh ON sh.id = e.shift_id LEFT JOIN employees m ON m.id = e.manager_id';
r.get('/api/employees', staff, () => db.prepare(`SELECT ${empCols}, e.pin_hash IS NOT NULL has_pin, e.password_hash IS NOT NULL has_password ${empJoin} ORDER BY e.active DESC, e.name`).all().map((e) => ({ ...e, ...currentState(db, e.id) })));
function saveEmployee(c, id) {
  const b = c.body;
  if (!String(b.name || '').trim() || !String(b.code || '').trim()) fail(400, 'Name and employee ID are required');
  if (b.role === 'admin' && c.user.role !== 'admin') fail(403, 'Only admins can create admins');
  if (b.pin && !/^\d{4,8}$/.test(String(b.pin))) fail(400, 'PIN must be 4–8 digits');
  if (b.password && String(b.password).length < 8) fail(400, 'Password must be at least 8 characters');
  if (b.photo && (!String(b.photo).startsWith('data:image/') || b.photo.length > 400_000)) fail(400, 'Photo is invalid or too large');
  const vals = [b.code.trim(), b.name.trim(), b.email || null, b.phone || null, b.title || null, ['admin', 'manager', 'employee'].includes(b.role) ? b.role : 'employee',
    b.department_id || null, b.location_id || null, b.shift_id || null, b.manager_id || null, b.photo || null, b.active === false ? 0 : 1, b.joined || null];
  try {
    if (id) {
      const cur = db.prepare('SELECT role FROM employees WHERE id = ?').get(id); if (!cur) fail(404, 'Not found');
      if (cur.role === 'admin' && c.user.role !== 'admin') fail(403, 'Only admins can edit admins');
      db.prepare('UPDATE employees SET code=?, name=?, email=?, phone=?, title=?, role=?, department_id=?, location_id=?, shift_id=?, manager_id=?, photo=?, active=?, joined=? WHERE id = ?').run(...vals, id);
    } else id = Number(db.prepare('INSERT INTO employees (code, name, email, phone, title, role, department_id, location_id, shift_id, manager_id, photo, active, joined, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, Date.now()).lastInsertRowid);
  } catch (e) { if (/UNIQUE/.test(e.message)) fail(409, /email/.test(e.message) ? 'That email is already used' : 'That employee ID is already used'); throw e; }
  if (b.pin) db.prepare('UPDATE employees SET pin_hash = ? WHERE id = ?').run(hashPassword(b.pin), id);
  if (b.password) db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
  audit(db, actor(c), c.params.id ? 'employee.update' : 'employee.create', { id, code: b.code });
  return { id };
}
r.post('/api/employees', staff, (c) => saveEmployee(c));
r.put('/api/employees/:id', staff, (c) => saveEmployee(c, Number(c.params.id)));
r.delete('/api/employees/:id', admin, (c) => { if (+c.params.id === c.user.id) fail(400, "You can't delete yourself"); db.prepare('DELETE FROM employees WHERE id = ?').run(c.params.id); audit(db, actor(c), 'employee.delete', { id: +c.params.id }); return { ok: true }; });
r.post('/api/employees/import', staff, (c) => {
  const rows = Array.isArray(c.body.rows) ? c.body.rows.slice(0, 5000) : [];
  const deptId = (n) => n && (db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE').get(n)?.id ?? Number(db.prepare('INSERT INTO departments (name) VALUES (?)').run(n).lastInsertRowid));
  const locId = (n) => n && db.prepare('SELECT id FROM locations WHERE name = ? COLLATE NOCASE').get(n)?.id;
  const shId = (n) => n && db.prepare('SELECT id FROM shifts WHERE name = ? COLLATE NOCASE').get(n)?.id;
  const ins = db.prepare("INSERT OR IGNORE INTO employees (code, name, email, phone, title, role, department_id, location_id, shift_id, pin_hash, joined, created_at) VALUES (?, ?, ?, ?, ?, 'employee', ?, ?, ?, ?, ?, ?)");
  let added = 0;
  db.exec('BEGIN');
  try { for (const x of rows) { if (!x.code || !x.name) continue; const pin = /^\d{4,8}$/.test(String(x.pin || '')) ? String(x.pin) : String(1000 + Math.floor(Math.random() * 9000));
    added += Number(ins.run(String(x.code).trim(), String(x.name).trim(), x.email || null, x.phone || null, x.title || null, deptId(x.department) || null, locId(x.location) || null, shId(x.shift) || null, hashPassword(pin), today(), Date.now()).changes); } db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(db, actor(c), 'employee.import', { added });
  return { added, skipped: rows.length - added };
});

/* ---------- organisation (generic CRUD) ---------- */
const ORG = {
  departments: { cols: ['name', 'color'], read: 'staff' }, locations: { cols: ['name', 'address', 'lat', 'lng', 'radius_m'], read: 'auth' },
  shifts: { cols: ['name', 'start', 'end', 'break_min', 'grace_min', 'days', 'color'], read: 'auth' }, leave_types: { cols: ['name', 'color', 'paid', 'quota_days'], read: 'auth' }
};
for (const [table, def] of Object.entries(ORG)) {
  const path = '/api/' + table.replace('_', '-');
  r.get(path, def.read === 'auth' ? auth : staff, () => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  r.post(path, admin, (c) => { if (!String(c.body.name || '').trim()) fail(400, 'Name is required'); const id = db.prepare(`INSERT INTO ${table} (${def.cols.join(',')}) VALUES (${def.cols.map(() => '?').join(',')})`).run(...def.cols.map((k) => c.body[k] === '' ? null : c.body[k] ?? null)).lastInsertRowid; audit(db, actor(c), table + '.create', { id: Number(id) }); return { id: Number(id) }; });
  r.put(path + '/:id', admin, (c) => { db.prepare(`UPDATE ${table} SET ${def.cols.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...def.cols.map((k) => c.body[k] === '' ? null : c.body[k] ?? null), c.params.id); audit(db, actor(c), table + '.update', { id: +c.params.id }); return { ok: true }; });
  r.delete(path + '/:id', admin, (c) => { db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(c.params.id); audit(db, actor(c), table + '.delete', { id: +c.params.id }); return { ok: true }; });
}
r.get('/api/holidays', auth, () => db.prepare('SELECT * FROM holidays ORDER BY date').all());
r.post('/api/holidays', admin, (c) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(c.body.date || '') || !c.body.name) fail(400, 'Date and name are required'); db.prepare('INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)').run(c.body.date, c.body.name); return { ok: true }; });
r.delete('/api/holidays/:date', admin, (c) => { db.prepare('DELETE FROM holidays WHERE date = ?').run(c.params.date); return { ok: true }; });

/* ---------- roster ---------- */
r.get('/api/roster', staff, (c) => {
  const from = c.query.from || today(); const to = addDays(from, 6);
  const where = c.query.department ? 'AND e.department_id = ' + Number(c.query.department) : '';
  const emps = db.prepare(`SELECT e.id, e.name, e.code, e.photo, e.title, e.shift_id, d.name department FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.active = 1 ${where} ORDER BY d.name, e.name`).all();
  const leave = db.prepare("SELECT employee_id, date_from, date_to, lt.name type, lt.color FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.type_id WHERE status = 'approved' AND date_to >= ? AND date_from <= ?").all(from, to);
  return { from, to, days: dateRange(from, to), employees: emps.map((e) => ({ ...e, cells: scheduleFor(e.id, from, to).map((x) => ({ ...x, override: !!db.prepare('SELECT 1 FROM roster WHERE employee_id = ? AND date = ?').get(e.id, x.date), leave: leave.find((l) => l.employee_id === e.id && l.date_from <= x.date && l.date_to >= x.date) || null })) })) };
});
r.put('/api/roster', staff, (c) => {
  const { employee_id, date, shift_id, dates } = c.body;
  const ids = Array.isArray(employee_id) ? employee_id : [employee_id];
  for (const eid of ids) for (const d of dates || [date]) {
    if (shift_id === 'default') db.prepare('DELETE FROM roster WHERE employee_id = ? AND date = ?').run(eid, d);
    else db.prepare('INSERT INTO roster (employee_id, date, shift_id) VALUES (?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET shift_id = excluded.shift_id').run(eid, d, shift_id || null);
  }
  audit(db, actor(c), 'roster.update', { employees: ids.length, shift_id });
  return { ok: true };
});
r.post('/api/roster/copy-week', staff, (c) => {
  const { from, to } = c.body; let n = 0;
  for (let i = 0; i < 7; i++) {
    for (const row of db.prepare('SELECT employee_id, shift_id FROM roster WHERE date = ?').all(addDays(from, i))) {
      db.prepare('INSERT INTO roster (employee_id, date, shift_id) VALUES (?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET shift_id = excluded.shift_id').run(row.employee_id, addDays(to, i), row.shift_id); n++;
    }
  }
  return { copied: n };
});

/* ---------- timesheets & punches ---------- */
r.get('/api/timesheets', staff, (c) => {
  const t = today(); const from = c.query.from || addDays(t, -6), to = c.query.to || t;
  const rows = buildDays(db, S(), { from, to, employeeIds: c.query.employee ? [Number(c.query.employee)] : undefined, departmentId: c.query.department, locationId: c.query.location });
  return { from, to, rows: rows.filter((x) => c.query.all === '1' || x.status !== 'off') };
});
r.get('/api/punches', staff, (c) => {
  const s = S(); const { employee, date } = c.query; if (!employee || !date) fail(400, 'employee and date are required');
  const list = db.prepare('SELECT p.*, l.name location FROM punches p LEFT JOIN locations l ON l.id = p.location_id WHERE employee_id = ? AND ts BETWEEN ? AND ? ORDER BY ts, p.id')
    .all(employee, Date.parse(date + 'T00:00:00Z') - 2 * 864e5, Date.parse(date + 'T23:59:59Z') + 2 * 864e5);
  return assignDates(list, s.timezone, parseHHMM(s.day_cutoff)).filter((p) => p.work_date === date);
});
const TYPES = ['in', 'out', 'break_start', 'break_end'];
r.post('/api/punches', staff, (c) => {
  const { employee_id, type, date, time, note } = c.body; if (!TYPES.includes(type)) fail(400, 'Invalid punch type');
  const s = S(); let ts = zonedTs(date, parseHHMM(time), s.timezone); if (parseHHMM(time) < parseHHMM(s.day_cutoff)) ts += 864e5;
  db.prepare('INSERT INTO punches (employee_id, type, ts, source, note, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(employee_id, type, ts, 'manual', note || null, actor(c), Date.now());
  audit(db, actor(c), 'punch.add', { employee_id, type, date, time, note }); return { ok: true };
});
r.put('/api/punches/:id', staff, (c) => {
  const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(c.params.id); if (!p) fail(404, 'Not found');
  const { type, date, time } = c.body; if (type && !TYPES.includes(type)) fail(400, 'Invalid punch type');
  const s = S(); let ts = p.ts; if (date && time) { ts = zonedTs(date, parseHHMM(time), s.timezone); if (parseHHMM(time) < parseHHMM(s.day_cutoff)) ts += 864e5; }
  db.prepare('UPDATE punches SET type = ?, ts = ?, edited_by = ? WHERE id = ?').run(type || p.type, ts, actor(c), p.id);
  audit(db, actor(c), 'punch.edit', { id: p.id, before: { type: p.type, ts: p.ts }, after: { type: type || p.type, ts } }); return { ok: true };
});
r.delete('/api/punches/:id', staff, (c) => { const p = db.prepare('SELECT * FROM punches WHERE id = ?').get(c.params.id); if (!p) fail(404, 'Not found'); db.prepare('DELETE FROM punches WHERE id = ?').run(p.id); audit(db, actor(c), 'punch.delete', { id: p.id, type: p.type, ts: p.ts, employee_id: p.employee_id }); return { ok: true }; });

/* ---------- leave & corrections ---------- */
r.get('/api/leave', staff, (c) => {
  const st = c.query.status;
  return db.prepare(`SELECT lr.*, e.name, e.photo, e.code, d.name department, lt.name type, lt.color FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN leave_types lt ON lt.id = lr.type_id ${st ? 'WHERE lr.status = ?' : ''} ORDER BY CASE lr.status WHEN 'pending' THEN 0 ELSE 1 END, lr.date_from DESC LIMIT 300`).all(...(st ? [st] : []))
    .map((x) => ({ ...x, days: x.half_day ? 0.5 : dateRange(x.date_from, x.date_to).length, balance: leaveBalances(db, x.employee_id, x.date_from.slice(0, 4)).find((b) => b.type_id === x.type_id) }));
});
r.post('/api/leave', staff, (c) => {
  const { employee_id, type_id, date_from, date_to, half_day, reason } = c.body;
  if (!employee_id || !date_from || !date_to || date_to < date_from) fail(400, 'Choose an employee and a valid date range');
  db.prepare("INSERT INTO leave_requests (employee_id, type_id, date_from, date_to, half_day, reason, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)").run(employee_id, type_id, date_from, date_to, half_day ? 1 : 0, reason || null, actor(c), Date.now(), Date.now());
  audit(db, actor(c), 'leave.create', { employee_id, date_from, date_to }); return { ok: true };
});
r.post('/api/leave/:id/decide', staff, (c) => {
  const { status, note } = c.body; if (!['approved', 'rejected'].includes(status)) fail(400, 'Invalid decision');
  db.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(status, actor(c), Date.now(), note || null, c.params.id);
  audit(db, actor(c), 'leave.' + status, { id: +c.params.id }); emit('leave.decided', { id: +c.params.id, status }); return { ok: true };
});
r.get('/api/corrections', staff, () => db.prepare(`SELECT co.*, e.name, e.photo, e.code FROM corrections co JOIN employees e ON e.id = co.employee_id ORDER BY CASE co.status WHEN 'pending' THEN 0 ELSE 1 END, co.created_at DESC LIMIT 200`).all());
r.post('/api/corrections/:id/decide', staff, (c) => {
  const co = db.prepare('SELECT * FROM corrections WHERE id = ?').get(c.params.id); if (!co) fail(404, 'Not found');
  const { status } = c.body; if (!['approved', 'rejected'].includes(status)) fail(400, 'Invalid decision');
  if (status === 'approved') {
    const s = S(); let ts = zonedTs(co.date, parseHHMM(co.time), s.timezone); if (parseHHMM(co.time) < parseHHMM(s.day_cutoff)) ts += 864e5;
    db.prepare('INSERT INTO punches (employee_id, type, ts, source, note, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(co.employee_id, co.type, ts, 'correction', co.reason, actor(c), Date.now());
  }
  db.prepare('UPDATE corrections SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, actor(c), Date.now(), co.id);
  audit(db, actor(c), 'correction.' + status, { id: co.id }); return { ok: true };
});

/* ---------- reports ---------- */
const fmtT = (ts, tz) => ts ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts) : '';
const range = (c) => { const t = today(); return [c.query.from || t.slice(0, 8) + '01', c.query.to || t]; };
r.get('/api/reports/summary', staff, (c) => {
  const s = S(); const [from, to] = range(c);
  const rows = buildDays(db, s, { from, to, departmentId: c.query.department, locationId: c.query.location });
  const sum = summarize(rows);
  if (c.query.format === 'csv') return new RawResponse(toCsv(sum, [
    { label: 'Employee ID', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'department' }, { label: 'Location', key: 'location' },
    { label: 'Scheduled days', key: 'expected' }, { label: 'Days present', key: 'present' }, { label: 'Absent', key: 'absent' }, { label: 'Leave days', key: 'leave' },
    { label: 'Late arrivals', key: 'late' }, { label: 'Late minutes', key: 'late_min' }, { label: 'Early-leave minutes', key: 'early_min' }, { label: 'Missing clock-outs', key: 'missing_out' },
    { label: 'Outside-geofence days', key: 'outside_fence' }, { label: 'Scheduled hours', value: (x) => (x.scheduled_min / 60).toFixed(2) }, { label: 'Worked hours', value: (x) => (x.worked_min / 60).toFixed(2) },
    { label: 'Overtime hours', value: (x) => (x.overtime_min / 60).toFixed(2) }, { label: 'Average clock-in', value: (x) => hhmm(x.avg_in_min) },
    { label: 'Attendance %', value: (x) => x.attendance_rate == null ? '' : Math.round(x.attendance_rate * 100) }, { label: 'Punctuality %', value: (x) => x.punctuality == null ? '' : Math.round(x.punctuality * 100) }
  ]), 'text/csv; charset=utf-8', `attendance-summary_${from}_${to}.csv`);
  const daily = dateRange(from, to).map((d) => { const day = rows.filter((x) => x.date === d); return { date: d, expected: day.filter((x) => x.expected).length, present: day.filter((x) => x.first_in).length, late: day.filter((x) => x.late).length, absent: day.filter((x) => x.status === 'absent').length, leave: day.filter((x) => x.status === 'leave').length, ot: day.reduce((a, b) => a + b.overtime_min, 0) }; });
  const depts = db.prepare('SELECT id, name, color FROM departments ORDER BY name').all();
  const heat = depts.map((d) => ({ ...d, days: [0, 1, 2, 3, 4, 5, 6].map((wd) => { const dr = rows.filter((x) => x.department_id === d.id && weekday(x.date) === wd && x.expected); return dr.length ? dr.filter((x) => x.first_in).length / dr.length : null; }) }));
  const statusMix = ['present', 'late', 'absent', 'leave', 'missing_out', 'holiday'].map((k) => ({ status: k, n: rows.filter((x) => (k === 'present' ? x.status === 'present' : x.status === k)).length }));
  return { from, to, summary: sum, daily, heat, statusMix };
});
r.get('/api/reports/timesheet.csv', staff, (c) => {
  const s = S(); const [from, to] = range(c);
  const rows = buildDays(db, s, { from, to, employeeIds: c.query.employee ? [Number(c.query.employee)] : undefined, departmentId: c.query.department, locationId: c.query.location }).filter((x) => x.status !== 'off' || x.punches);
  return new RawResponse(toCsv(rows, [
    { label: 'Date', key: 'date' }, { label: 'Employee ID', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'department' }, { label: 'Location', key: 'location' },
    { label: 'Shift', value: (x) => x.shift ? `${x.shift.name} ${x.shift.start}-${x.shift.end}` : '' }, { label: 'Status', key: 'status' }, { label: 'Leave', value: (x) => x.leave?.type || '' },
    { label: 'First in', value: (x) => fmtT(x.first_in, s.timezone) }, { label: 'Last out', value: (x) => fmtT(x.last_out, s.timezone) }, { label: 'Break minutes', key: 'break_min' },
    { label: 'Worked hours', value: (x) => (x.worked_min / 60).toFixed(2) }, { label: 'Late minutes', key: 'late_min' }, { label: 'Early-leave minutes', key: 'early_min' },
    { label: 'Overtime hours', value: (x) => (x.overtime_min / 60).toFixed(2) }, { label: 'Outside geofence', value: (x) => x.outside_fence ? 'yes' : '' }
  ]), 'text/csv; charset=utf-8', `timesheet_${from}_${to}.csv`);
});
r.get('/api/reports/payroll.csv', staff, (c) => {
  const s = S(); const [from, to] = range(c);
  const sum = summarize(buildDays(db, s, { from, to }));
  return new RawResponse(toCsv(sum, [
    { label: 'Employee ID', key: 'code' }, { label: 'Name', key: 'name' }, { label: 'Department', key: 'department' }, { label: 'Days worked', key: 'present' },
    { label: 'Paid leave days', key: 'leave' }, { label: 'Unpaid absences', key: 'absent' }, { label: 'Regular hours', value: (x) => ((x.worked_min - x.overtime_min) / 60).toFixed(2) },
    { label: 'Overtime hours', value: (x) => (x.overtime_min / 60).toFixed(2) }, { label: 'Late minutes', key: 'late_min' }
  ]), 'text/csv; charset=utf-8', `payroll-export_${from}_${to}.csv`);
});

/* ---------- settings, integrations, audit ---------- */
r.get('/api/settings', admin, () => S());
r.put('/api/settings', admin, (c) => {
  const b = c.body;
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { fail(400, 'Unknown timezone'); } }
  if (b.logo && (!String(b.logo).startsWith('data:image/') || b.logo.length > 300_000)) fail(400, 'Logo must be an image under 200 KB');
  if (b.accent && !/^#[0-9a-f]{6}$/i.test(b.accent)) fail(400, 'Accent must be a hex colour');
  setSettings(db, b); audit(db, actor(c), 'settings.update', Object.keys(b)); return S();
});
r.get('/api/api-keys', admin, () => db.prepare('SELECT id, name, prefix, scopes, last_used, created_at, revoked FROM api_keys ORDER BY id DESC').all());
r.post('/api/api-keys', admin, (c) => {
  const key = 'rk_' + randomBytes(24).toString('base64url').replace(/[-]/g, 'x');
  db.prepare('INSERT INTO api_keys (name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)').run(c.body.name || 'API key', key.slice(0, 9), sha(key), c.body.scopes === 'write' ? 'write' : 'read', Date.now());
  audit(db, actor(c), 'apikey.create', { name: c.body.name }); return { key };
});
r.delete('/api/api-keys/:id', admin, (c) => { db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(c.params.id); return { ok: true }; });
r.get('/api/webhooks', admin, () => db.prepare('SELECT id, url, events, active, last_status, last_at, created_at FROM webhooks ORDER BY id DESC').all());
r.post('/api/webhooks', admin, (c) => {
  if (!/^https?:\/\//.test(c.body.url || '')) fail(400, 'Enter an http(s) URL');
  const secretKey = 'whsec_' + randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO webhooks (url, events, secret, created_at) VALUES (?, ?, ?, ?)').run(c.body.url, c.body.events || '*', secretKey, Date.now());
  audit(db, actor(c), 'webhook.create', { url: c.body.url }); return { secret: secretKey };
});
r.delete('/api/webhooks/:id', admin, (c) => { db.prepare('DELETE FROM webhooks WHERE id = ?').run(c.params.id); return { ok: true }; });
r.get('/api/audit', admin, () => db.prepare('SELECT * FROM audit ORDER BY ts DESC LIMIT 300').all());

/* ---------- public REST API (API keys) ---------- */
r.get('/api/v1/employees', apiKey('read'), () => db.prepare(`SELECT e.id, e.code, e.name, e.email, e.title, e.role, e.active, d.name department, l.name location, sh.name shift ${empJoin.replace('LEFT JOIN employees m ON m.id = e.manager_id', '')} ORDER BY e.id`).all());
r.get('/api/v1/attendance', apiKey('read'), (c) => { const [from, to] = range(c); return { from, to, days: buildDays(db, S(), { from, to }).map(({ photo, ...x }) => x) }; });
r.get('/api/v1/punches', apiKey('read'), (c) => db.prepare('SELECT p.id, p.employee_id, e.code, p.type, p.ts, p.source, p.location_id, p.in_fence FROM punches p JOIN employees e ON e.id = p.employee_id WHERE p.ts > ? ORDER BY p.ts LIMIT 1000').all(Number(c.query.since) || 0));
r.post('/api/v1/punches', apiKey('write'), (c) => {
  const e = db.prepare('SELECT id FROM employees WHERE code = ? AND active = 1').get(String(c.body.code || ''));
  if (!e) fail(404, 'Employee not found');
  return doPunch(e.id, c.body.type, { source: 'api', device: c.body.device, lat: c.body.lat, lng: c.body.lng });
});
r.get('/api/health', () => ({ ok: true, app: APP_NAME }));

/* ---------- server ---------- */
const PUBLIC = join(ROOT, 'public');
startServer({
  port: PORT, name: APP_NAME,
  async handler(req, res) {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) { res.setHeader('Access-Control-Allow-Origin', url.startsWith('/api/v1/') ? '*' : 'null'); return r.handle(req, res, {}); }
    if (url.startsWith('/brand/')) { req.url = req.url.slice(6); return serveStatic(req, res, [BRAND_DIR]); }
    if (url === '/kiosk' || url === '/kiosk/') req.url = '/kiosk.html';
    return serveStatic(req, res, [PUBLIC], join(PUBLIC, 'index.html'));
  }
});
