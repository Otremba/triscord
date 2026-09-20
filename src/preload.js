const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  startSystemAudio: () => ipcRenderer.invoke('system-audio-start'),
  stopSystemAudio: () => ipcRenderer.invoke('system-audio-stop'),
  onSystemAudioData: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('system-audio-data', listener);
    return () => ipcRenderer.removeListener('system-audio-data', listener);
  },
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  setGlobalMuteShortcut: (accelerator) => ipcRenderer.invoke('set-global-mute-shortcut', accelerator),
  onGlobalMuteToggle: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('global-mute-toggle', listener);
    return () => ipcRenderer.removeListener('global-mute-toggle', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('update-downloaded', listener);
    return () => ipcRenderer.removeListener('update-downloaded', listener);
  },
  restartToUpdate: () => ipcRenderer.send('restart-to-update')
});
