// The journey an app reviewer signs in to (#260). Together Ledger is a journey shared between
// people, and a reviewer signs in alone: an empty ledger with nobody to share it with reads as an
// app that does nothing. So two sample accounts are made, already in one journey together, with
// moments in all three visibilities and a conversation of each kind, through the same service
// calls the product makes. Nothing is written around the service, so the journey's event chain is
// the one the product would have written.
//
// It is rebuilt from nothing on every run: both sample accounts are deleted the way a person
// deletes theirs, then made again. That is also why the guard below exists. Before deleting
// anything it checks that each account is one of the two sample accounts, by email and by its
// fixed private username, and that every journey it is in holds nobody else. If someone else has
// been pulled in, nothing is changed and the run stops.
//
// No mail is sent. The verification and invitation links the service would mail are kept in
// memory and used straight away, so the reviewer's addresses receive nothing from a run.

import { MemoryMailer } from './mailer.js';
import { PlatformError, PlatformService } from './platform.js';

export const REVIEW_USERNAMES = Object.freeze({ reviewer: 'app-review-sam', partner: 'app-review-alex' });
export const REVIEW_JOURNEY_NAME = 'Sample journey: Sam and Alex';
const NAMES = { reviewer: 'Sam (sample)', partner: 'Alex (sample)' };

// What the journey holds. `daysAgo` keeps the dates recent whenever it is rebuilt. Each person has
// something private and something waiting to be shared, so signing in as either one shows the
// privacy cue on moments only that person can see.
const MOMENTS = [
  { by: 'reviewer', daysAgo: 41, kind: 'memory', title: 'The walk along the canal', detail: 'We took the long way back and talked about nothing in particular. It was the first easy evening in a while.', visibility: 'shared-now', locations: [{ label: 'The canal path' }] },
  { by: 'partner', daysAgo: 34, kind: 'acknowledgment', title: 'Thank you for driving to the station', detail: 'It was late, and you came without being asked twice.', visibility: 'shared-now', theme: 'flexoki' },
  { by: 'reviewer', daysAgo: 27, kind: 'promise', title: 'Call before the late shift', detail: 'On the days I work late, I will call before it starts, not after.', visibility: 'shared-now' },
  { by: 'partner', daysAgo: 20, kind: 'heart-to-heart', title: "Talking about my dad's visit", detail: 'What I need that week is a bit of room in the evenings, and for us to decide the plans together.', visibility: 'shared-now', theme: 'green', locations: [{ label: 'Kitchen table' }] },
  { by: 'reviewer', daysAgo: 13, kind: 'practical-matter', title: 'Splitting the boiler repair', detail: 'Half each, settled at the end of the month.', visibility: 'shared-now', moneyCents: 18000, moneyCurrency: 'USD' },
  { by: 'reviewer', daysAgo: 9, kind: 'feeling', title: 'Tired more than angry', detail: 'Writing this down for myself before I say anything.', visibility: 'private' },
  { by: 'reviewer', daysAgo: 6, kind: 'repair-request', title: 'What I want to say about Sunday', detail: 'Holding this until I can say it kindly.', visibility: 'share-later' },
  { by: 'partner', daysAgo: 5, kind: 'feeling', title: 'Nervous about the visit', detail: 'Only for me, for now.', visibility: 'private' },
  { by: 'partner', daysAgo: 2, kind: 'memory', title: 'A note for our anniversary', detail: 'Saving this for the day itself.', visibility: 'share-later', theme: 'dark' },
];

const CONVERSATIONS = [
  { by: 'reviewer', title: 'How we split the weekends', detail: 'One weekend each for family, and one that is only ours. Still working it out.', status: 'open' },
  { by: 'partner', title: 'Dishes left overnight', detail: 'Agreed: whoever cooks does not wash up.', status: 'resolved' },
];

