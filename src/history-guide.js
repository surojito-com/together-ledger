// "How to read your history" (#349): what a journey's History means, in words a person who has
// never seen an audit log can follow. History stays a detailed log (owner, Oct 8, 2026); this is
// how to read it. The web (renderHistoryGuide in src/app.js) and the phone
// (apps/mobile/app/history-guide.tsx) both draw these words, so the two never say different things.
//
// Every kind of entry the server writes, and every value it writes into one, is explained here.
// tests/history-guide.test.js reads the kinds from server/*.js and writes each one for real, and
// fails when a kind or a value has no explanation, or when an explanation is left for one the
// server no longer writes.
//
// The phone reaches this file, so it names no price and no way to pay on the web (#268).

export const HISTORY_GUIDE_TITLE = 'How to read your history';

export const HISTORY_GUIDE_INTRO = Object.freeze([
  'History is this journey’s record. Each time something changes in the journey, the server writes one entry, and nobody can edit or remove an entry afterwards.',
  'It is a detailed log on purpose. What follows explains each part of it.',
]);

// The parts a person reads, in the order they reach them. Each paragraph is plain text.
export const HISTORY_GUIDE_SECTIONS = Object.freeze([
  {
    id: 'entry',
    heading: 'What an entry shows',
    paragraphs: [
      'The number, such as #12, is the entry’s place in the journey’s history. The first entry is #1, and each new one takes the next number. Numbers are never reused or skipped.',
      'Beside it, in words, is what happened. Below that is the person whose action it was, and when the entry was written, in your own time.',
      'Open an entry to see the values it recorded, each as its name, then what it was before, an arrow, and what it became. Only values that changed are listed. When something is added, everything recorded about it is listed, from “none”. When something is deleted, everything it was is listed, to “none”. Some entries record no values, and say so.',
      'At the bottom: the entry’s own ID, the ID of the entry before it (“Previous”), the words “server-authoritative”, and the start of the entry’s hash.',
    ],
  },
  {
    id: 'chain',
    heading: 'What the hash, the previous entry and the chain prove',
    paragraphs: [
      'Each entry’s hash is worked out from everything in it, including the hash of the entry before it, with a secret key only our server holds. That links every entry to the one before, in a chain back to #1. “Previous” names the entry it is linked to; #1 has none.',
      'So if an entry were changed, removed or put in another order directly in the database, its hash, and every hash after it, would stop matching. The server checks the whole chain each time it reads the journey’s history from the start. The database also refuses to change or remove an entry. The only time entries are removed is when the whole journey goes, because the last person in it deleted their account.',
      'What it can’t prove: the key is ours. The chain shows a change made without the key, such as an edit straight to the database. It is not something you can check for yourself, and on its own it does not rule out a change made by someone who holds the key. The apps do not show the result of the server’s check today.',
    ],
  },
  {
    id: 'attribution',
    heading: 'Server-authoritative and account-attributed',
    paragraphs: [
      'Server-authoritative means our server writes every entry, with the server’s own clock, in the same step that saves the change. Your phone or browser can’t write an entry, change one, or give it another time.',
      'A few entries are written a little apart from what they record. An invitation is recorded as sent only once the email has actually gone. Something that runs out, an invitation or a proposal to add someone, is recorded the first time the server notices, and the entry holds the real time it ran out. The change Together Ledger made to resting was recorded the next time our server started, with the time of the change inside it.',
      'Account-attributed means every entry stands under the account whose action it was, never under a name someone typed. History shows that person’s name as it is now, so if they change it, older entries show the new name, and an entry records the change. Someone no longer in the journey shows as Former journeyer.',
      'A few entries happen without anyone doing anything: something running out, paid room moving between journeys, and a change Together Ledger made for every journey. Each still stands under one person’s name, the person it concerns most, and its words say what happened rather than that they did it.',
    ],
  },
  {
    id: 'tombstones',
    heading: 'Tombstones: what’s kept after something is deleted',
    paragraphs: [
      'When a shared moment, an expense or a conversation to return to is deleted, it leaves the journey, but its entries in History stay, and one more entry records the deletion with what it was. That record of something no longer there is called a tombstone.',
      'A tombstone keeps only what History already recorded. For a moment: its title, kind, date, theme, places and money context. For an expense: its name, category, amount, date and whether it was paid. For a conversation: its title, whether it was open or resolved, and whether it had written context.',
      'It never keeps what History never records: a moment’s written detail or its photos; an expense’s notes, account label, reference or payer name as typed; a conversation’s written context. Moments held privately or kept to share later leave nothing in History at all, before or after deletion.',
      'Deleting an account works the same way. Entries already written stay, under Former journeyer. One entry says a member deleted their account, and each expense they paid for gets an entry as its payer becomes Deleted account.',
    ],
  },
  {
    id: 'two-entries',
    heading: 'Why one action can show as two entries',
    paragraphs: [
      'Some actions are written as more than one entry, so that each kind of change can be found on its own.',
      'Changing the theme of a shared moment writes Updated moment, with everything about the moment before and after, then Changed moment theme, with only the theme.',
      'Agreeing to add someone is one entry for each person who agrees. When the last person agrees, Invitation sent follows, once the email has gone.',
      'Deleting an account writes one entry for each expense that person paid for, then one saying they deleted their account.',
      'Some actions reach more than one journey. Changing your name writes an entry in every journey you’re in. Paid room moving from one journey to another writes an entry in each.',
    ],
  },
  {
    id: 'times',
    heading: 'Times inside entries are in UTC',
    paragraphs: [
      'The time under each entry’s summary is shown in your own time zone, as your device has it.',
      'Times written inside an entry, such as createdAt, updatedAt, expiresAt or graceUntil, are in world time, UTC, and end in Z. For example, 2026-10-08T02:14:04.380Z is 2:14 in the morning UTC on October 8, 2026. That was 10:14 PM on October 7 in New York, and 7:44 AM on October 8 in India.',
      'Dates without a time, such as a moment’s occurredOn or a journey’s startDate, are the day as it was entered, with no time zone.',
    ],
  },
]);

