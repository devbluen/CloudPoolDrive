const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./core/config');
const auth = require('./core/auth');
const { Pool, downloadName } = require('./core/pool');
const { TransferManager } = require('./core/transfers');
const i18n = require('./renderer/i18n');

const { t } = i18n;

let win;
let creds = null;
let saved = []; // [{ id, email, tokens }]
let pool = new Pool();
const transfers = new TransferManager(3);

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function state() {
  return { configured: !!creds, lang: i18n.getLang(), accounts: pool.accounts.map(a => a.summary()) };
}

function persist() {
  config.saveAccounts(saved);
}

async function attach(entry) {
  const client = auth.makeClient(creds);
  client.setCredentials(entry.tokens);
  client.on('tokens', t => {
    entry.tokens = { ...entry.tokens, ...t };
    persist();
  });
  const acc = pool.add({ id: entry.id, email: entry.email, client, limited: !auth.hasFullAccess(entry.tokens) });
  await acc.init();
  return acc;
}

async function loadPool() {
  pool = new Pool();
  if (creds) await Promise.all(saved.map(attach));
}

transfers.on('update', list => send('transfers', list));
transfers.on('idle', async () => {
  await Promise.all(pool.ready().map(a => a.refreshQuota().catch(() => {})));
  send('state', state());
});

// ---------- transfers ----------

function walkLocal(dir, rel = [], out = { files: [], emptyDirs: [] }) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (!entries.length) out.emptyDirs.push(rel);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkLocal(full, [...rel, e.name], out);
    else if (e.isFile()) out.files.push({ full, rel, name: e.name, size: fs.statSync(full).size });
  }
  return out;
}

function queueUpload(destSegs, localPath, name, size) {
  transfers.add({
    kind: 'upload',
    name,
    size,
    run: async (signal, progress) => {
      const acc = pool.pickAccount(size);
      try {
        const parentId = await acc.folderId(destSegs, true);
        await acc.upload(localPath, name, size, parentId, signal, progress);
        acc.usage += size;
      } finally {
        acc.reserved -= size;
      }
      send('changed', destSegs);
    },
  });
}

async function uploadPaths(destSegs, localPaths) {
  for (const p of localPaths) {
    const stat = fs.statSync(p);
    const base = path.basename(p);
    if (stat.isDirectory()) {
      const root = [...destSegs, base];
      const { files, emptyDirs } = walkLocal(p);
      for (const rel of emptyDirs) await pool.ensureFolder([...root, ...rel]);
      for (const f of files) queueUpload([...root, ...f.rel], f.full, f.name, f.size);
      if (emptyDirs.length) send('changed', destSegs);
    } else if (stat.isFile()) {
      queueUpload(destSegs, p, base, stat.size);
    }
  }
}

// Picks a free local name: "foto.jpg", "foto (2).jpg", ...
function uniquePath(dir, name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(candidate)) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

const safeLocalName = name => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || t('noName');

function queueDownload(item, dest) {
  transfers.add({
    kind: 'download',
    name: downloadName(item),
    size: item.size,
    run: async (signal, progress) => {
      await pool.get(item.accId).download(item, dest, signal, progress);
    },
  });
}

async function download(segs, items) {
  if (items.length === 1 && items[0].type === 'file') {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: safeLocalName(downloadName(items[0])) });
    if (!canceled) queueDownload(items[0], filePath);
    return;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t('chooseSaveDir'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled) return;
  const target = filePaths[0];
  const taken = new Set();
  for (const item of items) {
    if (item.type === 'file') {
      queueDownload(item, uniquePath(target, safeLocalName(downloadName(item)), taken));
      continue;
    }
    const root = uniquePath(target, safeLocalName(item.name), taken);
    const { dirs, files } = await pool.walk([...segs, item.name]);
    for (const rel of dirs) fs.mkdirSync(path.join(root, ...rel.map(safeLocalName)), { recursive: true });
    for (const { rel, item: file } of files) {
      queueDownload(file, uniquePath(path.join(root, ...rel.map(safeLocalName)), safeLocalName(downloadName(file)), taken));
    }
  }
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

