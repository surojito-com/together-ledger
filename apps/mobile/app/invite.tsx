import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { InvitationPreview } from '../src/api/client';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { ACCOUNT_WHILE_OFFLINE } from '../src/auth/session-state';
import { Body, Button, Field, Notice, Screen } from '../src/components/ui';
import { readPastedInvitation } from '../src/invitations/invitation-link';
import { closedInvitationMessage, invitationDate, INVITATION_WORDS as WORDS, isSettled } from '../src/invitations/invitation-words';
import { usePendingInvitation } from '../src/invitations/use-pending-invitation';
import { useJourney } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';
import { fonts, useTheme } from '../src/theme';

type Read = { code: string; answer: InvitationPreview };

/**
 * An invitation, on the phone (#266). A tapped link opens here, and so does "Have an invitation?",
 * where the whole link or just its code can be pasted: the iPhone's way in after installing,
 * since nothing carries a link through the App Store.
 *
 * It shows who invited them and to which journey, and waits for their answer. Everyone already in
 * the journey agreed before the invitation was sent (migration 022); joining is the person's own
 * decision, and the phone never says they joined until the server says so. Looking spends nothing.
 */
export default function InviteScreen() {
  const session = useSession();
  const pending = usePendingInvitation();
  const journey = useJourney();
  const shell = useShell();
  const { theme } = useTheme();
  const { code: arrived } = useLocalSearchParams<{ code?: string }>();
  const [pasted, setPasted] = useState('');
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'join' | 'refresh' | 'resend' | 'open' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const code = pending.code;
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const verified = session.status === 'signed-in' && session.user.emailVerified;
  const { keep, forget } = pending;

  // A tapped link hands its code over once (+native-intent.tsx); from then on it is kept on the
  // phone, and the address no longer carries it.
  useEffect(() => {
    if (!arrived) return;
    keep(String(arrived));
    router.setParams({ code: undefined });
  }, [arrived, keep]);

  // Read again whenever who is signed in, or whether their email is verified, changes: coming back
  // from verifying it in the browser is exactly when the answer changes.
  useEffect(() => {
    if (!userId || !code) return;
    let active = true;
    session.client.previewInvitation(code).then((answer) => {
      if (!active) return;
      setProblem(null);
      setRead({ code, answer });
      if (isSettled(answer)) forget();
    }, (error) => active && setProblem(accountMessage(error)));
    return () => { active = false; };
    // The session object changes identity as it refreshes; who and whether verified is what counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, verified, code, attempt]);

  // What was read stays on screen once the phone has let a settled invitation go.
  const shown = read && (read.code === code || (!code && isSettled(read.answer))) ? read.answer : null;

  async function openPasted() {
    const result = readPastedInvitation(pasted);
    if ('problem' in result) {
      setPasteProblem(WORDS.pasted[result.problem]);
      return;
    }
    setPasteProblem(null);
    setPasted('');
    setRead(null);
    await keep(result.code);
  }

  async function openJourney(journeyId: string) {
    setBusy('open');
    try {
      shell.completeOnboarding();
      await journey.open(journeyId);
      router.dismissTo('/ledger');
    } finally {
      setBusy(null);
    }
  }

  async function join(held: string, journeyName: string) {
    setBusy('join');
    setProblem(null);
    try {
      const journeyId = await session.client.acceptInvitation(held);
      await forget();
      shell.showToast(WORDS.joined(journeyName));
      shell.completeOnboarding();
      await journey.open(journeyId);
      router.dismissTo('/ledger');
    } catch (error) {
      const refused = (error as { code?: string }).code;
      // It changed since it was read (it ran out, or was withdrawn): read it again, and say why.
      if (refused === 'invalid_invitation' || refused === 'email_unverified') {
        if (refused === 'email_unverified') await session.refresh();
        setAttempt((value) => value + 1);
        return;
      }
      // A full journey, or one person's limit, leaves the invitation waiting; the server says so.
      setProblem(accountMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function notNow(expiresAt: string | null) {
    await forget();
    shell.showToast(WORDS.notNowDone(invitationDate(expiresAt)));
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  const pasteForm = (
    <>
      <Body>{WORDS.pasteLead}</Body>
      <Field label={WORDS.pasteLabel} value={pasted} onChangeText={(text) => { setPasted(text); setPasteProblem(null); }} problem={pasteProblem} autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="URL" keyboardType="url" returnKeyType="go" onSubmitEditing={openPasted} />
      <Button label={WORDS.openPasted} disabled={!pasted.trim()} onPress={openPasted} />
    </>
  );

  if (!pending.loaded || session.status === 'loading') return <Screen title={WORDS.title}><Body>{WORDS.reading}</Body></Screen>;

  if (!code && !shown) return <Screen title={WORDS.haveOne}>{pasteForm}</Screen>;

  if (code && session.status === 'signed-out') {
    return (
      <Screen title={WORDS.title}>
        <Body>{WORDS.signedOut}</Body>
        <Button label="Sign in" onPress={() => router.push('/account')} />
        <Button kind="quiet" label="Create account" onPress={() => router.push('/register')} />
        <Button kind="quiet" label={WORDS.notNow} onPress={() => notNow(null)} />
      </Screen>
    );
  }

  if (code && session.status === 'offline') {
    return (
      <Screen title={WORDS.title}>
        <Body>{ACCOUNT_WHILE_OFFLINE[session.reason]}</Body>
        <Button kind="quiet" label="Try again" pending={busy === 'refresh'} onPress={async () => {
          setBusy('refresh');
          try { await session.refresh(); } finally { setBusy(null); }
        }} />
      </Screen>
    );
  }

  if (!shown) {
    return (
      <Screen title={WORDS.title}>
        {problem ? <Notice message={problem} tone="problem" /> : <Body>{WORDS.reading}</Body>}
        {problem ? <Button kind="quiet" label="Try again" onPress={() => { setProblem(null); setAttempt((value) => value + 1); }} /> : null}
      </Screen>
    );
  }

  if (shown.state === 'open' && code) {
    const until = invitationDate(shown.expiresAt);
    return (
      <Screen title={WORDS.title}>
        <Text style={[styles.eyebrow, { color: theme.colors.accent }]}>{WORDS.waitingEyebrow}</Text>
        <Text accessibilityRole="header" style={[styles.headline, fonts.serif, { color: theme.colors.fg }]}>{WORDS.invitedBy(shown.invitedByDisplayName, shown.journeyName)}</Text>
        <Body>{WORDS.agreed}</Body>
        {until ? <Body>{WORDS.openUntil(until)}</Body> : null}
        <Notice message={problem} tone="problem" />
        <Button label={WORDS.join} pending={busy === 'join'} pendingLabel={WORDS.joining} onPress={() => join(code, shown.journeyName)} />
        <Button kind="quiet" label={WORDS.notNow} disabled={busy === 'join'} onPress={() => notNow(shown.expiresAt)} />
      </Screen>
    );
  }

  if (shown.state === 'verify_email') {
    return (
      <Screen title={WORDS.title}>
        <Body>{WORDS.verifyEmail}</Body>
        <Notice message={notice ?? problem} tone={problem && !notice ? 'problem' : 'info'} />
        {/* The account screen's own words and buttons for the same thing. */}
        <Button kind="quiet" label="Resend verification email" pending={busy === 'resend'} pendingLabel="Sending…" onPress={async () => {
          setBusy('resend');
          setNotice(null);
          try {
            setNotice(await session.client.resendVerification() ? ACCOUNT_NOTICES.verificationResent : ACCOUNT_NOTICES.verificationDelayed);
          } catch (error) {
            setProblem(accountMessage(error));
          } finally {
            setBusy(null);
          }
        }} />
        <Button kind="quiet" label="I verified it in my browser" pending={busy === 'refresh'} onPress={async () => {
          setBusy('refresh');
          try {
            await session.refresh();
            setAttempt((value) => value + 1);
          } finally {
            setBusy(null);
          }
        }} />
      </Screen>
    );
  }

  if (shown.state === 'another_account') {
    return (
      <Screen title={WORDS.title}>
        <Body>{WORDS.anotherAccount}</Body>
        <Button kind="quiet" label={WORDS.goToAccount} onPress={() => router.push('/account')} />
      </Screen>
    );
  }

  // It can't be answered: already in it, used, ran out, withdrawn, or not one at all.
  return (
    <Screen title={WORDS.title}>
      <Body>{closedInvitationMessage(shown)}</Body>
      {shown.state === 'already_member' ? <Button label={WORDS.openJourney} pending={busy === 'open'} onPress={() => openJourney(shown.journeyId)} /> : null}
      {code ? null : pasteForm}
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 12, fontWeight: '900', letterSpacing: 1.9, textTransform: 'uppercase' },
  headline: { fontSize: 28, lineHeight: 34 },
});
