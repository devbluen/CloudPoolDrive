const { EventEmitter } = require('events');

let seq = 0;

// Upload/download queue with limited concurrency. Emits 'update' (throttled) and 'idle'.
class TransferManager extends EventEmitter {
  constructor(concurrency = 3) {
    super();
    this.concurrency = concurrency;
    this.items = [];
    this.running = 0;
    this.timer = null;
  }

  add({ kind, name, size, run }) {
    const t = { id: ++seq, kind, name, size, done: 0, status: 'queued', error: null, run, ctrl: null };
    this.items.push(t);
    this.changed();
    this.pump();
    return t;
  }

  pump() {
    while (this.running < this.concurrency) {
      const t = this.items.find(x => x.status === 'queued');
      if (!t) break;
      this.running++;
      t.status = 'running';
      t.done = 0;
      t.error = null;
      t.ctrl = new AbortController();
      t.run(t.ctrl.signal, done => {
        t.done = done;
        this.changed();
      })
        .then(() => {
          t.status = 'done';
          t.done = t.size;
        })
        .catch(e => {
          if (t.ctrl.signal.aborted) {
            t.status = 'canceled';
          } else {
            t.status = 'error';
            t.error = e.message;
          }
        })
        .finally(() => {
          this.running--;
          this.changed(true);
          this.pump();
          if (!this.running) this.emit('idle');
        });
    }
  }

  cancel(id) {
    const t = this.items.find(x => x.id === id);
    if (!t) return;
    if (t.status === 'queued') t.status = 'canceled';
    else if (t.status === 'running') t.ctrl.abort();
    this.changed(true);
  }

  retry(id) {
    const t = this.items.find(x => x.id === id);
    if (!t || (t.status !== 'error' && t.status !== 'canceled')) return;
    t.status = 'queued';
    this.changed(true);
    this.pump();
  }

  clearFinished() {
    this.items = this.items.filter(t => t.status === 'queued' || t.status === 'running');
    this.changed(true);
  }

  snapshot() {
    return this.items.map(({ id, kind, name, size, done, status, error }) => ({ id, kind, name, size, done, status, error }));
  }

  changed(now = false) {
    if (now) {
      clearTimeout(this.timer);
      this.timer = null;
      this.emit('update', this.snapshot());
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('update', this.snapshot());
    }, 200);
  }
}

module.exports = { TransferManager };
