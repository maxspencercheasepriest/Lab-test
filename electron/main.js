// Desktop app: runs the game server inside the app and opens the game in a window.
// Whoever presses "Create a room" is the host; friends join using the host's address.
import { app, BrowserWindow, ipcMain, systemPreferences, shell, Menu } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME_PORT = 8080;
let port = GAME_PORT;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function boot() {
  // Use the standard port so friends can connect; fall back to any free port if it's taken.
  try { ({ port } = await startServer({ port: GAME_PORT })); }
  catch { ({ port } = await startServer({ port: 0 })); }

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }

  ipcMain.handle('programme:info', () => ({ port, lan: lanAddresses(), standardPort: port === GAME_PORT }));

  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280, height: 760, minWidth: 900, minHeight: 560,
    backgroundColor: '#000000',
    title: 'The Programme',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      backgroundThrottling: false,
    },
  });
  // Microphone for voice chat; nothing else.
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'pointerLock', 'fullscreen'].includes(perm)));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  win.loadURL(`http://localhost:${port}/?desktop=1`);
}

app.whenReady().then(boot);
app.on('window-all-closed', () => app.quit());
