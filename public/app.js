import {
  html, render, useState, useEffect, useMemo, api, download, useAsync, useInterval, useNow, useRoute,
  Toasts, toast, errToast, Modal, Avatar, Person, applyBrand, toggleTheme, Icon, Stat, Empty, Field, Loading,
  BarChart, Donut, fmtTime, fmtDate, fmtDateTime, dur, hours
} from './kit.js';
import { addDays, hhmm, localMinutes, weekday } from './time.js';
import { Camera, getLocation, ACTION_LABEL, ACTION_ICON, ACTION_DONE } from './camera.js';

let META = {};
const STATUS = {
  working: ['ok', 'Working'], on_break: ['warn', 'On break'], present: ['info', 'Present'], late: ['warn', 'Late'], pending: ['', 'Not in yet'],
  absent: ['bad', 'Absent'], leave: ['violet', 'On leave'], holiday: ['', 'Holiday'], off: ['', 'Day off'], missing_out: ['violet', 'No clock-out']
};
const StatusBadge = ({ s }) => { const [k, l] = STATUS[s] || ['', s]; return html`<span class=${'badge ' + k}><i class="dot"></i>${l}</span>`; };
const REQ = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '' };
const ReqBadge = ({ s }) => html`<span class=${'badge ' + (REQ[s] || '')}>${s}</span>`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const T = (ts) => fmtTime(ts, META.timezone);
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'manager');
const distLabel = (m) => m == null ? '' : m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
function readImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    if (file.type === 'image/svg+xml') { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(file); return; }
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85)); };
    img.onerror = reject; img.src = url;
  });
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const r = rows.filter((x) => x.some((c) => c.trim())); if (!r.length) return [];
  const head = r[0].map((h) => h.trim().toLowerCase()); return r.slice(1).map((x) => Object.fromEntries(head.map((h, i) => [h, (x[i] || '').trim()])));
}

/* =================== Root & auth =================== */
function App() {
  const [user, setUser] = useState(undefined);
  const refresh = () => api('/auth/me').then((d) => setUser(d.user)).catch(() => setUser(null));
  useEffect(() => { refresh(); }, []);
  if (user === undefined) return html`<${Loading} />`;
  if (META.needsSetup) return html`<${Setup} />`;
  if (!user) return html`<${Login} onDone=${refresh} />`;
  return html`<${Shell} user=${user} onLogout=${refresh} />`;
}
function AuthLayout({ children }) {
  return html`<div class="auth"><div class="auth-art">
      <div class="row"><img src=${META.logo} style=${{ width: 40, height: 40, borderRadius: 10, background: '#fff', padding: 4 }} alt="" /><b style=${{ fontSize: 18 }}>${META.appName}</b></div>
      <div><h2>${META.tagline}</h2><ul>
        <li>${Icon('map')} Geofenced clock-in from phones, kiosks and desktops</li><li>${Icon('calendar')} Shift rosters, night shifts and holidays</li>
        <li>${Icon('plane')} Leave requests, balances and approvals</li><li>${Icon('chart')} Payroll-ready reports, REST API and webhooks</li></ul>
        <div class="auth-kpis"><div><b>Multi-site</b><span>Geofences</span></div><div><b>3 roles</b><span>Role-based access</span></div><div><b>API</b><span>REST + webhooks</span></div></div></div>
      <div class="small" style=${{ opacity: .7 }}>${META.companyName}</div></div>
    <div class="auth-form">${children}</div></div>`;
}
function Login({ onDone }) {
  const [tab, setTab] = useState('email');
  const [f, set] = useState({ email: '', password: '', code: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { if (tab === 'email') await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } }); else await api('/auth/pin', { method: 'POST', body: { code: f.code, pin: f.pin } }); onDone(); }
    catch (err) { errToast(err); } finally { setBusy(false); }
  };
  const demo = (k) => { const d = META.demo[k]; if (k === 'employee') { setTab('pin'); set({ ...f, code: d.code, pin: d.pin }); } else { setTab('email'); set({ ...f, email: d.email, password: d.password }); } };
  return html`<${AuthLayout}><form onSubmit=${submit}>
    <div class="col gap-sm"><img src=${META.logo} style=${{ width: 48, height: 48 }} alt="" /><h1>Sign in</h1><p class="muted">${META.companyName}</p></div>
    <div class="seg" style=${{ alignSelf: 'flex-start' }}><button type="button" class=${tab === 'email' ? 'on' : ''} onClick=${() => setTab('email')}>Email</button><button type="button" class=${tab === 'pin' ? 'on' : ''} onClick=${() => setTab('pin')}>Employee ID + PIN</button></div>
    ${tab === 'email' ? html`<${Field} label="Email"><input class="input" type="email" autocomplete="username" value=${f.email} onInput=${(e) => set({ ...f, email: e.target.value })} required /><//>
      <${Field} label="Password"><input class="input" type="password" autocomplete="current-password" value=${f.password} onInput=${(e) => set({ ...f, password: e.target.value })} required /><//>`
    : html`<${Field} label="Employee ID"><input class="input" value=${f.code} onInput=${(e) => set({ ...f, code: e.target.value })} required /><//>
      <${Field} label="PIN"><input class="input" type="password" inputmode="numeric" value=${f.pin} onInput=${(e) => set({ ...f, pin: e.target.value })} required /><//>`}
    <button class="btn primary lg" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
    <a class="btn ghost" href="/kiosk">${Icon('monitor')} Kiosk mode</a>
    ${META.demo && html`<div class="demo-box"><b>Live demo</b><span class="muted">Synthetic data, reset regularly. Pick a role:</span>
      <div class="row wrap"><button type="button" class="btn sm" onClick=${() => demo('admin')}>Admin</button><button type="button" class="btn sm" onClick=${() => demo('manager')}>Manager</button><button type="button" class="btn sm" onClick=${() => demo('employee')}>Employee</button></div></div>`}
  </form><//>`;
}
function Setup() {
  const [f, set] = useState({ company_name: '', name: '', email: '', password: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const inp = (k, p = {}) => html`<input class="input" value=${f[k]} onInput=${(e) => set({ ...f, [k]: e.target.value })} ...${p} />`;
  return html`<${AuthLayout}><form onSubmit=${async (e) => { e.preventDefault(); try { await api('/setup', { method: 'POST', body: f }); location.reload(); } catch (err) { errToast(err); } }}>
    <h1>Set up ${META.appName}</h1><p class="muted">Create your organisation and the first admin.</p>
    <${Field} label="Company name">${inp('company_name', { required: true })}<//><${Field} label="Your name">${inp('name')}<//>
    <${Field} label="Email">${inp('email', { type: 'email', required: true })}<//><${Field} label="Password" help="At least 8 characters">${inp('password', { type: 'password', minlength: 8, required: true })}<//>
    <${Field} label="Timezone">${inp('timezone')}<//><button class="btn primary lg">Create organisation</button></form><//>`;
}

/* =================== Shell =================== */
function Shell({ user, onLogout }) {
  const route = useRoute();
  const staff = isStaff(user);
  const counts = useAsync(() => staff ? Promise.all([api('/leave?status=pending'), api('/corrections')]).then(([l, c]) => ({ leave: l.length, corr: c.filter((x) => x.status === 'pending').length })) : Promise.resolve({}), [route.path]);
  const nav = staff ? [
    ['dashboard', 'Dashboard', 'home', 0, 'Overview'], ['people', 'People', 'users', 0, 'Workforce'], ['schedule', 'Schedule', 'calendar', 0, 'Workforce'],
    ['timesheets', 'Timesheets', 'clock', 0, 'Time & attendance'], ['leave', 'Leave', 'plane', counts.data?.leave, 'Time & attendance'], ['requests', 'Corrections', 'inbox', counts.data?.corr, 'Time & attendance'],
    ['reports', 'Reports', 'chart', 0, 'Insights'], ...(user.role === 'admin' ? [['settings', 'Settings', 'settings', 0, 'Administration']] : []), ['me', 'My attendance', 'activity', 0, 'Personal']
  ] : [['me', 'My attendance', 'activity']];
  const page = route.parts[0] || (staff ? 'dashboard' : 'me');
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route.path]);
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); onLogout(); };
  const pages = { dashboard: Dashboard, people: People, schedule: Schedule, timesheets: Timesheets, leave: Leave, requests: Corrections, reports: Reports, settings: Settings, me: Me };
  const Page = (staff || page === 'me') ? pages[page] || Dashboard : Me;
  if (!staff) return html`<div class="me" style=${{ maxWidth: 640 }}><${Me} user=${user} onLogout=${logout} /></div>`;
  const groups = [...new Set(nav.map((n) => n[4]))];
  const cur = nav.find((n) => n[0] === page) || nav[0];
  return html`<div class="shell">
    <aside class=${'sidebar' + (open ? ' open' : '')}>
      <div class="brand"><img src=${META.logo} alt="" /><div style=${{ minWidth: 0 }}><div class="name">${META.companyName}</div><div class="sub">${META.appName} workspace</div></div></div>
      ${groups.map((g) => html`<div class="nav-label">${g}</div><nav class="nav">${nav.filter((n) => n[4] === g).map(([k, l, i, n]) => html`<a href=${'#/' + k} class=${page === k ? 'active' : ''}>${Icon(i)} ${l}${n ? html`<span class="count">${n}</span>` : ''}</a>`)}</nav>`)}
      <div class="nav-label">Clock-in points</div><nav class="nav"><a href="/kiosk" target="_blank">${Icon('monitor')} Kiosk mode</a></nav>
      <span class="spacer"></span>
      <div class="who"><${Avatar} name=${user.name} photo=${user.photo} size="sm" /><div style=${{ minWidth: 0 }}><b>${user.name}</b><span>${user.role}</span></div>
        <button class="btn ghost sm icon" title="Sign out" onClick=${logout}>${Icon('logout')}</button></div>
      <div class="side-actions"><button class="btn ghost sm" onClick=${toggleTheme}>${Icon('moon')} Toggle theme</button></div>
    </aside>
    ${open && html`<div class="scrim" onClick=${() => setOpen(false)}></div>`}
    <main class="main"><div class="topbar"><button class="btn ghost icon menu-btn" onClick=${() => setOpen(true)}>${Icon('menu')}</button>
      <div class="crumbs"><span>${cur[4]}</span>${Icon('chevronRight')}<h1>${cur[1]}</h1></div><span class="spacer"></span>
      <span class="tb-chip">${Icon('calendar')} ${new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: META.timezone })}</span>
      <span class="tb-chip">${Icon('clock')} ${META.timezone || 'UTC'}</span></div>
      <div class="content"><${Page} user=${user} route=${route} onLogout=${logout} /></div></main></div>`;
}

