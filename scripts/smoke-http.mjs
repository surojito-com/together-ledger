import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appServer } from './dev.mjs';

const server = appServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');

try {
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const page = await fetch(`${origin}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(html, /Together Ledger/);
  assert.match(html, /data-open-expense/);
  assert.match(html, /id="timeline-chart"/);
  assert.match(html, /src="\.\/src\/themes\.js"/);
  assert.match(html, /id="theme-select"/);

  const moduleResponse = await fetch(`${origin}/src/app.js`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type'), /text\/javascript/);
  assert.match(await moduleResponse.text(), /function renderTimeline/);

  const themeResponse = await fetch(`${origin}/src/themes.js`);
  assert.equal(themeResponse.status, 200);
  assert.match(themeResponse.headers.get('content-type'), /text\/javascript/);
  assert.match(await themeResponse.text(), /Catppuccin Mocha/);

  const missing = await fetch(`${origin}/route-that-does-not-exist`);
  assert.equal(missing.status, 200);
  assert.match(await missing.text(), /Together Ledger/);
  console.log('✓ HTTP smoke check passed — page, app module, and fallback route are served.');
} finally {
  server.close();
  await once(server, 'close');
}
