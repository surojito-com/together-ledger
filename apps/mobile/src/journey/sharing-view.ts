/**
 * What the phone's journey settings show, and in which words, for TL-M-09 (#184). Ported from
 * the web's renderAccountState() sharing section, inviteProposalRow(), proposalDecisionRow(),
 * renderUnpaidCapacityRest(), moveRestOrder(), renderEventManager() and renderBillingState() in
 * src/app.js, and from the confirmations its click handlers ask.
 *
 * remainingLabel and money come from the web's own src/model.js, so a countdown or an amount
 * can never read differently on the phone. Kept free of runtime imports other than those, so
 * tests/mobile-sharing.test.js can run it directly and compare it with the web's functions.
 */
import { money, remainingLabel } from '../../../../src/model.js';
import { momentThemeLabel } from '../../../../src/moment-themes.js';

export { remainingLabel };

export type Member = { id: string; displayName: string; role: string; joinedAt: string };

export type ProposalDecision = {
  userId: string;
  displayName: string;
  email: string;
  decision: 'agree' | 'decline' | 'pending' | string;
  requestedAt: string | null;
  decidedAt: string | null;
};

export type InviteProposal = {
  id: string;
  /** Masked by the server (#350): the whole address never reaches this phone. */
  email: string;
  /** Their name, once they have joined. */
  joinedDisplayName?: string | null;
  note: string;
  proposedByUserId: string;
  proposedByDisplayName: string;
  status: 'open' | 'agreed' | 'declined' | 'withdrawn' | 'lapsed' | string;
  proposedAt: string | null;
  expiresAt: string | null;
  agreedCount: number;
  pendingCount: number;
  askedCount: number;
  viewerMayDecide: boolean;
  decisions: ProposalDecision[];
};

export type Invitation = {
  id: string;
  proposalId?: string | null;
  /** Masked by the server (#350): the whole address never reaches this phone. */
  email: string;
  /** Their name, once they have joined. */
  joinedDisplayName?: string | null;
  invitedByUserId?: string;
  invitedByDisplayName: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked' | 'withdrawn' | string;
  sentAt: string | null;
  expiresAt: string | null;
  sendAgainUntil?: string | null;
  viewerMayWithdraw?: boolean;
  viewerMaySendAgain?: boolean;
};

export type Person = { id: string; displayName: string };

/** A journey waiting on a payment, as the server tells everyone in it (the Book, 4.7). */
export type Grace = {
  endsAt: string;
  daysLeft: number;
  payer: Person;
  calendarYear: number;
  requestsUsed: number;
  requestsPerYear: number;
  requestDays: number;
  canRequest: boolean;
  keepAdding: Person[];
};

export type Capacity = {
  peopleHere: number;
  canInvite: boolean;
  /** Full only because places are held for people invited (#350). */
  heldForInvitations?: boolean;
  mode: string;
  restingMemberIds?: string[];
  /** Only the owner is told this: who rests first, ending with the one who keeps adding (#281). */
  restOrder?: string[];
  grace?: Grace | null;
};

export type JourneyEvent = {
  id: string;
  sequence: number;
  actorUserId: string | null;
  action: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  eventHash?: string;
  createdAt: string;
};

export type ConcernRecord = { id: string; title: string; detail?: string | null; status: string; version: number; updatedAt: string };

export type SharingSnapshot = {
  journey: { id: string; name: string; role?: string; createdAt?: string };
  members: Member[];
  invitations?: Invitation[];
  inviteProposals?: InviteProposal[];
  capacity?: Capacity;
  concerns: ConcernRecord[];
  events: JourneyEvent[];
};

export function dateTimeLabel(value: string | null | undefined) {
  const date = new Date(value || '');
  if (!value || Number.isNaN(date.getTime())) return 'Time not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function proposalStatusLabel(status: string) {
  return ({ open: 'Waiting on everyone', agreed: 'Agreed', declined: 'Declined', withdrawn: 'Withdrawn', lapsed: 'Lapsed' } as Record<string, string>)[status] || 'Recorded';
}

export function proposalDecisionLabel(decision: string) {
  return ({ agree: 'Agreed', decline: 'Declined', pending: 'Waiting' } as Record<string, string>)[decision] || 'Recorded';
}

