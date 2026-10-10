import { test, expect } from './browser-test.js';

// #312: two small text controls were well under the 44px minimum target, and the owner chose to give
// them an invisible tap area rather than a bigger look. Each is checked here by asking the page what
// sits under the edges of that area, in every theme, at a phone width and a desktop width, and
// against the same page with the area switched off, so the controls themselves have not moved.
//
// A place's Remove gets the whole 44px. The two links under a journey's name cannot: that row stacks
// below 621px and wraps above it, 5px apart, so their areas stop at the middle of each gap instead of
// reaching under a neighbour. They are held to what the row's gap allows, and to 44px as soon as it
// allows that; the measurements go in the report.

const THEMES = ['light', 'dark', 'green', 'flexoki'];
const WIDTHS = [320, 1280];
const MIN_TARGET = 44;
const PLACES = ['Home', 'The long market street by the river, near the bridge where we stopped', 'Café'];
const WITHOUT_AREA = '.trip-record-links button::before, .location-list button::before { display: none !important; }';

async function beginWithAMoment(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await page.locator('#moment-form [name="title"]').fill('A first moment');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('.trip-bar')).toBeVisible();
}

async function openPlaces(page) {
  await page.locator('[data-open-moment]:visible').first().click();
  for (const place of PLACES) {
    await page.locator('#manual-location').fill(place);
    await page.locator('#add-manual-location').click();
  }
  await expect(page.locator('.location-list button')).toHaveCount(PLACES.length);
}

// Everything is measured inside the page, after scrolling the control into the middle of the
// viewport, so a box and the points sampled against it come from the same layout.
// 'centred' is the 44px box centred on the control; 'gaps' is the control widened by half of each gap
// around it in its row. Points are sampled 1px inside each edge: where two areas meet in the middle
// of a gap, the browser rounds the shared boundary to one of them.
function measure(button, shape) {
  button.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  const visible = button.getBoundingClientRect();
  let area;
  if (shape === 'centred') {
    const width = Math.max(visible.width, 44);
    const height = Math.max(visible.height, 44);
    const left = visible.left + (visible.width - width) / 2;
    const top = visible.top + (visible.height - height) / 2;
    area = { left, top, right: left + width, bottom: top + height };
  } else {
    const row = getComputedStyle(button.parentElement);
    const rowGap = parseFloat(row.rowGap) / 2;
    const columnGap = parseFloat(row.columnGap) / 2;
    area = { left: visible.left - columnGap, top: visible.top - rowGap, right: visible.right + columnGap, bottom: visible.bottom + rowGap };
  }
  area.width = area.right - area.left;
  area.height = area.bottom - area.top;
  const misses = [];
  for (const x of [area.left + 1, (area.left + area.right) / 2, area.right - 1]) {
    for (const y of [area.top + 1, (area.top + area.bottom) / 2, area.bottom - 1]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === button || button.contains(hit))) misses.push(`(${x.toFixed(1)}, ${y.toFixed(1)}) reached ${hit ? hit.outerHTML.slice(0, 60) : 'nothing'}`);
    }
  }
  const box = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
  const origin = button.closest('.trip-record-links, .location-list').getBoundingClientRect();
  const inRow = { left: area.left - origin.left, top: area.top - origin.top, right: area.right - origin.left, bottom: area.bottom - origin.top };
  return { visible: box(visible), area, misses, inRow };
}

// Scrolling moves everything, so boxes are compared in the coordinates of the row they belong to
// (measure() returns its area the same way, as inRow).
function inRow(element) {
  const rect = element.getBoundingClientRect();
  const origin = element.closest('.trip-record-links, .location-list').getBoundingClientRect();
  return { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
}

// What a neighbour's own visible box answers to: it must still be the neighbour, never a link's area.
function stillAnswersForItself(element) {
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  const misses = [];
  for (const x of [rect.left + 1, (rect.left + rect.right) / 2, rect.right - 1]) {
    for (const y of [rect.top + 1, (rect.top + rect.bottom) / 2, rect.bottom - 1]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === element || element.contains(hit))) misses.push(`(${x.toFixed(1)}, ${y.toFixed(1)}) reached ${hit ? hit.outerHTML.slice(0, 60) : 'nothing'}`);
    }
  }
  return misses;
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// The control's box and its row's boxes with the tap area switched off: what it looked like before.
async function boxesWithoutArea(page, selector) {
  const read = () => page.locator(selector).evaluateAll((elements) => elements.map((element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
  }));
  const withArea = await read();
  const style = await page.addStyleTag({ content: WITHOUT_AREA });
  const withoutArea = await read();
  await style.evaluate((element) => element.remove());
  return { withArea, withoutArea };
}

