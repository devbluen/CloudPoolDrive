const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = name => path.join(app.getPath('userData'), name);
const DATA_FILES = ['credentials.json', 'accounts.json', 'settings.json'];
const LEGACY_DIRS = ['cloud-pool-driver', 'drive-unificado']; // data folders used by earlier names of the app

// Copies settings from an earlier app name's data folder, once, if this one is still empty.
function migrateLegacyData() {
  const dir = app.getPath('userData');
  if (DATA_FILES.some(f => fs.existsSync(path.join(dir, f)))) return;
  for (const legacy of LEGACY_DIRS) {
    const from = path.join(app.getPath('appData'), legacy);
    if (!DATA_FILES.some(f => fs.existsSync(path.join(from, f)))) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of DATA_FILES) {
      if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(dir, f));
    }
    return;
  }
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(target + '.tmp', target);
}

// Tokens are encrypted with the OS keychain (DPAPI on Windows) when available.
function seal(obj) {
  const text = JSON.stringify(obj);
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(text).toString('base64') };
  }
  return { enc: false, data: text };
}

function unseal(value) {
  const text = value.enc ? safeStorage.decryptString(Buffer.from(value.data, 'base64')) : value.data;
  return JSON.parse(text);
}

function getCredentials() {
  return readJson('credentials.json', null);
}

function setCredentials(creds) {
  writeJson('credentials.json', creds);
}

function getSettings() {
  return readJson('settings.json', {});
}

function setSettings(patch) {
  writeJson('settings.json', { ...getSettings(), ...patch });
}

function loadAccounts() {
  const out = [];
  for (const a of readJson('accounts.json', [])) {
    try {
      out.push({ id: a.id, email: a.email, tokens: unseal(a.tokens) });
    } catch {
      // Unreadable entry (e.g. copied from another machine): drop it, user reconnects.
    }
  }
  return out;
}

function saveAccounts(list) {
  writeJson('accounts.json', list.map(a => ({ id: a.id, email: a.email, tokens: seal(a.tokens) })));
}

module.exports = { migrateLegacyData, getCredentials, setCredentials, getSettings, setSettings, loadAccounts, saveAccounts };
