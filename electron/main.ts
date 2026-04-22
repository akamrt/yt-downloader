import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function getEnvPath(): string {
  if (isDev) {
    return path.join(__dirname, '..', '.env.local');
  }
  return path.join(app.getPath('userData'), '.env.local');
}

function hasCompletedSetup(): boolean {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  return content.includes('GEMINI_API_KEY=') && !content.includes('GEMINI_API_KEY=\n');
}

function startExpressServer() {
  // Set the env path for the server to find
  process.env.VIBECUT_ENV_PATH = getEnvPath();
  process.env.VIBECUT_IS_ELECTRON = '1';

  // Load the Express server in-process
  require('../server/server.cjs');
}

function startDownloadServer() {
  // Start the yt-downloader local server on port 3002
  try {
    require('../server/download-server.js');
    const app = require('../server/download-server.js');
    if (app && typeof app.listen === 'function') {
      app.listen(3002, '127.0.0.1', () => {
        console.log('[yt-downloader] Download server running on http://127.0.0.1:3002');
      });
    }
  } catch (err) {
    console.error('[yt-downloader] Failed to start download server:', err);
  }
}

async function waitForServer(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'VibeCut AI',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // In production, Express serves both API and static files on port 3001
  // In dev, Vite serves frontend on 3000 with proxy to 3001
  const url = isDev ? 'http://localhost:3000' : 'http://localhost:3001';
  mainWindow.loadURL(url);

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 600,
    height: 520,
    resizable: false,
    title: 'VibeCut AI - Setup',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile(path.join(__dirname, 'setup-wizard.html'));

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

// ---- IPC Handlers ----

ipcMain.handle('setup:saveApiKeys', async (_event, keys: Record<string, string>) => {
  const envPath = getEnvPath();
  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = Object.entries(keys)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}=${v.trim()}`);

  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  return { success: true };
});

ipcMain.handle('setup:checkBinaries', async () => {
  const binDirs: string[] = [];

  // Check Electron resources (production)
  if (process.resourcesPath) {
    binDirs.push(path.join(process.resourcesPath, 'bin'));
  }
  // Check local bin/ (dev)
  binDirs.push(path.join(__dirname, '..', 'bin'));

  const ext = process.platform === 'win32' ? '.exe' : '';

  const findBin = (name: string) => {
    for (const dir of binDirs) {
      const p = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(p)) return true;
    }
    return false;
  };

  return {
    ytdlp: findBin('yt-dlp'),
    ffmpeg: findBin('ffmpeg'),
    pythonTracker: findBin('vibecut-tracker'),
  };
});

ipcMain.handle('setup:complete', async () => {
  if (setupWindow) {
    setupWindow.close();
    setupWindow = null;
  }

  if (!isDev) {
    startExpressServer();
    startDownloadServer();
    const ready = await waitForServer('http://localhost:3001');
    if (!ready) console.error('[Electron] Server failed to start within timeout');
  }

  createMainWindow();
  return { success: true };
});

ipcMain.handle('setup:openExternal', async (_event, url: string) => {
  shell.openExternal(url);
});

// ---- App Lifecycle ----

app.whenReady().then(async () => {
  if (isDev) {
    // In dev mode, Vite (port 3000) and Express (port 3001/3002) are started
    // externally by concurrently — just open the window
    createMainWindow();
  } else if (hasCompletedSetup()) {
    startExpressServer();
    startDownloadServer();
    const ready = await waitForServer('http://localhost:3001');
    if (!ready) console.error('[Electron] Server failed to start within timeout');
    createMainWindow();
  } else {
    // Even in setup mode, start the download server
    startDownloadServer();
    createSetupWindow();
  }
});

app.on('before-quit', () => {
  if (typeof (process as any).__vibecut_shutdown === 'function') {
    (process as any).__vibecut_shutdown('electron-quit');
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (hasCompletedSetup()) {
      createMainWindow();
    } else {
      createSetupWindow();
    }
  }
});
