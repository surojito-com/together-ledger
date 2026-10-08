import { readFile } from 'node:fs/promises';
import { test, expect } from './browser-test.js';
import { PHOTO_METADATA_REMOVED, stripPhotoMetadata } from '../src/photo-metadata.js';

// A photo's location and camera details are removed on the device, the moment it is picked
// (#258). These prove it in the browser: what is sent carries none of it, the line beneath the
// picker appears only once it is true, and the cleaned photo draws exactly as the original did,
// the right way up.

const FIXTURES = ['sideways-with-gps.jpg', 'progressive-with-gps.jpg', 'sideways-with-gps.png', 'sideways-with-gps.webp'];
const fixturePath = (name) => new URL(`./fixtures/photos/${name}`, import.meta.url).pathname;
const IDENTIFYING = ['Kolkata', 'Fixture Camera Co', 'FX-100', 'SN-FIXTURE-0042', 'Fixture Lens', 'FixtureOS', '2026:10:07', 'ns.adobe.com/xap', 'Photoshop 3.0', 'MotionPhoto'];

async function hostedJourney(page, uploads) {
  const owner = { id: 'photo-owner', username: 'photo-owner', displayName: 'photo-owner', email: 'photo@example.test', emailVerified: true };
  const moments = [];
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'journey-photo' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-photo/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'journey-photo', name: 'A journey with photos', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-10-07T11:00:00.000Z', updatedAt: '2026-10-07T11:00:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-10-07T11:00:00.000Z' }], invitations: [], expenses: [], moments, images: [], concerns: [], milestones: [],
      events: [], eventChainValid: true,
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-photo/moments', async (route) => {
    const body = route.request().postDataJSON();
    moments.push({ ...body, id: `moment-${moments.length + 1}`, journeyId: 'journey-photo', createdByUserId: owner.id, createdBy: owner.displayName, updatedBy: owner.displayName, shapedByBoth: false, version: 1, createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z' });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { moment: moments.at(-1) } }) });
  });
  await page.route(/\/api\/v1\/journeys\/journey-photo\/moments\/[^/]+\/images$/, async (route) => {
    const request = route.request();
    uploads.push({ contentType: request.headers()['content-type'], name: decodeURIComponent(request.headers()['x-together-image-name']), body: request.postDataBuffer() });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { image: { id: 'image-1', momentId: 'moment-1', filename: 'IMG_0042.jpg', contentType: 'image/jpeg', createdAt: '2026-10-07T12:00:00.000Z', deletedAt: null } } }) });
  });
}

test('a picked photo is sent without its location or camera details, and the line says so only once it is true', async ({ page }) => {
  const uploads = [];
  await hostedJourney(page, uploads);
  await page.goto('/');
  await page.getByRole('button', { name: /Hold a moment/ }).first().click();
  await expect(page.locator('#moment-image-field')).toBeVisible();
  const note = page.locator('#moment-image-privacy');
  await expect(note).toBeHidden();

  const original = await readFile(fixturePath('sideways-with-gps.jpg'));
  await page.locator('#moment-form [name="image"]').setInputFiles({ name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: original });
  await expect(note).toBeVisible();
  await expect(note).toHaveText(PHOTO_METADATA_REMOVED);

  await page.locator('#moment-form [name="title"]').fill('Home before the rain');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect.poll(() => uploads.length).toBe(1);
  const [upload] = uploads;
  expect(upload.contentType).toBe('image/jpeg');
  expect(upload.name).toBe('IMG_0042.jpg');
  expect(upload.body.length).toBeLessThan(original.length);
  for (const word of IDENTIFYING) expect(upload.body.includes(word), `the upload still carries "${word}"`).toBe(false);
  expect(Buffer.compare(upload.body, Buffer.from(stripPhotoMetadata(original).bytes))).toBe(0);

  // Opening the dialog again starts clean: no line about a photo that is not there.
  await page.getByRole('button', { name: /Hold a moment/ }).first().click();
  await expect(note).toBeHidden();
});

test('a file that cannot be read is not kept for upload, and the line does not appear', async ({ page }) => {
  const uploads = [];
  await hostedJourney(page, uploads);
  await page.goto('/');
  await page.getByRole('button', { name: /Hold a moment/ }).first().click();
  const input = page.locator('#moment-form [name="image"]');
  await input.setInputFiles({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo at all') });
  await expect(page.locator('#moment-dialog #status-banner')).toContainText('This photo could not be read.');
  await expect(page.locator('#moment-image-privacy')).toBeHidden();
  await expect(input).toHaveValue('');
  await page.locator('#moment-form [name="title"]').fill('No photo after all');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-dialog')).toBeHidden();
  expect(uploads).toEqual([]);

  // Picking a readable photo afterwards clears the problem and says what was removed.
  await page.getByRole('button', { name: /Hold a moment/ }).first().click();
  await input.setInputFiles({ name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo at all') });
  await expect(page.locator('#moment-dialog #status-banner')).toBeVisible();
  await input.setInputFiles(fixturePath('sideways-with-gps.png'));
  await expect(page.locator('#moment-dialog #status-banner')).toBeHidden();
  await expect(page.locator('#moment-image-privacy')).toHaveText(PHOTO_METADATA_REMOVED);
});

test('a cleaned photo draws pixel for pixel as the original did, the right way up', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async (names) => {
    const { stripPhotoMetadata } = await import('/src/photo-metadata.js');
    // Drawn through an <img>, as the journey shows it, so the browser applies orientation itself.
    const draw = async (bytes, type) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const at = (x, y) => Array.from(pixels.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
      return { width: canvas.width, height: canvas.height, pixels: Array.from(pixels), topLeft: at(2, 2), topRight: at(canvas.width - 3, 2) };
    };
    const out = {};
    for (const name of names) {
      const original = new Uint8Array(await (await fetch(`/tests/fixtures/photos/${name}`)).arrayBuffer());
      const { bytes, contentType } = stripPhotoMetadata(original);
      const before = await draw(original, contentType);
      const after = await draw(bytes, contentType);
      out[name] = { before: { ...before, pixels: undefined }, after: { ...after, pixels: undefined }, samePixels: before.pixels.length === after.pixels.length && before.pixels.every((value, index) => value === after.pixels[index]) };
    }
    return out;
  }, FIXTURES);

  const red = ([r, g, b]) => r > 180 && g < 90 && b < 90;
  for (const name of FIXTURES) {
    const { before, after, samePixels } = results[name];
    expect(samePixels, `${name} draws the same pixels`).toBe(true);
    expect([after.width, after.height], `${name} keeps its shape`).toEqual([before.width, before.height]);
    // Chromium does not turn a WebP by its EXIF orientation, original or cleaned; that it draws
    // both the same is checked above. Phones do not save camera photos as WebP.
    if (name.endsWith('.webp')) continue;
    // Stored 64 wide and 40 high, on its side. Turned upright it is 40 wide and 64 high, and the
    // red corner, stored at the top left, is at the top right.
    expect([after.width, after.height], `${name} is shown upright`).toEqual([40, 64]);
    expect(red(after.topRight) && !red(after.topLeft), `${name}: red at the top right`).toBe(true);
  }
});
