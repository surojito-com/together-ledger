import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { useJourney } from '../journey/use-journey';
import { useShell } from '../shell/shell-provider';
import { asStoreKit, loadStoreKit, storePlatform, type ExpoIap } from './store-kit';
import {
  ONE_TIME_IDS,
  STORE_UNAVAILABLE,
  SUBSCRIPTION_IDS,
  storeName,
  storeProductInfo,
  type ExtraProductId,
  type HeldSubscription,
  type RoomProductId,
  type StoreProductId,
} from './store-products';
import {
  KEPT_MESSAGE,
  settleStorePurchase,
  startStorePurchase,
  StorePurchaseRefused,
  WAITING_MESSAGE,
  type GrantedPurchase,
  type ListedProduct,
  type Replacing,
  type Settled,
  type StorePlatform,
  type StoreTransaction,
} from './store-purchase';

/**
 * The phone's connection to the App Store or Google Play while someone is signed in (#272).
 *
 * Everything bought comes back through the store library's purchase listener: a purchase made
 * just now, a renewal, or one the store hands back on launch because it was never finished. Each
 * is sent to our server, and the store is told it is finished only as the server's answer says
 * (settleStorePurchase in store-purchase.ts). Our server, not this phone, decides what it becomes.
 */
type StoreValue = {
  platform: StorePlatform | null;
  /** The store answered and can sell. False in a build without the store library, or before it connects. */
  ready: boolean;
  /** The store's own listing of each product, with its price for this person's storefront. */
  products: Partial<Record<StoreProductId, ListedProduct>>;
  /** Subscriptions this store account holds, with the journey value each carries. */
  held: HeldSubscription[];
  /** Extras paid for whose moment this phone no longer knows, waiting to be put on one. */
  waitingExtras: StoreTransaction[];
  /** The product a purchase is under way for. */
  buying: StoreProductId | null;
  restoring: boolean;
  /** The journey value this account carries into a purchase for a journey (#269). */
  journeyValue: (journeyId: string) => Promise<string | null>;
  buyRoom: (journeyId: string, productId: RoomProductId, replacing?: Replacing | null) => Promise<void>;
  buyExtra: (journeyId: string, momentId: string, productId: ExtraProductId) => Promise<void>;
  placeWaitingExtra: (purchase: StoreTransaction, momentId: string) => Promise<void>;
  restore: () => Promise<void>;
};

const StoreContext = createContext<StoreValue | null>(null);

type Intent = { journeyId: string; momentId: string | null };

function dateLabel(value: string | null | undefined) {
  const date = new Date(value || '');
  return value && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date) : null;
}

/** What the person is told once our server has honoured a purchase. */
export function grantedMessage(result: GrantedPurchase, now = Date.now()) {
  if (result.extra) return result.extra.kind === 'photo' ? 'An extra photo is ready on this moment. It stays with the moment for good.' : 'An extra place is ready on this moment. It stays with the moment for good.';
  const people = result.room?.people;
  const from = result.room?.from ? Date.parse(result.room.from) : NaN;
  if (Number.isFinite(from) && from > now) return `Room for ${people} people is paid for. It starts on ${dateLabel(result.room?.from)}, when the room already running ends.`;
  if (result.kind === 'subscription') return `Room for ${people} people is ready in this journey, and renews every month.`;
  const until = dateLabel(result.room?.until);
  return `Room for ${people} people is ready in this journey${until ? ` until ${until}` : ''}.`;
}