export function invitationStatusLabel(status: string) {
  return ({ accepted: 'Accepted', expired: 'Expired', pending: 'Pending', revoked: 'Revoked', withdrawn: 'Withdrawn' } as Record<string, string>)[status] || 'Recorded';
}

/** Who created the journey: the creation event's actor, else whoever owns it now (the web's rule). */
export function journeyCreator(snapshot: SharingSnapshot) {
  const creation = snapshot.events.find((event) => event.action === 'journey_created');
  const owner = snapshot.members.find((member) => member.role === 'owner');
  return { userId: creation?.actorUserId || owner?.id || '', createdAt: creation?.createdAt || snapshot.journey.createdAt || '' };
}

export type Reserved = { held: boolean; invitations: Invitation[] };

/**
 * "N people are here…", the web's sharingCopy for a signed-in, hosted journey. Where the journey is
 * full only because places are held for people invited, it says so, rather than that there is no
 * open place (#350).
 */
export function sharingCopy(memberCount: number, canInvite: boolean, reserved?: Reserved) {
  const here = `${memberCount} ${memberCount === 1 ? 'person is' : 'people are'} here.`;
  let room = canInvite ? 'There is room to add another person, and everybody here has to agree to them.' : 'There is no open place right now.';
  if (!canInvite && reserved?.held && reserved.invitations.length === 1) room = `1 place is reserved for ${invitedPerson(reserved.invitations[0])}, waiting for them to accept the invitation.`;
  else if (!canInvite && reserved?.held && reserved.invitations.length > 1) room = `${reserved.invitations.length} places are reserved, waiting for the people invited to accept.`;
  return `${here} ${room} Each person signs in separately.`;
}

/** The web's reservedFor. */
export function reservedFor(snapshot: SharingSnapshot): Reserved {
  return { held: Boolean(snapshot.capacity?.heldForInvitations), invitations: reservedInvitations(snapshot.invitations || []) };
}

/** The server sends only the masked email (#350); once the person has joined, their name. */
export function invitedPerson(record: { email: string; joinedDisplayName?: string | null }) {
  return record.joinedDisplayName || record.email;
}

/** Once everyone has agreed and it is out, the place is held for them: reserved, not being decided on. */
export function reservedInvitations(invitations: Invitation[]) {
  return invitations.filter((invitation) => invitation.status === 'pending');
}

/** "Being decided on" is only for people the journey hasn't finished agreeing on (#350). */
export function splitProposals(proposals: InviteProposal[]) {
  return { deciding: proposals.filter((proposal) => proposal.status === 'open'), settled: proposals.filter((proposal) => proposal.status !== 'open') };
}

export function reservedPlaceTitle(invitation: Invitation) {
  return `1 place reserved — waiting for ${invitedPerson(invitation)} to accept the invitation`;
}

export function sendAgainNote(invitation: Invitation) {
  return `Everyone has already agreed, so it can be sent again until ${dateTimeLabel(invitation.sendAgainUntil)} without asking them again.`;
}

/**
 * Two different waits: the journeyers have a month to answer, the person invited two weeks to
 * accept (#347). The value already says "left", so the prefix doesn't (#282). The web's words.
 */
export const COUNTDOWN = Object.freeze({ join: 'Time to join', answer: 'Time to answer' });

export function countdown(prefix: string, expiresAt: string | null, now: number) {
  return `${prefix}: ${remainingLabel(expiresAt, now)}`;
}

/**
 * Where the phone meets a full journey, it says where room comes from, and never points to a web
 * payment (#268; Apple 3.1.1 and 3.1.3). Room bought anywhere works everywhere (#267), so that is
 * what it says; a store purchase, when it arrives (TL-P-05 onward), is offered beside it.
 */
export const ROOM_IS_THE_JOURNEYS = 'Room for another person belongs to the journey, so it is the same on every device anyone here uses.';

/** Any journeyer may ask while there is room; the asking is not the adding. */
export function mayPropose(snapshot: SharingSnapshot) {
  return snapshot.capacity?.canInvite ?? snapshot.members.length < 2;
}

