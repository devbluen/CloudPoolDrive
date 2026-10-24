// Exercises src/core/pool.js against an in-memory fake of the Drive v3 REST API.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool, downloadName } = require('../src/core/pool');

const FOLDER = 'application/vnd.google-apps.folder';
const drives = {}; // token -> { files: Map, limit, usage, sessions }
let nextId = 1;
let failNextChunk = false;

function makeDrive(token, limit) {
  drives[token] = { files: new Map([['root', { id: 'root', name: 'root', mimeType: FOLDER, parents: [] }]]), limit, usage: 0, sessions: new Map() };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

global.fetch = async (input, opts = {}) => {
  const url = new URL(String(input));
  const d = drives[opts.headers.Authorization.split(' ')[1]];
  const method = opts.method || 'GET';
  const p = url.pathname;

  if (p.startsWith('/session/')) {
    const s = d.sessions.get(p);
    const range = opts.headers['Content-Range'];
    if (!range) { s.received = s.size; }
    else if (range.startsWith('bytes */')) {
      return new Response(null, { status: 308, headers: s.received ? { range: `bytes=0-${s.received - 1}` } : {} });
    } else {
      if (failNextChunk) { failNextChunk = false; s.data.push(Buffer.from(opts.body)); s.received += opts.body.length; throw new TypeError('fetch failed (simulated)'); }
      s.data.push(Buffer.from(opts.body));
      s.received += opts.body.length;
    }
    if (s.received < s.size) return new Response(null, { status: 308, headers: { range: `bytes=0-${s.received - 1}` } });
    const id = 'f' + nextId++;
    const content = Buffer.concat(s.data);
    d.files.set(id, { id, name: s.meta.name, parents: s.meta.parents, mimeType: 'application/octet-stream', size: String(content.length), content, modifiedTime: new Date().toISOString() });
    d.usage += content.length;
    return json({ id });
  }
  if (p === '/upload/drive/v3/files') {
    const sp = `/session/${nextId++}`;
    d.sessions.set(sp, { meta: JSON.parse(opts.body), size: Number(opts.headers['X-Upload-Content-Length']), received: 0, data: [] });
    return new Response(null, { status: 200, headers: { location: 'https://fake' + sp } });
  }
  if (p === '/drive/v3/about') return json({ storageQuota: { limit: String(d.limit), usage: String(d.usage) } });
  if (p === '/drive/v3/files' && method === 'GET') {
    const q = url.searchParams.get('q');
    if (q === 'trashed = true') {
      // Like Drive: children of a trashed folder are trashed too, but not explicitly.
      const isTrashed = f => f.trashed || f.parents.some(p => d.files.get(p) && isTrashed(d.files.get(p)));
      const files = [...d.files.values()].filter(f => f.id !== 'root' && isTrashed(f))
        .map(({ content, parents, ...f }) => ({ ...f, explicitlyTrashed: !!f.trashed }));
      return json({ files });
    }
    const parent = q.match(/^'([^']+)' in parents/)[1];
    const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1');
    const onlyFolders = q.includes(`mimeType = '${FOLDER}'`);
    let files = [...d.files.values()].filter(f => f.parents.includes(parent) && !f.trashed && (!name || f.name === name) && (!onlyFolders || f.mimeType === FOLDER));
    files = files.map(({ content, parents, ...f }) => f);
    return json({ files });
  }
  if (p === '/drive/v3/files' && method === 'POST') {
    const body = JSON.parse(opts.body);
    const id = 'd' + nextId++;
    d.files.set(id, { id, ...body, modifiedTime: new Date().toISOString() });
    return json({ id });
  }
  if (p === '/drive/v3/files/trash' && method === 'DELETE') {
    for (const f of [...d.files.values()]) if (f.trashed) d.files.delete(f.id);
    return new Response(null, { status: 204 });
  }
  const ex = p.match(/^\/drive\/v3\/files\/([^/]+)\/export$/);
  if (ex) return new Response('EXPORTED ' + url.searchParams.get('mimeType'));
  const m = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (m) {
    const f = d.files.get(m[1]);
    if (!f) return json({ error: { message: 'not found' } }, 404);
    if (method === 'PATCH') { Object.assign(f, JSON.parse(opts.body)); return json({ id: f.id }); }
    if (method === 'DELETE') {
      const del = id => { for (const c of [...d.files.values()].filter(x => x.parents.includes(id))) del(c.id); d.usage -= Number(d.files.get(id).size || 0); d.files.delete(id); };
      del(f.id);
      return new Response(null, { status: 204 });
    }
    if (url.searchParams.get('alt') === 'media') return new Response(f.content);
  }
  throw new Error('unhandled ' + method + ' ' + url);
};

