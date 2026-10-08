import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Body, Button, Field, Screen } from '../src/components/ui';
import {
  billingGlyph,
  billingSummary,
  CONSEQUENCES,
  dateTimeLabel,
  decisionAnswered,
  decisionToast,
  invitationStatusLabel,
  journeyCreator,
  mayManageMember,
  mayPropose,
  mayWithdraw,
  memberRow,
  moveInOrder,
  proposalDecisionLabel,
  proposalProgress,
  proposalStatusLabel,
  proposeToast,
  remainingLabel,
  restQueue,
  ROOM_IS_THE_JOURNEYS,
  sharingCopy,
  splitMembers,
  showsUnpaidCapacityRest,
  type BillingStatus,
  type InviteProposal,
  type SharingSnapshot,
} from '../src/journey/sharing-view';
import { useJourney, useReloadWhenShown } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';
import { targetSize } from '../src/theme/metrics';
import { useTheme } from '../src/theme';

/**
 * Journey sharing (TL-M-09, #184): who is here, proposing someone, the questions being decided,
 * the invitations sent, who keeps adding if a payment lapses, and where paid capacity stands. The web's
 * #sharing-settings, #unpaid-capacity-rest and #billing-panel, in its words.
 */
export default function JourneySettingsScreen() {
  const session = useSession();
  const journey = useJourney();
  const { state } = journey;
  if (session.status !== 'signed-in') return <Screen title="Journey sharing"><Body>Sign in and create a private journey to invite another journeyer.</Body></Screen>;
  if (state.phase !== 'ready') return <Screen title="Journey sharing"><Body>{state.phase === 'no-journeys' ? 'Your account is ready. Create a private journey to invite another journeyer.' : 'Loading this journey…'}</Body></Screen>;
  return <Sharing snapshot={state.snapshot as unknown as SharingSnapshot} viewerId={session.user.id} />;
}