/* =================== Dashboard =================== */
function Dashboard() {
  const [loc, setLoc] = useState('');
  const { data, reload } = useAsync(() => api('/dashboard' + (loc ? '?location=' + loc : '')), [loc]);
  useInterval(reload, 30000);
  if (!data) return html`<${Loading} />`;
  const d = data;
  const trend = d.trend.filter((x) => x.expected).map((x) => ({ label: fmtDate(x.date, { day: 'numeric', month: 'short' }), values: [{ name: 'On time', v: x.present - x.late, color: 'var(--accent)' }, { name: 'Late', v: x.late, color: '#f59e0b' }, { name: 'Missing', v: Math.max(0, x.expected - x.present), color: 'color-mix(in srgb, var(--ink-3) 35%, transparent)' }] }));
  const A = ({ href, icon, n, label, color }) => html`<a class="alert-card" href=${href}><span class="ic" style=${{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>${Icon(icon)}</span><div><b>${n}</b><span class="small muted">${label}</span></div></a>`;
  return html`<div class="col gap-lg">
    <div class="row wrap"><div class="seg"><button class=${!loc ? 'on' : ''} onClick=${() => setLoc('')}>All sites</button>${d.locations.map((l) => html`<button class=${loc == l.id ? 'on' : ''} onClick=${() => setLoc(String(l.id))}>${l.name}</button>`)}</div><span class="spacer"></span><a class="btn" href="/kiosk" target="_blank">${Icon('monitor')} Kiosk</a></div>
    <div class="grid grid-4">
      <${Stat} label="On site now" value=${d.onsite} hint=${`${d.onBreak} on break`} color="var(--ok)" />
      <${Stat} label="Arrived today" value=${`${d.arrived}/${d.expected}`} hint=${d.expected ? Math.round((d.arrived / d.expected) * 100) + '% of scheduled staff' : 'No shifts scheduled'} color="var(--accent)" />
      <${Stat} label="Late arrivals" value=${d.late} hint="After shift start + grace" color="#f59e0b" />
      <${Stat} label="On leave today" value=${d.onLeave} hint=${`${d.absent} scheduled, not in yet`} color="#8b5cf6" />
    </div>
    <div class="grid grid-4">
      <${A} href="#/leave" icon="plane" n=${d.alerts.pendingLeave} label="Leave requests to review" color="#8b5cf6" />
      <${A} href="#/requests" icon="inbox" n=${d.alerts.pendingCorrections} label="Time corrections pending" color="#0ea5e9" />
      <${A} href="#/timesheets" icon="alert" n=${d.alerts.missingOut} label="Missing clock-outs (7 days)" color="#ef4444" />
      <${A} href="#/timesheets" icon="map" n=${d.alerts.outsideFence} label="Punches outside geofence (7 days)" color="#f59e0b" />
    </div>
    <div class="grid" style=${{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
      <div class="card"><div class="card-head"><h3>Live attendance</h3><span class="pulse"></span><span class="spacer"></span><a class="small" href="#/timesheets">All timesheets →</a></div>
        <div style=${{ maxHeight: 470, overflow: 'auto' }}>${d.live.length ? d.live.map((x) => html`<div class="live-row"><${Person} name=${x.name} sub=${[x.department, x.location].filter(Boolean).join(' · ')} photo=${x.photo} /><span class="spacer"></span>
          ${x.shift && html`<span class="badge" style=${{ color: x.shift.color }}>${x.shift.name}</span>`}${x.outside_fence && html`<span class="badge warn" title="A punch was outside the geofence">${Icon('map', { width: 12, height: 12 })}</span>`}
          <span class="small muted nowrap">${T(x.first_in)} → ${x.open ? 'now' : T(x.last_out)}</span><b class="small nowrap" style=${{ width: 60, textAlign: 'right' }}>${dur(x.worked_min)}</b><${StatusBadge} s=${x.late && !x.open ? 'late' : x.status} /></div>`) : html`<${Empty} icon="users" title="Nobody has clocked in yet" />`}</div></div>
      <div class="col gap-lg">
        <div class="card"><div class="card-head"><h3>Sites</h3></div>${d.locations.map((l) => html`<div class="live-row"><span class="team-ic">${Icon('building', { width: 16, height: 16 })}</span><div style=${{ flex: 1 }}><b class="small">${l.name}</b><div class="faint small">${l.staff} scheduled today</div></div><b>${l.onsite}</b><span class="faint small">on site</span></div>`)}</div>
        <div class="card"><div class="card-head"><h3>Not in yet</h3><span class="badge">${d.waiting.length}</span></div><div style=${{ maxHeight: 220, overflow: 'auto' }}>${d.waiting.length ? d.waiting.map((x) => html`<div class="live-row"><${Person} name=${x.name} sub=${x.shift ? `${x.shift.name} · ${x.shift.start}` : x.department} photo=${x.photo} /></div>`) : html`<${Empty} icon="check" title="Everyone scheduled is in" />`}</div></div>
      </div></div>
    <div class="grid" style=${{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
      <div class="card"><div class="card-head"><h3>Attendance, last 2 weeks</h3></div><div class="card-pad"><${BarChart} stacked data=${trend} height=${200} /></div></div>
      <div class="card"><div class="card-head"><h3>Departments today</h3></div><div class="card-pad col">${d.depts.filter((x) => x.expected).map((x) => html`<div class="row"><span class="small" style=${{ width: 130 }}>${x.name}</span><div class="bar" style=${{ flex: 1 }}><i style=${{ width: Math.round((x.present / x.expected) * 100) + '%', background: x.color }}></i></div><span class="small muted" style=${{ width: 44, textAlign: 'right' }}>${x.present}/${x.expected}</span></div>`)}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Recent punches</h3></div><div class="table-wrap"><table class="table"><tbody>${d.activity.map((a) => html`<tr><td><${Person} name=${a.name} photo=${a.photo} /></td><td>${ACTION_DONE[a.type]}</td><td><span class="badge">${a.source}</span></td><td class="small muted">${a.location || '—'}${a.distance_m != null ? ` · ${distLabel(a.distance_m)}` : ''}</td><td>${a.in_fence === 0 ? html`<span class="badge warn">Outside geofence</span>` : a.in_fence === 1 ? html`<span class="badge ok">In geofence</span>` : ''}</td><td class="right small muted nowrap">${fmtDateTime(a.ts, META.timezone)}</td></tr>`)}</tbody></table></div></div>
  </div>`;
}

