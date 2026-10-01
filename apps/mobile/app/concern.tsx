import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Choices } from '../src/components/choices';
import { Body, Button, Field, Screen } from '../src/components/ui';
import { CONCERN_STATUSES, type SharingSnapshot } from '../src/journey/sharing-view';
import { useJourney } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';

/**
 * Start or change a conversation to return to: the web's #concern-dialog (TL-M-09, #184). An edit
 * is sent from the version it was read at, so a newer change made elsewhere is a conflict rather
 * than something quietly overwritten.
 */
export default function ConcernScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const session = useSession();
  const { state, reload } = useJourney();
  const { showStatus, showToast } = useShell();
  const snapshot = state.phase === 'ready' ? (state.snapshot as unknown as SharingSnapshot) : null;
  const existing = id ? snapshot?.concerns.find((concern) => concern.id === id) : undefined;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [detail, setDetail] = useState(existing?.detail ?? '');
  const [status, setStatus] = useState(existing?.status ?? 'open');
  const [pending, setPending] = useState(false);

  if (session.status !== 'signed-in' || !snapshot) return <Screen title="Return-to conversation"><Body>Sign in and open a journey first.</Body></Screen>;
  if (id && !existing) return <Screen title="Return-to conversation"><Body>This conversation is no longer here. It may have been deleted on another device.</Body></Screen>;

  const save = async () => {
    setPending(true);
    try {
      const concern = { title: title.trim(), detail: detail.trim(), status };
      if (existing) await session.client.updateConcern(snapshot.journey.id, existing.id, { ...concern, version: existing.version });
      else await session.client.createConcern(snapshot.journey.id, concern);
      await reload();
      showToast(existing ? 'Concern changes synced.' : 'Concern securely synced.');
      router.back();
    } catch (error) {
      showStatus(accountMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Screen title={existing ? 'Edit return-to conversation' : 'Start a return-to conversation'} lead="Use this for something you want to come back to together. It stays open until you choose otherwise.">
      <Field label="What would you like to return to?" value={title} onChangeText={setTitle} maxLength={100} placeholder="What would feel good to return to?" />
      <Field label="A little context" value={detail} onChangeText={setDetail} maxLength={500} multiline />
      <Choices label="Status" options={CONCERN_STATUSES} selected={status} onSelect={setStatus} />
      <Button label={existing ? 'Save conversation changes' : 'Keep this open'} pending={pending} disabled={!title.trim()} onPress={save} />
    </Screen>
  );
}
