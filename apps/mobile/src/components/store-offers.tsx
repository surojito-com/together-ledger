import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useStore } from '../billing/store-provider';
import {
  EXTRAS_INTRO,
  EXTRAS_TITLE,
  notOfferedYet,
  ONE_PAYER,
  ROOM_INTRO,
  ROOM_TITLE,
  roomOfferFor,
  roomShapeCopy,
  subscriptionTerms,
  STORE_PRODUCTS,
  STORE_UNAVAILABLE,
  storeProductInfo,
  type ExtraProductId,
  type RoomProductId,
  type StoreProductId,
} from '../billing/store-products';
import { fonts, useTheme } from '../theme';
import { Body, Button } from './ui';

/**
 * Where the phone sells (#272): room for more people in a journey's settings, and an extra place
 * on a moment (no extra photo until the phone can add photos, #187). Every price is the store's own, for this person's storefront, and a
 * product the store does not list is shown as not offered rather than with a price of ours.
 *
 * Paying and waiting are never failures, so nothing here takes the colour kept for what cannot be
 * undone.
 */
export function RoomForMorePeople({ journeyId, isOwner }: { journeyId: string; isOwner: boolean }) {
  const store = useStore();
  const [value, setValue] = useState<string | null | undefined>(undefined);
  const { journeyValue } = store;
  useEffect(() => {
    let current = true;
    if (isOwner && store.ready) journeyValue(journeyId).then((found) => { if (current) setValue(found); });
    return () => { current = false; };
  }, [journeyId, isOwner, store.ready, journeyValue]);

  if (!isOwner) {
    return (
      <Section title={ROOM_TITLE}>
        <Body>{ROOM_INTRO}</Body>
        <Body>{ONE_PAYER}</Body>
      </Section>
    );
  }
  if (!store.platform || !store.ready) {
    return (
      <Section title={ROOM_TITLE}>
        <Body>{ROOM_INTRO}</Body>
        <Body>{STORE_UNAVAILABLE}</Body>
      </Section>
    );
  }
  const offer = roomOfferFor(store.held, value ?? null);
  return (
    <Section title={ROOM_TITLE}>
      <Body>{ROOM_INTRO}</Body>
      <Body>{ONE_PAYER}</Body>
      {/* Nothing is offered until both the journey's value and what this store account already
          holds are known, so there is no moment in which a second subscription is offered. */}
      {value === undefined || !store.heldReady ? <Body>Asking {store.platform === 'ios' ? 'the App Store' : 'Google Play'} what this journey can have…</Body> : (
        <>
          <Body>{roomShapeCopy(offer, store.platform)}</Body>
          {offer.products.map((productId) => (
            <Offer
              key={productId}
              productId={productId}
              current={offer.current?.productId === productId}
              onBuy={() => store.buyRoom(journeyId, productId as RoomProductId, offer.current?.purchaseToken ? { productId: offer.current.productId, purchaseToken: offer.current.purchaseToken } : null)}
            />
          ))}
        </>
      )}
      <RestorePurchases />
    </Section>
  );
}

/** Extras for a moment that has been held, so the purchase can name it. */
export function MomentExtras({ journeyId, momentId, offered }: { journeyId: string; momentId: string; offered: ExtraProductId[] }) {
  const store = useStore();
  const waiting = store.waitingExtras.filter((purchase) => storeProductInfo(purchase.productId)?.kind === 'extra');
  if (!store.platform || (!offered.length && !waiting.length)) return null;
  return (
    <Section title={EXTRAS_TITLE}>
      <Body>{EXTRAS_INTRO}</Body>
      {waiting.map((purchase) => {
        const label = storeProductInfo(purchase.productId)?.label.toLowerCase() || 'an extra';
        return (
          <View key={purchase.id} style={styles.offer}>
            <Body>{`You've paid for ${label} that isn't on a moment yet. It can go on this one.`}</Body>
            <Button label={`Put ${label} on this moment`} onPress={() => store.placeWaitingExtra(purchase, momentId)} />
          </View>
        );
      })}
      {store.ready ? offered.map((productId) => (
        <Offer key={productId} productId={productId} onBuy={() => store.buyExtra(journeyId, momentId, productId)} />
      )) : <Body>{STORE_UNAVAILABLE}</Body>}
    </Section>
  );
}

/** Restore purchases (#275): what this store account bought, honoured again on this phone. */
export function RestorePurchases() {
  const store = useStore();
  if (!store.platform) return null;
  return <Button kind="quiet" label="Restore purchases" pendingLabel="Checking with the store…" pending={store.restoring} disabled={!store.ready || store.buying !== null} onPress={store.restore} />;
}

function Offer({ productId, current = false, onBuy }: { productId: StoreProductId; current?: boolean; onBuy: () => void }) {
  const store = useStore();
  const { theme } = useTheme();
  const product = STORE_PRODUCTS[productId];
  const listed = store.products[productId];
  const price = listed?.displayPrice;
  const subscription = product.kind === 'subscription';
  return (
    <View style={[styles.offer, { borderColor: current ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.m }]}>
      <View style={styles.offerHead}>
        <Text style={[styles.offerTitle, { color: theme.colors.fg }]}>{product.label}</Text>
        {price ? <Text style={[styles.price, { color: theme.colors.fg }]}>{price}</Text> : null}
      </View>
      <Text style={[styles.detail, { color: theme.colors.textSecondary }]}>{product.detail}</Text>
      {/* Apple 3.1.2: an auto-renewing subscription shows its title, its length, its price, and
          working links to the terms of use and the privacy policy, beside the offer. Both open
          inside the app, never a web page (#268). */}
      {subscription ? <Text style={[styles.detail, { color: theme.colors.textSecondary }]}>{subscriptionTerms(price, store.platform || 'ios')}</Text> : null}
      {subscription ? (
        <View style={styles.links}>
          <Button kind="quiet" label="Terms of use" onPress={() => router.push('/terms')} />
          <Button kind="quiet" label="Privacy policy" onPress={() => router.push('/privacy')} />
        </View>
      ) : null}
      {current ? <Text style={[styles.detail, { color: theme.colors.muted }]}>This journey has this now.</Text> : null}
      {!price ? <Text style={[styles.detail, { color: theme.colors.muted }]}>{notOfferedYet(store.platform || 'ios')}</Text> : null}
      {price && !current ? (
        <Button
          label={`${product.label} · ${price}`}
          pendingLabel="Waiting for the store…"
          pending={store.buying === productId}
          disabled={store.buying !== null || store.restoring}
          onPress={onBuy}
        />
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: theme.colors.fg }]}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 8 },
  sectionTitle: { fontSize: 20, lineHeight: 26 },
  offer: { borderWidth: 1, padding: 14, gap: 6 },
  offerHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  offerTitle: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  price: { fontSize: 16, fontWeight: '700' },
  detail: { fontSize: 14, lineHeight: 20 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
