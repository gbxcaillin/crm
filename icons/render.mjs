// Renders the SVG icons to PNG at the sizes the manifest needs.
// Usage: CHROME_BIN=/path/to/chrome node icons/render.mjs
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['maskable.svg', 'maskable-512.png', 512]
];
const b = await chromium.launch({ executablePath: process.env.CHROME_BIN });
const p = await b.newPage();
for (const [src, out, size] of jobs) {
  const svg = fs.readFileSync(path.join(dir, src), 'utf8');
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:#0A0A0A">${svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
  await p.screenshot({ path: path.join(dir, out), clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
  console.log('wrote', out);
}
await b.close();
