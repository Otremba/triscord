const { app, BrowserWindow, ipcMain, desktopCapturer, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Disable default menu for a clean look
Menu.setApplicationMenu(null);

let mainWindow = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'renderer/assets/icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Triscord',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    frame: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {})
  });

  // Enable autoplay and media capture permissions automatically
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'notifications', 'display-capture'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Load the renderer UI
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: Get all available screens and windows for screen sharing
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 360, height: 202 },
      fetchWindowIcons: true
    });

    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
      isScreen: source.id.startsWith('screen:')
    }));
  } catch (err) {
    console.error('Error fetching screen sources:', err);
    return [];
  }
});

// System audio for screen sharing: everything the PC plays except this app's
// own process tree, so the call's voices are never sent back to the call.
const LOOPBACK_HELPER = app.isPackaged
  ? path.join(process.resourcesPath, 'loopback-capture.exe')
  : path.join(__dirname, '../native/bin/loopback-capture.exe');

const systemAudioCaptures = new Map(); // webContents.id -> helper process
const watchedContents = new WeakSet();

function stopSystemAudio(webContentsId) {
  const helper = systemAudioCaptures.get(webContentsId);
  if (helper) {
    systemAudioCaptures.delete(webContentsId);
    helper.kill();
  }
}

ipcMain.handle('system-audio-start', (event) => {
  const sender = event.sender;
  stopSystemAudio(sender.id);

  if (process.platform !== 'win32' || !fs.existsSync(LOOPBACK_HELPER)) {
    return { ok: false, error: 'unsupported' };
  }

  return new Promise((resolve) => {
    const helper = spawn(LOOPBACK_HELPER, ['--exclude-pid', String(process.pid)], { windowsHide: true });
    systemAudioCaptures.set(sender.id, helper);

    let settled = false;
    let stderr = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (!result.ok) stopSystemAudio(sender.id);
      resolve(result);
    };

    helper.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('READY')) settle({ ok: true });
      const error = stderr.match(/ERROR (.*)/);
      if (error) settle({ ok: false, error: error[1].trim() });
    });

    helper.stdout.on('data', (chunk) => {
      if (!sender.isDestroyed()) sender.send('system-audio-data', chunk);
    });

    helper.on('error', (err) => settle({ ok: false, error: err.message }));
    helper.on('exit', (code) => {
      if (systemAudioCaptures.get(sender.id) === helper) systemAudioCaptures.delete(sender.id);
      settle({ ok: false, error: `helper exited with code ${code}` });
    });

    if (!watchedContents.has(sender)) {
      watchedContents.add(sender);
      const id = sender.id;
      sender.on('destroyed', () => stopSystemAudio(id));
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) stopSystemAudio(id);
      });
    }
  });
});

ipcMain.handle('system-audio-stop', (event) => {
  stopSystemAudio(event.sender.id);
});

app.on('will-quit', () => {
  systemAudioCaptures.forEach(helper => helper.kill());
  systemAudioCaptures.clear();
});

// IPC: Window controls
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