/* =================== People =================== */
function useOrg() { return useAsync(() => Promise.all(['/departments', '/locations', '/shifts', '/leave-types'].map((p) => api(p))).then(([departments, locations, shifts, leaveTypes]) => ({ departments, locations, shifts, leaveTypes }))); }
function People({ user }) {
  const { data, reload } = useAsync(() => api('/employees'));
  const org = useOrg();
  const [q, setQ] = useState(''); const [dept, setDept] = useState(''); const [edit, setEdit] = useState(null); const [imp, setImp] = useState(false);
  if (!data || !org.data) return html`<${Loading} />`;
  const list = data.filter((e) => (!dept || e.department_id == dept) && (!q || (e.name + e.code + (e.email || '') + (e.title || '')).toLowerCase().includes(q.toLowerCase())));
  const ST = { in: ['ok', 'In'], break: ['warn', 'Break'], out: ['', 'Out'] };
  return html`<div class="col gap-lg">
    <div class="row wrap"><div class="search" style=${{ width: 280 }}>${Icon('search')}<input class="input" placeholder="Search name, ID, email" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      <select class="input" style=${{ width: 200 }} value=${dept} onChange=${(e) => setDept(e.target.value)}><option value="">All departments</option>${org.data.departments.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>
      <span class="faint small">${list.length} people</span><span class="spacer"></span><button class="btn" onClick=${() => setImp(true)}>${Icon('upload')} Import CSV</button><button class="btn primary" onClick=${() => setEdit({})}>${Icon('plus')} Add person</button></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Person</th><th>ID</th><th>Department</th><th>Site</th><th>Shift</th><th>Role</th><th>Now</th><th></th></tr></thead><tbody>
      ${list.map((e) => html`<tr style=${{ opacity: e.active ? 1 : .5 }}><td><${Person} name=${e.name} sub=${e.title} photo=${e.photo} /></td><td class="mono small">${e.code}</td>
        <td>${e.department ? html`<span class="badge" style=${{ color: e.dept_color }}><i class="dot"></i>${e.department}</span>` : '—'}</td><td class="small">${e.location || '—'}</td><td class="small">${e.shift || '—'}</td>
        <td><span class=${'badge ' + (e.role === 'admin' ? 'accent' : e.role === 'manager' ? 'info' : '')}>${e.role}</span></td>
        <td>${e.active ? html`<span class=${'badge ' + ST[e.state][0]}><i class="dot"></i>${ST[e.state][1]}</span>` : html`<span class="badge">Inactive</span>`}</td>
        <td class="right"><button class="btn sm" onClick=${() => setEdit(e)}>${Icon('edit')} Edit</button></td></tr>`)}</tbody></table>${!list.length && html`<${Empty} icon="users" title="No one matches" />`}</div>
    ${edit && html`<${PersonForm} emp=${edit} org=${org.data} people=${data} user=${user} onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); reload(); }} />`}
    ${imp && html`<${ImportPeople} onClose=${() => setImp(false)} onDone=${() => { setImp(false); reload(); }} />`}</div>`;
}
function PersonForm({ emp, org, people, user, onClose, onSaved }) {
  const isNew = !emp.id;
  const [f, set] = useState({ name: '', code: '', email: '', phone: '', title: '', role: 'employee', department_id: '', location_id: '', shift_id: '', manager_id: '', active: true, joined: META.today, ...emp, pin: '', password: '', active: emp.active === undefined ? true : !!emp.active });
  const inp = (k, p = {}) => html`<input class="input" value=${f[k] ?? ''} onInput=${(e) => set({ ...f, [k]: e.target.value })} ...${p} />`;
  const sel = (k, opts, none = '—') => html`<select class="input" value=${f[k] ?? ''} onChange=${(e) => set({ ...f, [k]: e.target.value })}><option value="">${none}</option>${opts.map((o) => html`<option value=${o.id}>${o.name}</option>`)}</select>`;
  const save = async () => { try { await api(isNew ? '/employees' : '/employees/' + emp.id, { method: isNew ? 'POST' : 'PUT', body: f }); toast(isNew ? 'Person added' : 'Saved'); onSaved(); } catch (e) { errToast(e); } };
  const del = async () => { if (!confirm(`Delete ${emp.name} and all their attendance records? Consider marking them inactive instead.`)) return; try { await api('/employees/' + emp.id, { method: 'DELETE' }); onSaved(); } catch (e) { errToast(e); } };
  return html`<${Modal} wide title=${isNew ? 'Add person' : emp.name} onClose=${onClose} footer=${html`${!isNew && user.role === 'admin' && html`<button class="btn danger" onClick=${del}>${Icon('trash')} Delete</button>`}<span class="spacer"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${save}>${isNew ? 'Add person' : 'Save changes'}</button>`}>
    <div class="row"><${Avatar} name=${f.name || '?'} photo=${f.photo} size="lg" /><label class="btn sm">${Icon('upload')} Photo<input type="file" accept="image/*" hidden onChange=${async (e) => e.target.files[0] && set({ ...f, photo: await readImage(e.target.files[0]) })} /></label>${f.photo && html`<button class="btn sm ghost" onClick=${() => set({ ...f, photo: '' })}>Remove</button>`}</div>
    <div class="grid grid-3">
      <${Field} label="Full name">${inp('name')}<//><${Field} label="Employee ID">${inp('code')}<//><${Field} label="Job title">${inp('title')}<//>
      <${Field} label="Email" help="Used to sign in with a password">${inp('email', { type: 'email' })}<//><${Field} label="Phone">${inp('phone')}<//><${Field} label="Joined">${inp('joined', { type: 'date' })}<//>
      <${Field} label="Department">${sel('department_id', org.departments)}<//><${Field} label="Home site">${sel('location_id', org.locations)}<//><${Field} label="Default shift">${sel('shift_id', org.shifts, 'No fixed shift')}<//>
      <${Field} label="Reports to">${sel('manager_id', people.filter((p) => p.role !== 'employee' && p.id !== emp.id))}<//>
      <${Field} label="Role"><select class="input" value=${f.role} onChange=${(e) => set({ ...f, role: e.target.value })}><option value="employee">Employee</option><option value="manager">Manager</option>${user.role === 'admin' && html`<option value="admin">Admin</option>`}</select><//>
      <${Field} label="Status"><label class="check" style=${{ height: 38 }}><input type="checkbox" checked=${f.active} onChange=${(e) => set({ ...f, active: e.target.checked })} /> Active</label><//>
      <${Field} label=${isNew ? 'Kiosk PIN' : 'New kiosk PIN'} help="4–8 digits">${inp('pin', { inputmode: 'numeric', maxlength: 8, placeholder: emp.has_pin ? 'Set' : '' })}<//>
      <${Field} label=${isNew ? 'Password' : 'New password'} help="Optional, 8+ characters">${inp('password', { type: 'password', placeholder: emp.has_password ? 'Set' : '' })}<//>
    </div><//>`;
}
function ImportPeople({ onClose, onDone }) {
  const [text, setText] = useState('code,name,email,title,department,location,shift,pin\nE900,Jane Doe,jane@example.com,Associate,Sales,Flagship Store,Evening,4821');
  const rows = parseCsv(text);
  return html`<${Modal} wide title="Import people" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${async () => { try { const r = await api('/employees/import', { method: 'POST', body: { rows } }); toast(`Imported ${r.added}${r.skipped ? `, skipped ${r.skipped}` : ''}`); onDone(); } catch (e) { errToast(e); } }}>Import ${rows.length} rows</button>`}>
    <p class="muted small">Columns: <span class="kbd">code</span> <span class="kbd">name</span> plus optional <span class="kbd">email</span> <span class="kbd">phone</span> <span class="kbd">title</span> <span class="kbd">department</span> <span class="kbd">location</span> <span class="kbd">shift</span> <span class="kbd">pin</span>. Departments are created if missing; locations and shifts are matched by name.</p>
    <label class="btn sm" style=${{ alignSelf: 'flex-start' }}>${Icon('upload')} Choose file<input type="file" accept=".csv" hidden onChange=${async (e) => e.target.files[0] && setText(await e.target.files[0].text())} /></label>
    <textarea class="input mono" style=${{ minHeight: 170, fontSize: 12.5 }} value=${text} onInput=${(e) => setText(e.target.value)}></textarea><//>`;
}

