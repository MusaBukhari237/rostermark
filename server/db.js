import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDate, localMinutes, parseHHMM, weekday, dateRange, addDays } from './lib/time.js';

export const DEFAULT_SETTINGS = {
  company_name: 'Northwind Group', timezone: 'Asia/Dubai', day_cutoff: '04:00', overtime_after_min: '0',
  require_photo: '0', enforce_geofence: '1', allow_web_clock: '1', accent: '', logo: '', week_start: '1'
};

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#6366f1');
    CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 150);
    CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
      break_min INTEGER DEFAULT 60, grace_min INTEGER DEFAULT 10, days TEXT DEFAULT '1,2,3,4,5,6', color TEXT DEFAULT '#0ea5e9');
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, email TEXT UNIQUE COLLATE NOCASE, phone TEXT, title TEXT,
      role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','manager','employee')),
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL, location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL, manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      password_hash TEXT, pin_hash TEXT, photo TEXT, active INTEGER NOT NULL DEFAULT 1, joined TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS roster (employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE, PRIMARY KEY (employee_id, date));
    CREATE TABLE IF NOT EXISTS punches (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('in','out','break_start','break_end')), ts INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'web', location_id INTEGER, lat REAL, lng REAL, accuracy REAL, distance_m REAL, in_fence INTEGER,
      photo TEXT, device TEXT, note TEXT, edited_by TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS punches_emp_ts ON punches(employee_id, ts);
    CREATE INDEX IF NOT EXISTS punches_ts ON punches(ts);
    CREATE TABLE IF NOT EXISTS leave_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT DEFAULT '#8b5cf6', paid INTEGER DEFAULT 1, quota_days REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, type_id INTEGER REFERENCES leave_types(id) ON DELETE SET NULL,
      date_from TEXT NOT NULL, date_to TEXT NOT NULL, half_day INTEGER DEFAULT 0, reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      decided_by TEXT, decided_at INTEGER, decision_note TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL,
      type TEXT NOT NULL, time TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
      token_hash TEXT NOT NULL, last_seen INTEGER, created_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL, scopes TEXT DEFAULT 'read', last_used INTEGER, created_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER DEFAULT 1, last_status TEXT, last_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT);
  `);
  return db;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
export function setSettings(db, patch) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) st.run(k, String(v ?? ''));
}
export function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor || 'system', action, detail ? JSON.stringify(detail) : null);
}

export function currentState(db, employeeId) {
  const last = db.prepare('SELECT type, ts, location_id FROM punches WHERE employee_id = ? ORDER BY ts DESC, id DESC LIMIT 1').get(employeeId);
  if (!last || last.type === 'out') return { state: 'out', since: last?.ts ?? null };
  return { state: last.type === 'break_start' ? 'break' : 'in', since: last.ts, location_id: last.location_id };
}
export const allowedActions = (state) => state === 'out' ? ['in'] : state === 'break' ? ['break_end'] : ['out', 'break_start'];

export function haversine(a, b) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Work date of a punch: punches before the day cut-off (e.g. 04:00) belong to the previous day — supports night shifts. */
export function workDate(ts, tz, cutoffMin) {
  const d = localDate(ts, tz);
  return localMinutes(ts, tz) < cutoffMin ? addDays(d, -1) : d;
}

/** Assigns a work date to each punch. Out/break punches join the open clock-in they close (up to 20 h), so night shifts stay on one day. */
export function assignDates(punches, tz, cutoffMin) {
  const open = new Map();
  for (const p of punches) {
    const o = open.get(p.employee_id);
    if (p.type !== 'in' && o && p.ts - o.ts < 20 * 3600e3) p.work_date = o.date;
    else p.work_date = workDate(p.ts, tz, cutoffMin);
    if (p.type === 'in' && !(o && p.ts - o.ts < 20 * 3600e3)) open.set(p.employee_id, { ts: p.ts, date: p.work_date });
    if (p.type === 'out') open.delete(p.employee_id);
  }
  return punches;
}

/**
 * Builds one row per employee per day with shift, leave, holiday and punch data.
 * status: working | on_break | present | late | absent | leave | holiday | off | pending | missing_out
 */
export function buildDays(db, s, { from, to, employeeIds, departmentId, locationId, now = Date.now() }) {
  const tz = s.timezone, cutoff = parseHHMM(s.day_cutoff);
  const today = workDate(now, tz, cutoff);
  const where = ['1=1']; const args = [];
  if (employeeIds) where.push(`e.id IN (${employeeIds.map(Number).join(',') || 0})`);
  if (departmentId) { where.push('e.department_id = ?'); args.push(Number(departmentId)); }
  if (locationId) { where.push('e.location_id = ?'); args.push(Number(locationId)); }
  const emps = db.prepare(`SELECT e.id, e.code, e.name, e.photo, e.active, e.joined, e.shift_id, e.department_id, e.location_id, d.name department, d.color dept_color, l.name location
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN locations l ON l.id = e.location_id WHERE ${where.join(' AND ')} ORDER BY e.name`).all(...args);
  if (!emps.length) return [];
  const ids = emps.map((e) => e.id).join(',');
  const shifts = new Map(db.prepare('SELECT * FROM shifts').all().map((x) => [x.id, { ...x, startMin: parseHHMM(x.start), endMin: parseHHMM(x.end), daySet: new Set(String(x.days).split(',').filter(Boolean).map(Number)) }]));
  const roster = new Map(db.prepare(`SELECT employee_id, date, shift_id FROM roster WHERE date BETWEEN ? AND ? AND employee_id IN (${ids})`).all(from, to).map((r) => [r.employee_id + '|' + r.date, r.shift_id]));
  const holidays = new Map(db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map((h) => [h.date, h.name]));
  const leaves = db.prepare(`SELECT lr.employee_id, lr.date_from, lr.date_to, lr.half_day, lt.name type, lt.color, lt.paid FROM leave_requests lr LEFT JOIN leave_types lt ON lt.id = lr.type_id
    WHERE lr.status = 'approved' AND lr.date_to >= ? AND lr.date_from <= ? AND lr.employee_id IN (${ids})`).all(from, to);
  const punches = db.prepare(`SELECT id, employee_id, type, ts, source, in_fence, location_id FROM punches WHERE ts BETWEEN ? AND ? AND employee_id IN (${ids}) ORDER BY ts, id`)
    .all(Date.parse(from + 'T00:00:00Z') - 864e5, Date.parse(to + 'T23:59:59Z') + 2 * 864e5);
  const byKey = new Map();
  assignDates(punches, tz, cutoff);
  for (const p of punches) { const d = p.work_date; if (d < from || d > to) continue; const k = p.employee_id + '|' + d; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }

  const rows = [];
  for (const e of emps) {
    for (const date of dateRange(from, to)) {
      if (date > today) continue;
      const k = e.id + '|' + date;
      const list = byKey.get(k) || [];
      if (!list.length && (!e.active || (e.joined && date < e.joined))) continue;
      let shiftId = roster.has(k) ? roster.get(k) : (e.shift_id && shifts.get(e.shift_id)?.daySet.has(weekday(date)) ? e.shift_id : null);
      const shift = shiftId ? shifts.get(shiftId) : null;
      const holiday = holidays.get(date) || null;
      const leave = leaves.find((l) => l.employee_id === e.id && l.date_from <= date && l.date_to >= date) || null;
      rows.push({ employee_id: e.id, code: e.code, name: e.name, photo: e.photo, department: e.department, dept_color: e.dept_color, department_id: e.department_id, location: e.location, location_id: e.location_id, date,
        ...summarizeDay(list, { shift, holiday, leave, tz, isToday: date === today, now, otAfter: Number(s.overtime_after_min) || 0 }) });
    }
  }
  return rows;
}

export function summarizeDay(list, { shift, holiday, leave, tz, isToday, now, otAfter }) {
  let worked = 0, breaks = 0, openIn = null, openBreak = null, firstIn = null, lastOut = null;
  for (const p of list) {
    if (p.type === 'in') { if (openIn == null) openIn = p.ts; if (firstIn == null) firstIn = p.ts; }
    else if (p.type === 'out') { if (openIn != null) { worked += p.ts - openIn; openIn = null; } if (openBreak != null) { breaks += p.ts - openBreak; openBreak = null; } lastOut = p.ts; }
    else if (p.type === 'break_start') { if (openBreak == null) openBreak = p.ts; }
    else if (p.type === 'break_end') { if (openBreak != null) { breaks += p.ts - openBreak; openBreak = null; } }
  }
  let open = false, missingOut = false;
  if (openIn != null) { if (isToday) { open = true; worked += now - openIn; if (openBreak != null) breaks += now - openBreak; } else missingOut = true; }
  const workedMin = Math.max(0, Math.round((worked - breaks) / 60000));
  const breakMin = Math.round(breaks / 60000);
  const inMin = firstIn != null ? localMinutes(firstIn, tz) : null;
  const outMin = lastOut != null && !open ? localMinutes(lastOut, tz) : null;
  let scheduledMin = 0, lateMin = 0, earlyMin = 0;
  if (shift) {
    scheduledMin = ((shift.endMin - shift.startMin + 1440) % 1440 || 1440) - (shift.break_min || 0);
    if (inMin != null) { let diff = inMin - shift.startMin; if (diff < -720) diff += 1440; if (diff > shift.grace_min) lateMin = diff; }
    if (outMin != null) { let diff = shift.endMin - outMin; if (diff < -720) diff += 1440; if (diff > 720) diff -= 1440; if (diff > 5) earlyMin = diff; }
  }
  const expected = shift && !holiday && !leave;
  const overtimeMin = expected ? Math.max(0, workedMin - scheduledMin - otAfter) : workedMin;
  const outsideFence = list.some((p) => p.in_fence === 0);
  let status;
  if (open) status = openBreak != null ? 'on_break' : 'working';
  else if (list.length) status = missingOut ? 'missing_out' : lateMin ? 'late' : 'present';
  else if (leave) status = 'leave';
  else if (holiday) status = 'holiday';
  else if (!shift) status = 'off';
  else if (isToday) status = 'pending';
  else status = 'absent';
  return {
    shift: shift ? { id: shift.id, name: shift.name, start: shift.start, end: shift.end, color: shift.color } : null,
    holiday, leave: leave ? { type: leave.type, color: leave.color, half_day: !!leave.half_day, paid: !!leave.paid } : null,
    first_in: firstIn, first_in_min: inMin, last_out: open ? null : lastOut, worked_min: workedMin, break_min: breakMin, scheduled_min: expected ? scheduledMin : 0,
    late_min: lateMin, early_min: earlyMin, overtime_min: overtimeMin, open, missing_out: missingOut, late: lateMin > 0, outside_fence: outsideFence,
    expected: !!expected, status, punches: list.length
  };
}

export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.employee_id)) by.set(r.employee_id, { employee_id: r.employee_id, code: r.code, name: r.name, photo: r.photo, department: r.department, location: r.location,
      expected: 0, present: 0, late: 0, absent: 0, leave: 0, holiday: 0, missing_out: 0, worked_min: 0, scheduled_min: 0, overtime_min: 0, late_min: 0, early_min: 0, outside_fence: 0, in_sum: 0, in_n: 0 });
    const s = by.get(r.employee_id);
    if (r.expected) s.expected++;
    if (r.first_in) s.present++;
    if (r.late) s.late++;
    if (r.status === 'absent') s.absent++;
    if (r.status === 'leave') s.leave++;
    if (r.status === 'holiday') s.holiday++;
    if (r.missing_out) s.missing_out++;
    if (r.outside_fence) s.outside_fence++;
    s.worked_min += r.worked_min; s.scheduled_min += r.scheduled_min; s.overtime_min += r.overtime_min; s.late_min += r.late_min; s.early_min += r.early_min;
    if (r.first_in_min != null) { s.in_sum += r.first_in_min; s.in_n++; }
  }
  return [...by.values()].map(({ in_sum, in_n, ...s }) => ({ ...s, avg_in_min: in_n ? Math.round(in_sum / in_n) : null,
    attendance_rate: s.expected ? Math.min(1, s.present / s.expected) : null, punctuality: s.present ? 1 - s.late / s.present : null }));
}

export function leaveBalances(db, employeeId, year) {
  const types = db.prepare('SELECT * FROM leave_types ORDER BY id').all();
  const reqs = db.prepare(`SELECT type_id, date_from, date_to, half_day, status FROM leave_requests WHERE employee_id = ? AND status IN ('approved','pending') AND date_from <= ? AND date_to >= ?`)
    .all(employeeId, `${year}-12-31`, `${year}-01-01`);
  return types.map((t) => {
    let used = 0, pending = 0;
    for (const r of reqs.filter((x) => x.type_id === t.id)) {
      const days = r.half_day ? 0.5 : dateRange(r.date_from < `${year}-01-01` ? `${year}-01-01` : r.date_from, r.date_to > `${year}-12-31` ? `${year}-12-31` : r.date_to).length;
      if (r.status === 'approved') used += days; else pending += days;
    }
    return { type_id: t.id, name: t.name, color: t.color, quota: t.quota_days, used, pending, remaining: t.quota_days ? t.quota_days - used : null };
  });
}