// Every part of an entry the server sends, whether or not the apps show it.
export const HISTORY_ENTRY_PARTS = Object.freeze({
  sequence: 'The entry’s number, such as #12.',
  summary: 'What happened, in words.',
  actorUserId: 'The account the entry stands under. The apps show that person’s name as it is now.',
  createdAt: 'When the entry was written, by the server’s clock. Shown under the summary in your own time.',
  id: 'The entry’s own ID, shown at the bottom as Event ID.',
  previousHash: 'The hash of the entry before it, which this entry’s hash is worked out from. The apps show the entry before it by its ID instead, as Previous.',
  eventHash: 'This entry’s hash. The apps show its first twelve characters.',
  before: 'The values as they were before the change, listed with an arrow when you open the entry.',
  after: 'The values as they were after the change, listed after the arrow.',
  action: 'The kind of entry, by its code name, such as moment_added. Listed below. The apps don’t show it.',
  entityType: 'What kind of thing the entry is about: journey, moment, expense, concern, milestone, membership, invite_proposal or invitation. The apps don’t show it.',
  entityId: 'The ID of the thing the entry is about. The apps don’t show it.',
});

// Every value the server writes into an entry, by the name History shows. Some names are used by
// more than one kind of entry; each explanation covers all of them.
export const HISTORY_FIELDS = Object.freeze({
  id: 'The ID of the thing the entry is about: the journey, moment, expense or conversation. It stays the same as long as that thing exists, so it can be followed from entry to entry.',
  journeyId: 'The ID of this journey.',
  name: 'The journey’s name.',
  location: 'Where the journey is, as written for it. It can be empty.',
  startDate: 'The journey’s first day, as entered. Empty when it isn’t known.',
  startDateStatus: 'exact when the start date is known, unknown when it isn’t.',
  endDate: 'The journey’s last day, as entered. Empty when there isn’t one.',
  endDateStatus: 'date when the journey has an end date, unsure when nobody knows yet, forever when it isn’t meant to end.',
  budgetCents: 'The budget the journey set for itself, shown as an amount. It is not a payment.',
  version: 'How many times this has been saved. It starts at 1 and goes up by one with each save, which is how a device notices that someone else changed the same thing first.',
  role: 'owner or member. On a journey entry, the role of the person who made the change. On Removed journey member, the role of the person removed.',
  createdAt: 'When it was first created, in UTC.',
  updatedAt: 'When it was last saved, in UTC.',
  key: 'Which of the journey’s three steps this is: reviewedPicture, chosePrompt or agreedNextAction.',
  completed: 'true when the step is marked done, false when it is open again.',
  kind: 'The kind of moment, by its code name, such as promise, memory or boundary.',
  kindLabel: 'The name given to a moment of the kind “other”. Empty for every other kind.',
  occurredOn: 'The day it happened, as entered.',
  title: 'Its title, in the words it was given.',
  visibility: 'Who can see a moment. shared-now: everyone in the journey. private and share-later: only the person who made it. A shared moment can’t become private again.',
  theme: 'The moment’s own colour theme: Light, Dark, Green or Flexoki, or Use my theme when it follows each reader’s own.',
  moneyCents: 'The money context added to a moment, in cents, so 1250 is 12.50. Empty when there is none.',
  moneyCurrency: 'The currency of that money context, such as EUR or INR. Empty when none was chosen.',
  locations: 'The places added to the moment. Each has its name (label), and, when it has them, its latitude and longitude and how close they are, in metres (accuracyMeters).',
  createdByUserId: 'The account ID of the person who first added the moment.',
  createdBy: 'The name of the person who added the moment, as the journey knew them when the entry was written. Unlike the name under the summary, it stays as written if they change their name later. Someone who had already left the journey or deleted their account reads as Former journeyer. Older entries read Journey member, because the server used to record it without looking the name up.',
  updatedBy: 'The name of the person who last changed the moment, written the same way. Until someone changes it, it is the person who added it. Older entries read Journey member, for the same reason.',
  shapedByBoth: 'true when the person who last changed the moment is not the person who added it.',
  merchant: 'The expense’s name, such as where the money went.',
  category: 'The expense’s category: Flights, Hotel, Restaurants, Transportation, Activities, Shopping or Other.',
  amountCents: 'The expense’s amount, shown as an amount.',
  paidByUserId: 'The account ID of the person who paid, when one was chosen. Empty once that person has deleted their account.',
  status: 'Where something stands. An expense: paid or due. A conversation: open or resolved. A proposal to add someone: open, then withdrawn or lapsed. An invitation: pending, then withdrawn or expired.',
  detail: 'For a conversation to return to: [recorded] when it has written context, empty when it hasn’t. The context itself is never copied into History.',
  userId: 'The account ID of the person the entry is about.',
  displayName: 'A person’s name as the journey sees it, before and after they changed it.',
  ownerUserId: 'The account ID of the journey’s owner, before and after ownership moved.',
  graceUntil: 'When the extra time to pay ends, in UTC.',
  requestNumber: 'Which of the year’s six extra weeks this was: 1 for the first.',
  calendarYear: 'The year the request counts towards. The count starts again each January 1.',
  unpaidCapacityMode: 'What happened to people resting while a payment was due. paused: they couldn’t open the journey. read-only: they can read all of it.',
  changedAt: 'When Together Ledger made the change, in UTC.',
  people: 'How many people the paid room holds, counting the two every journey includes.',
  roomUntil: 'When the paid room leaves this journey, at the end of the time already paid for, in UTC.',
  email: 'The invited person’s email, partly hidden: the first letter, two dots, the last letter, then the whole domain, such as s••d@gmail.com. History never keeps it in full.',
  expiresAt: 'When it runs out if nothing more happens, in UTC. A proposal waits 30 days for everyone’s answer; an invitation waits 14 days to be accepted.',
  expiredAt: 'When it actually ran out, in UTC. The entry may have been written later, the first time the server noticed.',
  decision: 'agree or decline.',
  proposalId: 'The ID of the proposal everyone agreed to, which the invitation was sent for.',
  replaces: 'The ID of the invitation that ran out, which this one replaces.',
});

