/**
 * What the phone sells, and which of it a journey is offered (the Book, 4 · Decision guide → 4.7,
 * and 1 · The Book → "Together Ledger store products", owner, Oct 7, 2026). The product IDs are
 * the same in both stores and the same as the server's (server/store-products.js), which is what
 * a test holds them to.
 *
 * No price is written here. Every price shown is the one the App Store or Google Play returns for
 * this person's storefront, so it is always what they will actually be asked to pay.
 *
 * Kept free of runtime imports so the tests can run it directly.
 */
export type RoomProductId = 'room_51_monthly' | 'room_101_monthly' | 'room_51_week_pass' | 'room_101_week_pass' | 'room_51_month_pass' | 'room_101_month_pass';
export type ExtraProductId = 'extra_photo' | 'extra_place';
export type StoreProductId = RoomProductId | ExtraProductId;

export type StoreProductInfo = {
  id: StoreProductId;
  kind: 'subscription' | 'pass' | 'extra';
  /** The name in both stores (the Book's display names). */
  label: string;
  /** What it does, in the stores' description words. */
  detail: string;
  people?: 51 | 101;
  extra?: 'photo' | 'place';
};

export const STORE_PRODUCTS: Readonly<Record<StoreProductId, StoreProductInfo>> = Object.freeze({
  room_51_monthly: { id: 'room_51_monthly', kind: 'subscription', people: 51, label: 'Room for 51 people', detail: 'Up to 51 people in this journey, renewing every month' },
  room_101_monthly: { id: 'room_101_monthly', kind: 'subscription', people: 101, label: 'Room for 101 people', detail: 'Up to 101 people in this journey, renewing every month' },
  room_51_week_pass: { id: 'room_51_week_pass', kind: 'pass', people: 51, label: 'A week for 51 people', detail: 'Up to 51 people in this journey for 7 days' },
  room_101_week_pass: { id: 'room_101_week_pass', kind: 'pass', people: 101, label: 'A week for 101 people', detail: 'Up to 101 people in this journey for 7 days' },
  room_51_month_pass: { id: 'room_51_month_pass', kind: 'pass', people: 51, label: 'A month for 51 people', detail: 'Up to 51 people in this journey for a month' },
  room_101_month_pass: { id: 'room_101_month_pass', kind: 'pass', people: 101, label: 'A month for 101 people', detail: 'Up to 101 people in this journey for a month' },
  extra_photo: { id: 'extra_photo', kind: 'extra', extra: 'photo', label: 'An extra photo', detail: 'One more photo on this moment, kept for good' },
  extra_place: { id: 'extra_place', kind: 'extra', extra: 'place', label: 'An extra place', detail: 'One more place on this moment, kept for good' },
});

export const SUBSCRIPTION_IDS: RoomProductId[] = ['room_51_monthly', 'room_101_monthly'];
export const PASS_IDS: RoomProductId[] = ['room_51_week_pass', 'room_101_week_pass', 'room_51_month_pass', 'room_101_month_pass'];
export const EXTRA_IDS: ExtraProductId[] = ['extra_photo', 'extra_place'];
/** Bought with the store's one-time purchase rather than its subscription flow. */
export const ONE_TIME_IDS: StoreProductId[] = [...PASS_IDS, ...EXTRA_IDS];

export function storeProductInfo(productId: string): StoreProductInfo | null {
  return Object.hasOwn(STORE_PRODUCTS, productId) ? STORE_PRODUCTS[productId as StoreProductId] : null;
}

export type StorePlatformName = 'ios' | 'android';

export function storeName(platform: StorePlatformName) {
  return platform === 'ios' ? 'the App Store' : 'Google Play';
}

/** A running subscription the store reports for this store account, and the journey value it carries. */
export type HeldSubscription = { productId: RoomProductId; journeyValue: string | null; purchaseToken?: string | null };

