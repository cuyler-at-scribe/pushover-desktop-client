// lib/electronSetup.js
// Electron modal-based onboarding wizard using electron-prompt.

const prompt = require('electron-prompt');
const os = require('os');
const api = require('./api');
const settingsHelper = require('./settings');
const mkdirp = require('mkdirp');

async function ask(options) {
  const result = await prompt(Object.assign({
    width: 400,
    height: 150,
    resizable: false,
  }, options));
  if (result === null) {
    throw new Error('User cancelled setup');
  }
  return result.trim();
}

module.exports = async function runElectronWizard(settings) {
  try {
    let email = await ask({ title: 'Pushover Setup', label: 'Pushover Email:' });
    while (!email) {
      email = await ask({ title: 'Pushover Setup', label: 'Email is required:' });
    }

    let password = await ask({ title: 'Pushover Setup', label: 'Password:', inputAttrs: { type: 'password' } });
    while (!password) {
      password = await ask({ title: 'Pushover Setup', label: 'Password is required:', inputAttrs: { type: 'password' } });
    }

    // Login loop (handle 2FA)
    let loginResp;
    let twofa;
    while (true) {
      try {
        loginResp = await api.login({ email, password, twofa });
        break;
      } catch (err) {
        if (err.code === '2FA_REQUIRED') {
          twofa = await ask({ title: 'Two-Factor Authentication', label: '2FA Code:' });
          continue;
        }
        // Ask again
        email = await ask({ title: 'Login Failed', label: `Error: ${err.message}\nPushover Email:` });
        password = await ask({ title: 'Login Failed', label: 'Password:', inputAttrs: { type: 'password' } });
      }
    }

    const secret = loginResp.secret;
    const user_key = loginResp.id;

    // Device registration
    let defaultName = os.hostname().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 25) || 'my_device';
    let deviceId;
    while (true) {
      const name = await ask({ title: 'Device Registration', label: `Device name:`, value: defaultName });
      try {
        const regResp = await api.registerDevice({ secret, name });
        deviceId = regResp.id;
        break;
      } catch (err) {
        if (err.code === 'NAME_TAKEN') {
          await ask({ title: 'Name Taken', label: 'That name is taken. Click OK to choose another.' });
          continue;
        }
        throw err;
      }
    }

    settings.deviceId = deviceId;
    settings.secret = secret;
    settings.user_key = user_key;

    mkdirp.sync(settings.imageCache, '0755');
    settingsHelper.save(settings);

    await ask({ title: 'Setup Complete', label: 'Setup is complete! Click OK to start receiving notifications.' });
    return settings;
  } catch (err) {
    console.error('Setup wizard aborted:', err.message || err);
    const { dialog } = require('electron');
    dialog.showErrorBox('Pushover Setup Incomplete', err.message || String(err));
    process.exit(1);
  }
}; 