/** One row of the journey record: who, what they did, when, and in which role. */
export function memberRow(member: Member, { creatorId, createdAt, viewerId }: { creatorId: string; createdAt: string; viewerId: string | null }) {
  const createdJourney = member.id === creatorId;
  const role = member.role === 'owner' ? 'Owner' : createdJourney ? 'Creator' : 'Journeyer';
  return {
    description: createdJourney ? `Created by ${member.displayName}` : `${member.displayName} joined the journey`,
    timing: `${createdJourney ? 'Created' : 'Joined'} ${dateTimeLabel(createdJourney ? createdAt : member.joinedAt)}`,
    role: `${role}${member.id === viewerId ? ' · You' : ''}`,
  };
}

/**
 * A proposal is a question put to this person about another person, and it lived only inside
 * journey sharing — two screens in on the phone — so somebody could be asked and never know. The
 * count rides the controls that already lead there, so it is seen without interrupting and has
 * nothing to dismiss. Same rule and same words as the web's awaitingYourAnswer in src/app.js.
 */
// Typed by what it needs rather than by the whole sharing snapshot, so the ledger's narrower
// Snapshot can be passed without the unchecked cast the sharing screen has to make.
export function awaitingYourAnswer(snapshot: { inviteProposals?: { viewerMayDecide?: boolean }[] } | null | undefined) {
  return (snapshot?.inviteProposals || []).filter((proposal) => proposal.viewerMayDecide).length;
}

export function waitingSuffix(count: number) {
  return count ? ` · ${count} to answer` : '';
}

/**
 * A journey can hold 101 people, and each is a named row by decision (#155 parks the alternative).
 * Unbounded, the ceiling buries the proposals and invitations below it — on a phone far sooner
 * than on a desktop. Above the fold size the rows that answer "who holds this journey" and "where
 * do I stand" stay in view and the rest opens on request. Same size and same rule as the web's
 * memberListMarkup in src/app.js, so the two surfaces cannot drift apart.
 */
export const MEMBERS_SHOWN_BEFORE_FOLDING = 8;

export function splitMembers(members: Member[], { viewerId }: { viewerId: string | null }) {
  const whole = { inView: members, folded: [] as Member[] };
  if (members.length <= MEMBERS_SHOWN_BEFORE_FOLDING) return whole;
  const inView = members.filter((member) => member.role === 'owner' || member.id === viewerId);
  const folded = members.filter((member) => !inView.includes(member));
  return folded.length ? { inView, folded } : whole;
}

/** Only the owner hands the journey on or removes someone, and never themselves. */
export function mayManageMember(member: Member, { journeyRole, viewerId }: { journeyRole?: string; viewerId: string | null }) {
  return journeyRole === 'owner' && member.id !== viewerId;
}

export function proposalProgress(proposal: InviteProposal) {
  return proposal.status === 'open'
    ? `${proposal.agreedCount} of ${proposal.askedCount} have agreed · ${proposal.pendingCount} still to answer`
    : `${proposal.agreedCount} of ${proposal.askedCount} agreed`;
}

/** Whoever asked can stop asking, and so can the owner. */
export function mayWithdraw(proposal: InviteProposal, { viewerId, journeyRole }: { viewerId: string | null; journeyRole?: string }) {
  return proposal.status === 'open' && (proposal.proposedByUserId === viewerId || journeyRole === 'owner');
}

export function decisionAnswered(entry: ProposalDecision) {
  return entry.decision === 'pending'
    ? 'has not answered yet'
    : `${entry.decision === 'agree' ? 'agreed' : 'declined'} ${dateTimeLabel(entry.decidedAt)}`;
}

/**
 * The questions each act asks before it happens, in the web's words. Agreeing and declining
 * carry the same weight on purpose; only declining, which settles it for everyone and cannot be
 * taken back, and removing someone, wear the destructive colour.
 */