async function checkJourneyLinks(page, label) {
  const links = page.locator('.trip-record-links button');
  await expect(links).toHaveCount(2);
  const [history, edit] = [await links.nth(0).evaluate(measure, 'gaps'), await links.nth(1).evaluate(measure, 'gaps')];
  for (const [name, link] of [['See event history', history], ['Edit journey', edit]]) {
    // Every edge of the box reaching the middle of the gaps around it answers for the link.
    expect(link.misses, `${label}: ${name}'s tap area answers for it at every edge`).toEqual([]);
    expect(link.area.width, `${label}: ${name} is at least 44px wide`).toBeGreaterThanOrEqual(MIN_TARGET);
    test.info().annotations.push({ type: 'tap area', description: `${label} · ${name}: visible ${link.visible.width.toFixed(2)}×${link.visible.height.toFixed(2)}, tap ${link.area.width.toFixed(2)}×${link.area.height.toFixed(2)}` });
  }
  expect(overlaps(history.inRow, edit.inRow), `${label}: the two links' tap areas never overlap`).toBe(false);

  // The actor select sits under or beside them, depending on the width. It keeps every point of its own box.
  const actor = page.locator('#actor-control');
  await expect(actor).toBeVisible();
  expect(await actor.evaluate(stillAnswersForItself), `${label}: the actor select keeps its own box`).toEqual([]);
  const actorBox = await actor.evaluate(inRow);
  for (const [name, link] of [['See event history', history], ['Edit journey', edit]]) {
    expect(overlaps(link.inRow, actorBox), `${label}: ${name}'s tap area stays off the actor select`).toBe(false);
  }
  // And each link keeps its own box from the other.
  expect(await links.nth(0).evaluate(stillAnswersForItself), `${label}: See event history keeps its own box`).toEqual([]);
  expect(await links.nth(1).evaluate(stillAnswersForItself), `${label}: Edit journey keeps its own box`).toEqual([]);

  const { withArea, withoutArea } = await boxesWithoutArea(page, '.trip-identity, .trip-record-links, .trip-record-links > *');
  expect(withArea, `${label}: the journey row is laid out exactly as without the tap areas`).toEqual(withoutArea);
}

async function checkPlaces(page, label) {
  const buttons = page.locator('.location-list button');
  const areas = [];
  for (let index = 0; index < PLACES.length; index += 1) {
    const remove = await buttons.nth(index).evaluate(measure, 'centred');
    expect(remove.misses, `${label}: Remove ${PLACES[index]} answers at every edge of its 44px box`).toEqual([]);
    expect(remove.area.width).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(remove.area.height).toBeGreaterThanOrEqual(MIN_TARGET);
    // The box stays inside the place's own row, so it can never reach another place's Remove.
    const row = await buttons.nth(index).evaluate((button) => { const { left, top, right, bottom } = button.closest('li').getBoundingClientRect(); return { left, top, right, bottom }; });
    expect(remove.area.top, `${label}: Remove ${PLACES[index]} stays inside its row`).toBeGreaterThanOrEqual(row.top);
    expect(remove.area.bottom, `${label}: Remove ${PLACES[index]} stays inside its row`).toBeLessThanOrEqual(row.bottom);
    areas.push(remove.inRow);
    if (index === 0) test.info().annotations.push({ type: 'tap area', description: `${label} · Remove: visible ${remove.visible.width.toFixed(2)}×${remove.visible.height.toFixed(2)}, tap ${remove.area.width.toFixed(2)}×${remove.area.height.toFixed(2)}` });
  }
  for (let a = 0; a < areas.length; a += 1) {
    for (let b = a + 1; b < areas.length; b += 1) expect(overlaps(areas[a], areas[b]), `${label}: two places' Remove areas never overlap`).toBe(false);
  }
  const { withArea, withoutArea } = await boxesWithoutArea(page, '.location-list, .location-list li, .location-list li > *');
  expect(withArea, `${label}: the places are laid out exactly as without the tap areas`).toEqual(withoutArea);
}

for (const width of WIDTHS) {
  test(`at ${width}px, the journey links and a place's Remove answer across their tap areas in every theme`, async ({ page }) => {
    await beginWithAMoment(page, width);
    for (const theme of THEMES) {
      await page.locator('#workspace-theme-select').selectOption(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await checkJourneyLinks(page, `${theme} ${width}px`);
      await openPlaces(page);
      await checkPlaces(page, `${theme} ${width}px`);
      await page.keyboard.press('Escape');
      await expect(page.locator('#moment-dialog')).toBeHidden();
    }
  });

  test(`at ${width}px, the focus ring still follows the control, and forced colours keep the tap areas`, async ({ page }) => {
    await beginWithAMoment(page, width);
    // Reached by keyboard, so the ring is the one a keyboard user sees.
    await page.locator('#event-manager-button').focus();
    await page.keyboard.press('Shift+Tab');
    for (const id of ['#event-manager-button', '#edit-journey-button']) {
      await page.keyboard.press('Tab');
      const link = page.locator(id);
      await expect(link).toBeFocused();
      expect(await link.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
    }
    await openPlaces(page);
    await page.locator('#add-manual-location').focus();
    await page.keyboard.press('Tab');
    const remove = page.locator('.location-list button').first();
    await expect(remove).toBeFocused();
    expect(await remove.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    expect(await remove.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');

    // The area paints nothing of its own, so there is nothing for forced colours to repaint.
    for (const selector of ['.trip-record-links button', '.location-list button']) {
      const paint = await page.locator(selector).first().evaluate((element) => {
        const before = getComputedStyle(element, '::before');
        return { background: before.backgroundColor, border: before.borderStyle, outline: before.outlineStyle, shadow: before.boxShadow, content: before.content };
      });
      expect(paint, `${selector}::before paints nothing`).toEqual({ background: 'rgba(0, 0, 0, 0)', border: 'none', outline: 'none', shadow: 'none', content: '""' });
    }
    await page.keyboard.press('Escape');

    await page.emulateMedia({ forcedColors: 'active' });
    await checkJourneyLinks(page, `forced colours ${width}px`);
    await openPlaces(page);
    await checkPlaces(page, `forced colours ${width}px`);
  });
}