/* =================== Schedule (roster) =================== */
function weekStart(d) { const wd = weekday(d); return addDays(d, -((wd + 6) % 7)); }
function Schedule() {
  const [from, setFrom] = useState(weekStart(META.today));
  const [dept, setDept] = useState('');
  const org = useOrg();
  const { data, reload } = useAsync(() => api(`/roster?from=${from}${dept ? '&department=' + dept : ''}`), [from, dept]);
  const [pick, setPick] = useState(null);
  if (!data || !org.data) return html`<${Loading} />`;
  const assign = async (shift_id) => { try { await api('/roster', { method: 'PUT', body: { employee_id: pick.employee.id, dates: pick.all ? data.days : [pick.date], shift_id } }); setPick(null); reload(); } catch (e) { errToast(e); } };
  const copyPrev = async () => { try { const r = await api('/roster/copy-week', { method: 'POST', body: { from: addDays(from, -7), to: from } }); toast(`Copied ${r.copied} roster changes from last week`); reload(); } catch (e) { errToast(e); } };
  const counts = data.days.map((d, i) => { const by = {}; for (const e of data.employees) { const c = e.cells[i]; if (c.shift && !c.leave && !c.holiday) by[c.shift.name] = (by[c.shift.name] || 0) + 1; } return by; });
  return html`<div class="col gap-lg">
    <div class="row wrap"><div class="row gap-sm"><button class="btn icon" onClick=${() => setFrom(addDays(from, -7))}>${Icon('chevronLeft')}</button><b style=${{ minWidth: 200, textAlign: 'center' }}>${fmtDate(from, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(from, 6), { day: 'numeric', month: 'short', year: 'numeric' })}</b><button class="btn icon" onClick=${() => setFrom(addDays(from, 7))}>${Icon('chevronRight')}</button>
      <button class="btn sm ghost" onClick=${() => setFrom(weekStart(META.today))}>This week</button></div>
      <select class="input" style=${{ width: 200 }} value=${dept} onChange=${(e) => setDept(e.target.value)}><option value="">All departments</option>${org.data.departments.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>
      <span class="spacer"></span><button class="btn" onClick=${copyPrev}>${Icon('copy')} Copy last week's changes</button></div>
    <div class="row wrap small">${org.data.shifts.map((s) => html`<span class="shift-chip" style=${{ '--c': s.color, minWidth: 0, display: 'inline-block', padding: '3px 10px', cursor: 'default' }}>${s.name} ${s.start}–${s.end}</span>`)}<span class="faint">Dashed border = changed from default. Click a cell to change it.</span></div>
    <div class="card table-wrap" style=${{ maxHeight: 'calc(100vh - 250px)' }}><table class="roster"><thead><tr><th style=${{ textAlign: 'left', paddingLeft: 12, left: 0, zIndex: 2 }}>Person</th>
      ${data.days.map((d) => html`<th class=${d === META.today ? 'today' : ''}>${DOW[weekday(d)]}<br /><span style=${{ fontSize: 13, color: 'var(--ink)' }}>${+d.slice(8)}</span></th>`)}</tr></thead><tbody>
      ${data.employees.map((e) => html`<tr><td class="who"><div class="row"><${Person} name=${e.name} sub=${e.department} photo=${e.photo} /><span class="spacer"></span><button class="btn sm ghost icon" title="Set whole week" onClick=${() => setPick({ employee: e, all: true })}>${Icon('layers')}</button></div></td>
        ${e.cells.map((c) => html`<td>${c.leave ? html`<span class="shift-chip" style=${{ '--c': c.leave.color }}>${c.leave.type}</span>` : c.holiday ? html`<span class="shift-chip off">${c.holiday}</span>`
          : html`<span class=${'shift-chip' + (c.shift ? '' : ' off') + (c.override ? ' ovr' : '')} style=${c.shift ? { '--c': c.shift.color } : {}} onClick=${() => setPick({ employee: e, date: c.date })}>${c.shift ? html`${c.shift.name}<small>${c.shift.start}–${c.shift.end}</small>` : html`Off<small>—</small>`}</span>`}</td>`)}</tr>`)}
      <tr><td class="who faint small">Scheduled</td>${counts.map((by) => html`<td class="small muted">${Object.entries(by).map(([k, v]) => html`<div>${v} ${k}</div>`)}</td>`)}</tr>
    </tbody></table></div>
    ${pick && html`<${Modal} title=${`${pick.employee.name} · ${pick.all ? 'whole week' : fmtDate(pick.date, { weekday: 'long', day: 'numeric', month: 'short' })}`} onClose=${() => setPick(null)}>
      <div class="grid grid-2">${org.data.shifts.map((s) => html`<button class="btn lg" style=${{ justifyContent: 'flex-start', borderColor: s.color }} onClick=${() => assign(s.id)}><i class="dot" style=${{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' }}></i>${s.name} <span class="faint small">${s.start}–${s.end}</span></button>`)}
        <button class="btn lg" onClick=${() => assign(null)}>Day off</button><button class="btn lg ghost" onClick=${() => assign('default')}>${Icon('refresh')} Reset to default</button></div><//>`}
  </div>`;
}

/* =================== Timesheets =================== */
function presets() { const t = META.today; return { today: [t, t], week: [weekStart(t), t], last7: [addDays(t, -6), t], month: [t.slice(0, 8) + '01', t], lastMonth: (() => { const end = addDays(t.slice(0, 8) + '01', -1); return [end.slice(0, 8) + '01', end]; })() }; }
function RangePicker({ from, to, onChange }) {
  const p = presets();
  return html`<div class="row wrap"><div class="seg">${[['today', 'Today'], ['week', 'This week'], ['last7', '7 days'], ['month', 'This month'], ['lastMonth', 'Last month']].map(([k, l]) => html`<button class=${p[k][0] === from && p[k][1] === to ? 'on' : ''} onClick=${() => onChange(...p[k])}>${l}</button>`)}</div>
    <input type="date" class="input sm" style=${{ width: 150 }} value=${from} onChange=${(e) => onChange(e.target.value, to)} /><span class="faint">to</span><input type="date" class="input sm" style=${{ width: 150 }} value=${to} onChange=${(e) => onChange(from, e.target.value)} /></div>`;
}
function Timesheets() {
  const [[from, to], setRange] = useState(presets().last7);
  const [flt, setFlt] = useState({ employee: '', department: '', location: '', status: '' });
  const org = useOrg(); const people = useAsync(() => api('/employees'));
  const qs = `from=${from}&to=${to}${flt.employee ? '&employee=' + flt.employee : ''}${flt.department ? '&department=' + flt.department : ''}${flt.location ? '&location=' + flt.location : ''}`;
  const { data, reload } = useAsync(() => api('/timesheets?' + qs), [qs]);
  const [day, setDay] = useState(null);
  const rows = (data?.rows || []).filter((r) => !flt.status || r.status === flt.status || (flt.status === 'late' && r.late) || (flt.status === 'fence' && r.outside_fence)).sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const sel = (k, opts, label) => html`<select class="input sm" style=${{ width: 170 }} value=${flt[k]} onChange=${(e) => setFlt({ ...flt, [k]: e.target.value })}><option value="">${label}</option>${opts.map((o) => html`<option value=${o.id}>${o.name}</option>`)}</select>`;
  return html`<div class="col gap-lg">
    <div class="row wrap"><${RangePicker} from=${from} to=${to} onChange=${(a, b) => setRange([a, b])} /></div>
    <div class="row wrap">${sel('employee', people.data || [], 'All people')}${sel('department', org.data?.departments || [], 'All departments')}${sel('location', org.data?.locations || [], 'All sites')}
      <select class="input sm" style=${{ width: 170 }} value=${flt.status} onChange=${(e) => setFlt({ ...flt, status: e.target.value })}><option value="">Any status</option>${Object.entries(STATUS).filter(([k]) => k !== 'off').map(([k, [, l]]) => html`<option value=${k}>${l}</option>`)}<option value="fence">Outside geofence</option></select>
      <span class="spacer"></span><button class="btn" onClick=${() => download('/reports/timesheet.csv?' + qs)}>${Icon('download')} Export CSV</button></div>
    <div class="grid grid-4"><${Stat} label="Worked hours" value=${hours(rows.reduce((a, b) => a + b.worked_min, 0))} /><${Stat} label="Overtime hours" value=${hours(rows.reduce((a, b) => a + b.overtime_min, 0))} />
      <${Stat} label="Late arrivals" value=${rows.filter((r) => r.late).length} color="#f59e0b" /><${Stat} label="Missing clock-outs" value=${rows.filter((r) => r.missing_out).length} color="var(--violet)" /></div>
    <div class="card table-wrap">${!data ? html`<${Loading} />` : html`<table class="table"><thead><tr><th>Date</th><th>Person</th><th>Shift</th><th>In</th><th>Out</th><th class="num">Worked</th><th class="num">Late</th><th class="num">OT</th><th>Status</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr style=${{ cursor: 'pointer' }} onClick=${() => setDay(r)}><td class="nowrap">${fmtDate(r.date)}</td><td><${Person} name=${r.name} sub=${r.department} photo=${r.photo} /></td>
        <td class="small">${r.shift ? html`<span style=${{ color: r.shift.color, fontWeight: 650 }}>${r.shift.name}</span> <span class="faint">${r.shift.start}–${r.shift.end}</span>` : r.leave ? html`<span style=${{ color: r.leave.color }}>${r.leave.type}</span>` : '—'}</td>
        <td class="nowrap">${T(r.first_in)} ${r.outside_fence ? html`<span title="Outside geofence" style=${{ color: 'var(--warn)' }}>${Icon('map', { width: 13, height: 13 })}</span>` : ''}</td><td class="nowrap">${r.open ? html`<span class="faint">now</span>` : T(r.last_out)}</td>
        <td class="num"><b>${r.worked_min ? dur(r.worked_min) : '—'}</b></td><td class="num">${r.late_min ? html`<span style=${{ color: 'var(--warn)' }}>${dur(r.late_min)}</span>` : '—'}</td><td class="num">${r.overtime_min ? dur(r.overtime_min) : '—'}</td><td><${StatusBadge} s=${r.status} /></td></tr>`)}</tbody></table>
      ${!rows.length && html`<${Empty} icon="clock" title="No attendance in this range" />`}`}</div>
    ${day && html`<${DayDetail} row=${day} onClose=${() => setDay(null)} onChanged=${reload} />`}</div>`;
}
function DayDetail({ row, onClose, onChanged }) {
  const { data, reload } = useAsync(() => api(`/punches?employee=${row.employee_id}&date=${row.date}`));
  const [add, setAdd] = useState(null); const [photo, setPhoto] = useState(null);
  const changed = () => { reload(); onChanged(); };
  const call = async (p, o, msg) => { try { await api(p, o); toast(msg); changed(); } catch (e) { errToast(e); } };
  return html`<${Modal} wide title=${`${row.name} · ${fmtDate(row.date, { weekday: 'long', day: 'numeric', month: 'long' })}`} onClose=${onClose}>
    <div class="grid grid-4"><${Stat} label="Shift" value=${row.shift ? row.shift.name : '—'} hint=${row.shift ? `${row.shift.start}–${row.shift.end}` : ''} /><${Stat} label="Worked" value=${dur(row.worked_min)} hint=${`${dur(row.break_min)} break`} /><${Stat} label="Late" value=${row.late_min ? dur(row.late_min) : '—'} /><${Stat} label="Overtime" value=${row.overtime_min ? dur(row.overtime_min) : '—'} /></div>
    <div class="card table-wrap">${!data ? html`<${Loading} />` : html`<table class="table"><thead><tr><th>Type</th><th>Time</th><th>Source</th><th>Location</th><th></th></tr></thead><tbody>
      ${data.map((p) => html`<${PunchRow} key=${p.id + ':' + p.ts + p.type} p=${p} date=${row.date} onSave=${(type, time) => call('/punches/' + p.id, { method: 'PUT', body: { type, date: row.date, time } }, 'Punch updated')} onDelete=${() => confirm('Delete this punch?') && call('/punches/' + p.id, { method: 'DELETE' }, 'Punch deleted')} onPhoto=${setPhoto} />`)}
    </tbody></table>${!data.length && html`<${Empty} icon="clock" title="No punches" />`}`}</div>
    ${add ? html`<div class="row wrap card card-pad"><select class="input sm" style=${{ width: 140 }} value=${add.type} onChange=${(e) => setAdd({ ...add, type: e.target.value })}>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select>
      <input type="time" class="input sm" style=${{ width: 120 }} value=${add.time} onInput=${(e) => setAdd({ ...add, time: e.target.value })} /><input class="input sm" style=${{ flex: 1, minWidth: 160 }} placeholder="Reason (audit log)" value=${add.note} onInput=${(e) => setAdd({ ...add, note: e.target.value })} />
      <button class="btn sm" onClick=${() => setAdd(null)}>Cancel</button><button class="btn sm primary" onClick=${() => { call('/punches', { method: 'POST', body: { employee_id: row.employee_id, date: row.date, ...add } }, 'Punch added'); setAdd(null); }}>Add</button></div>`
    : html`<button class="btn" style=${{ alignSelf: 'flex-start' }} onClick=${() => setAdd({ type: row.first_in ? 'out' : 'in', time: row.first_in ? (row.shift?.end || '18:00') : (row.shift?.start || '09:00'), note: '' })}>${Icon('plus')} Add missing punch</button>`}
    ${photo && html`<${Modal} title="Punch photo" onClose=${() => setPhoto(null)}><img src=${photo} style=${{ width: '100%', borderRadius: 12 }} alt="" /><//>`}<//>`;
}
function PunchRow({ p, onSave, onDelete, onPhoto }) {
  const initial = hhmm(localMinutes(p.ts, META.timezone));
  const [type, setType] = useState(p.type); const [time, setTime] = useState(initial);
  return html`<tr><td><select class="input sm" style=${{ width: 130 }} value=${type} onChange=${(e) => setType(e.target.value)}>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></td>
    <td><input type="time" class="input sm" style=${{ width: 110 }} value=${time} onInput=${(e) => setTime(e.target.value)} /></td>
    <td><span class="badge">${p.source}</span>${p.device && html` <span class="faint small">${p.device}</span>`}${p.edited_by && html` <span class="badge violet" title=${'By ' + p.edited_by}>edited</span>`}${p.note && html`<div class="faint small">${p.note}</div>`}</td>
    <td class="small">${p.location || '—'} ${p.in_fence === 0 ? html`<span class="badge warn">${distLabel(p.distance_m)} away</span>` : p.in_fence === 1 ? html`<span class="badge ok">in fence</span>` : ''}
      ${p.lat != null && html` <a target="_blank" rel="noopener" href=${`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`}>map</a>`} ${p.photo && html`<img class="photo-thumb" src=${p.photo} onClick=${() => onPhoto(p.photo)} alt="" />`}</td>
    <td class="right nowrap">${(type !== p.type || time !== initial) && html`<button class="btn sm primary" onClick=${() => onSave(type, time)}>Save</button> `}<button class="btn sm ghost icon" onClick=${onDelete}>${Icon('trash')}</button></td></tr>`;
}