export const CONSEQUENCES = Object.freeze({
  withdrawInvitation: (email: string) => ({
    title: `Withdraw the invitation to ${email}?`,
    consequence: 'Their link stops working, and the place it held is free again straight away. The journey’s history keeps a record that it was withdrawn.',
    confirmLabel: 'Withdraw the invitation',
  }),
  withdraw: (email: string) => ({
    title: `Withdraw the proposal to add ${email}?`,
    consequence: 'The question is taken back, and nothing is sent to them. Nobody is recorded as having refused, and this person can be proposed again later.',
    confirmLabel: 'Withdraw the proposal',
  }),
  agree: (email: string) => ({
    title: `Agree to add ${email}?`,
    consequence: 'Once every journeyer has agreed and they join, they can read every moment this journey has shared, including moments shared long before they arrived. Moments you kept private stay private.',
    confirmLabel: 'Agree to add them',
  }),
  decline: (email: string) => ({
    title: `Decline adding ${email}?`,
    consequence: 'This settles it for everybody straight away, and nothing is ever sent to them. Your name and the time are kept with the decision, where the other journeyers can see them.',
    confirmLabel: 'Decline',
    destructive: true,
  }),
  transfer: (name: string) => ({
    title: `Make ${name} the journey owner?`,
    consequence: 'You will remain here as a journeyer. Ownership moves to them.',
    confirmLabel: 'Transfer ownership',
  }),
  remove: (name: string) => ({
    title: `Remove ${name} from this journey?`,
    consequence: 'Their private moments will be removed. Already shared history remains.',
    confirmLabel: 'Remove journeyer',
    destructive: true,
  }),
  deleteConcern: (title: string) => ({
    title: 'Delete this conversation to return to?',
    consequence: `“${title}” will be removed. The event history keeps a deletion tombstone, so the change stays attributable.`,
    confirmLabel: 'Delete conversation',
    destructive: true,
  }),
});

/** What the phone says once a decision is in, the web's toasts. */
export function decisionToast(agreeing: boolean, invitationSent: boolean | undefined) {
  if (invitationSent) return 'Everyone agreed. The invitation is on its way to them.';
  return agreeing ? 'Your agreement is recorded. Nothing is sent until everyone has answered.' : 'Recorded. Nobody was added, and nothing was sent to them.';
}

export const INVITATION_WITHDRAWN = 'Withdrawn. The link no longer works, and the place is free again.';
export const INVITATION_SENT_AGAIN = 'Sent again. Everyone had already agreed, so nobody was asked again.';

export function proposeToast(invitationSent: boolean | undefined) {
  // A journey of one has nobody to ask, so the invitation goes out there and then.
  return invitationSent ? 'Invitation sent. The journeyer must use their own verified account.' : 'Proposed. Nothing is sent to them until every journeyer agrees.';
}

/**
 * Resting capacity is the owner's alone, and only when this journey's capacity is billed. It is
 * a consequence, not a setting: it chooses what happens to another person's access.
 */
export function showsUnpaidCapacityRest(snapshot: SharingSnapshot) {
  return snapshot.journey.role === 'owner' && snapshot.capacity?.mode === 'billing';
}

/** The web's restQueue: the order the server saved, never the order people joined in (#281). */
export function restQueue(members: Member[], restOrder: string[] | undefined) {
  const byId = new Map(members.map((member) => [member.id, member]));
  return (restOrder || []).map((id) => byId.get(id)).filter((member): member is Member => Boolean(member));
}

/**
 * The web's graceBannerCopy: everyone in a journey waiting on a payment is told who pays, the
 * time left, the weeks asked for this year and who can still add if it isn't paid. The person
 * reading is "you".
 */
export function graceBannerCopy(grace: Grace, viewerId: string | undefined, peopleHere: number) {
  const name = (person: Person) => (person.id === viewerId ? 'you' : person.displayName);
  const names = (people: Person[]) => {
    const listed = people.map(name);
    return listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}` : listed[0] || '';
  };
  const payer = name(grace.payer);
  // A seventh week given under the old limit of 7 still reads as all of them, never 7 of 6.
  const weeks = `${Math.min(grace.requestsUsed, grace.requestsPerYear)} of ${grace.requestsPerYear} extra weeks asked for this year`;
  const someoneRests = grace.keepAdding.length < peopleHere;
  const whoAdds = `only ${names(grace.keepAdding)} can add new moments. Everyone else can still see everything, and nothing is lost.`;
  const days = `${grace.daysLeft} ${grace.daysLeft === 1 ? 'day' : 'days'} left`;
  return [
    `This journey is waiting on a payment from ${payer}.`,
    `${days} · ${weeks}.`,
    someoneRests ? `If it isn't paid, ${whoAdds} Paying again brings everyone back.` : 'If it isn\'t paid, everyone here can still add, and nothing is lost.',
  ].join(' ');
}

