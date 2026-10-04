import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderPolicyBody, renderPrivacyPage, renderTermsPage } from '../scripts/render-privacy-page.mjs';

const terms = readFileSync(new URL('../TERMS.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');

test('the /terms page carries every section in TERMS.md', () => {
  const page = renderTermsPage(terms);
  const sections = [...terms.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.ok(page.includes(`<h2>${section}</h2>`), `missing section ${section}`);
  }
  assert.ok(page.includes('<h1>Terms of use</h1>'));
  assert.ok(page.includes('<link rel="canonical" href="https://app.together-ledger.com/terms" />'));
  assert.ok(page.includes('<link rel="stylesheet" href="./src/styles.css" />'));
});

test('the terms say what the product decided, not a placeholder', () => {
  const page = renderTermsPage(terms);
  assert.ok(page.includes('You must be 18 or older, wherever you live.'));
  assert.ok(page.includes('Nobody is removed and no history is lost.'));
  assert.ok(page.includes('Bibb County, Georgia'));
  assert.ok(!/Decision \d/.test(terms), 'no open owner decision is left in the published text');
});

test('the privacy and terms pages point at each other', () => {
  assert.ok(renderTermsPage(terms).includes('<a href="./privacy">Privacy policy</a>'));
  assert.ok(renderPrivacyPage(policy).includes('<a href="./terms">Terms of use</a>'));
  assert.ok(renderTermsPage(terms).includes('subject=Together%20Ledger%20terms'));
});

test('a rendering error names the file that caused it', () => {
  assert.throws(() => renderPolicyBody('# T\n\n1. numbered', 'TERMS.md'), /TERMS\.md has a block this page does not render/);
});
