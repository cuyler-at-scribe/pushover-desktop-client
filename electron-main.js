const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Toaster = require('electron-toaster');
const PushoverDesktopClient = require('./index');
const settingsHelper = require('./lib/settings');

/***************************************************
 * This file bootstraps the existing Pushover client
 * inside a headless Electron window and replaces
 * the original node-notifier popup with bottom-right
 * toasts rendered by `electron-toaster`.
 ***************************************************/

// ---------------------------------------------------------------------------
// 1. tiny dummy BrowserWindow (required by Toaster)
// ---------------------------------------------------------------------------
let mainWindow;
const toaster = new Toaster();

// ---------------------------------------------------------------------------
// 2. node-notifier compatible adapter so that index.js can stay untouched
// ---------------------------------------------------------------------------
function createNotifier() {
  return {
    notify(payload, cb = () => {}) {
      // electron-toaster expects HTML; convert newlines
      const message = (payload.message || '').replace(/\n/g, '<br>');
      const toast = {
        title: payload.title || 'Notification',
        message,
        width: 380,
        timeout: 0, // never auto-dismiss
        focus: false   // don\'t steal focus
      };
      // build htmlFile to bypass electron-toaster bug
      const toasterHtmlPath = path.join(require.resolve('electron-toaster'), '..', 'toaster.html');
      toast.htmlFile = `file://${toasterHtmlPath}?title=${encodeURIComponent(payload.title||'')}&message=${encodeURIComponent((payload.message||'').replace(/<br>/g,' '))}&detail=&timeout=${toast.timeout}`;
      ipcMain.emit('electron-toaster-message', null, toast);
      cb(null);
    }
  };
}

// ---------------------------------------------------------------------------
// 3. load settings (runs interactive wizard on first launch)
// ---------------------------------------------------------------------------
async function prepareSettings() {
  let settings = await settingsHelper.load({ forceSetup: process.argv.includes('--setup'), runWizard: false });

  if (!settings.deviceId || !settings.secret) {
    // Run Electron modal wizard
    const runElectronWizard = require('./lib/electronSetup');
    settings = await runElectronWizard(settings);
  }

  // Inject our notifier replacement so index.js uses our Electron toaster
  settings.notifier = createNotifier();
  return settings;
}

// ---------------------------------------------------------------------------
// 4. create hidden window and launch the Pushover client
// ---------------------------------------------------------------------------
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 1,
    show: false
  });

  // init toaster: attaches its own alwaysOnTop transparent window
  toaster.init(mainWindow);

  // Load settings (wizard if needed) then run client
  const settings = await prepareSettings();

  const pdc = new PushoverDesktopClient(settings);
  pdc.connect();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // quit everything when user closes the toaster window
  app.quit();
});

// ---------------------------------------------------------------------------
// Patch electron-toaster bug: duplicated query string => blank content
// ---------------------------------------------------------------------------
const activeToasts = [];
function relayout(displayHeight) {
  let yPos = displayHeight - 4; // bottom padding
  for (let i = activeToasts.length - 1; i >= 0; i--) {
    const t = activeToasts[i];
    const [w,h] = t.getSize();
    yPos -= h;
    t.setPosition(t.getPosition()[0], yPos);
    yPos -= 4; // gap
  }
}

Toaster.prototype.init = function(hostWindow) {
  ipcMain.on('electron-toaster-message', (_event, msg) => {
    // Build correct URL
    const toasterHtml = `file://${path.join(path.dirname(require.resolve('electron-toaster')), 'toaster.html')}`;
    const url = `${toasterHtml}?foo=bar&title=${encodeURIComponent(msg.title || '')}` +
                `&message=${encodeURIComponent(msg.message || '')}` +
                `&detail=${encodeURIComponent(msg.detail || '')}` +
                `&timeout=${msg.timeout ?? 5000}`;

    const bw = new BrowserWindow({
      width: msg.width || 380,
      frame: false,
      transparent: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    // position bottom-right of same display as hostWindow
    const { workAreaSize } = require('electron').screen.getDisplayNearestPoint({ x: hostWindow.getBounds().x, y: hostWindow.getBounds().y });
    bw.loadURL(url);

    bw.webContents.once('did-finish-load', () => {
      const [w, h] = bw.getSize();
      bw.setPosition(workAreaSize.width - w - 4, workAreaSize.height - h - 4);
      bw.showInactive();

      activeToasts.push(bw);
      relayout(workAreaSize.height);
    });

    // close on click anywhere
    bw.webContents.once('dom-ready', () => {
      bw.webContents.executeJavaScript('document.addEventListener("click", () => window.close())');
    });

    bw.on('closed', () => {
      const idx = activeToasts.indexOf(bw);
      if (idx !== -1) activeToasts.splice(idx,1);
      relayout(workAreaSize.height);
    });
  });
}; 