import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, summarizeDay, assignDates, haversine, buildDays, getSettings } from '../server/db.js';
import { zonedTs } from '../server/lib/time.js';

const tz = 'Asia/Dubai';
const at = (date, hm) => zonedTs(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), tz);
const shift = { id: 1, name: 'General', start: '09:00', end: '18:00', startMin: 540, endMin: 1080, break_min: 60, grace_min: 10, color: '#000' };

test('worked time subtracts breaks and flags lateness after grace', () => {
  const d = '2026-03-02';
  const list = [{ type: 'in', ts: at(d, '09:25') }, { type: 'break_start', ts: at(d, '13:00') }, { type: 'break_end', ts: at(d, '13:45') }, { type: 'out', ts: at(d, '18:30') }];
  const r = summarizeDay(list, { shift, tz, isToday: false, now: Date.now(), otAfter: 0 });
  assert.equal(r.worked_min, 9 * 60 + 5 - 45);
  assert.equal(r.late_min, 25);
  assert.equal(r.status, 'late');
  assert.equal(r.overtime_min, r.worked_min - 8 * 60);
});

test('a missing clock-out on a past day is flagged', () => {
  const d = '2026-03-02';
  const r = summarizeDay([{ type: 'in', ts: at(d, '08:55') }], { shift, tz, isToday: false, now: Date.now(), otAfter: 0 });
  assert.equal(r.status, 'missing_out');
  assert.equal(r.late_min, 0);
});

test('night-shift clock-out after the day cut-off stays on the start day', () => {
  const p = assignDates([{ employee_id: 1, type: 'in', ts: at('2026-03-02', '22:01') }, { employee_id: 1, type: 'out', ts: at('2026-03-03', '06:12') }], tz, 240);
  assert.equal(p[0].work_date, '2026-03-02');
  assert.equal(p[1].work_date, '2026-03-02');
});

test('approved leave and holidays are not absences', () => {
  assert.equal(summarizeDay([], { shift, leave: { type: 'Annual' }, tz, isToday: false, now: 0, otAfter: 0 }).status, 'leave');
  assert.equal(summarizeDay([], { shift, holiday: 'National Day', tz, isToday: false, now: 0, otAfter: 0 }).status, 'holiday');
  assert.equal(summarizeDay([], { shift, tz, isToday: false, now: 0, otAfter: 0 }).status, 'absent');
});

test('haversine distance is roughly right', () => {
  const m = haversine({ lat: 25.1857, lng: 55.2665 }, { lat: 25.1972, lng: 55.2744 });
  assert.ok(m > 1400 && m < 1600, String(m));
});

test('buildDays uses the default shift and skips days off', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO shifts (name, start, end, days) VALUES ('General', '09:00', '18:00', '1,2,3,4,5')").run();
  db.prepare("INSERT INTO employees (code, name, shift_id, created_at) VALUES ('E1', 'Test', 1, 0)").run();
  db.prepare("INSERT INTO punches (employee_id, type, ts, created_at) VALUES (1, 'in', ?, 0), (1, 'out', ?, 0)").run(at('2026-03-02', '09:00'), at('2026-03-02', '17:00'));
  const rows = buildDays(db, getSettings(db), { from: '2026-03-01', to: '2026-03-03' });
  assert.deepEqual(rows.map((r) => r.status), ['off', 'present', 'absent']);
  assert.equal(rows[1].early_min, 60);
});
