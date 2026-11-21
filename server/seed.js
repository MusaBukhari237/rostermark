// Synthetic demo organisation: 3 locations, 7 departments, 4 shifts, 40 people, ~6 weeks of history.
import { hashPassword } from './lib/http.js';
import { addDays, weekday, zonedTs, parseHHMM } from './lib/time.js';
import { getSettings, setSettings, workDate } from './db.js';

const PEOPLE = [
  ['Layla Haddad', 'Operations', 'Operations Manager', 'manager'], ['Omar Siddiqui', 'Warehouse', 'Warehouse Lead', 'manager'],
  ['Grace Thompson', 'Sales', 'Store Manager', 'manager'], ['Arjun Menon', 'Warehouse', 'Forklift Operator'], ['Fatima Noor', 'Finance', 'Accountant'],
  ['Daniel Kim', 'Sales', 'Sales Associate'], ['Hira Javed', 'Customer Support', 'Support Agent'], ['Mateo Silva', 'Field Service', 'Technician'],
  ['Amina Yusuf', 'HR', 'HR Officer'], ['Rahul Iyer', 'Warehouse', 'Picker'], ['Sofia Rossi', 'Sales', 'Visual Merchandiser'],
  ['Khalid Al Mansoori', 'Operations', 'Supervisor'], ['Joy Bautista', 'Customer Support', 'Support Agent'], ['Ibrahim Saleh', 'Field Service', 'Electrician'],
  ['Chloe Martin', 'Finance', 'Payroll Specialist'], ['Bilal Chaudhry', 'Warehouse', 'Driver'], ['Nadia Petrov', 'Sales', 'Cashier'],
  ['Samuel Adeyemi', 'Operations', 'Coordinator'], ['Priya Raman', 'Customer Support', 'Team Lead'], ['Yusuf Erdem', 'Field Service', 'HVAC Technician'],
  ['Mariam Khan', 'HR', 'Recruiter'], ['Lucas Weber', 'Warehouse', 'Loader'], ['Aaliyah Brooks', 'Sales', 'Sales Associate'],
  ['Hamza Tariq', 'Operations', 'Dispatcher'], ['Elif Yilmaz', 'Customer Support', 'Support Agent'], ['George Mensah', 'Field Service', 'Plumber'],
  ['Zara Ahmed', 'Finance', 'Analyst'], ['Ravi Shankar', 'Warehouse', 'Stock Controller'], ['Emily Carter', 'Sales', 'Cashier'],
  ['Tariq Hussain', 'Operations', 'Security Officer'], ['Mei Chen', 'Customer Support', 'Support Agent'], ['Ahmed Fawzi', 'Field Service', 'Technician'],
  ['Noor Fatima', 'Sales', 'Sales Associate'], ['Kofi Owusu', 'Warehouse', 'Picker'], ['Isabel Garcia', 'Operations', 'Night Supervisor'],
  ['Faisal Qureshi', 'Operations', 'Security Officer'], ['Lina Saad', 'Sales', 'Cashier'], ['Victor Nwosu', 'Warehouse', 'Night Loader'],
  ['Anjali Desai', 'Customer Support', 'Support Agent'], ['Peter Novak', 'Field Service', 'Technician']
];
const DEPTS = [['Operations', '#f97316'], ['Sales', '#3b82f6'], ['Warehouse', '#14b8a6'], ['Finance', '#a855f7'], ['HR', '#ec4899'], ['Field Service', '#eab308'], ['Customer Support', '#22c55e']];
const LOCS = [['Head Office', 'Business Bay, Dubai', 25.1857, 55.2665, 150], ['Central Warehouse', 'Al Quoz Industrial 3, Dubai', 25.1316, 55.2297, 250], ['Flagship Store', 'Downtown Dubai', 25.1972, 55.2744, 120]];
const SHIFTS = [['General', '09:00', '18:00', 60, 10, '1,2,3,4,5,6', '#3b82f6'], ['Morning', '07:00', '15:00', 45, 10, '1,2,3,4,5,6', '#22c55e'], ['Evening', '14:00', '22:00', 45, 10, '0,1,2,3,4,5,6', '#f59e0b'], ['Night', '22:00', '06:00', 45, 15, '0,1,2,3,4,5', '#6366f1']];

