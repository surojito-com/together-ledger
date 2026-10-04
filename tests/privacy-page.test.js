import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderPrivacyBody, renderPrivacyPage } from '../scripts/render-privacy-page.mjs';

const policy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');

test('the /privacy page carries every policy section in PRIVACY.md', () => {
  const page = renderPrivacyPage(policy);
  const sections = [...policy.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.ok(sections.length > 0);
  for (const section of sections.filter((name) => name !== 'Never place in this public repository')) {
    assert.ok(page.includes(`<h2>${section}</h2>`), `missing section ${section}`);
  }
  assert.ok(page.includes('<h1>Privacy</h1>'));
  assert.ok(page.includes('<link rel="stylesheet" href="./src/styles.css" />'));
});

test('guidance for contributors to the repository stays off the public page', () => {
  const page = renderPrivacyPage(policy);
  assert.ok(!page.includes('Never place in this public repository'));
  assert.ok(!page.includes('THREAT_MODEL'));
  assert.ok(page.includes('An honest boundary'), 'the section after the skipped one still renders');
});

test('the renderer escapes HTML and renders the small Markdown subset it accepts', () => {
  const { title, html } = renderPrivacyBody('# Title\n\nA <b> & `code` and **bold** and [link](https://example.test).\n\n- one\n- two');
  assert.equal(title, 'Title');
  assert.ok(html.includes('A &lt;b&gt; &amp; <code>code</code> and <strong>bold</strong> and <a href="https://example.test">link</a>.'));
  assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
});

test('Markdown the page cannot render fails the build instead of shipping half-rendered', () => {
  assert.throws(() => renderPrivacyBody('# T\n\n1. numbered'), /does not render/);
  assert.throws(() => renderPrivacyBody('# T\n\nSee [docs](docs/OPERATIONS.md).'), /absolute https links/);
  assert.throws(() => renderPrivacyBody('# T\n\nsome *emphasis* here'), /does not render/);
  assert.throws(() => renderPrivacyBody('No title'), /top-level # heading/);
});