const fakeClient = token => ({ getAccessToken: async () => ({ token }) });

(async () => {
  makeDrive('A', 100 * 1024 * 1024);
  makeDrive('B', 300 * 1024 * 1024);
  const pool = new Pool();
  const a = pool.add({ id: 'a', email: 'a@x', client: fakeClient('A') });
  const b = pool.add({ id: 'b', email: 'b@x', client: fakeClient('B') });
  await Promise.all([a.init(), b.init()]);
  assert(a.ready && b.ready, 'accounts ready');

  // Folder created once in the account with the most free space (B).
  await pool.mkdir([], "Fotos d'Ana");
  await assert.rejects(pool.mkdir([], "Fotos d'Ana"), /Já existe/);
  assert.equal((await pool.list([]))[0].accounts.join(), 'b');

  // Upload a 20 MB file (3 chunks) with a simulated network failure mid-way.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
  const src = path.join(tmp, 'big.bin');
  const data = Buffer.alloc(20 * 1024 * 1024 + 123);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
  fs.writeFileSync(src, data);
  const target = pool.pickAccount(data.length);
  assert.equal(target.id, 'b');
  failNextChunk = true;
  const progress = [];
  const parent = await target.folderId(["Fotos d'Ana", 'sub'], true);
  await target.upload(src, 'big.bin', data.length, parent, new AbortController().signal, n => progress.push(n));
  target.reserved -= data.length;
  assert.equal(progress.at(-1), data.length);

  // Same virtual folder created in account A too; listing must merge both.
  const aParent = await a.folderId(["Fotos d'Ana", 'sub'], true);
  fs.writeFileSync(path.join(tmp, 'small.txt'), 'olá');
  await a.upload(path.join(tmp, 'small.txt'), 'small.txt', 4, aParent, new AbortController().signal, () => {});
  const merged = await pool.list(["Fotos d'Ana"]);
  assert.deepEqual(merged.map(i => [i.name, i.accounts.sort().join()]), [['sub', 'a,b']]);
  const sub = await pool.list(["Fotos d'Ana", 'sub']);
  assert.deepEqual(sub.map(i => `${i.name}@${i.accId}`), ['big.bin@b', 'small.txt@a']);

  // Download round-trips the bytes.
  const dest = path.join(tmp, 'out.bin');
  await b.download(sub[0], dest, new AbortController().signal, () => {});
  assert(fs.readFileSync(dest).equals(data), 'download content matches');

  // Walk, rename across accounts, delete.
  const walked = await pool.walk(["Fotos d'Ana"]);
  assert.equal(walked.files.length, 2);
  await pool.rename(["Fotos d'Ana"], { type: 'folder', name: 'sub' }, 'novo');
  assert.deepEqual((await pool.list(["Fotos d'Ana"])).map(i => i.name), ['novo']);
  assert.equal((await pool.list(["Fotos d'Ana", 'novo'])).length, 2);
  await pool.remove([], [{ type: 'folder', name: "Fotos d'Ana" }]);
  assert.equal((await pool.list([])).length, 0);
  // Deletion goes to the trash in every account that had the folder; nothing is destroyed.
  const trashed = [...drives.A.files.values(), ...drives.B.files.values()].filter(f => f.name === "Fotos d'Ana");
  assert.equal(trashed.length, 2);
  assert(trashed.every(f => f.trashed === true), 'moved to trash');

  // Space accounting: nothing fits a file larger than any single account.
  await assert.rejects(async () => pool.pickAccount(400 * 1024 * 1024), /Nenhuma conta tem/);

  // Concurrent uploads into a brand-new folder must not create duplicate folders.
  await Promise.all([1, 2, 3, 4].map(() => b.folderId(['x', 'y'], true)));
  b.forget(['x']);
  const xs = [...drives.B.files.values()].filter(f => f.name === 'x');
  assert.equal(xs.length, 1, 'no duplicate folders');

  // Files that already existed in an account's My Drive show up in the pool.
  makeDrive('C', 15 * 1024 * 1024);
  const C = drives.C.files;
  C.set('c1', { id: 'c1', name: 'antigo.txt', mimeType: 'text/plain', parents: ['root'], size: '3', content: Buffer.from('abc') });
  C.set('c2', { id: 'c2', name: 'Planilha', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['root'] });
  C.set('c3', { id: 'c3', name: 'atalho', mimeType: 'application/vnd.google-apps.shortcut', parents: ['root'] });
  C.set('c4', { id: 'c4', name: 'Form', mimeType: 'application/vnd.google-apps.form', parents: ['root'] });
  C.set('c5', { id: 'c5', name: 'A/B testes', mimeType: FOLDER, parents: ['root'] });
  C.set('c6', { id: 'c6', name: 'dentro.txt', mimeType: 'text/plain', parents: ['c5'], size: '1', content: Buffer.from('z') });
  const c = pool.add({ id: 'c', email: 'c@x', client: fakeClient('C') });
  await c.init();
  const rootList = await pool.list([]);
  const names = rootList.map(i => i.name);
  assert(names.includes('antigo.txt') && names.includes('Planilha') && names.includes('A/B testes'), 'existing files listed');
  assert(!names.includes('atalho'), 'shortcuts hidden');
  assert.equal(rootList.find(i => i.name === 'Planilha').native, true);

  // A folder whose name contains "/" can be opened.
  assert.deepEqual((await pool.list(['A/B testes'])).map(i => i.name), ['dentro.txt']);

  // Google Sheets are exported as .xlsx; forms cannot be downloaded.
  const sheet = rootList.find(i => i.name === 'Planilha');
  assert.equal(downloadName(sheet), 'Planilha.xlsx');
  const sheetDest = path.join(tmp, 'Planilha.xlsx');
  await c.download(sheet, sheetDest, new AbortController().signal, () => {});
  assert(fs.readFileSync(sheetDest, 'utf8').includes('spreadsheetml'), 'exported as xlsx');
  await assert.rejects(c.download(rootList.find(i => i.name === 'Form'), path.join(tmp, 'f'), new AbortController().signal, () => {}), /não pode ser baixado/);

  // An account connected with the old drive.file permission is not used until reconnected.
  const old = pool.add({ id: 'o', email: 'o@x', client: fakeClient('C'), limited: true });
  await old.init();
  assert(!old.ready && /Reconecte/.test(old.summary().error), 'limited account asks to reconnect');

  // Trash: only explicitly trashed items are listed (not the contents of a trashed folder).
  const trashList = await pool.listTrash();
  assert.deepEqual(trashList.map(i => `${i.name}@${i.accId}`).sort(), ["Fotos d'Ana@a", "Fotos d'Ana@b"]);
  assert.equal(new Set(trashList.map(i => `${i.accId}:${i.id}`)).size, 2, 'same-name items stay distinct');

  // Restore brings the folder back into the merged view.
  await pool.restore([trashList.find(i => i.accId === 'b')]);
  assert((await pool.list([])).some(i => i.name === "Fotos d'Ana" && i.accounts.includes('b')), 'restored');

  // Delete forever removes it for good; empty trash clears the rest.
  await pool.deleteForever([(await pool.listTrash()).find(i => i.accId === 'a')]);
  assert.equal([...drives.A.files.values()].filter(f => f.name === "Fotos d'Ana").length, 0, 'deleted forever');
  await pool.remove([], [{ type: 'file', name: 'antigo.txt', id: 'c1', accId: 'c' }]);
  assert.equal((await pool.listTrash()).length, 1);
  await pool.emptyTrash();
  assert.equal((await pool.listTrash()).length, 0, 'trash emptied');
  assert(!drives.C.files.has('c1'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL OK');
})().catch(e => { console.error(e); process.exit(1); });
