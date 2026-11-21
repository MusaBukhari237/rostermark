// Shared UI kit: Preact + htm (vendored, no build step), API client, toasts, modal, icons, router.
import { html, render, useState, useEffect, useRef, useMemo, useCallback } from './vendor/preact-htm.js';
export { html, render, useState, useEffect, useRef, useMemo, useCallback };

/* ---------- API ---------- */
export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(globalThis.rmDesktop ? { 'X-Client': 'desktop' } : {}), ...(globalThis.RM_DEVICE ? { 'X-Device-Token': globalThis.RM_DEVICE } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status; throw err;
  }
  return data;
}
export function download(path, filename) {
  const a = document.createElement('a'); a.href = '/api' + path; if (filename) a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- Hooks ---------- */
export function useAsync(fn, deps = []) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const tick = useRef(0);
  const reload = useCallback(() => {
    const id = ++tick.current;
    set((s) => ({ ...s, loading: true }));
    Promise.resolve().then(fn).then(
      (data) => id === tick.current && set({ loading: false, data, error: null }),
      (error) => id === tick.current && set({ loading: false, data: null, error })
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}
export function useInterval(fn, ms) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [ms]);
}
export function useNow(ms = 1000) { const [n, set] = useState(Date.now()); useInterval(() => set(Date.now()), ms); return n; }

/* ---------- Hash router ---------- */
export function useRoute() {
  const get = () => { const h = location.hash.replace(/^#\/?/, ''); const [path, q] = h.split('?'); return { path: '/' + path, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(q || '')) }; };
  const [r, set] = useState(get());
  useEffect(() => { const on = () => set(get()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  return r;
}
export const go = (path) => { location.hash = '#' + path; };

/* ---------- Toasts ---------- */
let pushToast = () => {};
export function toast(msg, kind = '') { pushToast({ msg, kind, id: Math.random() }); }
export function Toasts() {
  const [items, set] = useState([]);
  pushToast = (t) => { set((a) => [...a, t]); setTimeout(() => set((a) => a.filter((x) => x.id !== t.id)), 3600); };
  return html`<div class="toasts">${items.map((t) => html`<div class=${'toast ' + t.kind} key=${t.id}>${t.msg}</div>`)}</div>`;
}
export const errToast = (e) => toast(e?.message || String(e), 'bad');

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose?.(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`<div class="modal-bg" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class=${'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${title}</h2><span class="spacer"></span>
        <button class="btn ghost sm icon" onClick=${onClose} aria-label="Close">${Icon('x')}</button></div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </div></div>`;
}
export function confirmDialog(message) { return Promise.resolve(window.confirm(message)); }

/* ---------- Avatar ---------- */
const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0d9488', '#16a34a', '#0891b2', '#9333ea', '#c2410c', '#4f46e5'];
export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
export function colorFor(s = '') { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
export function Avatar({ name, photo, size = '' }) {
  return html`<span class=${'avatar ' + size} style=${{ background: colorFor(name) }}>${photo ? html`<img src=${photo} alt="" />` : initials(name)}</span>`;
}
export function Person({ name, sub, photo }) {
  return html`<div class="person"><${Avatar} name=${name} photo=${photo} /><div class="meta"><b>${name}</b>${sub && html`<small>${sub}</small>`}</div></div>`;
}

/* ---------- Branding ---------- */
export function applyBrand({ accent, accentInk, theme } = {}) {
  const r = document.documentElement;
  if (accent) r.style.setProperty('--accent', accent);
  if (accentInk) r.style.setProperty('--accent-ink', accentInk);
  const saved = safeGet('theme');
  r.dataset.theme = saved || theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
export function toggleTheme() {
  const r = document.documentElement; const t = r.dataset.theme === 'dark' ? 'light' : 'dark';
  r.dataset.theme = t; safeSet('theme', t);
}
export function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/* ---------- Formatting ---------- */
export const fmtTime = (ts, tz) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '—';
export const fmtDate = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString([], { ...opts, timeZone: d.length === 10 ? 'UTC' : undefined }) : '—';
export const fmtDateTime = (ts, tz) => ts ? new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz }) : '—';
export const dur = (mins) => { if (mins == null || isNaN(mins)) return '—'; const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`; };
export const hours = (mins) => mins == null ? '—' : (mins / 60).toFixed(1);
export const pct = (n) => `${Math.round(n * 100)}%`;
export const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* ---------- Icons (Lucide-style, MIT) ---------- */
const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-9',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', check: 'M20 6 9 17l-5-5',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z', trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35', menu: 'M3 12h18M3 6h18M3 18h18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79', monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2M11 18h2',
  map: 'M12 22s-8-6-8-12a8 8 0 0 1 16 0c0 6-8 12-8 12M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  coffee: 'M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zM6 1v3M10 1v3M14 1v3',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0M12 9v4M12 17h.01',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  chevronLeft: 'M15 18l-6-6 6-6', chevronRight: 'M9 18l6-6-6-6', chevronDown: 'M6 9l6 6 6-6',
  building: 'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78M15.5 7.5l3 3L22 7l-3-3',
  plane: 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14h1v1h-1zM14 20h1v1h-1zM18 18h3v3h-3z',
  backspace: 'M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM18 9l-6 6M12 9l6 6',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z', briefcase: 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11',
  webhook: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2', star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6', maximize: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3'
};
export function Icon(name, attrs = {}) {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ...${attrs}><path d=${P[name] || P.x} /></svg>`;
}

/* ---------- Small components ---------- */
export function Stat({ label, value, hint, color }) {
  return html`<div class="card stat"><span class="label">${color && html`<i class="dot" style=${{ background: color }}></i>`}${label}</span><span class="value">${value}</span>${hint && html`<span class="hint">${hint}</span>`}</div>`;
}
export function Empty({ icon = 'inbox', title, children }) {
  return html`<div class="empty">${Icon(icon)}<b>${title}</b>${children && html`<div class="small">${children}</div>`}</div>`;
}
export function Field({ label, help, children }) {
  return html`<label class="field"><span>${label}</span>${children}${help && html`<small class="help">${help}</small>`}</label>`;
}
export function Loading() { return html`<div class="empty"><div class="pulse"></div><span class="small">Loading…</span></div>`; }

/** Bar chart in inline SVG. data: [{label, value, color?}] */
export function BarChart({ data, height = 180, format = (v) => v, stacked }) {
  const max = Math.max(1, ...data.map((d) => stacked ? d.values.reduce((a, b) => a + b.v, 0) : d.value));
  const w = 100 / Math.max(data.length, 1);
  return html`<div style=${{ position: 'relative' }}>
    <svg viewBox=${`0 0 100 ${height / 3}`} preserveAspectRatio="none" style=${{ width: '100%', height: height + 'px', display: 'block' }}>
      ${data.map((d, i) => {
        if (stacked) {
          let y = height / 3;
          return d.values.map((s) => { const h = (s.v / max) * (height / 3 - 2); y -= h; return html`<rect x=${i * w + w * 0.18} y=${y} width=${w * 0.64} height=${Math.max(h, 0)} fill=${s.color} rx="0.6"><title>${d.label}: ${s.name} ${format(s.v)}</title></rect>`; });
        }
        const h = (d.value / max) * (height / 3 - 2);
        return html`<rect x=${i * w + w * 0.18} y=${height / 3 - h} width=${w * 0.64} height=${Math.max(h, 0.3)} fill=${d.color || 'var(--accent)'} rx="0.8"><title>${d.label}: ${format(d.value)}</title></rect>`;
      })}
    </svg>
    <div style=${{ display: 'grid', gridTemplateColumns: `repeat(${data.length}, 1fr)`, fontSize: '10.5px', color: 'var(--ink-3)', textAlign: 'center', marginTop: '6px' }}>
      ${data.map((d) => html`<span style=${{ overflow: 'hidden', whiteSpace: 'nowrap' }}>${d.label}</span>`)}
    </div></div>`;
}

/** Donut chart. data: [{label, value, color}] */
export function Donut({ data, size = 150, center }) {
  const total = data.reduce((a, b) => a + b.value, 0) || 1;
  let acc = 0; const r = 15.9155;
  return html`<div class="row gap-lg" style=${{ alignItems: 'center' }}>
    <svg viewBox="0 0 42 42" width=${size} height=${size} style=${{ flex: 'none' }}>
      <circle cx="21" cy="21" r=${r} fill="none" stroke="var(--bg-sunk)" stroke-width="5" />
      ${data.map((d) => { const len = (d.value / total) * 100; const el = html`<circle cx="21" cy="21" r=${r} fill="none" stroke=${d.color} stroke-width="5" stroke-dasharray=${`${len} ${100 - len}`} stroke-dashoffset=${25 - acc}><title>${d.label}: ${d.value}</title></circle>`; acc += len; return el; })}
      ${center && html`<text x="21" y="22.5" text-anchor="middle" font-size="6" font-weight="700" fill="var(--ink)">${center}</text>`}
    </svg>
    <div class="col gap-sm">${data.map((d) => html`<div class="row small"><i class="dot" style=${{ width: 10, height: 10, borderRadius: 3, background: d.color, display: 'inline-block' }}></i><span class="muted">${d.label}</span><b style=${{ marginLeft: 'auto', paddingLeft: '12px' }}>${d.value}</b></div>`)}</div>
  </div>`;
}