/* =================== Leave & corrections =================== */
function Leave() {
  const [tab, setTab] = useState('pending');
  const { data, reload } = useAsync(() => api('/leave' + (tab === 'all' ? '' : '?status=' + tab)), [tab]);
  const [add, setAdd] = useState(false);
  const decide = async (x, status) => { const note = status === 'rejected' ? prompt('Reason for rejecting (optional)') ?? '' : ''; try { await api(`/leave/${x.id}/decide`, { method: 'POST', body: { status, note } }); toast(`Leave ${status}`); reload(); } catch (e) { errToast(e); } };
  return html`<div class="col gap-lg">
    <div class="row"><div class="seg">${[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div><span class="spacer"></span><button class="btn primary" onClick=${() => setAdd(true)}>${Icon('plus')} Record leave</button></div>
    <div class="card table-wrap">${!data ? html`<${Loading} />` : html`<table class="table"><thead><tr><th>Person</th><th>Type</th><th>Dates</th><th class="num">Days</th><th>Balance</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
      ${data.map((x) => html`<tr><td><${Person} name=${x.name} sub=${x.department} photo=${x.photo} /></td><td><span class="badge" style=${{ color: x.color }}><i class="dot"></i>${x.type}</span></td>
        <td class="nowrap small">${fmtDate(x.date_from, { day: 'numeric', month: 'short' })}${x.date_to !== x.date_from ? ' – ' + fmtDate(x.date_to, { day: 'numeric', month: 'short' }) : ''}</td><td class="num">${x.days}</td>
        <td class="small muted">${x.balance?.quota ? `${x.balance.remaining} of ${x.balance.quota} left` : '—'}</td><td class="small" style=${{ maxWidth: 220 }}>${x.reason || ''}${x.decision_note ? html`<div class="faint">Note: ${x.decision_note}</div>` : ''}</td>
        <td><${ReqBadge} s=${x.status} /></td><td class="right nowrap">${x.status === 'pending' && html`<button class="btn sm" onClick=${() => decide(x, 'rejected')}>Reject</button> <button class="btn sm primary" onClick=${() => decide(x, 'approved')}>Approve</button>`}</td></tr>`)}</tbody></table>
      ${!data.length && html`<${Empty} icon="plane" title=${tab === 'pending' ? 'No leave requests waiting' : 'Nothing here'} />`}`}</div>
    ${add && html`<${RecordLeave} onClose=${() => setAdd(false)} onDone=${() => { setAdd(false); reload(); }} />`}</div>`;
}
function RecordLeave({ onClose, onDone }) {
  const people = useAsync(() => api('/employees')); const types = useAsync(() => api('/leave-types'));
  const [f, set] = useState({ employee_id: '', type_id: '', date_from: META.today, date_to: META.today, reason: '' });
  return html`<${Modal} title="Record approved leave" onClose=${onClose} footer=${html`<button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${async () => { try { await api('/leave', { method: 'POST', body: f }); toast('Leave recorded'); onDone(); } catch (e) { errToast(e); } }}>Save</button>`}>
    <${Field} label="Person"><select class="input" value=${f.employee_id} onChange=${(e) => set({ ...f, employee_id: e.target.value })}><option value="">Choose…</option>${(people.data || []).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>
    <${Field} label="Type"><select class="input" value=${f.type_id} onChange=${(e) => set({ ...f, type_id: e.target.value })}><option value="">Choose…</option>${(types.data || []).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>
    <div class="grid grid-2"><${Field} label="From"><input type="date" class="input" value=${f.date_from} onInput=${(e) => set({ ...f, date_from: e.target.value })} /><//><${Field} label="To"><input type="date" class="input" value=${f.date_to} onInput=${(e) => set({ ...f, date_to: e.target.value })} /><//></div>
    <${Field} label="Reason"><input class="input" value=${f.reason} onInput=${(e) => set({ ...f, reason: e.target.value })} /><//><//>`;
}
function Corrections() {
  const { data, reload } = useAsync(() => api('/corrections'));
  const decide = async (x, status) => { try { await api(`/corrections/${x.id}/decide`, { method: 'POST', body: { status } }); toast(status === 'approved' ? 'Approved — punch added to the timesheet' : 'Rejected'); reload(); } catch (e) { errToast(e); } };
  if (!data) return html`<${Loading} />`;
  return html`<div class="col gap-lg"><p class="muted">Employees ask for a missed or wrong punch to be fixed. Approving adds the punch to their timesheet and records it in the audit log.</p>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Person</th><th>Date</th><th>Requested punch</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
    ${data.map((x) => html`<tr><td><${Person} name=${x.name} sub=${x.code} photo=${x.photo} /></td><td class="nowrap">${fmtDate(x.date)}</td><td><b>${ACTION_LABEL[x.type]}</b> at ${x.time}</td><td class="small">${x.reason}</td><td><${ReqBadge} s=${x.status} /></td>
      <td class="right nowrap">${x.status === 'pending' && html`<button class="btn sm" onClick=${() => decide(x, 'rejected')}>Reject</button> <button class="btn sm primary" onClick=${() => decide(x, 'approved')}>Approve</button>`}</td></tr>`)}</tbody></table>
    ${!data.length && html`<${Empty} icon="inbox" title="No correction requests" />`}</div></div>`;
}

