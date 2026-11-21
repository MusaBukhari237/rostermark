// Rostermark Desktop: a window onto your Rostermark server, with a full-screen kiosk mode.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const defaults = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } })();
const PRODUCT = defaults.productName || 'Rostermark';
const cfgFile = () => path.join(app.getPath('userData'), 'settings.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const writeCfg = (c) => fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2));
let win;

function serverUrl() { return readCfg().server || defaults.defaultServer || ''; }
function open(mode) {
  const server = serverUrl();
  if (!server) return win.loadFile(path.join(__dirname, 'setup.html'));
  const kiosk = mode === 'kiosk';
  win.setKiosk(kiosk);
  win.setMenuBarVisibility(!kiosk);
  win.loadURL(server.replace(/\/$/, '') + (kiosk ? '/kiosk' : '/')).catch(() => win.loadFile(path.join(__dirname, 'setup.html'), { query: { error: 'Could not reach ' + server } }));
  writeCfg({ ...readCfg(), mode });
}

function menu() {
  return Menu.buildFromTemplate([
    { label: PRODUCT, submenu: [
      { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => open('app') },
      { label: 'Kiosk mode (full screen)', accelerator: 'CmdOrCtrl+K', click: () => open('kiosk') },
      { type: 'separator' },
      { label: 'Change server…', click: () => { win.setKiosk(false); win.loadFile(path.join(__dirname, 'setup.html')); } },
      { label: 'Open in browser', click: () => serverUrl() && shell.openExternal(serverUrl()) },
      { type: 'separator' }, { role: 'reload' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'Exit kiosk: Ctrl+Shift+Q', enabled: false }, { label: 'About', click: () => dialog.showMessageBox(win, { message: `${PRODUCT} Desktop ${app.getVersion()}`, detail: serverUrl() || 'No server set' }) }] }
  ]);
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 900, minHeight: 600, title: PRODUCT, icon: path.join(__dirname, 'icon.png'), backgroundColor: '#0b1020',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(menu());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (serverUrl() && url.startsWith(serverUrl()) && url.includes('/kiosk')) { open('kiosk'); return { action: 'deny' }; }
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (e, input) => { if (input.control && input.shift && input.key.toLowerCase() === 'q') { e.preventDefault(); open('app'); } });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'geolocation', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  ipcMain.handle('rm:set-server', (_e, url, mode) => { if (!/^https?:\/\//.test(url)) return false; writeCfg({ ...readCfg(), server: url.replace(/\/$/, '') }); open(mode || 'app'); return true; });
  ipcMain.handle('rm:get-server', () => serverUrl());
  open(readCfg().mode || 'app');
});
app.on('window-all-closed', () => app.quit());