const segsOf = p => {
  // Existing Drive folders may have "/" in their names, so only empty segments are invalid.
  if (!Array.isArray(p) || p.some(s => typeof s !== 'string' || !s)) throw new Error(t('invalidPath'));
  return p;
};

handle('state', () => state());

handle('lang:set', lang => {
  i18n.setLang(lang);
  config.setSettings({ lang: i18n.getLang() });
  return state();
});

// The setup guide only ever opens Google Cloud console pages.
handle('open-external', url => {
  if (!/^https:\/\/console\.cloud\.google\.com\//.test(url)) throw new Error('URL not allowed.');
  return shell.openExternal(url);
});

handle('credentials:save', async ({ clientId, clientSecret }) => {
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!clientId.endsWith('.apps.googleusercontent.com')) throw new Error(t('invalidClientId'));
  if (!clientSecret) throw new Error(t('missingSecret'));
  // Tokens belong to the OAuth client that issued them; a new client means reconnecting.
  if (creds && creds.clientId !== clientId) {
    saved = [];
    persist();
  }
  creds = { clientId, clientSecret };
  config.setCredentials(creds);
  await loadPool();
  return state();
});

handle('credentials:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t('importTitle'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled) return null;
  const json = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  const c = json.installed || json.web;
  if (!c) throw new Error(t('importUnknown'));
  return { clientId: c.client_id, clientSecret: c.client_secret };
});

handle('account:add', async () => {
  if (!creds) throw new Error(t('needCredentials'));
  const { email, tokens } = await auth.signIn(creds);
  let entry = saved.find(s => s.email === email);
  if (entry) {
    entry.tokens = tokens;
    pool.remove(entry.id);
  } else {
    entry = { id: crypto.randomUUID(), email, tokens };
    saved.push(entry);
  }
  persist();
  const acc = await attach(entry);
  if (!acc.ready) throw new Error(`${email}: ${acc.summary().error}`);
  return state();
});

handle('account:remove', id => {
  saved = saved.filter(s => s.id !== id);
  pool.remove(id);
  persist();
  return state();
});

handle('fs:list', p => pool.list(segsOf(p)));
handle('fs:mkdir', (p, name) => pool.mkdir(segsOf(p), name));
handle('fs:rename', (p, item, name) => pool.rename(segsOf(p), item, name));
handle('fs:delete', async (p, items) => {
  await pool.remove(segsOf(p), items);
  send('state', state());
});

handle('trash:list', () => pool.listTrash());
handle('trash:restore', async items => {
  await pool.restore(items);
  send('state', state());
});
handle('trash:delete', async items => {
  await pool.deleteForever(items);
  send('state', state());
});
handle('trash:empty', async () => {
  await pool.emptyTrash();
  send('state', state());
});

handle('fs:upload-dialog', async (p, kind) => {
  const segs = segsOf(p);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: t(kind === 'folder' ? 'uploadFolder' : 'uploadFiles'),
    properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
  });
  if (!canceled) await uploadPaths(segs, filePaths);
});
handle('fs:upload-paths', (p, paths) => uploadPaths(segsOf(p), paths));
handle('fs:download', (p, items) => download(segsOf(p), items));

handle('transfer:cancel', id => transfers.cancel(id));
handle('transfer:retry', id => transfers.retry(id));
handle('transfer:clear', () => transfers.clearFinished());
handle('transfer:list', () => transfers.snapshot());

// ---------- app ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 820,
    minHeight: 520,
    title: 'Cloud Pool Drive',
    backgroundColor: '#0f1320',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  config.migrateLegacyData();
  i18n.setLang(config.getSettings().lang || i18n.fromLocale(app.getLocale()));
  creds = config.getCredentials();
  saved = config.loadAccounts();
  createWindow();
  await loadPool();
  send('state', state());
});

app.on('window-all-closed', () => app.quit());
