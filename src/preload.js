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
  close: () => ipcRenderer.send('window-close')
});
