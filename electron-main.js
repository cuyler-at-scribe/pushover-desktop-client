const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Toaster = require('electron-toaster');
const PushoverDesktopClient = require('./index');
const settingsHelper = require('./lib/settings');
const { spawn } = require('child_process');
const fs = require('fs');

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

// macOS: pick first existing system sound from candidates
const MAC_SOUND_CANDIDATES = ['Submerge.aiff', 'Submarine.aiff', 'Funk.aiff'];
let macSoundPath = null;
if (process.platform === 'darwin') {
  for (const fileName of MAC_SOUND_CANDIDATES) {
    const candidate = `/System/Library/Sounds/${fileName}`;
    if (fs.existsSync(candidate)) {
      macSoundPath = candidate;
      break;
    }
  }
}

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

      // -----------------------------------------------------------------
      // Determine accent colour from Pushover priority so we can style the
      // toast (spine + glow) inside the renderer.
      //   priority >=1   → Critical   → crimson
      //   priority  0    → Normal     → blue
      //   priority <=-1  → Low / info → green
      // -----------------------------------------------------------------
      const prio = typeof payload.priority === 'number' ? payload.priority : 0;
      let accentColour = '#2E90FA'; // default (normal)
      if (prio >= 1) {
        accentColour = '#E53935'; // crimson for high/critical
      } else if (prio <= -1) {
        accentColour = '#39B54A'; // green for low/info
      }
      toast.accentColor = accentColour;

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
// Padding (in pixels).
//  - PADDING_X controls space from the right screen edge.
//  - PADDING_Y controls space from the bottom screen edge **and** between stacked toasts.
// Visual feedback showed the bottom margin appeared larger than the right one,
// so we increase horizontal padding slightly to balance things out.
const PADDING_X = 16; // right-edge spacing
const PADDING_Y = 16; // bottom-edge spacing & inter-toast gap

const activeToasts = [];
function relayout(displayHeight) {
  let yPos = displayHeight - PADDING_Y; // bottom padding
  for (let i = activeToasts.length - 1; i >= 0; i--) {
    const t = activeToasts[i];
    const [w, h] = t.getSize();
    yPos -= h;
    t.setPosition(t.getPosition()[0], yPos);
    yPos -= PADDING_Y; // gap between stacked toasts
  }
}

// Enable repeated alert sound if CLI flag is present
const REPEAT_SOUND = process.argv.includes('--repeat-sound');
// Gap between sound playbacks in milliseconds (platform-specific)
const REPEAT_SOUND_GAP = process.platform === 'darwin' ? 3000 : 8000; // 3 s on macOS, 8 s elsewhere

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

    // Helper to play alert sound (cross-platform best-effort)
    function playAlertSound() {
      try {
        if (process.platform === 'darwin') {
          const soundFile = macSoundPath || '/System/Library/Sounds/Funk.aiff';
          spawn('afplay', [soundFile]);
        } else if (process.platform === 'win32') {
          spawn('powershell', ['-c', '[console]::beep(1000,500)']);
        } else {
          // Linux / others – attempt paplay fallback if available
          spawn('paplay', ['/usr/share/sounds/freedesktop/stereo/bell.oga']);
        }
      } catch (_) {
        // Swallow any playback errors – sound is best-effort
      }
    }
    let soundTimer;

    // Determine display bounds (full screen area) of the monitor hosting the hidden window.
    // Using `bounds` instead of `workArea` ensures we don't leave an oversized gap caused
    // by the macOS Dock or similar taskbars – we want the toast flush against the true
    // screen edges.
    const display = require('electron').screen.getDisplayNearestPoint({ x: hostWindow.getBounds().x, y: hostWindow.getBounds().y });
    const displayBounds = display.bounds;
    bw.loadURL(url);

    bw.webContents.once('did-finish-load', () => {
      const [w, h] = bw.getSize();
      bw.setPosition(displayBounds.width - w - PADDING_X, displayBounds.height - h - PADDING_Y);
      bw.showInactive();

      // Inject styling & pulsating glow once content is ready
      const accent = msg.accentColor || '#2E90FA';
      const css = `body,html{background:#ffffff;color:#000000; margin:0; padding:0;}
        /* Main card */
        table#content{width:100%;height:100%;border-top:1px solid #E0E0E0;border-right:1px solid #E0E0E0;border-bottom:1px solid #E0E0E0;border-left:none;animation:pulseGlow 3s ease-in-out infinite;border-collapse:collapse;box-shadow:0 0 0 0 ${accent};border-spacing:0; margin:0; padding:0;}
        /* Icon background */
        td:first-child{background-color:${accent}!important;width:56px;padding:0;animation:pulseBG 1.5s ease-in-out infinite; margin:0; padding:0;}
        /* Under-title rule */
        hr{height:2px;border:0;background:${accent};opacity:0.25; margin:0; padding:0;}
        /* Pulsating glow – smoother (≈ sine) */
        @keyframes pulseGlow{
          0%,100% {box-shadow:0 0 0 0 ${accent};}
          25%     {box-shadow:0 0 4px 2px ${accent};}
          50%     {box-shadow:0 0 12px 6px ${accent};}
          75%     {box-shadow:0 0 4px 2px ${accent};}
        }
        @keyframes pulseBG{
          0%,100% {filter:brightness(1);}
          25%     {filter:brightness(1.2);}
          50%     {filter:brightness(1.6);} 
          75%     {filter:brightness(1.2);} 
        }
        /* Accent stripe that also covers rounded corners */
        body::before{content:'';position:fixed;left:0;top:0;width:56px;height:100%;background:${accent};animation:pulseBG 1.5s ease-in-out infinite;pointer-events:none;}
      `;
      bw.webContents.insertCSS(css).catch(()=>{});

      activeToasts.push(bw);
      relayout(displayBounds.height);

      // Start repeating alert sound if enabled
      if (REPEAT_SOUND) {
        playAlertSound();
        soundTimer = setInterval(playAlertSound, REPEAT_SOUND_GAP);
      }
    });

    // close on click anywhere
    bw.webContents.once('dom-ready', () => {
      bw.webContents.executeJavaScript('document.addEventListener("click", () => window.close())');
    });

    bw.on('closed', () => {
      const idx = activeToasts.indexOf(bw);
      if (idx !== -1) activeToasts.splice(idx,1);
      relayout(displayBounds.height);

      // Stop alert sound loop for this toast
      if (soundTimer) {
        clearInterval(soundTimer);
      }
    });
  });
}; 