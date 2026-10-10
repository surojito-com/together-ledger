// Turns PRIVACY.md and TERMS.md into the pages served at /privacy and /terms, so the words a person
// reads and the words in the repository are the same. App Store Connect and Play Console both ask for
// a public privacy policy URL; before this page existed, /privacy fell through to the app shell.
//
// Both files are written in a deliberately small subset of Markdown — headings, paragraphs,
// bulleted lists, **bold**, `code` and [links](…) — and this renders exactly that subset. Anything
// else fails the build rather than reaching the page half-rendered.

// Sections that are guidance for contributors to this repository, not policy for the people who
// use the product. They stay in the Markdown file and are left off the public page.
const repositoryOnlySections = new Set(['Never place in this public repository']);

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(text, source) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (!/^https:\/\//.test(href)) throw new Error(`${source} links to ${href}; the public page can only carry absolute https links.`);
    return `<a href="${href}">${label}</a>`;
  });
  if (/[*[\]]/.test(html.replace(/<code>[^<]*<\/code>/g, '').replace(/<[^>]+>/g, ''))) {
    throw new Error(`${source} uses Markdown this page does not render: ${text}`);
  }
  return html;
}

// The policy as blocks of still-Markdown text: headings, paragraphs and lists, with the
// repository-only sections left out. The web page renders these as HTML, and the phone app
// (scripts/mobile-policies.mjs) carries them as its own Privacy screen, so both read one parse.
// Every block's text has already passed inline(), so an unsupported mark fails here for both.
export function policyBlocks(markdown, source = 'PRIVACY.md') {
  const blocks = markdown.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  const parsed = [];
  let title = null;
  let skipping = false;

  for (const block of blocks) {
    const lines = block.split('\n');
    const heading = /^(#{1,3}) (.+)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      const level = heading[1].length;
      if (level === 1) {
        title = heading[2];
        skipping = false;
        continue;
      }
      if (level === 2) skipping = repositoryOnlySections.has(heading[2]);
      if (!skipping) parsed.push({ kind: 'heading', level, text: checked(heading[2], source) });
      continue;
    }
    if (skipping) continue;
    if (lines.every((line) => line.startsWith('- '))) {
      parsed.push({ kind: 'list', items: lines.map((line) => checked(line.slice(2), source)) });
      continue;
    }
    if (lines.some((line) => /^(#|- |\d+\. |>|```|\|)/.test(line))) {
      throw new Error(`${source} has a block this page does not render:\n${block}`);
    }
    parsed.push({ kind: 'paragraph', text: checked(lines.join(' '), source) });
  }

  if (!title) throw new Error(`${source} needs a top-level # heading to title the page.`);
  return { title, blocks: parsed };
}

function checked(text, source) {
  inline(text, source);
  return text;
}

export function renderPolicyBody(markdown, source = 'PRIVACY.md') {
  const { title, blocks } = policyBlocks(markdown, source);
  const html = blocks.map((block) => {
    if (block.kind === 'heading') return `<h${block.level}>${inline(block.text, source)}</h${block.level}>`;
    if (block.kind === 'list') return `<ul>${block.items.map((item) => `<li>${inline(item, source)}</li>`).join('')}</ul>`;
    return `<p>${inline(block.text, source)}</p>`;
  });
  return { title, html: html.join('\n        ') };
}

export function renderPrivacyBody(markdown) {
  return renderPolicyBody(markdown, 'PRIVACY.md');
}

const pages = {
  privacy: {
    source: 'PRIVACY.md',
    path: 'privacy',
    description: 'How Together Ledger handles what you hold in it: what stays in your browser, what private sync stores, and who can see it.',
    contact: 'Questions about this policy, or a request about your data:',
    subject: 'Together%20Ledger%20privacy',
    related: { path: 'terms', label: 'Terms of use' },
  },
  terms: {
    source: 'TERMS.md',
    path: 'terms',
    description: 'The terms of use for Together Ledger: who it is for, how journeys and paid capacity work, and what each side can expect.',
    contact: 'Questions about these terms:',
    subject: 'Together%20Ledger%20terms',
    related: { path: 'privacy', label: 'Privacy policy' },
  },
  support: {
    source: 'SUPPORT.md',
    path: 'support',
    description: 'How to get help with Together Ledger: signing in, purchases, deleting an account, and who to write to.',
    contact: 'For anything about your privacy or your data, write to',
    subject: 'Together%20Ledger%20privacy',
    related: { path: 'privacy', label: 'Privacy policy' },
  },
};

function renderPolicyPage(markdown, page) {
  const { title, html } = renderPolicyBody(markdown, page.source);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(page.description)}" />
    <meta name="theme-color" content="#F3EFE6" />
    <link rel="canonical" href="https://app.together-ledger.com/${page.path}" />
    <link rel="icon" href="https://app.together-ledger.com/favicon.svg" type="image/svg+xml" />
    <title>${escapeHtml(title)} — Together Ledger</title>
    <script src="./src/themes.js"></script>
    <link rel="stylesheet" href="./src/styles.css" />
  </head>
  <body>
    <svg class="mark-source" aria-hidden="true" focusable="false"><symbol id="knot-mark" viewBox="0 0 64 64" fill="none"><rect x="6.5" y="6.5" width="35" height="35" rx="10" stroke="currentColor" stroke-width="6.5"/><rect x="22.5" y="22.5" width="35" height="35" rx="10" stroke="currentColor" stroke-width="6.5"/></symbol></svg>
    <header class="site-header">
      <a class="brand" href="./" aria-label="Together Ledger home">
        <svg class="brand-mark" aria-hidden="true" focusable="false"><use href="#knot-mark"/></svg>
        <span><strong>Together Ledger</strong><small>A shared journey, held with care.</small></span>
      </a>
    </header>
    <main class="policy-page">
      <article>
        <h1>${escapeHtml(title)}</h1>
        ${html}
        <p class="policy-contact">${page.contact} <a href="mailto:legal@together-ledger.com?subject=${page.subject}">legal@together-ledger.com</a>. See also: <a href="./${page.related.path}">${page.related.label}</a>.</p>
      </article>
    </main>
  </body>
</html>
`;
}

export function renderPrivacyPage(markdown) {
  return renderPolicyPage(markdown, pages.privacy);
}

export function renderTermsPage(markdown) {
  return renderPolicyPage(markdown, pages.terms);
}

// The support URL both stores ask for (owner, Oct 8): the product's own page, next to its policies.
export function renderSupportPage(markdown) {
  return renderPolicyPage(markdown, pages.support);
}