export type RoomOffer = {
  /** 'subscriptions' for the payer's first paid journey; 'passes' for every other one. */
  shape: 'subscriptions' | 'passes';
  /** The subscription already making room for this journey, if it is this one's. */
  current: HeldSubscription | null;
  products: RoomProductId[];
};

/**
 * Which room a journey is offered (the Book, 4.7, "How it renews"). The payer's first paid journey
 * is an ordinary monthly subscription; every other journey uses week or month passes, renewed by
 * hand. That is also what the stores allow: an Apple ID holds one subscription per group, so
 * selling a second one would quietly move the first journey's room to this one
 * (docs/STORE_PURCHASES.md, "The room follows the journey the person has just paid from").
 *
 * So a journey is offered the subscriptions while this store account holds none, or while the one
 * it holds is this journey's own (then to change between 51 and 101 people). A subscription held
 * for another journey means passes here.
 */
export function roomOfferFor(held: HeldSubscription[], thisJourneyValue: string | null): RoomOffer {
  const value = (thisJourneyValue || '').toLowerCase();
  const own = value ? held.find((subscription) => (subscription.journeyValue || '').toLowerCase() === value) || null : null;
  if (own) return { shape: 'subscriptions', current: own, products: SUBSCRIPTION_IDS };
  if (held.length) return { shape: 'passes', current: null, products: PASS_IDS };
  return { shape: 'subscriptions', current: null, products: SUBSCRIPTION_IDS };
}

/**
 * The extras a moment is offered. Every moment's first photo and first place stay free, so an
 * extra is offered only once the moment holds the one that is included.
 */
export function extrasFor(moment: { locations?: unknown[] | null; images?: unknown[] | null }): ExtraProductId[] {
  const offered: ExtraProductId[] = [];
  if ((moment.images?.length ?? 0) >= 1) offered.push('extra_photo');
  if ((moment.locations?.length ?? 0) >= 1) offered.push('extra_place');
  return offered;
}

// The words: people, room and rest (CLAUDE.md, "Language"). Capacity is never counted out in pieces,
// and when a payment lapses people rest; nobody is taken out of a journey.

export const ROOM_TITLE = 'Room for more people';

export const ROOM_INTRO = 'A journey of two is free. Room for more people belongs to this journey, so it is the same on every device anyone here uses.';

/** Said plainly in journey settings (the Book, 4.7, "One person pays, for now"). */
export const ONE_PAYER = 'One person pays for a journey today: whoever owns it. Being able to hand paying over to someone else, or ask them to take it on, is coming.';

export function roomShapeCopy(offer: RoomOffer, platform: StorePlatformName) {
  if (offer.current) return `This journey's room renews every month through ${storeName(platform)}. To change between 51 and 101 people, choose the other size. Cancel it with ${platform === 'ios' ? 'Apple' : 'Google'}, in your subscriptions there.`;
  if (offer.shape === 'subscriptions') return `Your first paid journey renews by itself every month through ${storeName(platform)}, until you cancel it there.`;
  return 'Your monthly room already belongs to another journey, so this one uses passes: a week or a month at a time, renewed by hand. A pass bought while another is running starts when that one ends.';
}

export const EXTRAS_TITLE = 'More on this moment';

export const EXTRAS_INTRO = 'Every moment’s first photo and first place stay free. An extra photo or place is paid for once, and stays with this moment for good. It never rests and never lapses.';

export function notOfferedYet(platform: StorePlatformName) {
  return `${platform === 'ios' ? 'The App Store' : 'Google Play'} isn’t offering this yet.`;
}

export const STORE_UNAVAILABLE = 'Purchases can’t be made on this phone right now. Nothing was charged.';

/** Owner, Oct 8, 2026, and App Store guideline 5.1.1(v): said before an account is deleted. */
export const STORE_SUBSCRIPTION_NOT_CANCELLED = 'A subscription bought in the App Store or Google Play is not cancelled by deleting your account. Cancel it with Apple or Google, or it keeps renewing.';