/* =================== Reports =================== */
function Reports() {
  const [[from, to], setRange] = useState(presets().month);
  const [dept, setDept] = useState(''); const org = useOrg();
  const q = `from=${from}&to=${to}${dept ? '&department=' + dept : ''}`;
  const { data } = useAsync(() => api('/reports/summary?' + q), [q]);
  const [sort, setSort] = useState('name');
  const head = html`<div class="row wrap no-print"><${RangePicker} from=${from} to=${to} onChange=${(a, b) => setRange([a, b])} />
    <select class="input sm" style=${{ width: 180 }} value=${dept} onChange=${(e) => setDept(e.target.value)}><option value="">All departments</option>${(org.data?.departments || []).map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select><span class="spacer"></span>
    <button class="btn" onClick=${() => print()}>${Icon('print')} Print</button><button class="btn" onClick=${() => download('/reports/payroll.csv?' + q)}>${Icon('file')} Payroll export</button><button class="btn primary" onClick=${() => download('/reports/summary?' + q + '&format=csv')}>${Icon('download')} Summary CSV</button></div>`;
  if (!data) return html`<div class="col gap-lg">${head}<${Loading} /></div>`;
  const s = data.summary;
  const tot = s.reduce((a, b) => ({ exp: a.exp + b.expected, pres: a.pres + b.present, late: a.late + b.late, abs: a.abs + b.absent, lv: a.lv + b.leave, w: a.w + b.worked_min, ot: a.ot + b.overtime_min }), { exp: 0, pres: 0, late: 0, abs: 0, lv: 0, w: 0, ot: 0 });
  const sorted = [...s].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'rate' ? (a.attendance_rate ?? 2) - (b.attendance_rate ?? 2) : sort === 'late' ? b.late - a.late : b.overtime_min - a.overtime_min);
  const chart = data.daily.filter((d) => d.expected).map((d) => ({ label: String(+d.date.slice(8)), values: [{ name: 'On time', v: d.present - d.late, color: 'var(--accent)' }, { name: 'Late', v: d.late, color: '#f59e0b' }, { name: 'Leave', v: d.leave, color: '#a78bfa' }, { name: 'Absent', v: d.absent, color: '#ef4444' }] }));
  const heatColor = (v) => v == null ? 'var(--bg-sunk)' : `color-mix(in srgb, var(--accent) ${Math.round(15 + v * 75)}%, var(--bg-elev))`;
  const mixColors = { present: 'var(--accent)', late: '#f59e0b', absent: '#ef4444', leave: '#a78bfa', missing_out: '#ec4899', holiday: '#94a3b8' };
  return html`<div class="col gap-lg">${head}
    <h2>Attendance report · ${fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}</h2>
    <div class="grid grid-4"><${Stat} label="Attendance rate" value=${tot.exp ? Math.round((tot.pres / tot.exp) * 100) + '%' : '—'} hint=${`${tot.pres} of ${tot.exp} scheduled shifts`} color="var(--accent)" />
      <${Stat} label="Punctuality" value=${tot.pres ? Math.round((1 - tot.late / tot.pres) * 100) + '%' : '—'} hint=${`${tot.late} late arrivals`} color="#f59e0b" />
      <${Stat} label="Hours worked" value=${hours(tot.w)} hint=${`${hours(tot.ot)} h overtime`} /><${Stat} label="Absences / leave" value=${`${tot.abs} / ${tot.lv}`} color="#ef4444" /></div>
    <div class="grid" style=${{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)' }}>
      <div class="card"><div class="card-head"><h3>Daily attendance</h3></div><div class="card-pad"><${BarChart} stacked data=${chart} height=${200} /></div></div>
      <div class="card"><div class="card-head"><h3>Status mix</h3></div><div class="card-pad"><${Donut} data=${data.statusMix.filter((x) => x.n).map((x) => ({ label: STATUS[x.status]?.[1] || x.status, value: x.n, color: mixColors[x.status] }))} /></div></div></div>
    <div class="card"><div class="card-head"><h3>Attendance heatmap · department × weekday</h3></div><div class="card-pad table-wrap"><table class="heat"><thead><tr><th></th>${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<th class="small faint">${DOW[d]}</th>`)}</tr></thead><tbody>
      ${data.heat.map((d) => html`<tr><th class="small" style=${{ textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap', paddingRight: 10 }}>${d.name}</th>${[1, 2, 3, 4, 5, 6, 0].map((wd) => html`<td style=${{ background: heatColor(d.days[wd]), color: d.days[wd] > 0.6 ? '#fff' : 'var(--ink-2)' }}>${d.days[wd] == null ? '' : Math.round(d.days[wd] * 100) + '%'}</td>`)}</tr>`)}</tbody></table></div></div>
    <div class="card table-wrap"><div class="card-head"><h3>By person</h3><span class="spacer"></span><div class="seg no-print">${[['name', 'Name'], ['rate', 'Lowest attendance'], ['late', 'Most late'], ['ot', 'Most overtime']].map(([k, l]) => html`<button class=${sort === k ? 'on' : ''} onClick=${() => setSort(k)}>${l}</button>`)}</div></div>
      <table class="table"><thead><tr><th>Person</th><th class="num">Present</th><th class="num">Absent</th><th class="num">Leave</th><th class="num">Late</th><th class="num">Avg in</th><th class="num">Hours</th><th class="num">OT</th><th style=${{ width: 170 }}>Attendance</th></tr></thead><tbody>
      ${sorted.map((x) => html`<tr><td><${Person} name=${x.name} sub=${[x.code, x.department].filter(Boolean).join(' · ')} photo=${x.photo} /></td><td class="num">${x.present}/${x.expected}</td><td class="num">${x.absent || '—'}</td><td class="num">${x.leave || '—'}</td><td class="num">${x.late || '—'}</td><td class="num">${hhmm(x.avg_in_min) || '—'}</td><td class="num"><b>${hours(x.worked_min)}</b></td><td class="num">${x.overtime_min ? hours(x.overtime_min) : '—'}</td>
        <td><div class="row"><div class="bar" style=${{ flex: 1 }}><i style=${{ width: Math.round((x.attendance_rate ?? 0) * 100) + '%', background: (x.attendance_rate ?? 1) < 0.85 ? 'var(--warn)' : 'var(--accent)' }}></i></div><b class="small" style=${{ width: 38, textAlign: 'right' }}>${x.attendance_rate == null ? '—' : Math.round(x.attendance_rate * 100) + '%'}</b></div></td></tr>`)}</tbody></table></div></div>`;
}

/* =================== Settings =================== */
const TZS = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Dubai']; } })();
const ACCENTS = ['#5b5bd6', '#2563eb', '#0d9488', '#16a34a', '#ea580c', '#db2777', '#111827', '#b45309'];
function Settings() {
  const [tab, setTab] = useState('company');
  const tabs = [['company', 'Company'], ['locations', 'Sites & geofences'], ['departments', 'Departments'], ['shifts', 'Shifts'], ['leave', 'Leave types'], ['holidays', 'Holidays'], ['devices', 'Kiosk devices'], ['api', 'API & webhooks'], ['audit', 'Audit log']];
  return html`<div style=${{ maxWidth: 980 }}><div class="tabs">${tabs.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'company' && html`<${CompanySettings} />`}
    ${tab === 'locations' && html`<${OrgTable} path="/locations" title="site" cols=${[['name', 'Name'], ['address', 'Address'], ['lat', 'Latitude', 'number'], ['lng', 'Longitude', 'number'], ['radius_m', 'Geofence radius (m)', 'number']]} help="Phone punches are checked against the nearest site. Set the radius generously; GPS can drift 20–50 m indoors." geo />`}
    ${tab === 'departments' && html`<${OrgTable} path="/departments" title="department" cols=${[['name', 'Name'], ['color', 'Colour', 'color']]} />`}
    ${tab === 'shifts' && html`<${OrgTable} path="/shifts" title="shift" cols=${[['name', 'Name'], ['start', 'Starts', 'time'], ['end', 'Ends', 'time'], ['break_min', 'Unpaid break (min)', 'number'], ['grace_min', 'Grace (min)', 'number'], ['days', 'Days (0=Sun … 6=Sat)'], ['color', 'Colour', 'color']]} help="Shifts that end before they start (e.g. 22:00–06:00) are night shifts; punches before the day cut-off count toward the previous day." />`}
    ${tab === 'leave' && html`<${OrgTable} path="/leave-types" title="leave type" cols=${[['name', 'Name'], ['quota_days', 'Days per year', 'number'], ['paid', 'Paid (1/0)', 'number'], ['color', 'Colour', 'color']]} />`}
    ${tab === 'holidays' && html`<${Holidays} />`}${tab === 'devices' && html`<${Devices} />`}${tab === 'api' && html`<${Integrations} />`}${tab === 'audit' && html`<${Audit} />`}</div>`;
}
function CompanySettings() {
  const { data, reload } = useAsync(() => api('/settings'));
  const [f, set] = useState(null);
  useEffect(() => { if (data) set(data); }, [data]);
  if (!f) return html`<${Loading} />`;
  const save = async () => { try { await api('/settings', { method: 'PUT', body: f }); toast('Saved'); reload(); META = await api('/meta'); applyBrand(META); } catch (e) { errToast(e); } };
  const sw = (k, l, h) => html`<label class="check"><input type="checkbox" checked=${f[k] === '1'} onChange=${(e) => set({ ...f, [k]: e.target.checked ? '1' : '0' })} /><span><b>${l}</b><div class="faint small">${h}</div></span></label>`;
  return html`<div class="col gap-lg"><div class="card card-pad col gap-lg"><div class="grid grid-2">
      <${Field} label="Company name"><input class="input" value=${f.company_name} onInput=${(e) => set({ ...f, company_name: e.target.value })} /><//>
      <${Field} label="Timezone"><select class="input" value=${f.timezone} onChange=${(e) => set({ ...f, timezone: e.target.value })}>${TZS.map((z) => html`<option value=${z}>${z}</option>`)}</select><//>
      <${Field} label="Day cut-off" help="Punches before this time belong to the previous day (night shifts)"><input type="time" class="input" value=${f.day_cutoff} onInput=${(e) => set({ ...f, day_cutoff: e.target.value })} /><//>
      <${Field} label="Overtime starts after (min beyond shift)"><input type="number" class="input" value=${f.overtime_after_min} onInput=${(e) => set({ ...f, overtime_after_min: e.target.value })} /><//></div>
    ${sw('allow_web_clock', 'Allow clock-in from phones and browsers', 'Employees sign in and clock in from their own device.')}
    ${sw('enforce_geofence', 'Enforce geofences', 'Phone punches must be inside a site radius. Kiosk and desktop punches are always allowed.')}
    ${sw('require_photo', 'Require a photo on clock-in/out', 'Selfie on phones and kiosks to deter buddy punching.')}</div>
    <div class="card card-pad col gap-lg"><h3>Branding</h3>
      <div class="row"><div class="logo-preview"><img src=${f.logo || META.logo} alt="" /></div><label class="btn">${Icon('upload')} Upload logo<input type="file" accept="image/*" hidden onChange=${async (e) => e.target.files[0] && set({ ...f, logo: await readImage(e.target.files[0], 400) })} /></label>${f.logo && html`<button class="btn ghost" onClick=${() => set({ ...f, logo: '' })}>Use default</button>`}</div>
      <div class="row wrap">${ACCENTS.map((c) => html`<span class=${'color-swatch' + (f.accent === c ? ' on' : '')} style=${{ background: c }} onClick=${() => set({ ...f, accent: c })}></span>`)}<input class="input sm mono" style=${{ width: 110 }} placeholder="#hex" value=${f.accent} onInput=${(e) => set({ ...f, accent: e.target.value })} /></div></div>
    <div><button class="btn primary" onClick=${save}>Save settings</button></div></div>`;
}
function OrgTable({ path, title, cols, help, geo }) {
  const { data, reload } = useAsync(() => api(path));
  const [edit, setEdit] = useState(null);
  const save = async () => { try { await api(edit.id ? `${path}/${edit.id}` : path, { method: edit.id ? 'PUT' : 'POST', body: edit }); setEdit(null); reload(); toast('Saved'); } catch (e) { errToast(e); } };
  const del = async (x) => { if (!confirm(`Delete ${x.name}?`)) return; try { await api(`${path}/${x.id}`, { method: 'DELETE' }); reload(); } catch (e) { errToast(e); } };
  const here = async () => { const l = await getLocation(); if (!l) return errToast('Location unavailable'); setEdit({ ...edit, lat: +l.lat.toFixed(6), lng: +l.lng.toFixed(6) }); };
  if (!data) return html`<${Loading} />`;
  return html`<div class="col gap-lg">${help && html`<p class="muted small">${help}</p>`}
    <div class="card table-wrap"><table class="table"><thead><tr>${cols.map(([, l]) => html`<th>${l}</th>`)}<th></th></tr></thead><tbody>
      ${data.map((x) => html`<tr>${cols.map(([k, , t]) => html`<td>${t === 'color' ? html`<span class="color-swatch" style=${{ background: x[k], width: 20, height: 20, display: 'inline-block' }}></span>` : x[k] ?? '—'}</td>`)}
        <td class="right nowrap">${geo && x.lat != null && html`<a class="btn sm ghost" target="_blank" rel="noopener" href=${`https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lng}#map=16/${x.lat}/${x.lng}`}>${Icon('map')}</a>`}<button class="btn sm" onClick=${() => setEdit(x)}>${Icon('edit')}</button><button class="btn sm ghost" onClick=${() => del(x)}>${Icon('trash')}</button></td></tr>`)}</tbody></table>
      ${!data.length && html`<${Empty} title=${`No ${title}s yet`} />`}</div>
    <div><button class="btn primary" onClick=${() => setEdit({})}>${Icon('plus')} Add ${title}</button></div>
    ${edit && html`<${Modal} title=${(edit.id ? 'Edit ' : 'Add ') + title} onClose=${() => setEdit(null)} footer=${html`<button class="btn" onClick=${() => setEdit(null)}>Cancel</button><button class="btn primary" onClick=${save}>Save</button>`}>
      <div class="grid grid-2">${cols.map(([k, l, t]) => html`<${Field} label=${l}><input class="input" type=${t || 'text'} step=${t === 'number' ? 'any' : undefined} value=${edit[k] ?? (t === 'color' ? '#6366f1' : '')} onInput=${(e) => setEdit({ ...edit, [k]: t === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} /><//>`)}</div>
      ${geo && html`<button class="btn" onClick=${here}>${Icon('map')} Use my current location</button>`}<//>`}</div>`;
}
function Holidays() {
  const { data, reload } = useAsync(() => api('/holidays'));
  const [f, set] = useState({ date: META.today, name: '' });
  return html`<div class="col gap-lg"><div class="card card-pad row wrap"><input type="date" class="input" style=${{ width: 160 }} value=${f.date} onInput=${(e) => set({ ...f, date: e.target.value })} /><input class="input" style=${{ width: 260 }} placeholder="Holiday name" value=${f.name} onInput=${(e) => set({ ...f, name: e.target.value })} />
    <button class="btn primary" onClick=${async () => { try { await api('/holidays', { method: 'POST', body: f }); set({ ...f, name: '' }); reload(); } catch (e) { errToast(e); } }}>${Icon('plus')} Add holiday</button></div>
    <div class="card table-wrap"><table class="table"><tbody>${(data || []).map((h) => html`<tr><td>${fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</td><td><b>${h.name}</b></td><td class="right"><button class="btn sm ghost" onClick=${async () => { await api('/holidays/' + h.date, { method: 'DELETE' }); reload(); }}>${Icon('trash')}</button></td></tr>`)}</tbody></table></div></div>`;
}
function Devices() {
  const { data, reload } = useAsync(() => api('/devices')); const org = useOrg();
  const [f, set] = useState({ name: 'Front entrance', location_id: '' }); const [token, setToken] = useState(null);
  const create = async (useHere) => { try { const r = await api('/devices', { method: 'POST', body: f }); if (useHere) { localStorage.setItem('rm_device', r.token); toast('This browser is now a kiosk'); window.open('/kiosk', '_blank'); } else setToken(r.token); reload(); } catch (e) { errToast(e); } };
  return html`<div class="col gap-lg"><p class="muted">Kiosks are shared tablets or PCs at a site. Each one gets its own key, so you can revoke a lost device without affecting the others.</p>
    <div class="card card-pad col"><div class="grid grid-2"><${Field} label="Device name"><input class="input" value=${f.name} onInput=${(e) => set({ ...f, name: e.target.value })} /><//>
      <${Field} label="Site"><select class="input" value=${f.location_id} onChange=${(e) => set({ ...f, location_id: e.target.value })}><option value="">Any site</option>${(org.data?.locations || []).map((l) => html`<option value=${l.id}>${l.name}</option>`)}</select><//></div>
      <div class="row wrap"><button class="btn primary" onClick=${() => create(true)}>${Icon('monitor')} Use this browser as the kiosk</button><button class="btn" onClick=${() => create(false)}>${Icon('key')} Create pairing key</button></div>
      ${token && html`<div class="col gap-sm"><span class="small muted">Open <b>${location.origin}/kiosk</b> on the device and paste this key. It's shown once.</span><div class="secret">${token}</div></div>`}</div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Device</th><th>Site</th><th>Last seen</th><th>Status</th><th></th></tr></thead><tbody>
      ${(data || []).map((d) => html`<tr><td><b>${d.name}</b></td><td>${d.location || 'Any'}</td><td class="small muted">${d.last_seen ? fmtDateTime(d.last_seen, META.timezone) : 'Never'}</td><td>${d.revoked ? html`<span class="badge bad">Revoked</span>` : html`<span class="badge ok">Active</span>`}</td>
        <td class="right">${!d.revoked && html`<button class="btn sm danger" onClick=${async () => { if (confirm('Revoke this kiosk?')) { await api('/devices/' + d.id, { method: 'DELETE' }); reload(); } }}>Revoke</button>`}</td></tr>`)}</tbody></table></div></div>`;
}
function Integrations() {
  const keys = useAsync(() => api('/api-keys')); const hooks = useAsync(() => api('/webhooks'));
  const [k, setK] = useState({ name: 'Payroll sync', scopes: 'read' }); const [w, setW] = useState({ url: '', events: '*' }); const [shown, setShown] = useState(null);
  return html`<div class="col gap-lg">
    <div class="card card-pad col"><h3>API keys</h3><p class="muted small">Use <span class="kbd">Authorization: Bearer rk_…</span> with <span class="kbd">GET /api/v1/employees</span>, <span class="kbd">GET /api/v1/attendance?from=&to=</span>, <span class="kbd">GET /api/v1/punches?since=</span> and (write keys) <span class="kbd">POST /api/v1/punches</span>.</p>
      <div class="row wrap"><input class="input" style=${{ width: 220 }} value=${k.name} onInput=${(e) => setK({ ...k, name: e.target.value })} /><select class="input" style=${{ width: 140 }} value=${k.scopes} onChange=${(e) => setK({ ...k, scopes: e.target.value })}><option value="read">Read only</option><option value="write">Read & write</option></select>
        <button class="btn primary" onClick=${async () => { try { const r = await api('/api-keys', { method: 'POST', body: k }); setShown({ label: 'API key', value: r.key }); keys.reload(); } catch (e) { errToast(e); } }}>${Icon('key')} Create key</button></div>
      <table class="table"><tbody>${(keys.data || []).map((x) => html`<tr><td><b>${x.name}</b></td><td class="mono small">${x.prefix}…</td><td><span class="badge">${x.scopes}</span></td><td class="small muted">${x.last_used ? 'Used ' + fmtDateTime(x.last_used, META.timezone) : 'Never used'}</td><td class="right">${x.revoked ? html`<span class="badge bad">Revoked</span>` : html`<button class="btn sm danger" onClick=${async () => { await api('/api-keys/' + x.id, { method: 'DELETE' }); keys.reload(); }}>Revoke</button>`}</td></tr>`)}</tbody></table></div>
    <div class="card card-pad col"><h3>Webhooks</h3><p class="muted small">Events: <span class="kbd">punch.created</span> <span class="kbd">leave.requested</span> <span class="kbd">leave.decided</span> <span class="kbd">correction.requested</span>. Each request carries <span class="kbd">X-Rostermark-Signature: sha256=HMAC(body, secret)</span>.</p>
      <div class="row wrap"><input class="input" style=${{ flex: 1, minWidth: 240 }} placeholder="https://example.com/hooks/attendance" value=${w.url} onInput=${(e) => setW({ ...w, url: e.target.value })} /><input class="input" style=${{ width: 220 }} value=${w.events} onInput=${(e) => setW({ ...w, events: e.target.value })} title="Comma-separated events or *" />
        <button class="btn primary" onClick=${async () => { try { const r = await api('/webhooks', { method: 'POST', body: w }); setShown({ label: 'Signing secret', value: r.secret }); hooks.reload(); } catch (e) { errToast(e); } }}>${Icon('webhook')} Add webhook</button></div>
      <table class="table"><tbody>${(hooks.data || []).map((x) => html`<tr><td class="mono small">${x.url}</td><td><span class="badge">${x.events}</span></td><td class="small muted">${x.last_status ? `${x.last_status} · ${fmtDateTime(x.last_at, META.timezone)}` : 'No deliveries yet'}</td><td class="right"><button class="btn sm ghost" onClick=${async () => { await api('/webhooks/' + x.id, { method: 'DELETE' }); hooks.reload(); }}>${Icon('trash')}</button></td></tr>`)}</tbody></table></div>
    ${shown && html`<${Modal} title=${shown.label} onClose=${() => setShown(null)}><p class="muted">Copy it now. It won't be shown again.</p><div class="secret">${shown.value}</div><button class="btn" onClick=${() => { navigator.clipboard?.writeText(shown.value); toast('Copied'); }}>${Icon('copy')} Copy</button><//>`}</div>`;
}
function Audit() {
  const { data } = useAsync(() => api('/audit'));
  if (!data) return html`<${Loading} />`;
  return html`<div class="card table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${data.map((a) => html`<tr><td class="nowrap small">${fmtDateTime(a.ts, META.timezone)}</td><td class="small">${a.actor}</td><td><span class="badge">${a.action}</span></td><td class="mono small faint" style=${{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${a.detail}</td></tr>`)}</tbody></table></div>`;
}

/* =================== Self service =================== */
function Me({ onLogout, user }) {
  const { data, error, reload } = useAsync(() => api('/me'));
  const now = useNow(1000);
  const [tab, setTab] = useState('clock'); const [busy, setBusy] = useState(false); const [cam, setCam] = useState(null); const [geo, setGeo] = useState(null);
  useInterval(reload, 60000);
  if (error) return html`<${Empty} icon="alert" title=${error.message} />`;
  if (!data) return html`<${Loading} />`;
  const act = async (type, photo) => {
    setBusy(true);
    try {
      const loc = await getLocation(); setGeo(loc);
      const r = await api('/clock', { method: 'POST', body: { type, photo, ...(loc || {}) } });
      toast(`${ACTION_DONE[r.type]} at ${T(r.ts)}${r.distance != null ? ` · ${distLabel(r.distance)} from site` : ''}`); reload();
    } catch (e) { errToast(e); } finally { setBusy(false); setCam(null); }
  };
  const start = (t) => META.requirePhoto && (t === 'in' || t === 'out') && !globalThis.rmDesktop ? setCam(t) : act(t);
  const st = data.state.state; const t = data.days[0]; const e = data.employee;
  return html`<div class="col gap-lg">
    ${!isStaff(user) && html`<div class="me-head"><${Avatar} name=${e.name} photo=${e.photo} size="lg" /><div><h2>Hi, ${e.name.split(' ')[0]}</h2><div class="muted small">${[e.title, e.department, e.location].filter(Boolean).join(' · ')}</div></div><span class="spacer"></span>
      <button class="btn ghost icon" onClick=${toggleTheme}>${Icon('moon')}</button><button class="btn ghost icon" onClick=${onLogout}>${Icon('logout')}</button></div>`}
    <div class="me-tabs">${[['clock', 'Clock'], ['schedule', 'Schedule'], ['history', 'Timesheet'], ['leave', 'Leave'], ['fix', 'Corrections']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'clock' && html`<div class="card" style=${{ maxWidth: 560 }}><div class="clock-card">
      <div class="time">${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: META.timezone })}</div>
      <div class="date">${new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', timeZone: META.timezone })}</div>
      <span class=${'status-pill ' + st}>${st === 'in' ? `Clocked in since ${T(data.state.since)}` : st === 'break' ? `On break since ${T(data.state.since)}` : 'You are clocked out'}</span>
      ${t?.shift && html`<div class="small muted" style=${{ marginTop: 8 }}>Today: <b style=${{ color: t.shift.color }}>${t.shift.name}</b> ${t.shift.start}–${t.shift.end}</div>`}
      ${cam ? html`<div style=${{ width: '100%', marginTop: 14 }}><${Camera} label=${ACTION_LABEL[cam]} onCancel=${() => setCam(null)} onCapture=${(p) => act(cam, p)} /></div>`
      : html`<div class="big-actions">${data.actions.map((a, i) => html`<button class=${'big-btn ' + (i ? 'secondary' : a)} disabled=${busy} onClick=${() => start(a)}>${Icon(ACTION_ICON[a])} ${busy && !i ? 'Checking location…' : ACTION_LABEL[a]}</button>`)}</div>`}
      ${data.site && html`<div class="geo-note muted">${Icon('map', { width: 14, height: 14 })} ${data.site.name} · ${data.site.radius_m} m geofence${geo ? ' · last fix ±' + Math.round(geo.accuracy) + ' m' : ''}</div>`}</div>
      <div class="today-grid"><div><b>${t?.first_in ? T(t.first_in) : '—'}</b><span>First in</span></div><div><b>${dur(t?.worked_min || 0)}</b><span>Worked today</span></div><div><b>${data.balances.find((b) => b.quota)?.remaining ?? '—'}</b><span>Annual leave left</span></div></div></div>`}
    ${tab === 'schedule' && html`<div class="card">${data.upcoming.map((d) => html`<div class="live-row"><div style=${{ width: 110 }}><b class="small">${fmtDate(d.date)}</b></div><span class="spacer"></span>
      ${d.holiday ? html`<span class="badge">${d.holiday}</span>` : d.shift ? html`<span class="shift-chip" style=${{ '--c': d.shift.color, minWidth: 140, cursor: 'default' }}>${d.shift.name}<small>${d.shift.start}–${d.shift.end}</small></span>` : html`<span class="badge">Day off</span>`}</div>`)}</div>`}
    ${tab === 'history' && html`<div class="card">${data.days.filter((d) => d.status !== 'off').map((d) => html`<div class="live-row"><div style=${{ width: 90 }}><b class="small">${fmtDate(d.date)}</b></div>
      <div class="small muted" style=${{ flex: 1 }}>${d.first_in ? `${T(d.first_in)} – ${d.last_out ? T(d.last_out) : d.open ? 'now' : '?'}` : d.leave ? d.leave.type : ''}</div><b class="small">${d.worked_min ? dur(d.worked_min) : ''}</b><${StatusBadge} s=${d.status} /></div>`)}</div>`}
    ${tab === 'leave' && html`<${MyLeave} data=${data} reload=${reload} />`}
    ${tab === 'fix' && html`<${MyCorrections} data=${data} reload=${reload} />`}</div>`;
}
function MyLeave({ data, reload }) {
  const [f, set] = useState({ type_id: data.leaveTypes[0]?.id || '', date_from: META.today, date_to: META.today, half_day: false, reason: '' });
  const submit = async () => { try { await api('/me/leave', { method: 'POST', body: f }); toast('Leave request sent'); set({ ...f, reason: '' }); reload(); } catch (e) { errToast(e); } };
  return html`<div class="col gap-lg"><div class="grid grid-3">${data.balances.filter((b) => b.quota).map((b) => html`<div class="card stat"><span class="label"><i class="dot" style=${{ background: b.color }}></i>${b.name}</span><span class="value">${b.remaining}</span><span class="hint">of ${b.quota} days left${b.pending ? ` · ${b.pending} pending` : ''}</span></div>`)}</div>
    <div class="card card-pad col"><h3>Request leave</h3><div class="grid grid-3">
      <${Field} label="Type"><select class="input" value=${f.type_id} onChange=${(e) => set({ ...f, type_id: e.target.value })}>${data.leaveTypes.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select><//>
      <${Field} label="From"><input type="date" class="input" value=${f.date_from} onInput=${(e) => set({ ...f, date_from: e.target.value, date_to: e.target.value > f.date_to ? e.target.value : f.date_to })} /><//>
      <${Field} label="To"><input type="date" class="input" value=${f.date_to} onInput=${(e) => set({ ...f, date_to: e.target.value })} /><//></div>
      <${Field} label="Reason"><input class="input" value=${f.reason} onInput=${(e) => set({ ...f, reason: e.target.value })} /><//>
      <div class="row"><label class="check"><input type="checkbox" checked=${f.half_day} onChange=${(e) => set({ ...f, half_day: e.target.checked })} /> Half day</label><span class="spacer"></span><button class="btn primary" onClick=${submit}>Send request</button></div></div>
    <div class="card">${data.leave.map((x) => html`<div class="live-row"><span class="badge" style=${{ color: x.color }}><i class="dot"></i>${x.type}</span><span class="small">${fmtDate(x.date_from, { day: 'numeric', month: 'short' })}${x.date_to !== x.date_from ? ' – ' + fmtDate(x.date_to, { day: 'numeric', month: 'short' }) : ''}</span><span class="spacer"></span><${ReqBadge} s=${x.status} />
      ${x.status === 'pending' && html`<button class="btn sm ghost" onClick=${async () => { await api('/me/leave/' + x.id, { method: 'DELETE' }); reload(); }}>Cancel</button>`}</div>`)}${!data.leave.length && html`<${Empty} icon="plane" title="No leave requests yet" />`}</div></div>`;
}
function MyCorrections({ data, reload }) {
  const [f, set] = useState({ date: addDays(META.today, -1), type: 'out', time: '18:00', reason: '' });
  const submit = async () => { try { await api('/me/corrections', { method: 'POST', body: f }); toast('Correction request sent to your manager'); set({ ...f, reason: '' }); reload(); } catch (e) { errToast(e); } };
  return html`<div class="col gap-lg"><div class="card card-pad col"><h3>Fix a missed punch</h3><div class="grid grid-3">
      <${Field} label="Date"><input type="date" class="input" value=${f.date} onInput=${(e) => set({ ...f, date: e.target.value })} /><//>
      <${Field} label="Punch"><select class="input" value=${f.type} onChange=${(e) => set({ ...f, type: e.target.value })}>${Object.entries(ACTION_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select><//>
      <${Field} label="Time"><input type="time" class="input" value=${f.time} onInput=${(e) => set({ ...f, time: e.target.value })} /><//></div>
      <${Field} label="What happened?"><input class="input" value=${f.reason} onInput=${(e) => set({ ...f, reason: e.target.value })} /><//><div><button class="btn primary" onClick=${submit}>Send request</button></div></div>
    <div class="card">${data.corrections.map((x) => html`<div class="live-row"><b class="small">${fmtDate(x.date)}</b><span class="small">${ACTION_LABEL[x.type]} at ${x.time}</span><span class="spacer"></span><${ReqBadge} s=${x.status} /></div>`)}${!data.corrections.length && html`<${Empty} icon="inbox" title="No correction requests" />`}</div></div>`;
}

(async () => {
  META = await api('/meta');
  document.title = `${META.appName} · ${META.companyName}`;
  document.querySelector('link[rel=icon]').href = META.logo;
  applyBrand(META);
  render(html`<${App} /><${Toasts} />`, document.getElementById('app'));
})();
