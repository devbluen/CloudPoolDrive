const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const EVENTS = ['state', 'transfers', 'changed'];

contextBridge.exposeInMainWorld('api', {
  state: () => invoke('state'),
  setLang: lang => invoke('lang:set', lang),
  openExternal: url => invoke('open-external', url),
  saveCredentials: c => invoke('credentials:save', c),
  importCredentials: () => invoke('credentials:import'),
  addAccount: () => invoke('account:add'),
  removeAccount: id => invoke('account:remove', id),
  list: p => invoke('fs:list', p),
  mkdir: (p, name) => invoke('fs:mkdir', p, name),
  rename: (p, item, name) => invoke('fs:rename', p, item, name),
  remove: (p, items) => invoke('fs:delete', p, items),
  listTrash: () => invoke('trash:list'),
  restore: items => invoke('trash:restore', items),
  deleteForever: items => invoke('trash:delete', items),
  emptyTrash: () => invoke('trash:empty'),
  uploadDialog: (p, kind) => invoke('fs:upload-dialog', p, kind),
  uploadPaths: (p, paths) => invoke('fs:upload-paths', p, paths),
  download: (p, items) => invoke('fs:download', p, items),
  transfers: () => invoke('transfer:list'),
  cancelTransfer: id => invoke('transfer:cancel', id),
  retryTransfer: id => invoke('transfer:retry', id),
  clearTransfers: () => invoke('transfer:clear'),
  pathForFile: file => webUtils.getPathForFile(file),
  on(channel, cb) {
    if (!EVENTS.includes(channel)) return () => {};
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