const JOURNEY = ['id', 'name', 'location', 'startDate', 'startDateStatus', 'endDate', 'endDateStatus', 'budgetCents', 'version', 'role', 'createdAt', 'updatedAt'];
const MOMENT = ['id', 'journeyId', 'kind', 'kindLabel', 'occurredOn', 'title', 'visibility', 'theme', 'moneyCents', 'moneyCurrency', 'locations', 'createdByUserId', 'createdBy', 'updatedBy', 'shapedByBoth', 'version', 'createdAt', 'updatedAt'];
const EXPENSE = ['id', 'journeyId', 'merchant', 'category', 'amountCents', 'occurredOn', 'paidByUserId', 'status', 'version', 'createdAt', 'updatedAt'];
const CONCERN = ['id', 'journeyId', 'title', 'detail', 'status', 'version', 'createdAt', 'updatedAt'];
const MOMENT_NEVER = 'The moment’s written detail, or its photos.';
const EXPENSE_NEVER = 'The expense’s notes, its account label, its reference, or the payer’s name as typed.';
const CONCERN_NEVER = 'The conversation’s written context, only whether it has some.';

// Every kind of entry, grouped as a person thinks of them. `reads` is how the entry's summary
// reads in History, with … standing for a name or a number; `records` the values it writes.
export const HISTORY_EVENT_GROUPS = Object.freeze([
  {
    heading: 'The journey',
    kinds: [
      { action: 'journey_created', reads: ['Created journey: …'], when: 'Someone began this journey.', records: JOURNEY, never: 'Anything about paying. The budget is a number the journey sets for itself, not a payment.' },
      { action: 'journey_updated', reads: ['Updated journey: …'], when: 'Someone changed the journey’s name, place, dates or budget.', records: JOURNEY, never: 'Anything about paying.' },
      { action: 'milestone_updated', reads: ['Completed milestone: …', 'Reopened milestone: …'], when: 'Someone marked one of the journey’s three steps done, or open again.', records: ['key', 'completed'], never: 'Anything said or written about the step.' },
    ],
  },
  {
    heading: 'Moments',
    kinds: [
      { action: 'moment_added', reads: ['Held …: …'], when: 'Someone added a moment shared with everyone. A moment held privately, or kept to share later, writes nothing here.', records: MOMENT, never: MOMENT_NEVER },
      { action: 'moment_shared', reads: ['Shared a held moment'], when: 'Someone shared a moment they had been holding.', records: ['visibility'], never: 'Anything else about the moment, not even its title. A later change to it records those.' },
      { action: 'moment_updated', reads: ['Updated moment: …'], when: 'Someone changed a shared moment.', records: MOMENT, never: MOMENT_NEVER },
      { action: 'moment_theme_changed', reads: ['Changed moment theme'], when: 'Someone changed a shared moment’s theme. It follows an Updated moment entry for the same change.', records: ['theme'], never: 'Anything else about the moment.' },
      { action: 'moment_deleted', reads: ['Deleted moment: …'], when: 'Someone deleted a shared moment. This is its tombstone.', records: MOMENT, never: MOMENT_NEVER },
    ],
  },
  {
    heading: 'Expenses',
    kinds: [
      { action: 'expense_added', reads: ['Added expense: …'], when: 'Someone added an expense.', records: EXPENSE, never: EXPENSE_NEVER },
      { action: 'expense_updated', reads: ['Updated expense: …'], when: 'Someone changed an expense.', records: EXPENSE, never: EXPENSE_NEVER },
      { action: 'expense_deleted', reads: ['Deleted expense: …'], when: 'Someone deleted an expense. This is its tombstone.', records: EXPENSE, never: EXPENSE_NEVER },
      { action: 'expense_payer_pseudonymized', reads: ['Removed deleted account from expense payer attribution'], when: 'The person who paid for an expense deleted their account, so it now shows Deleted account as the payer.', records: EXPENSE, never: `${EXPENSE_NEVER} Nor the deleted account’s name or email.` },
    ],
  },
  {
    heading: 'Conversations to return to',
    kinds: [
      { action: 'concern_added', reads: ['Logged concern: …'], when: 'Someone started a conversation to return to.', records: CONCERN, never: CONCERN_NEVER },
      { action: 'concern_updated', reads: ['Updated concern: …'], when: 'Someone changed one, or marked it open or resolved.', records: CONCERN, never: CONCERN_NEVER },
      { action: 'concern_deleted', reads: ['Deleted concern: …'], when: 'Someone deleted one. This is its tombstone.', records: CONCERN, never: CONCERN_NEVER },
    ],
  },
  {
    heading: 'People',
    kinds: [
      { action: 'member_joined', reads: ['Accepted journey invitation'], when: 'Someone accepted an invitation and joined. From here on, History names them.', records: ['userId'], never: 'The email they were invited at.' },
      { action: 'member_renamed', reads: ['Changed their name from … to …'], when: 'Someone changed the name the journey sees. It is written in every journey they’re in.', records: ['displayName'], never: 'Their private username, or their email.' },
      { action: 'member_removed', reads: ['Removed journey member: …'], when: 'The owner removed someone. Their private moments leave with them.', records: ['userId', 'role'], never: 'Why, or anything from their private moments.' },
      { action: 'ownership_transferred', reads: ['Transferred journey ownership to …'], when: 'The owner handed the journey to someone else in it.', records: ['ownerUserId'], never: 'Anything about paying.' },
      { action: 'member_deleted_account', reads: ['A journey member deleted their account'], when: 'Someone in the journey deleted their account. Their entries stay, under Former journeyer.', records: ['userId'], never: 'Their name or their email.' },
    ],
  },
  {
    heading: 'Inviting someone',
    kinds: [
      { action: 'invite_proposed', reads: ['Asked to add …'], when: 'Someone asked the journey to add a person. Asking counts as their own agreement.', records: ['email', 'status', 'expiresAt'], never: 'The full email, or the note about who the person is.' },
      { action: 'invite_agreed', reads: ['Agreed to add …'], when: 'Someone in the journey agreed.', records: ['email', 'decision'], never: 'The full email.' },
      { action: 'invite_declined', reads: ['Declined adding …'], when: 'Someone in the journey declined, which settles it for everyone.', records: ['email', 'decision'], never: 'The full email, or why.' },
      { action: 'invite_proposal_withdrawn', reads: ['Withdrew the proposal to add …'], when: 'The person who asked took the question back.', records: ['email', 'status'], never: 'The full email, or why.' },
      { action: 'invite_proposal_lapsed', reads: ['The proposal to add … ran out, and nobody was added'], when: 'Not everyone answered within 30 days. Nobody did this; it stands under the name of the person who asked.', records: ['email', 'status', 'expiredAt'], never: 'The full email, or who hadn’t answered.' },
      { action: 'invitation_sent', reads: ['Invitation sent to …'], when: 'Everyone agreed, and the invitation email went out.', records: ['email', 'proposalId', 'expiresAt'], never: 'The full email, or the link inside it.' },
      { action: 'invitation_withdrawn', reads: ['Withdrew the invitation to …'], when: 'The person who asked, or the owner, withdrew an invitation before it was accepted. Its link stopped working.', records: ['email', 'status'], never: 'The full email, or why.' },
      { action: 'invitation_lapsed', reads: ['The invitation to … ran out'], when: 'Nobody accepted within 14 days. Nobody did this; it stands under the name of the person who asked.', records: ['email', 'status', 'expiredAt'], never: 'The full email.' },
      { action: 'invitation_sent_again', reads: ['Sent the invitation to … again'], when: 'The person who asked sent an invitation that had run out again, without asking everyone again.', records: ['email', 'replaces', 'expiresAt'], never: 'The full email, or the link inside it.' },
    ],
  },
  {
    heading: 'Paying and resting',
    kinds: [
      { action: 'grace_requested', reads: ['Asked for … more days to pay (… of … in …)'], when: 'The person who pays asked for another week to pay.', records: ['graceUntil', 'requestNumber', 'calendarYear'], never: 'How much is owed, or any card or store details.' },
      { action: 'unpaid_capacity_rest_updated', reads: ['Updated the resting order'], when: 'The owner changed who rests first if a payment lapses.', records: [], never: 'The order itself. The owner sees the current order where it is set.' },
      { action: 'unpaid_capacity_rest_made_read_only', reads: ['Together Ledger no longer lets resting journeyers be fully paused, so anyone resting here can read the whole journey again'], when: 'Together Ledger stopped letting a journey fully pause the people resting in it. Nobody here did this; it stands under the owner’s name.', records: ['unpaidCapacityMode', 'changedAt'], never: 'Anything anyone in the journey did.' },
      { action: 'paid_room_moved_out', reads: ['Paid room moved to another journey; this journey has its days of grace', 'Paid room moves to another journey when this period ends; this journey then has its days of grace', 'Lapsed paid room renewed for another journey'], when: 'The person who pays for room here paid for it from another journey instead, so it moved there. This journey keeps any grace it had.', records: ['people', 'graceUntil', 'roomUntil'], never: 'Which journey it went to, since people here may not be in it, or any price.' },
      { action: 'paid_room_moved_in', reads: ['Paid room moved here from another journey'], when: 'Paid room arrived here from another journey.', records: ['people'], never: 'Which journey it came from, or any price.' },
    ],
  },
]);

export const HISTORY_EVENT_KINDS = Object.freeze(Object.fromEntries(HISTORY_EVENT_GROUPS.flatMap((group) => group.kinds.map((kind) => [kind.action, kind]))));

export const HISTORY_KINDS_HEADING = 'Every kind of entry';
export const HISTORY_FIELDS_HEADING = 'What each value means';
export const HISTORY_ENTRY_PARTS_HEADING = 'Every part of an entry';
export const HISTORY_RECORDS_LABEL = 'Records';
export const HISTORY_RECORDS_NOTHING = 'No values, only that it happened.';
export const HISTORY_NEVER_LABEL = 'Never records';