function heldFrom(purchases: StoreTransaction[], platform: StorePlatform): HeldSubscription[] {
  return purchases
    .filter((purchase) => (SUBSCRIPTION_IDS as string[]).includes(purchase.productId))
    .map((purchase) => ({
      productId: purchase.productId as RoomProductId,
      journeyValue: (platform === 'ios' ? purchase.appAccountToken : purchase.obfuscatedProfileIdAndroid) || null,
      purchaseToken: platform === 'android' ? purchase.purchaseToken : null,
    }));
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const { client } = session;
  const { reload } = useJourney();
  const { showStatus, showToast } = useShell();
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const platform = storePlatform();
  const [iap, setIap] = useState<ExpoIap | null>(null);
  const [products, setProducts] = useState<StoreValue['products']>({});
  const [held, setHeld] = useState<HeldSubscription[]>([]);
  const [waitingExtras, setWaitingExtras] = useState<StoreTransaction[]>([]);
  const [buying, setBuying] = useState<StoreProductId | null>(null);
  const [restoring, setRestoring] = useState(false);
  // What each purchase started on this phone was for. An extra needs its moment, which the store
  // does not carry, so it is remembered here from the tap until the store answers.
  const intents = useRef(new Map<string, Intent>());
  const settling = useRef(new Set<string>());
  const values = useRef(new Map<string, string>());

  const settle = useCallback(async (kit: ExpoIap, purchase: StoreTransaction, { announce, momentId }: { announce: boolean; momentId?: string | null }): Promise<Settled | null> => {
    if (!platform) return null;
    const key = purchase.transactionId || purchase.id || purchase.purchaseToken || '';
    if (settling.current.has(key)) return null;
    settling.current.add(key);
    try {
      const intent = intents.current.get(purchase.productId);
      const moment = momentId ?? intent?.momentId ?? null;
      const settled = await settleStorePurchase({ kit: asStoreKit(kit), client, platform, purchase, momentId: moment });
      const extra = storeProductInfo(purchase.productId)?.kind === 'extra';
      if (settled.outcome === 'granted') {
        intents.current.delete(purchase.productId);
        setWaitingExtras((current) => current.filter((entry) => entry.id !== purchase.id));
        if (announce || intent) showToast(grantedMessage(settled.result));
        reload();
      } else if (settled.outcome === 'waiting') {
        if (announce || intent) showStatus(WAITING_MESSAGE, { tone: 'caution', source: 'store' });
      } else if (settled.outcome === 'kept' && extra && ['store_extra_needs_moment', 'store_extra_moment_missing'].includes(settled.code)) {
        // Paid for, and its moment is not known or has gone: it waits to be put on another.
        setWaitingExtras((current) => current.some((entry) => entry.id === purchase.id) ? current : [...current, purchase]);
        if (announce || intent) showStatus(settled.message, { tone: 'caution', source: 'store' });
      } else if (announce || intent) {
        showStatus(settled.message, { tone: settled.outcome === 'kept' ? 'caution' : 'problem', source: 'store' });
      }
      if (settled.outcome === 'refused') intents.current.delete(purchase.productId);
      return settled;
    } finally {
      settling.current.delete(key);
    }
  }, [client, platform, reload, showStatus, showToast]);

  const refreshHeld = useCallback(async (kit: ExpoIap) => {
    if (!platform) return [] as StoreTransaction[];
    const purchases = (await kit.getAvailablePurchases({ onlyIncludeActiveItemsIOS: true }).catch(() => [])) as unknown as StoreTransaction[];
    setHeld(heldFrom(purchases, platform));
    return purchases;
  }, [platform]);

  // Connect while someone is signed in, and hand back to our server anything left unfinished.
  useEffect(() => {
    if (!userId || !platform) return;
    let current = true;
    let subscriptions: { remove(): void }[] = [];
    let kit: ExpoIap | null = null;
    const startedFor = intents.current;
    const valuesFor = values.current;
    (async () => {
      kit = await loadStoreKit();
      if (!kit || !current) return;
      try {
        await kit.initConnection();
      } catch {
        return;
      }
      if (!current) return;
      const connected = kit;
      subscriptions = [
        connected.purchaseUpdatedListener((purchase) => { settle(connected, purchase as unknown as StoreTransaction, { announce: false }); }),
        connected.purchaseErrorListener((error) => {
          setBuying(null);
          if (connected.isUserCancelledError(error)) return;
          showStatus('The store didn’t complete the purchase, so nothing was charged.', { source: 'store' });
        }),
      ];
      setIap(connected);
      const [subs, oneTime] = await Promise.all([
        connected.fetchProducts({ skus: SUBSCRIPTION_IDS, type: 'subs' }).catch(() => null),
        connected.fetchProducts({ skus: ONE_TIME_IDS, type: 'in-app' }).catch(() => null),
      ]);
      if (!current) return;
      const listed: StoreValue['products'] = {};
      for (const product of [...(subs || []), ...(oneTime || [])] as unknown as ListedProduct[]) {
        if (storeProductInfo(product.id)) listed[product.id as StoreProductId] = product;
      }
      setProducts(listed);
      // Unfinished purchases: StoreKit redelivers them, and Play returns unacknowledged ones.
      for (const purchase of await refreshHeld(connected)) {
        if (current) await settle(connected, purchase, { announce: false });
      }
    })();
    return () => {
      current = false;
      for (const subscription of subscriptions) subscription.remove();
      setIap(null);
      setProducts({});
      setHeld([]);
      setWaitingExtras([]);
      startedFor.clear();
      valuesFor.clear();
      if (kit) kit.endConnection().catch(() => undefined);
    };
  }, [userId, platform, settle, refreshHeld, showStatus]);

  const identity = useCallback(async (journeyId: string) => {
    const found = await client.storePurchaseIdentity(journeyId);
    if (found?.appAccountToken) values.current.set(journeyId, found.appAccountToken);
    return found;
  }, [client]);

  const journeyValue = useCallback(async (journeyId: string) => {
    if (values.current.has(journeyId)) return values.current.get(journeyId) || null;
    try {
      return (await identity(journeyId))?.appAccountToken || null;
    } catch {
      return null;
    }
  }, [identity]);

  const buy = useCallback(async (journeyId: string, productId: StoreProductId, momentId: string | null, replacing: Replacing | null = null) => {
    const product = storeProductInfo(productId);
    if (!iap || !platform || !product) {
      showStatus(STORE_UNAVAILABLE, { source: 'store' });
      return;
    }
    setBuying(productId);
    try {
      intents.current.set(productId, { journeyId, momentId });
      await startStorePurchase({ kit: asStoreKit(iap), identity: await identity(journeyId), platform, product, listed: products[productId], replacing });
    } catch (error) {
      intents.current.delete(productId);
      if (iap.isUserCancelledError(error)) return;
      showStatus(error instanceof StorePurchaseRefused ? error.message : accountMessage(error), { source: 'store' });
    } finally {
      setBuying(null);
    }
  }, [iap, platform, products, identity, showStatus]);

  const buyRoom = useCallback((journeyId: string, productId: RoomProductId, replacing: Replacing | null = null) => buy(journeyId, productId, null, replacing).then(() => { if (iap) refreshHeld(iap); }), [buy, iap, refreshHeld]);
  const buyExtra = useCallback((journeyId: string, momentId: string, productId: ExtraProductId) => buy(journeyId, productId, momentId), [buy]);

  const placeWaitingExtra = useCallback(async (purchase: StoreTransaction, momentId: string) => {
    if (iap) await settle(iap, purchase, { announce: true, momentId });
  }, [iap, settle]);

  // Restore purchases (#275, Guideline 3.1.1): ask the store for everything this store account
  // holds and send each to our server, which honours what belongs to this account and explains
  // what doesn't. Nothing is charged.
  const restore = useCallback(async () => {
    if (!iap || !platform) {
      showStatus(STORE_UNAVAILABLE, { source: 'store' });
      return;
    }
    setRestoring(true);
    try {
      await iap.restorePurchases().catch(() => undefined);
      const purchases = await refreshHeld(iap);
      const outcomes = [];
      for (const purchase of purchases) outcomes.push(await settle(iap, purchase, { announce: false }));
      const refused = outcomes.find((outcome) => outcome?.outcome === 'refused');
      const kept = outcomes.find((outcome) => outcome?.outcome === 'kept');
      const granted = outcomes.filter((outcome) => outcome?.outcome === 'granted').length;
      if (refused && refused.outcome === 'refused') showStatus(refused.message, { source: 'store' });
      else if (kept && kept.outcome === 'kept') showStatus(kept.message || KEPT_MESSAGE, { tone: 'caution', source: 'store' });
      showToast(granted
        ? `Checked with ${storeName(platform)}. ${granted === 1 ? 'One purchase is' : `${granted} purchases are`} in place on your account.`
        : `Checked with ${storeName(platform)}. There was nothing to restore for this account.`);
    } finally {
      setRestoring(false);
    }
  }, [iap, platform, refreshHeld, settle, showStatus, showToast]);

  const value = useMemo<StoreValue>(() => ({
    platform,
    ready: iap !== null,
    products,
    held,
    waitingExtras,
    buying,
    restoring,
    journeyValue,
    buyRoom,
    buyExtra,
    placeWaitingExtra,
    restore,
  }), [platform, iap, products, held, waitingExtras, buying, restoring, journeyValue, buyRoom, buyExtra, placeWaitingExtra, restore]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside StoreProvider');
  return value;
}
