const { app, BrowserWindow, ipcMain, desktopCapturer, session, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Disable default menu for a clean look
Menu.setApplicationMenu(null);

// Warnings and errors of the main process (system audio helper, updater...),
// kept for the diagnostics report in Settings. The renderer cannot see these.
const MAIN_LOG_LIMIT = 200;
const mainLog = [];
['warn', 'error'].forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const message = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .slice(0, 500);
    mainLog.push({ t: Date.now(), level, message });
    if (mainLog.length > MAIN_LOG_LIMIT) mainLog.shift();
  };
});

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
      webSecurity: true,
      // A minimized call must keep running at full speed: Chromium otherwise
      // throttles timers in a background window, which delays the timers that
      // recover a dropped peer connection
      backgroundThrottling: false
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

// WASAPI process loopback, which can leave one process tree out of the capture,
// exists since Windows build 20348 (Windows 11 is 22000+)
const MIN_PROCESS_LOOPBACK_BUILD = 20348;

function windowsBuild() {
  // os.release() is "10.0.<build>" on both Windows 10 and 11
  return parseInt(os.release().split('.')[2], 10) || 0;
}

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

  // Each failure says why, so the renderer never blames the Windows version
  // for something else (a missing helper used to show "requires Windows 11")
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported-platform', error: process.platform };
  }
  const build = windowsBuild();
  if (build < MIN_PROCESS_LOOPBACK_BUILD) {
    return { ok: false, reason: 'windows-too-old', error: `Windows build ${build}`, build };
  }
  if (!fs.existsSync(LOOPBACK_HELPER)) {
    console.error(`[SystemAudio] Helper not found at ${LOOPBACK_HELPER}`);
    return { ok: false, reason: 'helper-missing', error: LOOPBACK_HELPER };
  }

  return new Promise((resolve) => {
    const helper = spawn(LOOPBACK_HELPER, ['--exclude-pid', String(process.pid)], { windowsHide: true });
    systemAudioCaptures.set(sender.id, helper);

    let settled = false;
    let stderr = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (!result.ok) {
        stopSystemAudio(sender.id);
        console.error('[SystemAudio] Capture failed:', result.error);
      }
      resolve(result);
    };

    helper.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('READY')) settle({ ok: true });
      const error = stderr.match(/ERROR (.*)/);
      if (error) settle({ ok: false, reason: 'helper-failed', error: error[1].trim() });
    });

    helper.stdout.on('data', (chunk) => {
      if (!sender.isDestroyed()) sender.send('system-audio-data', chunk);
    });

    // 'error' is typically the helper being blocked (antivirus) or unreadable
    helper.on('error', (err) => settle({ ok: false, reason: 'helper-failed', error: err.message }));
    helper.on('exit', (code) => {
      if (systemAudioCaptures.get(sender.id) === helper) systemAudioCaptures.delete(sender.id);
      settle({ ok: false, reason: 'helper-failed', error: `helper exited with code ${code}` });
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

// Global "toggle mute" shortcut — works even while Triscord is in the
// background, since it's registered with the OS rather than the page
let currentMuteAccelerator = null;

// Environment and live resource use, for the diagnostics report
ipcMain.handle('get-diagnostics-info', () => {
  const metrics = app.getAppMetrics();
  const cpus = os.cpus();
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    os: `${process.platform} ${os.release()} (${process.arch})`,
    cpu: cpus.length ? `${cpus[0].model.trim()} x${cpus.length}` : 'unknown',
    totalMemoryMB: Math.round(os.totalmem() / 1048576),
    freeMemoryMB: Math.round(os.freemem() / 1048576),
    // All of Triscord's processes together
    appCpuPercent: Math.round(metrics.reduce((sum, m) => sum + (m.cpu ? m.cpu.percentCPUUsage : 0), 0) * 10) / 10,
    appMemoryMB: Math.round(metrics.reduce((sum, m) => sum + (m.memory ? m.memory.workingSetSize : 0), 0) / 1024),
    mainLog: mainLog.slice()
  };
});

ipcMain.handle('set-global-mute-shortcut', (event, accelerator) => {
  if (typeof accelerator !== 'string' || !accelerator.trim()) {
    return { ok: false, error: 'invalid accelerator' };
  }

  if (currentMuteAccelerator) {
    globalShortcut.unregister(currentMuteAccelerator);
    currentMuteAccelerator = null;
  }

  try {
    const registered = globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('global-mute-toggle');
      }
    });
    if (!registered) return { ok: false, error: 'accelerator already in use' };
    currentMuteAccelerator = accelerator;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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
  checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Auto-update from GitHub Releases in packaged builds. Requires the app to be
// signed/published via `npm run build:win` + a GitHub release carrying the
// generated latest.yml; harmless no-op in dev or if the dependency is absent.
let autoUpdaterRef = null;

function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterRef = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded');
      }
    });
    autoUpdater.on('error', (err) => console.warn('[AutoUpdater] Error:', err.message));
    autoUpdater.checkForUpdatesAndNotify().catch(err => console.warn('[AutoUpdater] Check failed:', err.message));
  } catch (err) {
    console.warn('[AutoUpdater] electron-updater not available:', err.message);
  }
}

ipcMain.on('restart-to-update', () => {
  if (autoUpdaterRef) autoUpdaterRef.quitAndInstall();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
