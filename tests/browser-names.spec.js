import { test, expect } from './browser-test.js';

// Names hold any language, symbol and emoji (owner, Oct 10, 2026). Wherever one appears it is shown
// as written and never read as markup, and a name's box counts its limit in what a person sees.
// Escapes keep what each sample is made of in plain sight.
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const HEART = '❤️';
const INDIA = '\u{1F1EE}\u{1F1F3}';
const BOLD = "O'Brien – <b>bold</b>";
const SAMPLES = [`Saanvi & Ravi ${HEART}`, '家族の旅', 'רות ודני', 'सान्वी', `Zoë's ${INDIA} summer`, `${FAMILY} weekend`, BOLD];
const JOURNEY_NAME = SAMPLES[1];

const owner = { id: 'names-owner', username: 'names-owner', displayName: SAMPLES[0], email: 'owner@example.test', emailVerified: true };
const members = SAMPLES.map((displayName, index) => ({ id: index ? `member-${index}` : owner.id, displayName, role: index ? 'member' : 'owner', joinedAt: `2026-10-0${index + 1}T12:00:00.000Z` }));
const moments = SAMPLES.map((name, index) => ({
  id: `moment-${index}`, journeyId: 'names-journey', kind: 'other', kindLabel: name, occurredOn: `2026-10-0${index + 1}`, title: name, detail: '', visibility: 'shared-now',
  moneyCents: null, moneyCurrency: '', locations: [{ label: name }], createdByUserId: members[index].id, createdBy: name, updatedBy: name, shapedByBoth: false, version: 1,
  createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z',
}));
const events = [
  { id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'names-journey', summary: `Created journey: ${JOURNEY_NAME}`, before: null, after: null, previousHash: '', eventHash: '', createdAt: '2026-10-01T12:00:00.000Z' },
  { id: 'event-2', sequence: 2, actorUserId: 'member-6', action: 'member_renamed', entityType: 'membership', entityId: 'member-6', summary: `Changed their name from journeyer-6 to ${BOLD}`, before: { displayName: 'journeyer-6' }, after: { displayName: BOLD }, previousHash: '', eventHash: '', createdAt: '2026-10-09T12:00:00.000Z' },
];

async function openNamedJourney(page) {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'names-journey' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/names-journey/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'names-journey', name: JOURNEY_NAME, location: SAMPLES[4], startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z' },
      members, invitations: [], inviteProposals: [], expenses: [], moments, concerns: [], milestones: [], events, eventChainValid: true,
      capacity: { peopleHere: members.length, openInvitations: 0, canInvite: true, mode: 'test-groups' },
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/names-journey/billing', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { enabled: false, portalEnabled: false, environment: 'test', offers: [], entitlement: null, subscription: null, invoices: [] } }),
  }));
  await page.goto('/');
  await expect(page.locator('#trip-name')).toHaveText(JOURNEY_NAME);
}

const graphemes = (locator) => locator.evaluate((input) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.value)).length);

test('a name in any language, symbol or emoji is shown as written everywhere, never as markup', async ({ page }) => {
  await openNamedJourney(page);

  await page.getByRole('button', { name: /See all \d+ moments/ }).click();
  const timeline = page.locator('#moment-timeline');
  for (const name of SAMPLES) {
    await expect(timeline.locator('.moment-card strong', { hasText: name }).first()).toHaveText(name);
    await expect(timeline).toContainText(`Held by ${name}`);
  }
  await expect(timeline.locator('.moment-card b')).toHaveCount(0);

  await page.locator('#event-manager-button').click();
  const history = page.locator('#event-dialog');
  await expect(history).toContainText(`Created journey: ${JOURNEY_NAME}`);
  await expect(history).toContainText(`Changed their name from journeyer-6 to ${BOLD}`);
  await expect(history.locator('.event-row b')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Journey settings' }).click();
  const record = page.locator('#member-list');
  for (const name of SAMPLES.slice(1)) await expect(record).toContainText(`${name} joined the journey`);
  await expect(record.locator('b')).toHaveCount(0);
  await page.locator('[data-remove-member="member-6"]').click();
  const dialog = page.locator('#consequence-dialog');
  await expect(page.locator('#consequence-dialog-title')).toHaveText(`Remove ${BOLD} from this journey?`);
  await expect(dialog.locator('b')).toHaveCount(0);
  await page.locator('#consequence-dialog-cancel').click();
  await page.keyboard.press('Escape');

  // The name box counts characters: eighty families fit, and the eighty-first is never half kept.
  await page.getByRole('button', { name: 'Account settings' }).first().click();
  const name = page.getByLabel('Name journeyers see');
  await expect(name).toHaveValue(SAMPLES[0]);
  await name.fill(FAMILY.repeat(81));
  await expect(name).toHaveValue(FAMILY.repeat(80));
});

test('a name box holds its limit in what a person sees, and never keeps half of an emoji', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Hold a moment' })).toBeVisible();

  const title = page.locator('#moment-form [name="title"]');
  await title.fill(FAMILY.repeat(121));
  await expect(title).toHaveValue(FAMILY.repeat(120));
  expect(await graphemes(title)).toBe(120);
  // Typed at the limit: what fits is kept, and what was there stays.
  await title.fill('x'.repeat(119));
  await title.press('End');
  await page.keyboard.insertText(`${FAMILY}${FAMILY}`);
  await expect(title).toHaveValue(`${'x'.repeat(119)}${FAMILY}`);

  await page.locator('#moment-form [name="kind"]').selectOption('other');
  const kindLabel = page.locator('#moment-form [name="kindLabel"]');
  await kindLabel.fill(HEART.repeat(61));
  await expect(kindLabel).toHaveValue(HEART.repeat(60));
  const place = page.locator('#manual-location');
  await place.fill(INDIA.repeat(121));
  await expect(place).toHaveValue(INDIA.repeat(120));

  await kindLabel.fill(SAMPLES[2]);
  await place.fill(SAMPLES[4]);
  await page.getByRole('button', { name: 'Add place' }).click();
  await title.fill(BOLD);
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  const card = page.locator('#moment-timeline .moment-card').first();
  await expect(card.locator('strong')).toHaveText(BOLD);
  await expect(card.locator('.moment-kind')).toHaveText(SAMPLES[2]);
  await expect(card.locator('.location-context')).toHaveText(SAMPLES[4]);
  await expect(card.locator('b')).toHaveCount(0);
});
