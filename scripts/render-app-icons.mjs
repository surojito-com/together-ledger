// Renders the phone app's icons from one drawing: the launcher icon iOS and
// Android use, and Android's three adaptive layers.
//
//   node scripts/render-app-icons.mjs
//
// Needs Playwright with Chromium. If it isn't resolvable from here, point
// PLAYWRIGHT_MODULE at an installed copy (e.g. "$(npm root -g)/playwright").
//
// The mark is the knot from public/favicon.svg, drawn with the same geometry
// and colours as the Play icon (store/google-play/source/icon.html), because
// Play expects the store icon to match the installed one: #8C3A3A behind,
// #F3EFE6 for the knot. The owner chose these on Oct 6 (#324). The hex is also
// the in-app destructive role; that rule governs interface colour, and this
// is the brand mark.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const brand = '#8C3A3A';
const knotInk = '#F3EFE6';

// The knot on the favicon's 64-unit grid: two overlapping rounded squares.
// `scale` is the share of the 64-unit frame the knot's own 64 units take up,
// centred, so the Play icon's `translate(9.6 9.6) scale(.7)` is scale 0.7.
function knot({ scale, ink }) {
  const offset = (64 - 64 * scale) / 2;
  return `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${ink}" stroke-width="6.5">
    <rect x="6.5" y="6.5" width="35" height="35" rx="10"/>
    <rect x="22.5" y="22.5" width="35" height="35" rx="10"/>
  </g>`;
}

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${body}</svg>`;

// Full-bleed square: iOS and Play add their own corners. Same scale as the
// Play icon.
const squareIcon = (size) => svg(size, `<rect width="64" height="64" fill="${brand}"/>${knot({ scale: 0.7, ink: knotInk })}`);

// An adaptive layer is a 108dp canvas of which the launcher shows the middle
// 72dp, inside a 66dp safe circle. Scaling the Play icon's knot by 72/108
// makes it the same size on the launcher as in the store. Its farthest point,
// the outer corner of a rounded square, is then 26% of the canvas from the
// centre, inside the safe circle's 31%.
const adaptiveScale = 0.7 * (72 / 108);
const adaptiveForeground = (size) => svg(size, knot({ scale: adaptiveScale, ink: knotInk }));
const adaptiveBackground = (size) => svg(size, `<rect width="64" height="64" fill="${brand}"/>`);
// Themed icons: Android reads only the alpha, so white on transparent.
const adaptiveMonochrome = (size) => svg(size, knot({ scale: adaptiveScale, ink: '#FFFFFF' }));

const jobs = [
  // iOS rejects an app icon with an alpha channel, so this one is opaque.
  { path: 'apps/mobile/assets/icon.png', size: 1024, draw: squareIcon },
  { path: 'apps/mobile/assets/android-icon-background.png', size: 512, draw: adaptiveBackground },
  { path: 'apps/mobile/assets/android-icon-foreground.png', size: 512, draw: adaptiveForeground, transparent: true },
  { path: 'apps/mobile/assets/android-icon-monochrome.png', size: 432, draw: adaptiveMonochrome, transparent: true },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${job.draw(job.size)}</body></html>`,
    );
    const out = join(root, job.path);
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: 'png', omitBackground: Boolean(job.transparent) });
    await page.close();
    console.log(`wrote ${job.path} (${job.size}×${job.size}${job.transparent ? ', transparent' : ''})`);
  }
} finally {
  await browser.close();
}