/** Countdowns redraw on their own, every half minute, without re-reading the journey. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Sharing({ snapshot, viewerId }: { snapshot: SharingSnapshot; viewerId: string }) {
  const { client } = useSession();
  const { reload, refresh, refreshing } = useJourney();
  const { confirmConsequence, showStatus, showToast } = useShell();
  const now = useNow();
  useReloadWhenShown();
  const journeyId = snapshot.journey.id;
  const role = snapshot.journey.role;
  const creator = journeyCreator(snapshot);
  const canPropose = mayPropose(snapshot);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);

  useEffect(() => {
    let current = true;
    // Billing that is switched off, or unreachable, is simply not shown: nothing about it is a failure.
    client.billingStatus<BillingStatus>(journeyId).then((status) => { if (current) setBilling(status?.enabled ? status : null); }, () => { if (current) setBilling(null); });
    return () => { current = false; };
  }, [client, journeyId]);

  async function act(key: string, work: () => Promise<string | null>) {
    setPending(key);
    try {
      const message = await work();
      await reload();
      if (message) showToast(message);
    } catch (error) {
      showStatus(accountMessage(error));
    } finally {
      setPending(null);
    }
  }

  const propose = () => act('propose', async () => {
    const result = await client.proposeInvitation(journeyId, { email: email.trim(), note: note.trim() });
    setEmail('');
    setNote('');
    return proposeToast(result?.invitationSent);
  });

  const decide = async (proposal: InviteProposal, agreeing: boolean) => {
    if (!await confirmConsequence(agreeing ? CONSEQUENCES.agree(proposal.email) : CONSEQUENCES.decline(proposal.email))) return;
    await act(`decide-${proposal.id}`, async () => decisionToast(agreeing, (await client.decideProposal(journeyId, proposal.id, agreeing ? 'agree' : 'decline'))?.invitationSent));
  };

  const withdraw = async (proposal: InviteProposal) => {
    if (!await confirmConsequence(CONSEQUENCES.withdraw(proposal.email))) return;
    await act(`withdraw-${proposal.id}`, async () => {
      await client.withdrawProposal(journeyId, proposal.id);
      return 'Withdrawn. Nothing was sent, and nobody was added.';
    });
  };

  const transfer = async (memberId: string, name: string) => {
    if (!await confirmConsequence(CONSEQUENCES.transfer(name))) return;
    await act(`transfer-${memberId}`, async () => {
      await client.transferOwnership(journeyId, memberId);
      return `${name} is now the journey owner.`;
    });
  };

  const remove = async (memberId: string, name: string) => {
    if (!await confirmConsequence(CONSEQUENCES.remove(name))) return;
    await act(`remove-${memberId}`, async () => {
      await client.removeMember(journeyId, memberId);
      return `${name} was removed from this journey.`;
    });
  };

  const saveRest = (restOrder: string[]) => act('rest-order', async () => {
    await client.setRestOrder(journeyId, restOrder);
    return 'Saved the resting order.';
  });

  const proposals = snapshot.inviteProposals || [];
  const invitations = snapshot.invitations || [];
  const queue = restQueue(snapshot.members, snapshot.capacity?.restOrder);
  const resting = new Set(snapshot.capacity?.restingMemberIds || []);
  const order = queue.map((member) => member.id);

  return (
    <Screen title="Journey sharing" lead={sharingCopy(snapshot.members.length, canPropose)} refresh={{ refreshing, onRefresh: refresh }}>
      {canPropose ? (
        <Section title="Propose a journeyer">
          <Field label="Propose a journeyer by email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" placeholder="journeyer@example.com" hint="Everyone already in this journey has to agree before anything is sent. Until they all do, nothing reaches this person and they learn nothing about the journey." />
          <Field label="Who they are" value={note} onChangeText={setNote} maxLength={300} placeholder="My sister, who has been asking after you" hint="Optional, and shown to the journeyers deciding, so they answer about a person rather than an address." />
          <Button label="Propose this person" pendingLabel="Proposing…" pending={pending === 'propose'} disabled={!email.trim()} onPress={propose} />
        </Section>
      ) : <Body>{ROOM_IS_THE_JOURNEYS}</Body>}

      <Section title="Journey record">
        {snapshot.members.length ? (() => {
          const { inView, folded } = splitMembers(snapshot.members, { viewerId });
          const memberCard = (member: typeof snapshot.members[number]) => {
            const row = memberRow(member, { creatorId: creator.userId, createdAt: creator.createdAt, viewerId });
            return (
              <Row key={member.id} title={row.description} meta={[row.timing]} tag={row.role}>
                {mayManageMember(member, { journeyRole: role, viewerId }) ? (
                  <>
                    <Button kind="quiet" label="Make owner" pending={pending === `transfer-${member.id}`} onPress={() => transfer(member.id, member.displayName)} />
                    <Button kind="destructive" label="Remove" pending={pending === `remove-${member.id}`} onPress={() => remove(member.id, member.displayName)} />
                  </>
                ) : null}
              </Row>
            );
          };
          return (
            <>
              {inView.map(memberCard)}
              {folded.length ? <MemberFold count={folded.length}>{folded.map(memberCard)}</MemberFold> : null}
            </>
          );
        })() : <Body>The people in this journey appear here once the account service answers.</Body>}
      </Section>

      {proposals.length ? (
        <Section title="People being decided on">
          {proposals.map((proposal) => (
            <Proposal
              key={proposal.id}
              proposal={proposal}
              now={now}
              pending={pending}
              mayWithdraw={mayWithdraw(proposal, { viewerId, journeyRole: role })}
              onAgree={() => decide(proposal, true)}
              onDecline={() => decide(proposal, false)}
              onWithdraw={() => withdraw(proposal)}
            />
          ))}
        </Section>
      ) : null}

      {invitations.length ? (
        <Section title="Invitation history">
          {invitations.map((invitation) => (
            // Two different waits: the journeyers have a month to answer, the person invited has
            // only as long as a single-use link safely lasts.
            <Row
              key={invitation.id}
              title={`Invitation sent to ${invitation.email}`}
              meta={[`Sent by ${invitation.invitedByDisplayName} · ${dateTimeLabel(invitation.sentAt)}`, ...(invitation.status === 'pending' ? [`Time left to join: ${remainingLabel(invitation.expiresAt, now)}`] : [])]}
              tag={invitationStatusLabel(invitation.status)}
            />
          ))}
        </Section>
      ) : null}

      {showsUnpaidCapacityRest(snapshot) ? (
        <Section title="If the payment lapses">
          <Body>Nobody is removed and no history is lost. If this journey stays unpaid, you and one person you choose can still add to it, and everyone else can still read everything.</Body>
          {queue.length ? (
            <>
              <Body>{"Who rests first, if it isn't paid. The last person here keeps adding with you."}</Body>
              {queue.map((member, index) => (
                <Row key={member.id} title={member.displayName} meta={[...(resting.has(member.id) ? ['Resting now'] : []), ...(index === queue.length - 1 ? ['Keeps adding with you'] : [])]}>
                  <Button kind="quiet" label="Rest earlier" disabled={index === 0 || pending !== null} onPress={() => { const next = moveInOrder(order, member.id, -1); if (next) saveRest(next); }} />
                  <Button kind="quiet" label="Rest later" disabled={index === queue.length - 1 || pending !== null} onPress={() => { const next = moveInOrder(order, member.id, 1); if (next) saveRest(next); }} />
                </Row>
              ))}
            </>
          ) : <Body>When another journeyer joins, you can choose who keeps adding with you.</Body>}
        </Section>
      ) : null}

      {billing ? <Billing status={billing} /> : null}

      <Button kind="quiet" label="History and conversations" onPress={() => router.push('/history')} />
    </Screen>
  );
}

function Proposal({ proposal, now, pending, mayWithdraw: canWithdraw, onAgree, onDecline, onWithdraw }: {
  proposal: InviteProposal;
  now: number;
  pending: string | null;
  mayWithdraw: boolean;
  onAgree: () => void;
  onDecline: () => void;
  onWithdraw: () => void;
}) {
  const [showDecisions, setShowDecisions] = useState(false);
  const meta = [
    `Proposed by ${proposal.proposedByDisplayName} · ${dateTimeLabel(proposal.proposedAt)}`,
    ...(proposal.note ? [proposal.note] : []),
    proposalProgress(proposal),
    ...(proposal.status === 'open' ? [`Time left to answer: ${remainingLabel(proposal.expiresAt, now)}`] : []),
  ];
  return (
    <Row title={proposal.email} meta={meta} tag={proposalStatusLabel(proposal.status)}>
      {/* Agreeing and declining carry the same weight on purpose: the product has no opinion
          about how somebody answers a question about another person's access. */}
      {proposal.viewerMayDecide ? <Button kind="quiet" label="Agree to add them" pending={pending === `decide-${proposal.id}`} onPress={onAgree} /> : null}
      {proposal.viewerMayDecide ? <Button kind="quiet" label="Decline" disabled={pending === `decide-${proposal.id}`} onPress={onDecline} /> : null}
      {canWithdraw ? <Button kind="quiet" label="Withdraw" pending={pending === `withdraw-${proposal.id}`} onPress={onWithdraw} /> : null}
      <Button kind="quiet" label={showDecisions ? 'Hide who was asked' : 'Who was asked, and when'} onPress={() => setShowDecisions((open) => !open)} />
      {showDecisions ? proposal.decisions.map((entry) => (
        <Row key={entry.userId} title={entry.displayName} meta={[entry.email, `Asked ${dateTimeLabel(entry.requestedAt)} · ${decisionAnswered(entry)}`]} tag={proposalDecisionLabel(entry.decision)} />
      )) : null}
    </Row>
  );
}

