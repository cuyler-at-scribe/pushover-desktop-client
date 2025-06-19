// lib/api.js
// Thin wrapper around Pushover Open Client HTTPS endpoints that we need during
// onboarding. Each method returns a Promise.

const https = require('https');
const querystring = require('querystring');

const API_HOST = 'api.pushover.net';
const API_BASE = '/1';
const USER_AGENT = `pushover-desktop-client/${require('../package.json').version} (+https://github.com/nbrownus/pushover-desktop-client)`;

function makeRequest({ path, method = 'POST', dataObj }) {
  const postData = querystring.stringify(dataObj);

  const options = {
    host: API_HOST,
    method,
    path,
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d.toString()));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          return reject(new Error(`Invalid JSON response (${res.statusCode})`));
        }

        if (res.statusCode === 200 && json.status === 1) {
          resolve(json);
        } else if (res.statusCode === 412) {
          // Two-factor required for login
          const err = new Error('Two-factor authentication required');
          err.code = '2FA_REQUIRED';
          err.response = json;
          reject(err);
        } else if (json && json.errors && json.errors.name && json.errors.name.includes('has already been taken')) {
          const err = new Error('Device name already taken');
          err.code = 'NAME_TAKEN';
          err.response = json;
          reject(err);
        } else {
          const err = new Error(json && json.errors ? JSON.stringify(json.errors) : `HTTP ${res.statusCode}`);
          err.response = json;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(postData + '\n');
    req.end();
  });
}

module.exports.login = ({ email, password, twofa }) => {
  return makeRequest({
    path: `${API_BASE}/users/login.json`,
    dataObj: { email, password, twofa }
  });
};

module.exports.registerDevice = ({ secret, name }) => {
  return makeRequest({
    path: `${API_BASE}/devices.json`,
    dataObj: { secret, name, os: 'O' }
  });
}; 