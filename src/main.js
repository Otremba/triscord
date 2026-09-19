const { app, BrowserWindow, ipcMain, desktopCapturer, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable default menu for clean Discord look
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
    title: 'Discord Voice & Video Client',
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
