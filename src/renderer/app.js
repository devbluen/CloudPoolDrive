// `api` is the global exposed by preload.js; `i18n` comes from i18n.js.
const $ = sel => document.querySelector(sel);
const { t, formatSize } = i18n;

const ICONS = {
  folder: '<svg class="ficon folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg class="ficon file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};
const PALETTE = ['#3b6cf6', '#1fb57a', '#f2a024', '#e5484d', '#9b5cf6', '#14a3c7', '#d6409f', '#7c8a2e'];

let state = { configured: false, lang: 'pt', accounts: [] };
let cwd = [];
let items = [];
let selected = new Set();
let anchor = -1;
let focusKey = null; // file highlighted by a plain click; not a selection
let view = 'files'; // 'files' (the merged drives) or 'trash'
let transfers = [];
let transfersOpen = false;
let loadSeq = 0;

// Setup guide: one Google Cloud page per step; the last step imports the credential.
const GUIDE = [
  { key: 'project', url: 'https://console.cloud.google.com/projectcreate' },
  { key: 'api', url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com' },
  { key: 'consent', url: 'https://console.cloud.google.com/auth/overview' },
  { key: 'publish', url: 'https://console.cloud.google.com/auth/audience' },
  { key: 'client', url: 'https://console.cloud.google.com/auth/clients' },
  { key: 'import' },
];
let guideStep = 0;

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v; // CSSOM is allowed by the CSP; a style attribute is not
    else if (k === 'html') node.innerHTML = v; // only used with static icon markup
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const formatDate = iso => (iso ? new Intl.DateTimeFormat(i18n.locale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');
// Items with an id are unique per account; merged folders (no id) are identified by name.
const keyOf = it => (it.id ? `f:${it.accId}:${it.id}` : 'd:' + it.name);
const accountIndex = id => state.accounts.findIndex(a => a.id === id);
const accountEmail = id => state.accounts.find(a => a.id === id)?.email || '?';
const readyIds = () => state.accounts.filter(a => a.ready).map(a => a.id).join();
const sameDir = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

// Fixed palette first; beyond that, golden-angle hues keep any number of accounts distinguishable.
function accountColor(id) {
  const i = Math.max(0, accountIndex(id));
  return i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)} 62% 52%)`;
}

function toast(message, type = 'info') {
  const n = el('div', { class: `toast ${type}` }, message);
  $('#toasts').append(n);
  setTimeout(() => n.remove(), type === 'error' ? 7000 : 3500);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}

// ---------- language ----------

function translateStatic() {
  document.documentElement.lang = i18n.locale();
  document.title = t('appName');
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml); // trusted dictionary markup
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const sel of document.querySelectorAll('[data-lang-select]')) {
    sel.replaceChildren(...Object.entries(i18n.LANGS).map(([code, name]) => el('option', { value: code }, name)));
    sel.value = i18n.getLang();
    sel.title = t('language');
  }
  renderGuide();
}

async function changeLang(lang) {
  const s = await attempt(() => api.setLang(lang));
  if (!s) return;
  applyState(s);
  renderCrumbs();
  renderList();
  renderTransfers();
}

// ---------- modal ----------

function modal({ title, text = '', input = null, ok = 'OK', danger = false }) {
  return new Promise(resolve => {
    const back = $('#modal');
    const field = $('#modalInput');
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalText').hidden = !text;
    field.hidden = input === null;
    field.value = input ?? '';
    $('#modalOk').textContent = ok;
    $('#modalOk').style.background = danger ? 'var(--danger)' : '';
    $('#modalOk').style.borderColor = danger ? 'var(--danger)' : '';
    back.hidden = false;

    const finish = value => {
      back.hidden = true;
      $('#modalForm').onsubmit = null;
      $('#modalCancel').onclick = null;
      back.onkeydown = null;
      resolve(value);
    };
    $('#modalForm').onsubmit = e => {
      e.preventDefault();
      finish(input === null ? true : field.value.trim());
    };
    $('#modalCancel').onclick = () => finish(input === null ? false : null);
    back.onkeydown = e => { if (e.key === 'Escape') finish(input === null ? false : null); };

    if (input !== null) {
      field.focus();
      // Select the name without the extension, like a file manager does.
      const dot = field.value.lastIndexOf('.');
      field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
    } else {
      $('#modalOk').focus();
    }
  });
}

// ---------- state / sidebar ----------

function applyState(s) {
  const langChanged = s.lang !== i18n.getLang() || !document.title;
  state = s;
  i18n.setLang(s.lang);
  if (langChanged) translateStatic();
  $('#setup').hidden = s.configured;
  $('#app').hidden = !s.configured;
  $('#cancelSetup').hidden = true;
  renderSidebar();
}

function renderSidebar() {
  const ready = state.accounts.filter(a => a.ready);
  const limited = ready.filter(a => a.limit > 0);
  const unlimited = ready.length > limited.length;
  const total = limited.reduce((s, a) => s + a.limit, 0);
  const used = ready.reduce((s, a) => s + a.usage, 0);

  $('#totalValue').textContent = ready.length
    ? t('totalOf', { used: formatSize(used), total: unlimited ? t('unlimited') : formatSize(total) })
    : t('noAccount');
  $('#totalFree').textContent = ready.length && !unlimited
    ? t('freeIn', { free: formatSize(Math.max(0, total - used)), n: ready.length })
    : '';
  $('#accountCount').textContent = state.accounts.length ? `(${state.accounts.length})` : '';
  const trashBytes = ready.reduce((s, a) => s + (a.trash || 0), 0);
  $('#trashSize').textContent = trashBytes ? formatSize(trashBytes) : '';

  const bar = $('#stackbar');
  bar.replaceChildren();
  if (total > 0) {
    for (const a of limited) {
      bar.append(el('div', { style: `width:${(a.usage / total) * 100}%;background:${accountColor(a.id)}`, title: `${a.email}: ${formatSize(a.usage)}` }));
    }
  }

  const list = $('#accounts');
  list.replaceChildren();
  for (const a of state.accounts) {
    const pct = a.limit ? Math.min(100, (a.usage / a.limit) * 100) : 0;
    list.append(el('li', { class: 'account' },
      el('div', { class: 'account-top' },
        el('span', { class: 'dot', style: `background:${accountColor(a.id)}` }),
        el('span', { class: 'account-email', title: a.email }, a.email),
        el('button', { class: 'account-remove', title: t('disconnectAccount'), html: ICONS.x, onclick: () => removeAccount(a) }),
      ),
      a.error
        ? el('div', { class: 'account-error' }, a.error,
          el('div', {}, el('button', { class: 'btn small-btn', onclick: addAccount }, t('reconnect'))))
        : !a.ready ? el('div', { class: 'account-usage' }, t('connecting'))
        : [
          el('div', { class: 'progress' }, el('div', { style: `width:${pct}%;background:${accountColor(a.id)}` })),
          el('div', { class: 'account-usage' }, a.limit
            ? t('accountUsage', { used: formatSize(a.usage), limit: formatSize(a.limit), free: formatSize(a.limit - a.usage) })
            : t('accountUsageUnlimited', { used: formatSize(a.usage) })),
        ],
    ));
  }
}

async function addAccount() {
  const btn = $('#addAccount');
  btn.disabled = true;
  toast(t('loginInBrowser'));
  const s = await attempt(() => api.addAccount());
  btn.disabled = false;
  if (s) {
    applyState(s);
    toast(t('accountConnected'));
    load(cwd);
  }
}

async function removeAccount(a) {
  const ok = await modal({
    title: t('disconnectTitle'),
    text: t('disconnectText', { email: a.email }),
    ok: t('disconnect'),
    danger: true,
  });
  if (!ok) return;
  const s = await attempt(() => api.removeAccount(a.id));
  if (s) {
    applyState(s);
    load(cwd);
  }
}

// ---------- file list ----------

async function load(path = cwd, { keepSelection = false } = {}) {
  const seq = ++loadSeq;
  const changedDir = view !== 'files' || !sameDir(path, cwd);
  view = 'files';
  cwd = path;
  applyView();
  renderCrumbs();
  if (!state.accounts.some(a => a.ready)) {
    items = [];
    selected.clear();
    renderList();
    return;
  }
  const slow = setTimeout(() => { if (seq === loadSeq) $('#loading').hidden = false; }, 150);
  try {
    const result = await api.list(path);
    if (seq !== loadSeq) return;
    items = result;
    if (changedDir || !keepSelection) {
      selected.clear();
      anchor = -1;
      focusKey = null;
    } else {
      const keys = new Set(items.map(keyOf));
      selected = new Set([...selected].filter(k => keys.has(k)));
    }
    renderList();
  } catch (e) {
    if (seq !== loadSeq) return;
    toast(e.message, 'error');
    if (path.length) load(path.slice(0, -1));
  } finally {
    clearTimeout(slow);
    if (seq === loadSeq) $('#loading').hidden = true;
  }
}

async function loadTrash({ keepSelection = false } = {}) {
  const seq = ++loadSeq;
  const changedView = view !== 'trash';
  view = 'trash';
  applyView();
  renderCrumbs();
  if (changedView || !keepSelection) {
    selected.clear();
    anchor = -1;
    focusKey = null;
  }
  if (!state.accounts.some(a => a.ready)) {
    items = [];
    renderList();
    return;
  }
  const slow = setTimeout(() => { if (seq === loadSeq) $('#loading').hidden = false; }, 150);
  try {
    const result = await api.listTrash();
    if (seq !== loadSeq) return;
    items = result;
    const keys = new Set(items.map(keyOf));
    selected = new Set([...selected].filter(k => keys.has(k)));
    renderList();
  } catch (e) {
    if (seq === loadSeq) toast(e.message, 'error');
  } finally {
    clearTimeout(slow);
    if (seq === loadSeq) $('#loading').hidden = true;
  }
}

const reloadView = () => (view === 'trash' ? loadTrash({ keepSelection: true }) : load(cwd, { keepSelection: true }));

// Shows the toolbar / selection buttons of the current view (files or trash).
function applyView() {
  const trash = view === 'trash';
  for (const id of ['newFolder', 'uploadFolder', 'uploadFiles', 'selDownload', 'selRename', 'selDelete']) $('#' + id).hidden = trash;
  for (const id of ['emptyTrash', 'selRestore', 'selDeleteForever']) $('#' + id).hidden = !trash;
  $('#navFiles').classList.toggle('active', !trash);
  $('#navTrash').classList.toggle('active', trash);
}

function renderCrumbs() {
  const nav = $('#crumbs');
  nav.replaceChildren();
  if (view === 'trash') {
    nav.append(el('button', { class: 'crumb current' }, t('trash')));
    return;
  }
  const parts = [{ name: t('myStorage'), path: [] }, ...cwd.map((name, i) => ({ name, path: cwd.slice(0, i + 1) }))];
  parts.forEach((p, i) => {
    if (i) nav.append(el('span', { class: 'crumb-sep' }, '›'));
    const last = i === parts.length - 1;
    nav.append(el('button', { class: 'crumb' + (last ? ' current' : ''), title: p.name, onclick: () => !last && load(p.path) }, p.name));
  });
}

function renderList() {
  const body = $('#rows');
  body.replaceChildren();
  items.forEach((it, i) => {
    const accCell = it.accounts // merged folder; trash items and files belong to one account
      ? el('div', { class: 'acc-cell' },
        el('span', { class: 'dots' }, it.accounts.slice(0, 6).map(id => el('span', { class: 'dot', style: `background:${accountColor(id)}`, title: accountEmail(id) }))),
        el('span', {}, it.accounts.length > 1 ? t('nAccounts', { n: it.accounts.length }) : accountEmail(it.accounts[0])))
      : el('div', { class: 'acc-cell', title: accountEmail(it.accId) },
        el('span', { class: 'dot', style: `background:${accountColor(it.accId)}` }),
        el('span', {}, accountEmail(it.accId)));

    const check = el('input', { type: 'checkbox', class: 'check', title: t('selectAll') });
    check.addEventListener('click', e => { e.stopPropagation(); toggleSelect(i, e.shiftKey); });

    const trash = view === 'trash';
    const quick = trash
      ? el('button', { title: t('restore'), html: ICONS.restore, onclick: e => { e.stopPropagation(); restoreItems([it]); } })
      : el('button', { title: t('download'), html: ICONS.download, onclick: e => { e.stopPropagation(); download([it]); } });
    const actions = el('div', { class: 'row-actions' },
      quick,
      el('button', {
        title: t('more'),
        html: ICONS.more,
        onclick: e => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          showContextMenu(r.right, r.bottom + 4, targetsFor(it), true);
        },
      }));

    const row = el('tr', {
      class: it.type === 'folder' && !trash ? 'is-folder' : '',
      onclick: e => clickRow(e, i),
      ondblclick: e => { if (it.type === 'file' && !trash && !e.ctrlKey && !e.shiftKey) download([it]); },
      oncontextmenu: e => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, targetsFor(it));
      },
    },
    el('td', {}, check),
    el('td', {}, el('div', { class: 'name', html: it.type === 'folder' ? ICONS.folder : ICONS.file }, el('span', { title: it.name }, it.name))),
    el('td', { class: 'td-muted' }, it.type === 'folder' || it.native ? '—' : formatSize(it.size)),
    el('td', {}, accCell),
    el('td', { class: 'td-muted' }, formatDate(it.modifiedTime)),
    el('td', {}, actions));

    if (it.type === 'folder' && !trash) {
      row.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); row.classList.add('drop'); setDropText([...cwd, it.name]); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', e => { e.stopPropagation(); row.classList.remove('drop'); dropFiles(e, [...cwd, it.name]); });
    }
    body.append(row);
  });

  const empty = $('#empty');
  empty.replaceChildren();
  if (!state.accounts.length) {
    empty.append(el('div', { html: ICONS.cloud }), el('b', {}, t('connectFirstTitle')),
      el('div', {}, t('connectFirstText')),
      el('button', { class: 'btn primary', onclick: addAccount }, t('addAccount')));
  } else if (!items.length && view === 'trash') {
    empty.append(el('div', { html: ICONS.trash }), el('b', {}, t('trashEmptyTitle')),
      el('div', {}, t('trashEmptyText')));
  } else if (!items.length) {
    empty.append(el('div', { html: ICONS.empty }), el('b', {}, t('emptyFolderTitle')),
      el('div', {}, t('emptyFolderText')));
  }
  empty.hidden = !!items.length;
  renderSelection();
}

function renderSelection() {
  const rows = $('#rows').children;
  items.forEach((it, i) => {
    const row = rows[i];
    if (!row) return;
    const on = selected.has(keyOf(it));
    row.classList.toggle('selected', on);
    row.classList.toggle('focused', !on && keyOf(it) === focusKey);
    row.querySelector('.check').checked = on;
  });
  const n = selected.size;
  $('#selectionbar').hidden = n === 0;
  $('#selCount').textContent = t('selectedCount', { n });
  $('#selRename').disabled = n !== 1;
  $('.files').classList.toggle('selecting', n > 0);
  const all = $('#checkAll');
  all.checked = n > 0 && n === items.length;
  all.indeterminate = n > 0 && n < items.length;
}

const selectedItems = () => items.filter(it => selected.has(keyOf(it)));

// What an action on `it` applies to: the whole selection if `it` is part of it, otherwise just `it`.
const targetsFor = it => (selected.has(keyOf(it)) ? selectedItems() : [it]);

// Keyboard actions use the selection, or the highlighted file when nothing is selected.
function keyboardTargets() {
  if (selected.size) return selectedItems();
  const it = items.find(x => keyOf(x) === focusKey);
  return it ? [it] : [];
}

function toggleSelect(i, range) {
  const k = keyOf(items[i]);
  if (range && anchor >= 0) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
    for (let j = a; j <= b; j++) selected.add(keyOf(items[j]));
  } else {
    selected.has(k) ? selected.delete(k) : selected.add(k);
    anchor = i;
  }
  renderSelection();
}

// Plain click: a folder opens, a file is just highlighted. Ctrl/Shift+click select, like a file manager.
function clickRow(e, i) {
  const it = items[i];
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    toggleSelect(i, e.shiftKey);
    return;
  }
  if (selected.size) {
    toggleSelect(i, false); // while selecting, clicks keep adding/removing items
    return;
  }
  if (it.type === 'folder' && view === 'files') {
    load([...cwd, it.name]);
    return;
  }
  focusKey = focusKey === keyOf(it) ? null : keyOf(it);
  anchor = i;
  renderSelection();
}

function openItem(it) {
  if (it.type === 'folder') load([...cwd, it.name]);
  else download([it]);
}

// ---------- actions ----------

async function newFolder() {
  const name = await modal({ title: t('newFolder'), input: t('newFolder'), ok: t('create') });
  if (!name) return;
  if (await attempt(() => api.mkdir(cwd, name)) !== undefined) load(cwd);
}

async function renameItem(it) {
  if (!it) return;
  const name = await modal({ title: t('rename'), input: it.name, ok: t('rename') });
  if (!name || name === it.name) return;
  if (await attempt(() => api.rename(cwd, it, name)) !== undefined) load(cwd);
}

async function deleteItems(list) {
  if (!list.length) return;
  const hasFolders = list.some(i => i.type === 'folder');
  const ok = await modal({
    title: list.length === 1 ? t('deleteOneTitle', { name: list[0].name }) : t('deleteManyTitle', { n: list.length }),
    text: t(hasFolders ? 'deleteTextFolders' : 'deleteText'),
    ok: t('delete'),
    danger: true,
  });
  if (!ok) return;
  $('#loading').hidden = false;
  const done = await attempt(() => api.remove(cwd, list));
  $('#loading').hidden = true;
  if (done !== undefined) toast(list.length === 1 ? t('deletedOne') : t('deletedMany', { n: list.length }));
  load(cwd);
}

async function download(list = selectedItems()) {
  if (!list.length) return;
  await attempt(() => api.download(cwd, list));
}

function upload(kind) {
  attempt(() => api.uploadDialog(cwd, kind));
}

// ---------- trash actions ----------

async function restoreItems(list) {
  if (!list.length) return;
  $('#loading').hidden = false;
  const done = await attempt(() => api.restore(list));
  $('#loading').hidden = true;
  if (done !== undefined) toast(list.length === 1 ? t('restoredOne') : t('restoredMany', { n: list.length }));
  loadTrash();
}

async function deleteForeverItems(list) {
  if (!list.length) return;
  const ok = await modal({
    title: list.length === 1 ? t('deleteForeverOneTitle', { name: list[0].name }) : t('deleteForeverManyTitle', { n: list.length }),
    text: t('deleteForeverText'),
    ok: t('deleteForever'),
    danger: true,
  });
  if (!ok) return;
  $('#loading').hidden = false;
  const done = await attempt(() => api.deleteForever(list));
  $('#loading').hidden = true;
  if (done !== undefined) toast(list.length === 1 ? t('deletedForeverOne') : t('deletedForeverMany', { n: list.length }));
  loadTrash();
}

async function emptyTrash() {
  const size = formatSize(state.accounts.filter(a => a.ready).reduce((s, a) => s + (a.trash || 0), 0));
  const ok = await modal({ title: t('emptyTrashTitle'), text: t('emptyTrashText', { size }), ok: t('emptyTrash'), danger: true });
  if (!ok) return;
  $('#loading').hidden = false;
  const done = await attempt(() => api.emptyTrash());
  $('#loading').hidden = true;
  if (done !== undefined) toast(t('trashEmptied'));
  loadTrash();
}

// ---------- context menu ----------

// alignRight: (x, y) is the menu's top-right corner (used by the row "⋯" button).
function showContextMenu(x, y, list, alignRight = false) {
  if (!list.length) return;
  const menu = $('#ctxmenu');
  menu.replaceChildren();
  const add = (icon, label, fn, cls = '') => menu.append(el('li', { class: cls, onclick: () => { hideMenu(); fn(); } }, el('span', { html: ICONS[icon] }), label));
  if (view === 'trash') {
    add('restore', t('restore'), () => restoreItems(list));
    menu.append(el('li', { class: 'sep' }));
    add('delete', t('deleteForever'), () => deleteForeverItems(list), 'danger');
  } else {
    addFileMenu(add, list);
  }
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const r = menu.getBoundingClientRect();
  const left = alignRight ? x - r.width : x;
  menu.style.left = `${Math.max(6, Math.min(left, w - r.width - 6))}px`;
  menu.style.top = `${Math.min(y, h - r.height - 6)}px`;
}

function addFileMenu(add, list) {
  const menu = $('#ctxmenu');
  if (list.length === 1 && list[0].type === 'folder') add('open', t('open'), () => openItem(list[0]));
  add('download', t('download'), () => download(list));
  if (list.length === 1) add('rename', t('rename'), () => renameItem(list[0]));
  menu.append(el('li', { class: 'sep' }));
  add('delete', list.length > 1 ? t('deleteN', { n: list.length }) : t('delete'), () => deleteItems(list), 'danger');
}

function hideMenu() {
  $('#ctxmenu').hidden = true;
}

// ---------- drag & drop ----------

const hasFiles = e => e.dataTransfer?.types.includes('Files');
let dragDepth = 0;

function setDropText(path) {
  $('#dropText').textContent = t('dropTo', { name: path.length ? path[path.length - 1] : t('myStorage') });
}

function dropFiles(e, target) {
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  if (!state.accounts.some(a => a.ready)) {
    toast(t('connectBeforeUpload'), 'error');
    return;
  }
  const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (paths.length) attempt(() => api.uploadPaths(target, paths));
}

function setupDragDrop() {
  const main = document.querySelector('.main');
  main.addEventListener('dragenter', e => {
    if (!hasFiles(e) || view === 'trash') return;
    dragDepth++;
    $('#dropzone').hidden = false;
  });
  main.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('#dropzone').hidden = true;
    }
  });
  main.addEventListener('dragover', e => {
    if (!hasFiles(e) || view === 'trash') return;
    e.preventDefault();
    setDropText(cwd);
  });
  main.addEventListener('drop', e => { if (view === 'files') dropFiles(e, cwd); });
  // Never let a dropped file navigate the window.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

// ---------- transfers ----------

function renderTransfers() {
  const panel = $('#transfers');
  panel.hidden = !transfers.length;
  panel.classList.toggle('open', transfersOpen);
  if (!transfers.length) return;

  const active = transfers.filter(x => x.status === 'running' || x.status === 'queued');
  const failed = transfers.filter(x => x.status === 'error').length;
  const totalBytes = active.reduce((s, x) => s + x.size, 0);
  const doneBytes = active.reduce((s, x) => s + x.done, 0);
  $('#transfersTitle').textContent = active.length
    ? t('transferring', { n: active.length, done: formatSize(doneBytes), total: formatSize(totalBytes) })
    : t('transfersDone') + (failed ? t('withErrors', { n: failed }) : '');
  $('#transfersBar').style.width = active.length ? `${totalBytes ? (doneBytes / totalBytes) * 100 : 0}%` : '100%';

  if (!transfersOpen) return;
  const list = $('#transferList');
  list.replaceChildren();
  // Running first, then queued, then finished (newest first).
  const order = { running: 0, queued: 1, error: 2, canceled: 3, done: 4 };
  const sorted = [...transfers].sort((a, b) => order[a.status] - order[b.status] || b.id - a.id).slice(0, 300);
  for (const x of sorted) {
    const pct = x.size ? (x.done / x.size) * 100 : x.status === 'done' ? 100 : 0;
    const statusText = x.status === 'running'
      ? t('progressOf', { done: formatSize(x.done), total: formatSize(x.size) })
      : t(x.status) + (x.error ? `: ${x.error}` : '');
    const actions = [];
    if (x.status === 'running' || x.status === 'queued') actions.push(el('button', { title: t('cancelTransfer'), html: ICONS.x, onclick: () => api.cancelTransfer(x.id) }));
    if (x.status === 'error' || x.status === 'canceled') actions.push(el('button', { title: t('retry'), html: ICONS.retry, onclick: () => api.retryTransfer(x.id) }));
    list.append(el('li', { class: 'transfer' },
      el('span', { class: `t-kind ${x.kind}`, title: t(x.kind === 'upload' ? 'kindUpload' : 'kindDownload'), html: x.kind === 'upload' ? ICONS.upload : ICONS.download }),
      el('div', { style: 'min-width:0' }, el('div', { class: 't-name', title: x.name }, x.name),
        x.status === 'running' ? el('div', { class: 'progress' }, el('div', { style: `width:${pct}%` })) : null),
      el('div', { class: `t-status ${x.status}`, title: x.error || '' }, statusText),
      el('div', { class: 't-actions' }, actions)));
  }
}

// ---------- setup ----------

function renderGuide() {
  const step = GUIDE[guideStep];
  const last = guideStep === GUIDE.length - 1;
  $('#stepper').replaceChildren(...GUIDE.map((s, i) => el('button', {
    class: i === guideStep ? 'current' : i < guideStep ? 'done' : '',
    title: t(`step_${s.key}_title`),
    onclick: () => goToStep(i),
  })));
  $('#stepLabel').textContent = t('stepOf', { n: guideStep + 1, total: GUIDE.length });
  $('#stepTitle').textContent = t(`step_${step.key}_title`);
  $('#stepBody').innerHTML = t(`step_${step.key}_body`); // trusted dictionary markup
  $('#stepBody').style.minHeight = last ? '0' : '';
  $('#stepLink').hidden = !step.url;
  $('#credsForm').hidden = !last;
  $('#stepBack').hidden = guideStep === 0;
  $('#stepNext').hidden = last;
  $('#skipToEnd').hidden = last;
  $('#saveCreds').hidden = !last;
}

function goToStep(i) {
  guideStep = Math.max(0, Math.min(GUIDE.length - 1, i));
  renderGuide();
}

async function saveCredentials() {
  const s = await attempt(() => api.saveCredentials({ clientId: $('#clientId').value, clientSecret: $('#clientSecret').value }));
  if (s) {
    applyState(s);
    toast(t('credentialsSaved'));
    load([]);
  }
}

async function importCredentials() {
  const c = await attempt(() => api.importCredentials());
  if (!c) return;
  $('#clientId').value = c.clientId;
  $('#clientSecret').value = c.clientSecret;
  saveCredentials();
}

async function openSettings() {
  const ok = await modal({ title: t('changeCredsTitle'), text: t('changeCredsText'), ok: t('continue') });
  if (!ok) return;
  $('#clientId').value = '';
  $('#clientSecret').value = '';
  goToStep(GUIDE.length - 1);
  $('#setup').hidden = false;
  $('#app').hidden = true;
  $('#cancelSetup').hidden = false;
}

// ---------- wiring ----------

function bind() {
  $('#saveCreds').onclick = saveCredentials;
  $('#importCreds').onclick = importCredentials;
  $('#cancelSetup').onclick = () => applyState(state);
  $('#stepBack').onclick = () => goToStep(guideStep - 1);
  $('#stepNext').onclick = () => goToStep(guideStep + 1);
  $('#skipToEnd').onclick = () => goToStep(GUIDE.length - 1);
  $('#stepLink').onclick = () => attempt(() => api.openExternal(GUIDE[guideStep].url));
  $('#openSettings').onclick = openSettings;
  $('#addAccount').onclick = addAccount;
  $('#refresh').onclick = () => { attempt(async () => applyState(await api.state())); reloadView(); };
  $('#navFiles').onclick = () => load(view === 'files' ? [] : cwd);
  $('#navTrash').onclick = () => loadTrash();
  $('#emptyTrash').onclick = emptyTrash;
  $('#selRestore').onclick = () => restoreItems(selectedItems());
  $('#selDeleteForever').onclick = () => deleteForeverItems(selectedItems());
  $('#newFolder').onclick = newFolder;
  $('#uploadFiles').onclick = () => upload('files');
  $('#uploadFolder').onclick = () => upload('folder');
  $('#selDownload').onclick = () => download(selectedItems());
  $('#selRename').onclick = () => renameItem(selectedItems()[0]);
  $('#selDelete').onclick = () => deleteItems(selectedItems());
  $('#selClear').onclick = () => { selected.clear(); renderSelection(); };
  $('#checkAll').onclick = e => {
    selected = e.target.checked ? new Set(items.map(keyOf)) : new Set();
    renderSelection();
  };
  $('#clearTransfers').onclick = e => { e.stopPropagation(); api.clearTransfers(); };
  $('#transfersHead').onclick = () => { transfersOpen = !transfersOpen; renderTransfers(); };
  for (const sel of document.querySelectorAll('[data-lang-select]')) sel.onchange = () => changeLang(sel.value);

  $('#listwrap').addEventListener('click', e => {
    if (!e.target.closest('tr')) { selected.clear(); focusKey = null; renderSelection(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#ctxmenu')) hideMenu(); });
  window.addEventListener('blur', hideMenu);

  document.addEventListener('keydown', e => {
    if (!$('#modal').hidden || $('#app').hidden || e.target.matches('input:not([type=checkbox]), select')) return;
    const targets = keyboardTargets();
    if (e.key === 'Escape') { hideMenu(); selected.clear(); focusKey = null; renderSelection(); }
    else if (e.key === 'F5') reloadView();
    else if (view === 'trash') {
      if (e.key === 'Delete') deleteForeverItems(targets);
      else if (e.key === 'Backspace') load(cwd);
    }
    else if (e.key === 'Delete') deleteItems(targets);
    else if (e.key === 'F2' && targets.length === 1) renameItem(targets[0]);
    else if (e.key === 'Backspace' && cwd.length) load(cwd.slice(0, -1));
    else if (e.key === 'Enter' && targets.length === 1) openItem(targets[0]);
    else if (e.key.toLowerCase() === 'a' && e.ctrlKey) { e.preventDefault(); selected = new Set(items.map(keyOf)); renderSelection(); }
  });

  setupDragDrop();

  let changedTimer = null;
  api.on('changed', path => {
    // A change inside the current folder (or below it) can alter what is listed here.
    if (view !== 'files' || path.length < cwd.length || !cwd.every((s, i) => s === path[i])) return;
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => load(cwd, { keepSelection: true }), 600);
  });
  api.on('state', s => {
    // Accounts finish connecting after startup; reload when the usable set changes.
    const before = readyIds();
    applyState(s);
    if (readyIds() !== before) reloadView();
  });
  api.on('transfers', list => { transfers = list; renderTransfers(); });
}

(async function start() {
  bind();
  document.title = '';
  applyState(await api.state());
  transfers = await api.transfers();
  renderTransfers();
  load([]);
})();
