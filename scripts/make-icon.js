// Renders build/icon.png (512x512) from HTML. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${SIZE}px;height:${SIZE}px;display:grid;place-items:center">
  <div style="width:440px;height:440px;border-radius:110px;position:relative;
    background:conic-gradient(from 45deg,#3b6cf6,#1fb57a,#f2b62d,#e5484d,#3b6cf6);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)">
    <svg viewBox="0 0 24 24" style="position:absolute;inset:90px;width:260px;height:260px"
      fill="rgba(255,255,255,.95)" stroke="none">
      <path d="M7 19a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 11a4 4 0 0 1-1 8z"/>
    </svg>
  </div>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log('icon written:', out);
  app.quit();
});