/** Read only on the phone: where capacity stands, with no price, no purchase and no payment link. */
function Billing({ status }: { status: BillingStatus }) {
  const { theme } = useTheme();
  const summary = billingSummary(status);
  const glyph = billingGlyph(summary.tone);
  return (
    <Section title="This journey's capacity">
      {status.environment === 'test' ? <Body>Test mode — no real charge can be made.</Body> : null}
      <Text accessibilityLiveRegion="polite" style={[styles.body, { color: theme.colors.fg }]}>
        {glyph ? <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: summary.tone === 'settled' ? theme.colors.positive : theme.colors.caution }}>{glyph} </Text> : null}
        {summary.message}
      </Text>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.colors.fg }]}>{title}</Text>
      {children}
    </View>
  );
}

/** Nobody is hidden: the rest of a large journey is one press away, and says how many it holds. */
function MemberFold({ count, children }: { count: number; children: ReactNode }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const label = `Show the other ${count} ${count === 1 ? 'person' : 'people'}`;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={[targetSize, styles.foldHead]}>
        <Text style={[styles.foldLabel, { color: theme.colors.muted }]}>{label}</Text>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.foldToggle, { color: theme.colors.accent }]}>{open ? '−' : '＋'}</Text>
      </Pressable>
      {open ? <View style={styles.foldBody}>{children}</View> : null}
    </View>
  );
}

function Row({ title, meta = [], tag, children }: { title: string; meta?: string[]; tag?: string; children?: ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.m }]}>
      <View style={styles.rowHead}>
        <Text style={[styles.rowTitle, { color: theme.colors.fg }]}>{title}</Text>
        {tag ? <Text style={[styles.tag, { color: theme.colors.muted }]}>{tag}</Text> : null}
      </View>
      {meta.map((line, index) => <Text key={index} style={[styles.meta, { color: theme.colors.textSecondary }]}>{line}</Text>)}
      {children ? <View style={styles.rowActions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  row: { borderWidth: 1, padding: 14, gap: 4 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  rowTitle: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  tag: { fontSize: 13, fontWeight: '700' },
  meta: { fontSize: 14, lineHeight: 20 },
  rowActions: { gap: 8, marginTop: 8 },
  foldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  foldLabel: { fontSize: 14, fontWeight: '700' },
  foldToggle: { fontSize: 16, fontWeight: '700' },
  foldBody: { gap: 10 },
  body: { fontSize: 16, lineHeight: 23 },
});
