const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  checkForUpdates: () => ipcRenderer.invoke('check-and-apply-update'),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data))
});
