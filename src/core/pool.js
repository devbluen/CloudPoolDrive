const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { t, formatSize } = require('../renderer/i18n');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const SEP = '\u0000'; // joins path segments in cache keys; folder names may contain "/"

// Google Docs/Sheets/Slides have no binary content: they are downloaded converted.
const EXPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.script': { mime: 'application/vnd.google-apps.script+json', ext: '.json' },
};
const isNative = mime => mime.startsWith('application/vnd.google-apps.');

// Local file name for a download, with the export extension for Google files.
function downloadName(item) {
  const exp = EXPORTS[item.mimeType];
  return exp && !item.name.toLowerCase().endsWith(exp.ext) ? item.name + exp.ext : item.name;
}
const CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const MAX_RETRIES = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const quote = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

function checkName(name) {
  if (!name || !name.trim()) throw new Error(t('nameEmpty'));
  if (name.includes('/')) throw new Error(t('nameSlash'));
}

function googleMessage(text) {
  try {
    return JSON.parse(text).error.message;
  } catch {
    return text.slice(0, 200);
  }
}

class Account {
  constructor({ id, email, client, limited = false }) {
    this.id = id;
    this.email = email;
    this.client = client;
    this.limited = limited; // connected with the old drive.file permission; must reconnect
    this.rootId = null;
    this.limit = 0; // 0 = unlimited
    this.usage = 0;
    this.reserved = 0; // bytes claimed by uploads in progress
    this.trashUsage = 0; // bytes in this account's Drive trash (still count against the quota)
    this.error = null;
    this.folders = new Map(); // virtual path (segments joined by SEP) -> folder id
    this.pending = new Map(); // in-flight folder lookups, to avoid duplicate creation
  }

  get ready() {
    return !this.error && !this.expired && !this.limited && !!this.rootId;
  }

  get free() {
    return this.limit ? this.limit - this.usage - this.reserved : Infinity;
  }

  summary() {
    return { id: this.id, email: this.email, limit: this.limit, usage: this.usage, trash: this.trashUsage, error: this.limited ? t('needsFullAccess') : this.expired ? t('accountExpired') : this.error, ready: this.ready };
  }

  async init() {
    if (this.limited) return;
    try {
      await this.refreshQuota();
      this.rootId = 'root'; // the pool's root is each account's My Drive
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  async token() {
    try {
      return (await this.client.getAccessToken()).token;
    } catch (e) {
      if (/invalid_grant|invalid_client|unauthorized_client/.test(String(e.message))) {
        this.expired = true;
        throw new Error(`${this.email}: ${t('accountExpired')}`);
      }
      throw e;
    }
  }

  // fetch with auth and retries on rate limits / server errors / network failures.
  async request(url, { accept = [], signal, headers, retries = MAX_RETRIES, ...opts } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const token = await this.token();
        res = await fetch(url, { ...opts, signal, redirect: 'manual', headers: { ...headers, Authorization: `Bearer ${token}` } });
      } catch (e) {
        if (signal?.aborted || attempt >= retries || this.expired) throw e;
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (res.ok || accept.includes(res.status)) return res;
      const text = await res.text();
      const retriable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rate ?limit/i.test(text));
      if (retriable && attempt < retries && !signal?.aborted) {
        await sleep(2 ** attempt * 500 + Math.random() * 500);
        continue;
      }
      throw new Error(`Google Drive (${res.status}): ${googleMessage(text)}`);
    }
  }

