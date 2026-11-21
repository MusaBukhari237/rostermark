const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rmDesktop', {
  platform: process.platform,
  setServer: (url, mode) => ipcRenderer.invoke('rm:set-server', url, mode),
  getServer: () => ipcRenderer.invoke('rm:get-server')
});
