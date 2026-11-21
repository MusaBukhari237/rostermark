// Timezone-aware date helpers built on Intl. Works in Node.js and the browser.
const fmtCache = new Map();
function parts(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}

/** YYYY-MM-DD of a timestamp in a timezone. */
export function localDate(ts, tz) { const p = parts(ts, tz); return `${p.year}-${p.month}-${p.day}`; }
/** Minutes since local midnight. */
export function localMinutes(ts, tz) { const p = parts(ts, tz); return Number(p.hour) * 60 + Number(p.minute); }
/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string. */
export function weekday(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
/** UTC offset in minutes for tz at ts. */
export function tzOffset(ts, tz) {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}
/** Timestamp for a local date + minutes-of-day in tz. */
export function zonedTs(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0) + minutes * 60000;
  const off = tzOffset(guess, tz);
  const ts = guess - off * 60000;
  const off2 = tzOffset(ts, tz);
  return off2 === off ? ts : guess - off2 * 60000;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function dateRange(from, to) {
  const out = []; let d = from; let guard = 0;
  while (d <= to && guard++ < 800) { out.push(d); d = addDays(d, 1); }
  return out;
}
export function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}`, days: last };
}
export const hhmm = (mins) => mins == null ? '' : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.round(mins % 60)).padStart(2, '0')}`;
export const parseHHMM = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const durationLabel = (mins) => {
  if (mins == null || isNaN(mins)) return '—';
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