/** The web's graceRequestNote: what the payer reads when another week can't be asked for yet, or at all this year. */
export function graceRequestNote(grace: Grace, viewerId: string | undefined) {
  if (grace.payer.id !== viewerId || grace.canRequest) return '';
  if (grace.requestsUsed >= grace.requestsPerYear) return `All ${grace.requestsPerYear} extra weeks for ${grace.calendarYear} have been asked for. The count starts again on January 1.`;
  return `Another week can be asked for once ${grace.requestDays} days or fewer are left.`;
}

/** Only the payer asks, and only when the server says another week can be asked for. */
export function mayRequestGrace(grace: Grace | null | undefined, viewerId: string | undefined) {
  return Boolean(grace && grace.payer.id === viewerId && grace.canRequest);
}

export const GRACE_REQUESTED = 'Asked for 7 more days. Everyone in this journey can see it.';

/** The web's moveRestOrder: swap with the neighbour, or nothing at either end. */
export function moveInOrder(order: string[], memberUserId: string, direction: -1 | 1): string[] | null {
  const from = order.indexOf(memberUserId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function meaningfulChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys]
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .map((key) => ({ key, before: before?.[key], after: after?.[key] }));
}

export function valueLabel(key: string, value: unknown) {
  if (value == null || value === '') return 'none';
  if (key === 'budgetCents' || key === 'amountCents') return money(value as number);
  if (key === 'theme') return momentThemeLabel(value as string);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The append-only history, newest first, each with who did it. Someone gone reads as "Former journeyer". */
export function historyEvents(snapshot: SharingSnapshot) {
  const names = Object.fromEntries(snapshot.members.map((member) => [member.id, member.displayName]));
  const ordered = [...snapshot.events].sort((a, b) => a.sequence - b.sequence);
  return ordered
    .map((event, index) => ({
      ...event,
      actorName: (event.actorUserId && names[event.actorUserId]) || 'Former journeyer',
      previousEventId: ordered[index - 1]?.id || '',
      changes: meaningfulChanges(event.before, event.after),
    }))
    .reverse();
}

/** Conversations to return to, most recently changed first. */
export function concernsByRecency(concerns: ConcernRecord[]) {
  return [...concerns].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export const CONCERN_STATUSES: [string, string][] = [['open', 'Open'], ['resolved', 'Resolved']];

export type BillingStatus = {
  enabled: boolean;
  environment?: string;
  journey: { name: string };
  entitlement?: { state: string; quantity?: number; expiresAt?: string | null } | null;
  subscription?: { cancelAtPeriodEnd?: boolean; currentPeriodEnd?: string | null; paidCapacity?: number } | null;
};

/**
 * The billing panel's summary on the phone (#184): it says where this journey's capacity stands.
 * It never names a web price or links to a web payment (#268). The phone sells capacity through
 * the App Store and Google Play (#267), offered beside this once built. Waiting and settled have
 * their own tone, and neither is a failure, so neither takes the destructive role.
 */
export function billingSummary(status: BillingStatus): { tone: '' | 'settled' | 'waiting'; message: string } {
  const entitlement = status.entitlement;
  const periodEnd = status.subscription?.currentPeriodEnd || entitlement?.expiresAt;
  const until = periodEnd ? ` through ${dateTimeLabel(periodEnd)}` : '';
  const paidCapacity = status.subscription?.paidCapacity || entitlement?.quantity || 0;
  if (status.subscription?.cancelAtPeriodEnd) return { tone: 'waiting', message: `Cancellation is set for renewal${until}. Existing people, shared history, and valid invitation reservations remain.` };
  if (!entitlement) return { tone: '', message: `The first two people in ${status.journey.name} are included.` };
  if (entitlement.state === 'active') return { tone: 'settled', message: `${paidCapacity} additional ${paidCapacity === 1 ? 'person is' : 'people are'} covered for this journey${until}.` };
  if (entitlement.state === 'grace') return { tone: 'waiting', message: `This journey's paid capacity needs payment attention${until}. No person or shared history is removed automatically.` };
  if (entitlement.state === 'pending') return { tone: 'waiting', message: 'This journey is waiting for payment confirmation.' };
  return { tone: '', message: 'This journey does not currently have paid additional-person capacity.' };
}

/** The glyph that carries the tone without colour, as on the web. */
export function billingGlyph(tone: '' | 'settled' | 'waiting') {
  return tone === 'settled' ? '●' : tone === 'waiting' ? '▲' : '';
}
