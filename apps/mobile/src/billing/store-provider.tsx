import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { useJourney } from '../journey/use-journey';
import { useShell } from '../shell/shell-provider';
import { asStoreKit, loadStoreKit, storePlatform, type ExpoIap } from './store-kit';
import {
  ONE_TIME_IDS,
  restoreAnswer,
  STORE_UNAVAILABLE,
  SUBSCRIPTION_IDS,
  storeProductInfo,
  type ExtraProductId,
  type HeldSubscription,
  type RoomProductId,
  type StoreProductId,
} from './store-products';
import {
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
  /** The store has answered what this account holds. Until then no room is offered (#340). */
  heldReady: boolean;
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
  const [heldReady, setHeldReady] = useState(false);
  const [waitingExtras, setWaitingExtras] = useState<StoreTransaction[]>([]);
  const [buying, setBuying] = useState<StoreProductId | null>(null);
  const [restoring, setRestoring] = useState(false);
  // What each purchase started on this phone was for. An extra needs its moment, which the store
  // does not carry, so it is remembered here from the tap until the store answers.
  const intents = useRef(new Map<string, Intent>());
  const settling = useRef(new Set<string>());
  const values = useRef(new Map<string, string>());
  // A purchase waiting for approval is said once, not on every sweep.
  const waitingSaid = useRef(new Set<string>());

  // The connection lives as long as the signed-in account, never as long as a journey: what it
  // calls back into is read through refs, so a new journey or a new reload() doesn't reconnect.
  const live = useRef({ client, reload, showStatus, showToast });
  useLayoutEffect(() => {
    live.current = { client, reload, showStatus, showToast };
  }, [client, reload, showStatus, showToast]);

  const refreshHeld = useCallback(async (kit: ExpoIap) => {
    if (!platform) return [] as StoreTransaction[];
    const purchases = (await kit.getAvailablePurchases({ onlyIncludeActiveItemsIOS: true }).catch(() => [])) as unknown as StoreTransaction[];
    setHeld(heldFrom(purchases, platform));
    setHeldReady(true);
    return purchases;
  }, [platform]);

  const settle = useCallback(async (kit: ExpoIap, purchase: StoreTransaction, { announce, momentId }: { announce: boolean; momentId?: string | null }): Promise<Settled | null> => {
    if (!platform) return null;
    const key = purchase.transactionId || purchase.id || purchase.purchaseToken || '';
    if (settling.current.has(key)) return null;
    settling.current.add(key);
    const { client: api, reload: reloadJourney, showStatus: status, showToast: toast } = live.current;
    try {
      const intent = intents.current.get(purchase.productId);
      const moment = momentId ?? intent?.momentId ?? null;
      const settled = await settleStorePurchase({ kit: asStoreKit(kit), client: api, platform, purchase, momentId: moment });
      const info = storeProductInfo(purchase.productId);
      const tell = announce || Boolean(intent);
      if (settled.outcome === 'granted') {
        intents.current.delete(purchase.productId);
        setWaitingExtras((current) => current.filter((entry) => entry.id !== purchase.id));
        if (tell) toast(grantedMessage(settled.result));
        reloadJourney();
        // The subscription this store account holds has changed only now that it has arrived.
        if (info?.kind === 'subscription') refreshHeld(kit);
      } else if (settled.outcome === 'waiting') {
        if (!waitingSaid.current.has(key)) {
          waitingSaid.current.add(key);
          status(WAITING_MESSAGE, { tone: 'caution', source: 'store' });
        }
      } else if (settled.outcome === 'kept' && info?.kind === 'extra' && ['store_extra_needs_moment', 'store_extra_moment_missing'].includes(settled.code)) {
        // Paid for, and its moment is not known or has gone: it waits to be put on another.
        setWaitingExtras((current) => current.some((entry) => entry.id === purchase.id) ? current : [...current, purchase]);
        if (tell) status(settled.message, { tone: 'caution', source: 'store' });
      } else if (tell) {
        status(settled.message, { tone: settled.outcome === 'kept' ? 'caution' : 'problem', source: 'store' });
      }
      if (settled.outcome === 'refused') intents.current.delete(purchase.productId);
      return settled;
    } finally {
      settling.current.delete(key);
    }
  }, [platform, refreshHeld]);
  const settleRef = useRef(settle);
  useLayoutEffect(() => {
    settleRef.current = settle;
  }, [settle]);

  // Everything the store still holds open, sent to our server: StoreKit's unfinished transactions
  // (on iOS getAvailablePurchases leaves out an unfinished consumable, so the pending ones are
  // swept as well) and Play's unacknowledged purchases. Done on connecting and every time the app
  // comes back to the foreground, so a purchase kept for a retry doesn't wait for the next launch.
  const sweeping = useRef(false);
  const sweep = useCallback(async (kit: ExpoIap) => {
    if (sweeping.current) return [] as (Settled | null)[];
    sweeping.current = true;
    try {
      const purchases = await refreshHeld(kit);
      const pending = platform === 'ios' ? ((await kit.getPendingTransactionsIOS().catch(() => [])) as unknown as StoreTransaction[]) : [];
      const seen = new Set<string>();
      const outcomes: (Settled | null)[] = [];
      for (const purchase of [...pending, ...purchases]) {
        const key = purchase.transactionId || purchase.id;
        if (seen.has(key)) continue;
        seen.add(key);
        outcomes.push(await settleRef.current(kit, purchase, { announce: false }));
      }
      return outcomes;
    } finally {
      sweeping.current = false;
    }
  }, [platform, refreshHeld]);
  const sweepRef = useRef(sweep);
  useLayoutEffect(() => {
    sweepRef.current = sweep;
  }, [sweep]);

  // Connect while someone is signed in. The listeners are registered before the connection opens,
  // as expo-iap's own useIAP does, so nothing the store delivers on connecting is missed.
  useEffect(() => {
    if (!userId || !platform) return;
    let current = true;
    let subscriptions: { remove(): void }[] = [];
    let kit: ExpoIap | null = null;
    let open = false;
    const startedFor = intents.current;
    const valuesFor = values.current;
    const said = waitingSaid.current;
    (async () => {
      kit = await loadStoreKit();
      if (!kit || !current) return;
      const connected = kit;
      subscriptions = [
        connected.purchaseUpdatedListener((purchase) => { settleRef.current(connected, purchase as unknown as StoreTransaction, { announce: false }); }),
        connected.purchaseErrorListener((error) => {
          setBuying(null);
          if (connected.isUserCancelledError(error)) return;
          if (error.code === connected.ErrorCode.DeferredPayment || error.code === connected.ErrorCode.Pending) {
            const key = `deferred:${error.productId || ''}`;
            if (said.has(key)) return;
            said.add(key);
            live.current.showStatus(WAITING_MESSAGE, { tone: 'caution', source: 'store' });
            return;
          }
          live.current.showStatus('The store didn’t complete the purchase, so nothing was charged.', { source: 'store' });
        }),
      ];
      try {
        await connected.initConnection();
      } catch {
        return;
      }
      if (!current) return;
      open = true;
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
      await sweepRef.current(connected);
    })();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active' && current && open && kit) sweepRef.current(kit);
    });
    return () => {
      current = false;
      foreground.remove();
      for (const subscription of subscriptions) subscription.remove();
      setIap(null);
      setProducts({});
      setHeld([]);
      setHeldReady(false);
      setWaitingExtras([]);
      startedFor.clear();
      valuesFor.clear();
      said.clear();
      if (kit) kit.endConnection().catch(() => undefined);
    };
  }, [userId, platform]);

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

  const buyRoom = useCallback((journeyId: string, productId: RoomProductId, replacing: Replacing | null = null) => buy(journeyId, productId, null, replacing), [buy]);
  const buyExtra = useCallback((journeyId: string, momentId: string, productId: ExtraProductId) => buy(journeyId, productId, momentId), [buy]);

  const placeWaitingExtra = useCallback(async (purchase: StoreTransaction, momentId: string) => {
    if (iap) await settle(iap, purchase, { announce: true, momentId });
  }, [iap, settle]);

  // Restore purchases (#275, Guideline 3.1.1): ask the store for everything this store account
  // holds and send each to our server, which honours what belongs to this account and explains
  // what doesn't. Nothing is charged. One answer is given: a refusal, or what is kept for later,
  // or what was added. A purchase our server had already honoured is not counted as restored.
  const restore = useCallback(async () => {
    if (!iap || !platform) {
      showStatus(STORE_UNAVAILABLE, { source: 'store' });
      return;
    }
    setRestoring(true);
    try {
      await iap.restorePurchases().catch(() => undefined);
      const answer = restoreAnswer(await sweep(iap), platform);
      if (answer.kind === 'toast') showToast(answer.message);
      else showStatus(answer.message, { tone: answer.tone, source: 'store' });
    } finally {
      setRestoring(false);
    }
  }, [iap, platform, sweep, showStatus, showToast]);

  const value = useMemo<StoreValue>(() => ({
    platform,
    ready: iap !== null,
    products,
    held,
    heldReady,
    waitingExtras,
    buying,
    restoring,
    journeyValue,
    buyRoom,
    buyExtra,
    placeWaitingExtra,
    restore,
  }), [platform, iap, products, held, heldReady, waitingExtras, buying, restoring, journeyValue, buyRoom, buyExtra, placeWaitingExtra, restore]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside StoreProvider');
  return value;
}
