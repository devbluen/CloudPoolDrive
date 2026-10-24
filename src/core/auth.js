const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');
const { OAuth2Client } = require('google-auth-library');
const { t } = require('../renderer/i18n');

// Full Drive access, so files that already exist in each account show up in the pool.
// It is a restricted scope: without Google verification, sign-in shows an "unverified app"
// warning and the project is capped at 100 accounts, which is fine for personal use.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

// Accounts connected by earlier versions only granted drive.file and must reconnect.
const hasFullAccess = tokens => String(tokens?.scope || '').split(' ').includes(DRIVE_SCOPE);
const SCOPES = [DRIVE_SCOPE, 'openid', 'email'];
const LOGIN_TIMEOUT = 5 * 60 * 1000;

function makeClient(creds, redirectUri) {
  return new OAuth2Client({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri });
}

function resultPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6fa;color:#1d2433">
<div style="text-align:center"><h2>${title}</h2><p>${text}</p></div></body>`;
}

// Loopback OAuth flow with PKCE: opens the system browser and waits for the redirect.
async function signIn(creds) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const client = makeClient(creds, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = crypto.randomBytes(16).toString('hex');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });

  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('loginTimeout'))), LOGIN_TIMEOUT);
      server.on('request', (req, res) => {
        const params = new URL(req.url, redirectUri).searchParams;
        if (params.get('state') !== state) {
          res.writeHead(404).end();
          return;
        }
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (params.get('error')) {
          res.end(resultPage(t('pageCanceledTitle'), t('pageCanceledText')));
          reject(new Error(t('loginCanceled')));
        } else {
          res.end(resultPage(t('pageConnectedTitle'), t('pageConnectedText')));
          resolve(params.get('code'));
        }
      });
      shell.openExternal(url);
    });

    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!hasFullAccess(tokens)) {
      throw new Error(t('scopeMissing'));
    }
    if (!tokens.refresh_token) {
      throw new Error(t('noRefreshToken'));
    }
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: creds.clientId });
    return { email: ticket.getPayload().email, tokens };
  } finally {
    server.close();
  }
}

module.exports = { makeClient, signIn, hasFullAccess };