// Optional industry profile: DEMO_PROFILE=construction relabels departments, sites and titles.
const CON_DEPT = { Operations: 'Site Execution', Sales: 'Design Studio', Warehouse: 'Joinery Workshop', Finance: 'Finance', HR: 'HR & Admin', 'Field Service': 'MEP', 'Customer Support': 'Project Management' };
const CON_TITLE = { 'Site Execution': ['Site Engineer', 'Foreman', 'Mason', 'Tiler', 'Painter', 'Helper'], 'Design Studio': ['Interior Designer', 'Draftsman', 'Estimator'],
  'Joinery Workshop': ['Carpenter', 'Joiner', 'Polisher', 'CNC Operator'], 'MEP': ['Electrician', 'Plumber', 'HVAC Technician', 'Duct Fabricator'], 'Project Management': ['Project Manager', 'Project Coordinator', 'QS Engineer'] };
const CON_LOCS = [['Head Office', 'Business Bay, Dubai', 25.1857, 55.2665, 150], ['Joinery Workshop', 'Al Quoz Industrial 3, Dubai', 25.1316, 55.2297, 250], ['Site · Villa Fit-out', 'Jumeirah, Dubai', 25.2048, 55.2416, 200]];
const CON = process.env.DEMO_PROFILE === 'construction';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function seedDemo(db, { companyName } = {}) {
  const rand = rng(424242), now = Date.now();
  setSettings(db, { company_name: companyName || 'Northwind Group', ...(process.env.DEMO_TIMEZONE ? { timezone: process.env.DEMO_TIMEZONE } : {}) });
  const s = getSettings(db), tz = s.timezone, cutoff = parseHHMM(s.day_cutoff);
  const today = workDate(now, tz, cutoff);
  const id = (r) => Number(r.lastInsertRowid);
  const dept = Object.fromEntries(DEPTS.map(([n, c]) => [n, id(db.prepare('INSERT INTO departments (name, color) VALUES (?, ?)').run(CON ? CON_DEPT[n] : n, c))]));
  const locs = (CON ? CON_LOCS : LOCS).map((l) => id(db.prepare('INSERT INTO locations (name, address, lat, lng, radius_m) VALUES (?, ?, ?, ?, ?)').run(...l)));
  const shifts = SHIFTS.map((x) => id(db.prepare('INSERT INTO shifts (name, start, end, break_min, grace_min, days, color) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...x)));
  const lt = [['Annual leave', '#8b5cf6', 1, 30], ['Sick leave', '#ef4444', 1, 15], ['Emergency leave', '#f59e0b', 1, 5], ['Unpaid leave', '#64748b', 0, 0]]
    .map((x) => id(db.prepare('INSERT INTO leave_types (name, color, paid, quota_days) VALUES (?, ?, ?, ?)').run(...x)));
  db.prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)').run(addDays(today, -24), 'Public holiday');
  db.prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)').run(addDays(today, 12), 'National Day');

  const pw = hashPassword('demo1234'), pin = hashPassword('1234');
  const insE = db.prepare(`INSERT INTO employees (code, name, email, title, role, department_id, location_id, shift_id, manager_id, password_hash, pin_hash, joined, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const adminId = id(insE.run('E100', 'Demo Admin', 'admin@demo.local', 'HR Director', 'admin', dept.HR, locs[0], null, null, pw, pin, addDays(today, -400), now));
  const emps = PEOPLE.map(([name, d, title, role], i) => {
    if (CON && !role && CON_TITLE[CON_DEPT[d]]) { const t = CON_TITLE[CON_DEPT[d]]; title = t[i % t.length]; }
    const loc = d === 'Warehouse' ? locs[1] : d === (CON ? 'Operations' : 'Sales') ? locs[2] : locs[0];
    const shift = /Night/.test(title) ? shifts[3] : d === 'Warehouse' ? shifts[1] : d === 'Sales' ? shifts[CON ? 0 : 2] : d === 'Field Service' ? shifts[1] : shifts[0];
    const email = i === 0 ? 'manager@demo.local' : name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com';
    const empId = id(insE.run('E' + (201 + i), name, email, title, role || 'employee', dept[d], loc, shift, role ? adminId : null, pw, pin, addDays(today, -300 + i), now));
    return { id: empId, loc, shift, idx: i, dept: d };
  });
  const managers = emps.filter((e) => e.idx < 3);
  for (const e of emps.slice(3)) db.prepare('UPDATE employees SET manager_id = ? WHERE id = ?').run(managers[e.idx % 3].id, e.id);

  const shiftRow = new Map(db.prepare('SELECT * FROM shifts').all().map((x) => [x.id, x]));
  const insP = db.prepare('INSERT INTO punches (employee_id, type, ts, source, location_id, lat, lng, accuracy, distance_m, in_fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const locRow = new Map(db.prepare('SELECT * FROM locations').all().map((l) => [l.id, l]));
  const leaveDays = new Set();
  // Approved and pending leave
  const insL = db.prepare('INSERT INTO leave_requests (employee_id, type_id, date_from, date_to, half_day, reason, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  [[5, 0, -20, -16, 'approved', 'Family trip'], [12, 1, -9, -8, 'approved', 'Flu'], [20, 0, -3, 1, 'approved', 'Annual vacation'], [27, 2, -30, -30, 'approved', 'Family emergency'],
    [8, 0, 6, 10, 'pending', 'Wedding in the family'], [15, 1, 0, 0, 'pending', 'Doctor appointment'], [31, 0, 14, 21, 'pending', 'Home visit'], [2, 3, 3, 4, 'rejected', 'Personal']].forEach(([i, t, a, b, st, why]) => {
    const e = emps[i];
    insL.run(e.id, lt[t], addDays(today, a), addDays(today, b), 0, why, st, st === 'pending' ? null : 'admin@demo.local', st === 'pending' ? null : now, now - 5 * 864e5);
    if (st === 'approved') for (let d = a; d <= b; d++) leaveDays.add(e.id + '|' + addDays(today, d));
  });
  const holidays = new Set(db.prepare('SELECT date FROM holidays').all().map((h) => h.date));

  db.exec('BEGIN');
  for (let back = 42; back >= 0; back--) {
    const date = addDays(today, -back);
    if (holidays.has(date)) continue;
    for (const e of emps) {
      const sh = shiftRow.get(e.shift);
      if (!String(sh.days).split(',').map(Number).includes(weekday(date))) continue;
      if (leaveDays.has(e.id + '|' + date)) continue;
      if (rand() > (e.idx % 8 === 5 ? 0.86 : 0.965)) continue; // absent
      const start = parseHHMM(sh.start), end = parseHHMM(sh.end) < start ? parseHHMM(sh.end) + 1440 : parseHHMM(sh.end);
      const late = e.idx % 6 === 4 && rand() < 0.4;
      const arrive = start - 18 + Math.floor(rand() * 26) + (late ? 14 + Math.floor(rand() * 30) : 0);
      const leave = end - 6 + Math.floor(rand() * 55) + (rand() < 0.15 ? 60 + Math.floor(rand() * 60) : 0);
      const loc = locRow.get(e.loc);
      const mobile = e.dept === 'Field Service' || rand() < 0.25;
      const fence = !(mobile && rand() < 0.06);
      const off = fence ? rand() * 0.0008 : 0.01 + rand() * 0.01;
      const geo = mobile ? [loc.lat + off, loc.lng + off, 12 + rand() * 25, fence ? Math.round(rand() * 80) : Math.round(1200 + rand() * 900), fence ? 1 : 0] : [null, null, null, null, null];
      const src = mobile ? 'mobile' : rand() < 0.5 ? 'kiosk' : 'desktop';
      const t = (m) => zonedTs(date, m, tz);
      const punch = (type, m) => { const ts = t(m); if (ts > now) return false; insP.run(e.id, type, ts, src, e.loc, ...geo, now); return true; };
      if (!punch('in', arrive)) continue;
      const bs = start + Math.floor((end - start) / 2) - 20 + Math.floor(rand() * 40);
      if (punch('break_start', bs)) punch('break_end', bs + (sh.break_min || 45) - 5 + Math.floor(rand() * 15));
      if (back > 0 && rand() < 0.008) continue; // forgot to clock out
      punch('out', leave);
    }
  }
  db.exec('COMMIT');
  // Roster changes this week and next: rotate a few people onto evening and night cover.
  const insR = db.prepare('INSERT OR REPLACE INTO roster (employee_id, date, shift_id) VALUES (?, ?, ?)');
  const wk = addDays(today, -((weekday(today) + 6) % 7));
  [[11, 2], [17, 3], [29, 3], [35, 2]].forEach(([i, sh], n) => { for (let d = 0; d < 14; d++) if (addDays(wk, d) >= today && (d + n) % 3 === 0) insR.run(emps[i].id, addDays(wk, d), shifts[sh]); });
  [6, 18].forEach((i) => { if (addDays(wk, 5) >= today) insR.run(emps[i].id, addDays(wk, 5), null); });
  // Correction requests
  const insC = db.prepare('INSERT INTO corrections (employee_id, date, type, time, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insC.run(emps[9].id, addDays(today, -2), 'out', '18:05', 'Phone battery died, forgot to clock out', 'pending', now);
  insC.run(emps[23].id, addDays(today, -1), 'in', '08:55', 'Kiosk was offline when I arrived', 'pending', now);
  // API key & webhook examples are left for the user to create.
}
