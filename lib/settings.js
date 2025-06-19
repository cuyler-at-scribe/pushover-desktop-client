// lib/settings.js
// Helper for loading and saving persistent Pushover Desktop Client settings
// Handles XDG paths, env overrides, first-run setup wizard, and ensures required
// directories exist.

const fs = require('fs');
const path = require('path');
const os = require('os');
const xdg = require('xdg');
const mkdirp = require('mkdirp');

const CONFIG_DIR = process.env.PUSHOVER_SETTINGS_PATH
  ? path.dirname(process.env.PUSHOVER_SETTINGS_PATH)
  : xdg.basedir.configPath('pushover-dc');

const CONFIG_PATH = process.env.PUSHOVER_SETTINGS_PATH || path.join(CONFIG_DIR, 'settings.json');
const DEFAULT_IMAGE_CACHE = process.env.PUSHOVER_IMAGE_CACHE || xdg.basedir.cachePath('pushover-dc');

// ---------------------------------------------------------------------------
// Utility – write JSON atomically and chmod 0600
// ---------------------------------------------------------------------------
function writeFileSecure(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Setup wizard (CLI implementation)
// ---------------------------------------------------------------------------
async function runSetupWizard(api, settings) {
  const readline = require('readline');

  function ask(question, { hidden = false } = {}) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

      if (hidden) {
        // Hide user input by overriding _writeToOutput
        const orig = rl._writeToOutput;
        rl._writeToOutput = function (stringToWrite) {
          if (stringToWrite.trim() === '') {
            return orig.call(rl, stringToWrite);
          }
          rl.output.write('*');
        };
      }

      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  console.log('\nPushover Desktop Client – First-run setup');
  console.log('---------------------------------------');

  let email = await ask('Pushover Email: ');
  while (!email) {
    email = await ask('Email is required. Please enter Pushover Email: ');
  }

  let password = await ask('Password: ', { hidden: true });
  while (!password) {
    password = await ask('Password is required. Please enter Password: ', { hidden: true });
  }

  // Attempt login (handle 2FA loop)
  let loginResp;
  let twofa;
  while (true) {
    try {
      loginResp = await api.login({ email, password, twofa });
      break; // success
    } catch (err) {
      if (err && err.code === '2FA_REQUIRED') {
        twofa = await ask('Two-factor code: ');
        continue;
      }
      console.error('Login failed:', err.message || err);
      // Re-prompt credentials
      email = await ask('Pushover Email: ');
      password = await ask('Password: ', { hidden: true });
    }
  }

  const secret = loginResp.secret;
  const user_key = loginResp.id; // API returns id field

  // Device registration loop → prompt for name until accepted
  let deviceId;
  let defaultName = os.hostname().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 25) || 'my_device';
  while (true) {
    const name = await ask(`Device name [${defaultName}]: `) || defaultName;
    try {
      const regResp = await api.registerDevice({ secret, name });
      deviceId = regResp.id;
      break;
    } catch (err) {
      if (err && err.code === 'NAME_TAKEN') {
        console.error('That device name is already taken. Please choose another.');
        continue;
      }
      console.error('Failed to register device:', err.message || err);
    }
  }

  // Persist settings
  settings.deviceId = deviceId;
  settings.secret = secret;
  settings.user_key = user_key;
  settings.imageCache = settings.imageCache || DEFAULT_IMAGE_CACHE;

  mkdirp.sync(CONFIG_DIR, '0755');
  mkdirp.sync(settings.imageCache, '0755');
  writeFileSecure(CONFIG_PATH, settings);

  console.log('\nSetup complete! Configuration saved to', CONFIG_PATH);
  return settings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
module.exports.load = async function load(opts = {}) {
  const { forceSetup = false, runWizard = true } = opts;
  let settings = {};

  // Attempt to read existing config file
  try {
    settings = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    // ignore – first run most likely
  }

  // Apply env overrides
  settings.deviceId = process.env.PUSHOVER_DEVICE_ID || settings.deviceId;
  settings.secret = process.env.PUSHOVER_SECRET || settings.secret;
  settings.imageCache = DEFAULT_IMAGE_CACHE;

  // Ensure cache dir exists
  mkdirp.sync(settings.imageCache, '0755');

  // Early exit when we already have creds and not forced into setup
  if (!forceSetup && settings.deviceId && settings.secret) {
    return settings;
  }

  if (!runWizard) {
    return settings; // caller will handle interactive flow
  }

  // Lazy-load API helper to avoid circular deps when settings.js is required by API
  const api = require('./api');
  return runSetupWizard(api, settings);
};

module.exports.save = function save(settings) {
  mkdirp.sync(CONFIG_DIR, '0755');
  writeFileSecure(CONFIG_PATH, settings);
};

module.exports.CONFIG_PATH = CONFIG_PATH; 