function day(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function refuse(message) {
  return new PlatformError(409, 'review_journey_refused', message);
}

// Finds a sample account and proves it is one before anything is deleted.
async function existingSample(pool, email, username, sampleEmails) {
  const found = await pool.query('SELECT id,username FROM users WHERE email_normalized=$1 AND deleted_at IS NULL', [email]);
  const byName = await pool.query('SELECT id,email_normalized FROM users WHERE username=$1 AND deleted_at IS NULL', [username]);
  if (!found.rowCount && !byName.rowCount) return null;
  if (!found.rowCount || found.rows[0].username !== username) {
    throw refuse(`An account with the email or username meant for the sample "${username}" exists and is not that sample account. Nothing was changed.`);
  }
  const strangers = await pool.query(
    `SELECT 1 FROM journey_members mine
       JOIN journey_members other ON other.journey_id=mine.journey_id
       JOIN users u ON u.id=other.user_id
     WHERE mine.user_id=$1 AND u.email_normalized NOT IN ($2,$3)
     LIMIT 1`,
    [found.rows[0].id, ...sampleEmails],
  );
  if (strangers.rowCount) throw refuse(`The sample account "${username}" shares a journey with someone else. Nothing was changed; look at that journey before running this again.`);
  return found.rows[0].id;
}

/**
 * Builds the reviewer's journey from nothing, deleting an earlier run's first. Returns what was
 * made, without any secret: ids, names and counts.
 */
export async function seedReviewJourney({ pool, config, reviewerEmail, partnerEmail, password, now = () => new Date() }) {
  const reviewer = String(reviewerEmail || '').trim().toLowerCase();
  const partner = String(partnerEmail || '').trim().toLowerCase();
  if (!reviewer || !partner || reviewer === partner) throw refuse('Give two different email addresses, one for each sample account.');
  if (typeof password !== 'string' || password.length < 12) throw refuse('Give a password of at least 12 characters for the sample accounts.');

  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now });
  const accountOrigin = config.ACCOUNT_ORIGIN || config.PUBLIC_ORIGIN;
  const samples = [reviewer, partner];

  // Both are checked before either is deleted, so a refusal never leaves half a reset behind.
  const earlierPartner = await existingSample(pool, partner, REVIEW_USERNAMES.partner, samples);
  const earlierReviewer = await existingSample(pool, reviewer, REVIEW_USERNAMES.reviewer, samples);
  // The partner goes first: an owner cannot leave a journey someone else is still in, and the
  // journey itself goes with its last member.
  if (earlierPartner) await platform.eraseAccount(earlierPartner);
  if (earlierReviewer) await platform.eraseAccount(earlierReviewer);

  const ids = {};
  for (const [who, email] of [['reviewer', reviewer], ['partner', partner]]) {
    const { user } = await platform.register({ email, username: REVIEW_USERNAMES[who], password }, accountOrigin, { issueSession: false });
    const link = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
    await platform.verifyEmail(link.token);
    await platform.changeDisplayName(user.id, { displayName: NAMES[who] });
    ids[who] = user.id;
  }

  const journey = await platform.createJourney(ids.reviewer, {
    name: REVIEW_JOURNEY_NAME,
    location: '',
    startDateStatus: 'exact',
    startDate: day(now(), 60),
    endDateStatus: 'forever',
    endDate: null,
    budgetCents: 0,
  });
  // The partner joins the way anyone does: proposed, agreed (the only other journeyer is the one
  // proposing), invited, and accepted.
  await platform.proposeInvitation(ids.reviewer, journey.id, partner, 'Alex, the other half of this sample journey.', accountOrigin);
  const invitation = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === partner);
  await platform.acceptInvitation(ids.partner, invitation.token);

  const counts = { 'shared-now': 0, private: 0, 'share-later': 0 };
  for (const { by, daysAgo, ...moment } of MOMENTS) {
    await platform.createMoment(ids[by], journey.id, { theme: '', moneyCents: null, moneyCurrency: '', locations: [], kindLabel: '', ...moment, occurredOn: day(now(), daysAgo) });
    counts[moment.visibility] += 1;
  }
  for (const { by, ...conversation } of CONVERSATIONS) await platform.createConcern(ids[by], journey.id, conversation);

  return {
    journeyId: journey.id,
    journeyName: REVIEW_JOURNEY_NAME,
    reviewer: { id: ids.reviewer, username: REVIEW_USERNAMES.reviewer, displayName: NAMES.reviewer },
    partner: { id: ids.partner, username: REVIEW_USERNAMES.partner, displayName: NAMES.partner },
    moments: counts,
    conversations: CONVERSATIONS.length,
    rebuilt: Boolean(earlierReviewer || earlierPartner),
  };
}
