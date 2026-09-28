'use strict';
// Renders build/icon.svg into the app icons, with no image libraries:
//   build/icon.png       1024 px, for electron-builder (it makes the macOS .icns from it)
//   build/icon.ico       16-256 px, Windows taskbar and installer
//   build/icons/<n>.png  every size, for Linux and the window icon
//
//   npx electron scripts/make-icons.js
//
// Electron's offscreen renderer rasterizes the SVG with a transparent
// background; the .ico is a plain directory of PNG images (Windows Vista+).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [...ICO_SIZES, 512, 1024];

app.disableHardwareAcceleration();
// Each size gets its own window; closing the last one must not quit the app.
app.on('window-all-closed', () => {});

async function render(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
    `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  // capturePage returns device pixels; make sure the file is exactly size x size.
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICONDIR + ICONDIRENTRY[] + PNG blobs. A width/height byte of 0 means 256.
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // no palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});

async function main() {
  const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
  fs.mkdirSync(path.join(BUILD, 'icons'), { recursive: true });
  const images = [];
  for (const size of PNG_SIZES) {
    const png = await render(svg, size);
    fs.writeFileSync(path.join(BUILD, 'icons', `${size}.png`), png);
    images.push({ size, png });
    console.log(`icons/${size}.png  ${png.length} bytes`);
  }
  fs.writeFileSync(path.join(BUILD, 'icon.png'), images.find((i) => i.size === 1024).png);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(images.filter((i) => ICO_SIZES.includes(i.size))));
  console.log('icon.png (1024) and icon.ico written');
  app.quit();
}
