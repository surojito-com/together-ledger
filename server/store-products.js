// What the App Store and Google Play sell for Together Ledger, as the owner decided it on Oct 7,
// 2026 (#203, the Book's Decision guide 4.7 and its "Together Ledger store products" list). The
// product IDs are the same in both stores, so one entry here answers for both.
//
// Nothing in a store tells us how long a pass lasts: a non-renewing subscription has no duration
// field in App Store Connect, and a one-time product has none in Play Console. So the length lives
// here, read from the product ID, and nowhere else. Prices are the stores' business and are never
// checked here: the stores convert them per storefront, and a verified transaction is proof enough
// that the person paid what the store asked.
//
// `people` is how many people the journey holds once paid for. The entitlement records the room
// beyond the two a journey always holds, so 51 is stored as 49 and 101 as 99, which is the shape
// `billing_entitlements.quantity` already has (migration 020).

export const INCLUDED_PEOPLE = 2;

const ROOM = 'additional-journey-capacity';

export const STORE_PRODUCTS = Object.freeze({
  room_51_monthly: Object.freeze({ kind: 'subscription', people: 51 }),
  room_101_monthly: Object.freeze({ kind: 'subscription', people: 101 }),
  room_51_week_pass: Object.freeze({ kind: 'pass', people: 51, length: Object.freeze({ days: 7 }) }),
  room_101_week_pass: Object.freeze({ kind: 'pass', people: 101, length: Object.freeze({ days: 7 }) }),
  room_51_month_pass: Object.freeze({ kind: 'pass', people: 51, length: Object.freeze({ months: 1 }) }),
  room_101_month_pass: Object.freeze({ kind: 'pass', people: 101, length: Object.freeze({ months: 1 }) }),
  extra_photo: Object.freeze({ kind: 'extra', extra: 'photo' }),
  extra_place: Object.freeze({ kind: 'extra', extra: 'place' }),
});

// The type each store must report for a product. A product that comes back as anything else was
// set up wrongly in a console, or is not ours, and grants nothing.
const APPLE_TYPES = { subscription: 'Auto-Renewable Subscription', pass: 'Non-Renewing Subscription', extra: 'Consumable' };

export const ROOM_CAPABILITY = ROOM;

export function storeProduct(productId) {
  return Object.hasOwn(STORE_PRODUCTS, String(productId)) ? STORE_PRODUCTS[productId] : null;
}

export function appleTypeFor(product) {
  return APPLE_TYPES[product.kind];
}

// The room an entitlement records for a product: the people beyond the included two.
export function roomFor(product) {
  return product.people - INCLUDED_PEOPLE;
}

// One month from a moment is the same day and time next month, in UTC, or the last day of next
// month when it has no such day: Jan 31 runs to Feb 28 (or 29), never into March.
function addMonths(from, months) {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  return target;
}

// When a pass that starts at `from` ends. A purchase of several (a store quantity above one) runs
// that many lengths back to back.
export function passEnd(product, from, quantity = 1) {
  if (product.length.days) return new Date(from.getTime() + product.length.days * quantity * 24 * 60 * 60 * 1000);
  return addMonths(from, product.length.months * quantity);
}