  async json(method, path, { query, body, accept } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await this.request(url, {
      method,
      accept,
      headers: body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204 || res.status === 404) return null;
    return res.json();
  }

  async refreshQuota() {
    const { storageQuota: q } = await this.json('GET', '/about', { query: { fields: 'storageQuota' } });
    this.limit = Number(q.limit || 0);
    this.usage = Number(q.usage || 0);
    this.trashUsage = Number(q.usageInDriveTrash || 0);
  }

  async findChildFolder(parentId, name) {
    const r = await this.json('GET', '/files', {
      query: {
        q: `${quote(parentId)} in parents and name = ${quote(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: 'files(id)',
        pageSize: '1',
      },
    });
    return r.files[0]?.id || null;
  }

  // Trash instead of permanent delete: the user can restore it from Drive for 30 days.
  async trash(id) {
    await this.json('PATCH', `/files/${encodeURIComponent(id)}`, { body: { trashed: true }, accept: [404] });
  }

  async restore(id) {
    await this.json('PATCH', `/files/${encodeURIComponent(id)}`, { body: { trashed: false }, accept: [404] });
    this.folders.clear(); // a restored folder can bring back paths the cache considered missing
  }

  async deleteForever(id) {
    await this.json('DELETE', `/files/${encodeURIComponent(id)}`, { accept: [404] });
  }

  // Empties this account's whole Google Drive trash, including items trashed outside the app.
  async emptyTrash() {
    await this.json('DELETE', '/files/trash');
  }

  // Items the user put in the trash. Their contents (trashed along with them) are left out,
  // like the Trash view on the Google Drive website.
  async listTrash() {
    const out = [];
    let pageToken;
    do {
      const query = {
        q: 'trashed = true',
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, explicitlyTrashed)',
        pageSize: '1000',
      };
      if (pageToken) query.pageToken = pageToken;
      const r = await this.json('GET', '/files', { query });
      out.push(...r.files.filter(f => f.explicitlyTrashed));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(parentId, name) {
    const r = await this.json('POST', '/files', {
      query: { fields: 'id' },
      body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    });
    return r.id;
  }

  async listChildren(parentId) {
    const out = [];
    let pageToken;
    do {
      const query = {
        q: `${quote(parentId)} in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
        pageSize: '1000',
      };
      if (pageToken) query.pageToken = pageToken;
      const r = await this.json('GET', '/files', { query });
      out.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  // Resolves a virtual path to this account's folder id; null if missing (unless create).
  async folderId(segs, create = false) {
    let parent = this.rootId;
    for (let i = 0; i < segs.length; i++) {
      parent = await this.resolveStep(parent, segs.slice(0, i + 1).join(SEP), segs[i], create);
      if (!parent) return null;
    }
    return parent;
  }

  async resolveStep(parent, key, name, create) {
    for (;;) {
      const cached = this.folders.get(key);
      if (cached) return cached;
      const inflight = this.pending.get(key);
      if (inflight) {
        const id = await inflight.catch(() => null);
        if (id || !create) return id;
        if (this.pending.get(key) === inflight) this.pending.delete(key);
        continue;
      }
      const p = (async () => {
        const id = (await this.findChildFolder(parent, name)) || (create ? await this.createFolder(parent, name) : null);
        if (id) this.folders.set(key, id);
        return id;
      })();
      this.pending.set(key, p);
      try {
        return await p;
      } finally {
        if (this.pending.get(key) === p) this.pending.delete(key);
      }
    }
  }

  forget(segs) {
    const prefix = segs.join(SEP);
    for (const key of [...this.folders.keys()]) {
      if (key === prefix || key.startsWith(prefix + SEP)) this.folders.delete(key);
    }
  }

  // Resumable upload in chunks, so large files survive network hiccups.
  async upload(localPath, name, size, parentId, signal, onProgress) {
    const init = await this.request(`${UPLOAD_API}?uploadType=resumable&fields=id`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    const session = init.headers.get('location');
    if (size === 0) {
      await this.request(session, { method: 'PUT', signal, body: Buffer.alloc(0) });
      return;
    }

    const fh = await fs.promises.open(localPath, 'r');
    try {
      let offset = 0;
      let recoveries = 0;
      while (offset < size) {
        const len = Math.min(CHUNK_SIZE, size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        let res;
        try {
          // No blind resend on failure: the server may have stored part of the chunk.
          res = await this.request(session, {
            method: 'PUT',
            signal,
            retries: 0,
            accept: [308],
            headers: { 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` },
            body: buf,
          });
          recoveries = 0;
        } catch (e) {
          if (signal.aborted || ++recoveries > MAX_RETRIES) throw e;
          await sleep(2 ** recoveries * 500);
          // Ask the server how much it actually received, then continue from there.
          res = await this.request(session, {
            method: 'PUT',
            signal,
            accept: [308],
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        if (res.status === 308) {
          const range = res.headers.get('range');
          offset = range ? Number(range.split('-')[1]) + 1 : 0;
        } else {
          offset = size;
        }
        onProgress(offset);
      }
    } finally {
      await fh.close();
    }
  }

  async download(item, dest, signal, onProgress) {
    const id = encodeURIComponent(item.id);
    let url = `${API}/files/${id}?alt=media`;
    if (isNative(item.mimeType)) {
      const exp = EXPORTS[item.mimeType];
      if (!exp) throw new Error(t('cannotDownload'));
      url = `${API}/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}`;
    }
    const res = await this.request(url, { signal });
    const tmp = dest + '.part';
    let done = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', chunk => {
      done += chunk.length;
      onProgress(done);
    });
    try {
      await pipeline(body, fs.createWriteStream(tmp), { signal });
      await fs.promises.rename(tmp, dest);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
  }
}

// Presents every connected account as one storage: the root is the union of every account's My Drive,
// and a virtual folder is the union of the same path across all accounts.
class Pool {
  constructor() {
    this.accounts = [];
  }

  add(info) {
    const acc = new Account(info);
    this.accounts.push(acc);
    return acc;
  }

  remove(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
  }

  get(id) {
    const acc = this.accounts.find(a => a.id === id);
    if (!acc) throw new Error(t('accountNotFound'));
    if (!acc.ready) throw new Error(`${acc.email}: ${acc.summary().error || t('accountUnavailable')}`);
    return acc;
  }

  ready() {
    return this.accounts.filter(a => a.ready);
  }

  // Account with the most free space that fits `size`; reserves the space until release().
  pickAccount(size) {
    const ready = this.ready();
    if (!ready.length) throw new Error(t('needAccount'));
    const best = ready.sort((a, b) => b.free - a.free)[0];
    if (best.free < size) {
      throw new Error(t('noSpace', { size: formatSize(size), free: formatSize(Math.max(0, best.free)) }));
    }
    best.reserved += size;
    return best;
  }

  async list(segs) {
    const results = await Promise.all(this.ready().map(async acc => {
      const id = await acc.folderId(segs);
      return id ? { acc, children: await acc.listChildren(id) } : null;
    }));
    if (segs.length && !results.some(Boolean)) throw new Error(t('folderNotFound'));

    const folders = new Map();
    const files = [];
    for (const r of results) {
      if (!r) continue;
      for (const f of r.children) {
        if (f.mimeType === FOLDER_MIME) {
          const key = [...segs, f.name].join(SEP);
          if (!r.acc.folders.has(key)) r.acc.folders.set(key, f.id);
          const cur = folders.get(f.name) || { type: 'folder', name: f.name, modifiedTime: f.modifiedTime, accounts: [] };
          if (!cur.accounts.includes(r.acc.id)) cur.accounts.push(r.acc.id);
          if (f.modifiedTime > cur.modifiedTime) cur.modifiedTime = f.modifiedTime;
          folders.set(f.name, cur);
        } else if (f.mimeType !== SHORTCUT_MIME) {
          files.push({
            type: 'file',
            name: f.name,
            id: f.id,
            accId: r.acc.id,
            size: Number(f.size || 0),
            mimeType: f.mimeType,
            native: isNative(f.mimeType),
            modifiedTime: f.modifiedTime,
          });
        }
      }
    }
    return [...folders.values()].sort(byName).concat(files.sort(byName));
  }

  async folderExists(segs) {
    const ids = await Promise.all(this.ready().map(a => a.folderId(segs)));
    return ids.some(Boolean);
  }

  async ensureFolder(segs) {
    if (await this.folderExists(segs)) return;
    const acc = this.pickAccount(0);
    await acc.folderId(segs, true);
  }

  async mkdir(segs, name) {
    checkName(name);
    const target = [...segs, name];
    if (await this.folderExists(target)) throw new Error(t('folderExists'));
    await this.ensureFolder(target);
  }

  async rename(segs, item, newName) {
    checkName(newName);
    if (item.type === 'file') {
      await this.get(item.accId).json('PATCH', `/files/${encodeURIComponent(item.id)}`, { body: { name: newName } });
      return;
    }
    const from = [...segs, item.name];
    if (await this.folderExists([...segs, newName])) throw new Error(t('folderExists'));
    await Promise.all(this.ready().map(async acc => {
      const id = await acc.folderId(from);
      if (!id) return;
      await acc.json('PATCH', `/files/${encodeURIComponent(id)}`, { body: { name: newName } });
      acc.forget(from);
    }));
  }

  async remove(segs, items) {
    const touched = new Set();
    for (const item of items) {
      if (item.type === 'file') {
        const acc = this.get(item.accId);
        await acc.trash(item.id);
        touched.add(acc);
        continue;
      }
      const path = [...segs, item.name];
      await Promise.all(this.ready().map(async acc => {
        const id = await acc.folderId(path);
        if (!id) return;
        await acc.trash(id);
        acc.forget(path);
        touched.add(acc);
      }));
    }
    await Promise.all([...touched].map(a => a.refreshQuota().catch(() => {})));
  }

  // ---------- trash ----------

  async listTrash() {
    const lists = await Promise.all(this.ready().map(async acc => (await acc.listTrash()).map(f => ({
      type: f.mimeType === FOLDER_MIME ? 'folder' : 'file',
      name: f.name,
      id: f.id,
      accId: acc.id,
      size: Number(f.size || 0),
      mimeType: f.mimeType,
      native: isNative(f.mimeType) && f.mimeType !== FOLDER_MIME,
      modifiedTime: f.modifiedTime,
    }))));
    const items = lists.flat();
    return items.filter(i => i.type === 'folder').sort(byName).concat(items.filter(i => i.type === 'file').sort(byName));
  }

  async restore(items) {
    for (const item of items) await this.get(item.accId).restore(item.id);
  }

  async deleteForever(items) {
    const touched = new Set();
    for (const item of items) {
      const acc = this.get(item.accId);
      await acc.deleteForever(item.id);
      touched.add(acc);
    }
    await Promise.all([...touched].map(a => a.refreshQuota().catch(() => {})));
  }

  async emptyTrash() {
    await Promise.all(this.ready().map(async acc => {
      await acc.emptyTrash();
      await acc.refreshQuota().catch(() => {});
    }));
  }

  // Every folder and file under a virtual folder, with paths relative to it.
  async walk(segs, rel = []) {
    const out = { dirs: [rel], files: [] };
    for (const item of await this.list(segs)) {
      if (item.type === 'folder') {
        const sub = await this.walk([...segs, item.name], [...rel, item.name]);
        out.dirs.push(...sub.dirs);
        out.files.push(...sub.files);
      } else {
        out.files.push({ rel, item });
      }
    }
    return out;
  }
}

module.exports = { Pool, downloadName };
