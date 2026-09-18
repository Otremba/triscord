const { app, BrowserWindow, ipcMain, desktopCapturer, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Start embedded signaling server if running standalone
try {
  require('../server/server.js');
} catch (e) {
  console.log('[Embedded Server Startup Note]', e.message);
}

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

// IPC: Auto-update from GitHub
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

ipcMain.handle('check-and-apply-update', async (event) => {
  const projectRoot = path.join(__dirname, '..');
  const sendProgress = (stage, message, percent = null) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { stage, message, percent });
    }
  };

  try {
    sendProgress('checking', 'Conectando ao GitHub e verificando novas versões...');

    // 1. Get current branch name
    let currentBranch = 'main';
    try {
      const { stdout: branchStdout } = await execPromise('git branch --show-current', { cwd: projectRoot });
      currentBranch = branchStdout.trim() || 'main';
    } catch (e) {}

    // 2. Fetch all changes from origin safely
    try {
      await execPromise('git fetch origin', { cwd: projectRoot });
    } catch (fetchErr) {
      console.warn('Git fetch origin warning:', fetchErr.message);
    }

    // 3. Check which remote branches exist
    const { stdout: remoteBranchesOut } = await execPromise('git branch -r', { cwd: projectRoot });
    const remoteBranches = remoteBranchesOut.split('\n').map(b => b.trim()).filter(Boolean);

    const targetRemoteBranch = remoteBranches.find(b => b === `origin/${currentBranch}`) ||
                               remoteBranches.find(b => b === 'origin/main') ||
                               remoteBranches.find(b => b === 'origin/master');

    if (!targetRemoteBranch) {
      sendProgress('up-to-date', 'Você já está usando a versão mais recente! (Nenhum commit novo encontrado no GitHub).');
      return { status: 'up-to-date', message: 'Você já está na versão mais recente!' };
    }

    // 4. Compare local commit hash with remote commit hash
    const { stdout: localHash } = await execPromise('git rev-parse HEAD', { cwd: projectRoot });
    const { stdout: remoteHash } = await execPromise(`git rev-parse ${targetRemoteBranch}`, { cwd: projectRoot });

    if (localHash.trim() === remoteHash.trim()) {
      sendProgress('up-to-date', 'Você já está usando a versão mais recente do app!');
      return { status: 'up-to-date', message: 'Você já está na versão mais recente!' };
    }

    // 5. Updates available! Pull changes
    sendProgress('downloading', 'Novas atualizações encontradas! Baixando do GitHub...', 35);
    const branchName = targetRemoteBranch.replace('origin/', '');
    await execPromise(`git pull origin ${branchName}`, { cwd: projectRoot });

    // 6. Update dependencies if needed
    sendProgress('dependencies', 'Instalando dependências e aplicando mudanças...', 75);
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      await execPromise(`${npmCmd} install --no-audit --prefer-offline`, { cwd: projectRoot });
    } catch (npmErr) {
      console.warn('NPM install non-critical error:', npmErr);
    }

    // 7. Complete and restart app
    sendProgress('restarting', 'Atualização concluída com sucesso! Reiniciando...', 100);

    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 1500);

    return { status: 'success', message: 'Atualizado com sucesso!' };
  } catch (error) {
    console.error('Update error:', error);
    sendProgress('error', `Erro na atualização: ${error.message}`);
    return { status: 'error', message: error.message };
  }
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
