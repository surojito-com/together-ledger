// Renders the Google Play icon and feature graphic from their HTML sources.
//
//   (cd apps/mobile && npm install)            # puts Gelasio in node_modules
//   node store/google-play/source/render.mjs
//
// Gelasio comes from the mobile app's own @expo-google-fonts/gelasio
// package (the bundled serif, #177), or from FONT_DIR if set.
//
// Needs Playwright with Chromium. It isn't a repo dependency; if it isn't
// resolvable from here, point PLAYWRIGHT_MODULE at an installed copy
// (e.g. "$(npm root -g)/playwright").

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const require = createRequire(import.meta.url);

const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

function fontDir() {
  if (process.env.FONT_DIR) return process.env.FONT_DIR;
  const mobile = createRequire(join(here, '../../../apps/mobile/package.json'));
  const root = dirname(mobile.resolve('@expo-google-fonts/gelasio/package.json'));
  const dir = mkdtempSync(join(tmpdir(), 'tl-fonts-'));
  writeFileSync(join(dir, 'Gelasio_400Regular.ttf'), readFileSync(join(root, '400Regular/Gelasio_400Regular.ttf')));
  return dir;
}

const jobs = [
  { src: 'icon.html', png: 'icon-512.png', width: 512, height: 512 },
  { src: 'feature-graphic.html', png: 'feature-graphic-1024x500.png', width: 1024, height: 500 },
];

const fonts = pathToFileURL(fontDir()).href;
const work = mkdtempSync(join(tmpdir(), 'play-listing-'));
const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const html = readFileSync(join(here, job.src), 'utf8').replaceAll('FONT_DIR', fonts);
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
    const tmp = join(work, job.src);
    writeFileSync(tmp, html);
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => document.fonts.ready);
    const missing = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status !== 'loaded' && f.status !== 'unloaded').map((f) => f.family),
    );
    if (missing.length) throw new Error(`${job.src}: fonts failed to load: ${missing.join(', ')}`);
    // Opaque output: Play rejects an icon with transparency.
    await page.screenshot({ path: join(out, job.png), omitBackground: false, type: 'png' });
    await page.close();
    console.log(`wrote ${job.png} (${job.width}×${job.height})`);
  }
} finally {
  await browser.close();
}
if (!existsSync(join(out, 'icon-512.png'))) process.exit(1);
