import {
  activeEntries,
  activeMoments,
  activeTrip,
  appendJourneyEvent,
  CATEGORIES,
  CATEGORY_ICONS,
  conversationPrompts,
  countOf,
  CURRENT_SCHEMA_VERSION,
  dateLabel,
  dateRange,
  groupDayByCategory,
  isValidState,
  localDay,
  money,
  MOMENT_NAME_MISSING,
  MOMENT_TYPES,
  normalizeConcern,
  normalizeEntry,
  normalizeMoment,
  normalizeTrip,
  RECENT_MOMENTS_SHOWN,
  remainingLabel,
  seeAllShown,
  summarize,
} from './model.js';
import { exportState, importState, loadState, resetState, saveState } from './store.js';
import { ApiError, TogetherApi } from './api.js';
import { MOMENT_THEMES, momentThemeLabel, normalizeMomentTheme } from './moment-themes.js';
import { PHOTO_METADATA_REMOVED, stripPhotoMetadata } from './photo-metadata.js';
import {
  HISTORY_ENTRY_PARTS, HISTORY_ENTRY_PARTS_HEADING, HISTORY_EVENT_GROUPS, HISTORY_FIELDS, HISTORY_FIELDS_HEADING, HISTORY_GUIDE_INTRO,
  HISTORY_GUIDE_SECTIONS, HISTORY_GUIDE_TITLE, HISTORY_KINDS_HEADING, HISTORY_NEVER_LABEL, HISTORY_RECORDS_LABEL, HISTORY_RECORDS_NOTHING,
} from './history-guide.js';

// Visibility is carried by shape as well as colour and word: an empty ring holds nothing
// out, a half ring is meant for later, a full ring is out. The order reads even in
// monochrome, in forced colours, and for anyone who cannot separate the three hues.
const VISIBILITY_CUES = Object.freeze({
  private: { glyph: '○', label: 'Private' },
  'share-later': { glyph: '◐', label: 'Share later' },
  'shared-now': { glyph: '●', label: 'Shared now' },
});

function visibilityCue(visibility) {
  return VISIBILITY_CUES[visibility] || { glyph: '○', label: String(visibility || '').replaceAll('-', ' ') };
}

// A consequence is read before it is agreed to. The confirming button names the act rather
// than saying OK, and focus opens on the way out, so the irreversible choice is never the one
// a stray Return key reaches first.
function confirmConsequence({ title, consequence, confirmLabel, keepLabel = 'Keep things as they are', destructive = false }) {
  const dialog = document.querySelector('#consequence-dialog');
  if (!dialog?.showModal) return Promise.resolve(false);
  dialog.querySelector('#consequence-dialog-title').textContent = title;
  dialog.querySelector('#consequence-dialog-consequence').textContent = consequence;
  const cancel = dialog.querySelector('#consequence-dialog-cancel');
  const accept = dialog.querySelector('#consequence-dialog-accept');
  cancel.textContent = keepLabel;
  accept.textContent = confirmLabel;
  accept.className = destructive ? 'button danger' : 'button primary';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

// A confirmation may pass; a problem must not. Anything a person needs to read twice, act on,
// or copy down stays on the page until they dismiss it, rather than fading after 2.6 seconds.
// Tone is carried by a shape as well as a colour, so the two kinds are told apart without it.
const STATUS_TONES = Object.freeze({
  caution: { glyph: '▲', className: 'caution' },
  problem: { glyph: '■', className: 'problem' },
});
let statusBannerSource = '';
const statusHomeParent = document.querySelector('#status-banner')?.parentNode || null;
const statusHomeNext = document.querySelector('#status-banner')?.nextSibling || null;

// The status region sits above the work so nothing is covered. A modal dialog is the one place
// that stops being true: it draws over the page and dims it, so a problem raised inside a dialog
// was being written behind the dialog reporting it — a wrong password said nothing a person could
// see. There is still one region; it moves to wherever the work currently is.
function modalOnTop() {
  const open = Array.from(document.querySelectorAll('dialog[open]'));
  for (let index = open.length - 1; index >= 0; index -= 1) {
    try {
      if (open[index].matches(':modal')) return open[index];
    } catch {
      return open[index];
    }
  }
  return null;
}

function placeStatus(banner) {
  const modal = modalOnTop();
  const target = modal || statusHomeParent;
  if (!target || banner.parentNode === target) return;
  if (modal) modal.prepend(banner);
  else statusHomeParent.insertBefore(banner, statusHomeNext);
}

function showStatus(message, { tone = 'problem', source = 'action' } = {}) {
  const banner = document.querySelector('#status-banner');
  if (!banner) return;
  placeStatus(banner);
  const shape = STATUS_TONES[tone] || STATUS_TONES.problem;
  banner.querySelector('.status-banner-glyph').textContent = shape.glyph;
  banner.querySelector('#status-banner-message').textContent = message;
  banner.className = `status-banner ${shape.className}`;
  banner.hidden = false;
  statusBannerSource = source;
  // A dialog holds whatever scroll position it already had, so a region placed at its top can
  // still sit above the fold. Being in the right box is not the same as being seen.
  if (banner.parentNode !== statusHomeParent) banner.scrollIntoView({ block: 'nearest' });
}

function clearStatus(source) {
  const banner = document.querySelector('#status-banner');
  // Reconnecting clears the offline notice, but never a problem the person has not read.
  if (!banner || (source && statusBannerSource !== source)) return;
  banner.hidden = true;
  statusBannerSource = '';
}

// An empty surface still says what it is and why it is empty, rather than trailing off.
function emptyState(title, body, { compact = false } = {}) {
  return `<div class="empty${compact ? ' compact' : ''}"><strong>${title}</strong><p>${body}</p></div>`;
}

let state = loadState();
const api = new TogetherApi();
let accountUser = null;
let billingState = null;
let cloudJourneyIds = new Set();
let filter = 'All';
let selectedDay = null;
let selectedCategory = null;
let removeId = null;
let removeSnapshot = null;
let guidanceIndex = 0;
const momentImageUrls = new Map();
let momentFilter = 'all';
let momentsExpanded = false;
let momentLocations = [];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function saveWorkingState() {
  if (accountUser) return;
  try {
    saveState(state);
  } catch (error) {
    // Invalid data is a bug and stays loud. A full or blocked store is said in the status
    // region instead, and the change still shows (#185).
    if (!isValidState(state)) throw error;
    showStatus('This browser could not save that change. It shows for now, but may not be here the next time this page opens.', { tone: 'caution', source: 'storage' });
  }
}

function isCloudJourney(trip = activeTrip(state)) {
  return Boolean(accountUser && trip && cloudJourneyIds.has(trip.id));
}

function accountMessage(error) {
  if (error instanceof ApiError) return error.message;
  return 'The account service could not complete that request.';
}

function snapshotToState(snapshots) {
  const previousActive = state.activeTripId;
  const preferences = state.preferences;
  const trips = [];
  const entries = [];
  const moments = [];
  const concerns = [];
  const events = [];
  for (const snapshot of snapshots) {
    const membersById = Object.fromEntries(snapshot.members.map((member) => [member.id, member.displayName]));
    const creationEvent = snapshot.events.find((event) => event.action === 'journey_created');
    const fallbackCreator = snapshot.members.find((member) => member.role === 'owner');
    const createdByUserId = creationEvent?.actorUserId || fallbackCreator?.id || '';
    const createdByDisplayName = membersById[createdByUserId] || (creationEvent ? 'Former journeyer' : fallbackCreator?.displayName || 'Journey member');
    const milestones = { reviewedPicture: false, chosePrompt: false, agreedNextAction: false };
    snapshot.milestones.forEach((item) => { milestones[item.key] = item.completed; });
    trips.push({ ...snapshot.journey, members: snapshot.members.map((member) => member.displayName), memberRecords: snapshot.members, invitationRecords: snapshot.invitations || [], inviteProposalRecords: snapshot.inviteProposals || [], capacity: snapshot.capacity, createdByUserId, createdByDisplayName, createdAt: creationEvent?.createdAt || snapshot.journey.createdAt, milestones, archivedAt: '' });
    entries.push(...snapshot.expenses.map((expense) => ({ ...expense, tripId: expense.journeyId, paidBy: expense.payerLabel })));
    const imagesByMoment = Object.groupBy((snapshot.images || []).filter((image) => !image.deletedAt), (image) => image.momentId);
    const removedImagesByMoment = Object.groupBy((snapshot.images || []).filter((image) => image.deletedAt), (image) => image.momentId);
    moments.push(...snapshot.moments.map((moment) => ({ ...moment, tripId: moment.journeyId, images: imagesByMoment[moment.id] || [], removedImages: removedImagesByMoment[moment.id] || [] })));
    concerns.push(...snapshot.concerns.map((concern) => ({ ...concern, tripId: concern.journeyId, updatedBy: 'Journey member', updatedAt: new Date(concern.updatedAt).toISOString() })));
    snapshot.events.forEach((event, index) => events.push({
      ...event,
      tripId: snapshot.journey.id,
      occurredAt: event.createdAt,
      actorName: membersById[event.actorUserId] || 'Former journeyer',
      previousEventId: snapshot.events[index - 1]?.id || '',
      source: 'server-authoritative',
    }));
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeTripId: trips.some((trip) => trip.id === previousActive) ? previousActive : trips[0].id,
    preferences,
    trips,
    entries,
    moments,
    concerns,
    events,
  };
}

async function refreshCloudState({ announce = false } = {}) {
  if (!accountUser) return;
  const { journeys } = await api.request('/journeys');
  cloudJourneyIds = new Set(journeys.map((journey) => journey.id));
  if (!journeys.length) {
    renderAccountState();
    render();
    if (announce) showToast('Account ready. Create your first private journey.');
    return;
  }
  const snapshots = await Promise.all(journeys.map((journey) => api.request(`/journeys/${journey.id}/snapshot`)));
  state = snapshotToState(snapshots);
  renderAccountState();
  render();
  if (announce) showToast('Private journeys refreshed.');
}

function renderBillingState() {
  const panel = $('#billing-panel');
  if (!panel) return;
  const visible = Boolean(accountUser && billingState?.enabled);
  panel.hidden = !visible;
  if (!visible) return;

  const testMode = billingState.environment === 'test';
  $('#billing-environment').hidden = !testMode;
  $('#billing-environment').textContent = testMode ? 'Test mode — checkout cannot create a real charge.' : '';
  const entitlement = billingState.entitlement;
  const periodEnd = billingState.subscription?.currentPeriodEnd || entitlement?.expiresAt;
  const until = periodEnd ? ` through ${dateTimeLabel(periodEnd)}` : '';
  const paidCapacity = billingState.subscription?.paidCapacity || entitlement?.quantity || 0;
  // Tone as well as words: settled and waiting look different, and neither is a failure, so
  // neither takes the destructive role. A glyph carries the distinction without the colour.
  const capacity = billingState.subscription?.cancelAtPeriodEnd
    ? { tone: 'waiting', message: `Cancellation is set for renewal${until}. Existing people, shared history, and valid invitation reservations remain.` }
    : !entitlement
    ? { tone: '', message: `The first two people in ${billingState.journey.name} are included. Add another person for $1 USD each month.` }
    : entitlement.state === 'active'
      ? { tone: 'settled', message: `${paidCapacity} additional ${paidCapacity === 1 ? 'person is' : 'people are'} covered for this journey${until}.` }
      : entitlement.state === 'grace'
        ? { tone: 'waiting', message: `This journey's paid capacity needs payment attention${until}. No person or shared history is removed automatically.` }
        : entitlement.state === 'pending'
          ? { tone: 'waiting', message: 'This journey is waiting for payment confirmation.' }
          : { tone: '', message: 'This journey does not currently have paid additional-person capacity.' };
  const status = $('#billing-status');
  status.className = `billing-status ${capacity.tone}`.trim();
  status.replaceChildren();
  if (capacity.tone) {
    const glyph = document.createElement('span');
    glyph.className = 'billing-status-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = capacity.tone === 'settled' ? '\u25CF' : '\u25B2';
    status.append(glyph);
  }
  status.append(document.createTextNode(capacity.message));

  const offers = $('#billing-offers');
  const hasCurrentSubscription = billingState.subscription
    && !['canceled', 'incomplete_expired'].includes(billingState.subscription.status);
  const availableOffers = !hasCurrentSubscription ? billingState.offers : [];
  offers.replaceChildren(...availableOffers.map((offer) => {
    const button = document.createElement('button');
    button.className = 'button primary';
    button.type = 'button';
    button.dataset.billingOffer = offer.id;
    button.textContent = `Add another person · $${(offer.unitAmount / 100).toFixed(2)} ${offer.currency} / month`;
    return button;
  }));

  const picker = $('#billing-capacity-picker');
  const showPicker = Boolean(availableOffers.length);
  if (showPicker && picker.hidden) {
    $('#billing-capacity-range').value = '1';
    $('#billing-capacity-number').value = '1';
  }
  picker.hidden = !showPicker;
  if (showPicker) updateCapacityTotal(availableOffers[0]);
  $('#billing-portal-button').hidden = !billingState.portalEnabled;
}

function clampCapacity(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(99, Math.max(1, parsed)) : 1;
}

function capacityQuantity() {
  return clampCapacity($('#billing-capacity-number').value);
}

function updateCapacityTotal(offer) {
  const total = $('#billing-capacity-total');
  if (!offer) { total.textContent = ''; return; }
  total.textContent = `${money(offer.unitAmount * capacityQuantity(), offer.currency)} / month`;
}

function syncCapacityFromRange() {
  const quantity = clampCapacity($('#billing-capacity-range').value);
  $('#billing-capacity-number').value = String(quantity);
  updateCapacityTotal(billingState?.offers?.[0]);
}

function previewCapacityFromNumber() {
  $('#billing-capacity-range').value = String(capacityQuantity());
  updateCapacityTotal(billingState?.offers?.[0]);
}

function normalizeCapacityNumber() {
  $('#billing-capacity-number').value = String(capacityQuantity());
  previewCapacityFromNumber();
}

async function refreshBillingState() {
  const journey = activeTrip(state);
  if (!accountUser || !isCloudJourney(journey) || journey.role !== 'owner') {
    billingState = null;
    renderBillingState();
    return;
  }
  try {
    billingState = await api.request(`/journeys/${journey.id}/billing`);
  } catch (error) {
    if (![403, 404, 503].includes(error.status)) throw error;
    billingState = null;
  }
  renderBillingState();
}

// An account opened with Apple that shared no usable email holds a placeholder the server made
// from its own id (server/platform.js), which is nobody's address. It is said in words (#217).
const APPLE_SHARED_NO_EMAIL = 'Apple didn’t share an email address.';
function accountEmailLabel(email) {
  return /^apple-[^@\s]+@no-email\.invalid$/i.test(email) ? APPLE_SHARED_NO_EMAIL : email;
}

function renderAccountState() {
  const signedIn = Boolean(accountUser);
  const accountsAvailable = api.accountsAvailable;
  $('#account-unavailable').hidden = signedIn || accountsAvailable;
  $('#signed-out-account').hidden = signedIn || !accountsAvailable;
  $('#signed-in-account').hidden = !signedIn;
  $('#account-button').textContent = signedIn ? 'Account settings' : accountsAvailable ? 'Sign in' : 'Accounts soon';
  $$('[data-open-account]').forEach((button) => { button.textContent = signedIn ? 'Account settings' : accountsAvailable ? 'Sign in' : 'Accounts soon'; });
  $('#account-dialog-copy').textContent = accountsAvailable ? 'Passwords are never shared between journeyers.' : 'The private account service is not live on this public page yet.';
  $('#account-name').textContent = signedIn ? accountUser.displayName : '';
  const nameInput = $('#display-name-form [name=displayName]');
  if (document.activeElement !== nameInput) nameInput.value = signedIn ? accountUser.displayName : '';
  $('#account-username').textContent = signedIn ? `@${accountUser.username}` : '';
  $('#account-email').textContent = signedIn ? accountEmailLabel(accountUser.email) : '';
  $('#verification-status').textContent = signedIn ? (accountUser.emailVerified ? 'Email verified' : 'Email verification is still required before accepting an invitation.') : '';
  $('#resend-verification-button').hidden = !signedIn || accountUser.emailVerified;
  // An account opened with Google or Apple has no password, so deleting it asks only for DELETE.
  const deleteAsksForPassword = !signedIn || accountUser.hasPassword !== false;
  $('#delete-account-password').hidden = !deleteAsksForPassword;
  $('#delete-account-password input').disabled = !deleteAsksForPassword;
  $('#account-sync-copy').textContent = isCloudJourney() ? 'Private journey sync is active. Moment visibility is enforced by the account service; shared threads and practical context remain visible to people in this journey.' : 'Your account is ready. Create a private journey when you are ready to invite another journeyer.';
  $('#settings-storage-copy').textContent = isCloudJourney() ? 'This signed-in journey is loaded from the private service. Sign out to return to your browser-only journey.' : 'Browser-only journeys stay on this device unless you download a backup.';
  $('#sync-badge').textContent = isCloudJourney() ? 'Private sync' : signedIn ? 'Account ready' : accountsAvailable ? 'Browser only' : 'Accounts soon';
  $('#sync-badge').classList.toggle('cloud', signedIn);
  renderBillingState();
  $('#actor-control').hidden = isCloudJourney();
  const sharing = isCloudJourney();
  const needsPrivateJourney = signedIn && !sharing;
  const canInvite = activeTrip(state)?.capacity?.canInvite ?? activeTrip(state)?.members.length < 2;
  // Any journeyer may ask; the asking is not the adding, so this is no longer the owner's form.
  $('#invite-form').hidden = !sharing || !canInvite;
  $('#sharing-create-journey-button').hidden = !needsPrivateJourney;
  $('#sharing-copy').textContent = sharing
    ? sharingCopy(activeTrip(state).members.length, canInvite, reservedFor(activeTrip(state)))
    : needsPrivateJourney
      ? 'Your account is ready. Create a private journey to invite another journeyer.'
      : 'Sign in and create a private journey to invite another journeyer.';
  $('#journey-record').hidden = !sharing;
  renderGraceBanner(sharing ? activeTrip(state) : null);
  if (sharing) {
    const trip = activeTrip(state);
    const members = trip.memberRecords || [];
    const memberActions = (member) => trip.role === 'owner' && member.id !== accountUser.id
      ? `<div class="journey-member-actions"><button class="button quiet" type="button" data-transfer-owner="${escapeHtml(member.id)}" data-member-name="${escapeHtml(member.displayName)}">Make owner</button><button class="button danger" type="button" data-remove-member="${escapeHtml(member.id)}" data-member-name="${escapeHtml(member.displayName)}">Remove</button></div>`
      : '';
    const memberRow = (member) => {
      const createdJourney = member.id === trip.createdByUserId;
      const timestamp = createdJourney ? trip.createdAt : member.joinedAt;
      const description = createdJourney ? `Created by ${escapeHtml(member.displayName)}` : `${escapeHtml(member.displayName)} joined the journey`;
      const timing = createdJourney ? 'Created' : 'Joined';
      const role = member.role === 'owner' ? 'Owner' : createdJourney ? 'Creator' : 'Journeyer';
      return `<div class="journey-record-row"><div><strong>${description}</strong><small>${timing} <time datetime="${escapeHtml(timestamp)}">${escapeHtml(dateTimeLabel(timestamp))}</time></small>${memberActions(member)}</div><span class="journey-role">${role}${member.id === accountUser.id ? ' · You' : ''}</span></div>`;
    };
    $('#member-list').innerHTML = memberListMarkup(members, memberRow)
      || emptyState('No one is listed yet', 'The people in this journey appear here once the account service answers.', { compact: true });
    const invitations = trip.invitationRecords || [];
    // Once everyone has agreed and the invitation is out, nothing is being decided any more: the
    // place is held for the person until they accept, it runs out, or it is withdrawn (#350).
    const reserved = reservedInvitations(invitations);
    $('#reserved-places').hidden = !reserved.length;
    $('#reserved-place-list').innerHTML = reserved.map(reservedPlaceRow).join('');
    const { deciding, settled } = splitProposals(trip.inviteProposalRecords || []);
    $('#invite-proposals').hidden = !deciding.length;
    $('#invite-proposal-list').innerHTML = deciding.map((proposal) => inviteProposalRow(proposal, trip)).join('');
    $('#settled-proposals').hidden = !settled.length;
    $('#settled-proposal-list').innerHTML = settled.map((proposal) => inviteProposalRow(proposal, trip)).join('');
    renderUnpaidCapacityRest(trip, members);
    $('#invitation-history').hidden = !invitations.length;
    $('#invitation-list').innerHTML = invitations.map(invitationHistoryRow).join('');
  } else {
    $('#member-list').innerHTML = '';
    $('#reserved-places').hidden = true;
    $('#reserved-place-list').innerHTML = '';
    $('#invite-proposals').hidden = true;
    $('#invite-proposal-list').innerHTML = '';
    $('#settled-proposals').hidden = true;
    $('#settled-proposal-list').innerHTML = '';
    $('#invitation-history').hidden = true;
    $('#invitation-list').innerHTML = '';
  }
  $('#theme-copy').textContent = 'Your theme changes only your own view. Each journeyer chooses what feels right on their screen.';
}

function dateTimeLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return 'Time not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

// A journey can hold a hundred and one people. Every one of them is a named row, deliberately —
// the visual-token idea is parked in #155 — but a hundred and one named rows is about twenty
// screens of list, and everything below membership was being pushed under it.
//
// So a small journey reads exactly as it did, and a large one keeps in view the two rows that
// answer the questions actually being asked of this list: who holds this journey, and where do I
// stand in it. The rest opens when somebody wants it, which is also when the removal and
// ownership controls inside it are wanted.
const MEMBERS_SHOWN_BEFORE_FOLDING = 8;

function memberListMarkup(members, memberRow) {
  if (members.length <= MEMBERS_SHOWN_BEFORE_FOLDING) return members.map(memberRow).join('');
  const inView = members.filter((member) => member.role === 'owner' || member.id === accountUser?.id);
  const folded = members.filter((member) => !inView.includes(member));
  if (!folded.length) return members.map(memberRow).join('');
  const people = folded.length === 1 ? 'person' : 'people';
  return `${inView.map(memberRow).join('')}<details class="member-overflow"><summary>Show the other ${folded.length} ${people}</summary>${folded.map(memberRow).join('')}</details>`;
}

// "N people are here…": the top line of Journey sharing. Where the journey is full only because
// places are held for people invited, it says so, rather than that there is no open place (#350).
function sharingCopy(memberCount, canInvite, reserved) {
  const here = `${memberCount} ${memberCount === 1 ? 'person is' : 'people are'} here.`;
  let room = canInvite ? 'There is room to add another person, and everybody here has to agree to them.' : 'There is no open place right now.';
  if (!canInvite && reserved?.held && reserved.invitations.length === 1) room = `1 place is reserved for ${invitedPerson(reserved.invitations[0])}, waiting for them to accept the invitation.`;
  else if (!canInvite && reserved?.held && reserved.invitations.length > 1) room = `${reserved.invitations.length} places are reserved, waiting for the people invited to accept.`;
  return `${here} ${room} Each person signs in separately.`;
}

function reservedFor(trip) {
  return { held: Boolean(trip?.capacity?.heldForInvitations), invitations: reservedInvitations(trip?.invitationRecords || []) };
}

// The server sends only the masked email (#350); once the person has joined, their name.
function invitedPerson(record) {
  return record.joinedDisplayName || record.email;
}

function reservedInvitations(invitations) {
  return invitations.filter((invitation) => invitation.status === 'pending');
}

// "Being decided on" is only for people the journey hasn't finished agreeing on. Everything else
// is settled, and its record stays readable below it.
function splitProposals(proposals) {
  return { deciding: proposals.filter((proposal) => proposal.status === 'open'), settled: proposals.filter((proposal) => proposal.status !== 'open') };
}

function reservedPlaceTitle(invitation) {
  return `1 place reserved — waiting for ${invitedPerson(invitation)} to accept the invitation`;
}

// Two different waits, and they are not the same length: the journeyers have a month to answer,
// and the person invited has two weeks to accept (#347). "left" is said once, by the value (#282).
function countdownMarkup(expiresAt, prefix) {
  return `<small class="countdown" data-expires-at="${escapeHtml(expiresAt || '')}" data-countdown-prefix="${escapeHtml(prefix)}">${escapeHtml(prefix)}: ${escapeHtml(remainingLabel(expiresAt))}</small>`;
}

function reservedPlaceRow(invitation) {
  const withdraw = invitation.viewerMayWithdraw
    ? `<div class="settings-actions"><button class="button quiet" type="button" data-withdraw-invitation="${escapeHtml(invitation.id)}">Withdraw the invitation</button></div>`
    : '';
  return `<div class="journey-record-row"><div><strong>${escapeHtml(reservedPlaceTitle(invitation))}</strong><small>Sent by ${escapeHtml(invitation.invitedByDisplayName)} · <time datetime="${escapeHtml(invitation.sentAt || '')}">${escapeHtml(dateTimeLabel(invitation.sentAt))}</time></small>${countdownMarkup(invitation.expiresAt, 'Time to join')}${withdraw}</div><span class="invitation-status ${escapeHtml(invitation.status)}">${escapeHtml(invitationStatusLabel(invitation.status))}</span></div>`;
}

function sendAgainNote(invitation) {
  return `Everyone has already agreed, so it can be sent again until ${dateTimeLabel(invitation.sendAgainUntil)} without asking them again.`;
}

function invitationHistoryRow(invitation) {
  const joining = invitation.status === 'pending' ? countdownMarkup(invitation.expiresAt, 'Time to join') : '';
  const sendAgain = invitation.viewerMaySendAgain
    ? `<small>${escapeHtml(sendAgainNote(invitation))}</small><div class="settings-actions"><button class="button quiet" type="button" data-send-invitation-again="${escapeHtml(invitation.id)}">Send it again</button></div>`
    : '';
  return `<div class="journey-record-row"><div><strong>Invitation sent to ${escapeHtml(invitedPerson(invitation))}</strong><small>Sent by ${escapeHtml(invitation.invitedByDisplayName)} · <time datetime="${escapeHtml(invitation.sentAt)}">${escapeHtml(dateTimeLabel(invitation.sentAt))}</time></small>${joining}${sendAgain}</div><span class="invitation-status ${escapeHtml(invitation.status)}">${escapeHtml(invitationStatusLabel(invitation.status))}</span></div>`;
}

// The times on both sides of a decision are kept in the record: when somebody was asked, and
// when they answered. A journey can fold this away to read the summary, and cannot lose it.
function inviteProposalRow(proposal, trip) {
  const waiting = proposal.status === 'open'
    ? `${proposal.agreedCount} of ${proposal.askedCount} have agreed · ${proposal.pendingCount} still to answer`
    : `${proposal.agreedCount} of ${proposal.askedCount} agreed`;
  // Whoever asked can stop asking, and so can the owner. Withdrawing settles the question
  // without recording a refusal against anybody who simply had not answered yet.
  const mayWithdraw = proposal.status === 'open' && (proposal.proposedByUserId === accountUser?.id || trip?.role === 'owner');
  // Agreeing and declining carry the same weight on purpose. A solid primary on one of them is
  // the product having an opinion about how somebody should answer a question about another
  // person's access to everything this journey has shared. It does not get one.
  const buttons = [
    proposal.viewerMayDecide ? `<button class="button quiet" type="button" data-agree-proposal="${escapeHtml(proposal.id)}">Agree to add them</button>` : '',
    proposal.viewerMayDecide ? `<button class="button quiet" type="button" data-decline-proposal="${escapeHtml(proposal.id)}">Decline</button>` : '',
    mayWithdraw ? `<button class="button quiet" type="button" data-withdraw-proposal="${escapeHtml(proposal.id)}">Withdraw</button>` : '',
  ].filter(Boolean).join('');
  const actions = buttons ? `<div class="settings-actions">${buttons}</div>` : '';
  const note = proposal.note ? `<small>${escapeHtml(proposal.note)}</small>` : '';
  const countdown = proposal.status === 'open' ? countdownMarkup(proposal.expiresAt, 'Time to answer') : '';
  return `<div class="journey-record-row"><div><strong>${escapeHtml(invitedPerson(proposal))}</strong><small>Proposed by ${escapeHtml(proposal.proposedByDisplayName)} · <time datetime="${escapeHtml(proposal.proposedAt || '')}">${escapeHtml(dateTimeLabel(proposal.proposedAt))}</time></small>${note}<small>${escapeHtml(waiting)}</small>${countdown}${actions}<details class="proposal-detail"><summary>Who was asked, and when</summary>${proposal.decisions.map(proposalDecisionRow).join('')}</details></div><span class="invitation-status ${escapeHtml(proposal.status)}">${escapeHtml(proposalStatusLabel(proposal.status))}</span></div>`;
}

function proposalDecisionRow(entry) {
  const answered = entry.decision === 'pending'
    ? 'has not answered yet'
    : `${entry.decision === 'agree' ? 'agreed' : 'declined'} ${dateTimeLabel(entry.decidedAt)}`;
  return `<div class="journey-record-row"><div><strong>${escapeHtml(entry.displayName)}</strong><small>Asked <time datetime="${escapeHtml(entry.requestedAt || '')}">${escapeHtml(dateTimeLabel(entry.requestedAt))}</time> · ${escapeHtml(answered)}</small></div><span class="invitation-status ${escapeHtml(entry.decision)}">${escapeHtml(proposalDecisionLabel(entry.decision))}</span></div>`;
}

// The countdowns are redrawn in place rather than by re-rendering the journey, so that a fold
// somebody opened to read the record does not close under them while they are reading it.
function refreshCountdowns() {
  document.querySelectorAll('.countdown[data-expires-at]').forEach((element) => {
    element.textContent = `${element.dataset.countdownPrefix}: ${remainingLabel(element.dataset.expiresAt)}`;
  });
}

function proposalStatusLabel(status) {
  return ({ open: 'Waiting on everyone', agreed: 'Agreed', declined: 'Declined', withdrawn: 'Withdrawn', lapsed: 'Lapsed' })[status] || 'Recorded';
}

function proposalDecisionLabel(decision) {
  return ({ agree: 'Agreed', decline: 'Declined', pending: 'Waiting' })[decision] || 'Recorded';
}

// Only the owner sees this: they hold the journey and the payment, and the decision is theirs.
// It is written as a consequence rather than a setting, because what it chooses is what happens
// to another person's access when a payment lapses. Resting is always read-only (the Book, 4.7),
// so the order is all there is to choose: the last person in it keeps adding with the owner.
function renderUnpaidCapacityRest(trip, members) {
  const section = $('#unpaid-capacity-rest');
  if (!section) return;
  const capacity = trip.capacity;
  const owning = trip.role === 'owner' && capacity && capacity.mode === 'billing';
  section.hidden = !owning;
  if (!owning) return;

  const queue = restQueue(members, capacity.restOrder);
  const resting = new Set(capacity.restingMemberIds || []);
  $('#rest-queue').innerHTML = queue.length
    ? `<p class="rest-queue-copy">Who rests first, if it isn't paid. The last person here keeps adding with you.</p>${queue.map((member, index) => `<div class="journey-record-row"><div><strong>${escapeHtml(member.displayName)}</strong>${resting.has(member.id) ? '<small>Resting now</small>' : ''}${index === queue.length - 1 ? '<small class="rest-keeps-adding">Keeps adding with you</small>' : ''}</div><div class="journey-member-actions"><button class="button quiet" type="button" data-rest-earlier="${escapeHtml(member.id)}"${index === 0 ? ' disabled' : ''}>Rest earlier</button><button class="button quiet" type="button" data-rest-later="${escapeHtml(member.id)}"${index === queue.length - 1 ? ' disabled' : ''}>Rest later</button></div></div>`).join('')}`
    : emptyState('No one else is here yet', 'When another journeyer joins, you can choose who keeps adding with you.', { compact: true });

  const order = queue.map((member) => member.id);
  $$('[data-rest-earlier]', section).forEach((button) => button.addEventListener('click', () => moveRestOrder(trip, order, button.dataset.restEarlier, -1)));
  $$('[data-rest-later]', section).forEach((button) => button.addEventListener('click', () => moveRestOrder(trip, order, button.dataset.restLater, 1)));
}

// The order comes from the server (#281), so a move always starts from the order that is saved,
// never from the order people joined in. Someone the server does not list is not in the queue.
function restQueue(members, restOrder) {
  const byId = new Map(members.map((member) => [member.id, member]));
  return (restOrder || []).map((id) => byId.get(id)).filter(Boolean);
}

// A journey waiting on a payment tells everyone in it: who pays, the time left, the weeks asked
// for this year and who can still add if it isn't paid (the Book, 4.7). Everyone knows, so the
// payer can't quietly lean on the group's trust. The person reading is "you".
function graceBannerCopy(grace, viewerId, peopleHere) {
  const name = (person) => (person.id === viewerId ? 'you' : person.displayName);
  const names = (people) => {
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

// What the payer reads under the banner when another week can't be asked for yet, or at all
// this year.
function graceRequestNote(grace, viewerId) {
  if (grace.payer.id !== viewerId || grace.canRequest) return '';
  if (grace.requestsUsed >= grace.requestsPerYear) return `All ${grace.requestsPerYear} extra weeks for ${grace.calendarYear} have been asked for. The count starts again on January 1.`;
  return `Another week can be asked for once ${grace.requestDays} days or fewer are left.`;
}

function renderGraceBanner(trip) {
  const banner = $('#grace-banner');
  if (!banner) return;
  const grace = trip?.capacity?.grace;
  banner.hidden = !grace;
  if (!grace) return;
  $('#grace-banner-message').textContent = graceBannerCopy(grace, accountUser?.id, trip.capacity.peopleHere);
  const note = graceRequestNote(grace, accountUser?.id);
  $('#grace-banner-note').textContent = note;
  $('#grace-banner-note').hidden = !note;
  const button = $('#grace-request-button');
  button.hidden = !(grace.payer.id === accountUser?.id && grace.canRequest);
  button.textContent = `Ask for ${grace.requestDays} more days`;
}

async function requestMoreGrace() {
  const trip = activeTrip(state);
  if (!trip) return;
  try {
    await api.mutate(`/journeys/${trip.id}/grace-requests`, 'POST', {});
    await refreshCloudState();
    showToast('Asked for 7 more days. Everyone in this journey can see it.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
}

function moveRestOrder(trip, order, memberUserId, direction) {
  const from = order.indexOf(memberUserId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  saveUnpaidCapacityRest(trip, { restOrder: next });
}

async function saveUnpaidCapacityRest(trip, payload) {
  try {
    await api.mutate(`/journeys/${trip.id}/unpaid-capacity`, 'PATCH', payload);
    await refreshCloudState();
    showToast('Saved the resting order.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
}

function invitationStatusLabel(status) {
  return ({ accepted: 'Accepted', expired: 'Expired', pending: 'Pending', revoked: 'Revoked', withdrawn: 'Withdrawn' })[status] || 'Recorded';
}

function initializeThemePicker() {
  const selects = $$('[data-theme-picker]');
  const themes = window.TOGETHER_THEMES || [];
  selects.forEach((select) => {
    select.innerHTML = themes.map((theme) => `<option value="${theme.id}">${theme.label}</option>`).join('');
    select.value = document.documentElement.dataset.theme || 'light';
    select.addEventListener('change', () => {
      const id = window.applyTogetherTheme(select.value);
      localStorage.setItem('theme', id);
      selects.forEach((item) => { item.value = id; });
      showToast(`${themes.find((theme) => theme.id === id)?.label || 'Theme'} applied.`);
    });
  });
}

function initializeDialogBranding() {
  $$('dialog').forEach((dialog) => {
    const signature = document.createElement('div');
    signature.className = 'dialog-signature';
    signature.setAttribute('aria-hidden', 'true');
    signature.innerHTML = '<span class="mini-mark"><i></i><i></i></span><span>Together Ledger</span>';
    dialog.prepend(signature);
  });
}

function setSurface(surface) {
  const welcome = surface === 'welcome';
  document.body.dataset.surface = welcome ? 'welcome' : 'ledger';
  $$('[data-welcome-only]').forEach((element) => { element.hidden = !welcome; });
  $$('[data-ledger-only]').forEach((element) => { element.hidden = welcome; });
  const skipLink = $('.skip-link');
  skipLink.href = welcome ? '#welcome-title' : '#moments-title';
  skipLink.textContent = welcome ? 'Skip to the main story' : 'Skip to the shared ledger';
  if (!welcome) $('#ledger-app').hidden = false;
}

function showWelcomeSurface() {
  setSurface('welcome');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showLedgerSurface({ persist = false, focus = false } = {}) {
  if (persist && !state.preferences.onboardingComplete) {
    state.preferences.onboardingComplete = true;
    saveWorkingState();
  }
  setSurface('ledger');
  $$('.welcome-menu').forEach((menu) => { menu.open = false; });
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (focus) $('#moments-title').focus?.({ preventScroll: true });
}

function beginLedger() {
  showLedgerSurface({ persist: true });
  window.requestAnimationFrame(() => {
    if (accountUser && !isCloudJourney()) openJourney();
    else {
      $('#moment-dialog').addEventListener('close', () => $('#moments-title').focus({ preventScroll: true }), { once: true });
      openMoment();
    }
  });
}

function render() {
  const trip = activeTrip(state);
  const moments = activeMoments(state);
  const isEmptyStart = trip.id === 'first-shared-space' && !moments.length && !state.entries.length && !state.concerns.length;
  const accountNeedsJourney = Boolean(accountUser && !isCloudJourney(trip));
  renderJourneyControls(trip);
  $('.trip-bar').hidden = isEmptyStart;
  $$('[data-open-moment]').forEach((button) => { button.textContent = accountNeedsJourney ? 'Create a journey' : isEmptyStart ? 'Begin' : '＋ Hold a moment'; });
  $('#trip-name').textContent = trip.name;
  $('#trip-period').textContent = isEmptyStart ? 'Nothing has been written here yet.' : journeyPeriod(trip);
  $('#guidance').hidden = isEmptyStart || guidanceEndedToday();
  $('#threads').hidden = isEmptyStart;
  renderSharedJourney(trip, moments, isEmptyStart);
}

// A proposal is a question put to this person about another person, and until now it was only
// visible inside Journey settings — so somebody could be asked and never know. It is shown on the
// control that already leads there rather than announced: a count beside a label is seen whenever
// the ledger is, and it waits instead of interrupting. Nothing is added to the chrome, so there is
// no new thing to dismiss and nothing to grow louder the longer it is left.
function awaitingYourAnswer(trip) {
  return (trip?.inviteProposalRecords || []).filter((proposal) => proposal.viewerMayDecide).length;
}

function waitingSuffix(count) {
  return count ? ` · ${count} to answer` : '';
}

function renderJourneyControls(trip) {
  $('#journey-select').innerHTML = state.trips.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  $('#journey-select').value = trip.id;
  const actor = currentActor(trip);
  $('#actor-select').innerHTML = trip.members.map((member) => `<option>${escapeHtml(member)}</option>`).join('');
  $('#actor-select').value = actor;
  $('#event-count').textContent = `(${state.events.filter((event) => event.tripId === trip.id).length})`;
  $('#settings-button').textContent = `Journey settings${waitingSuffix(awaitingYourAnswer(trip))}`;
  const accountWithoutJourney = Boolean(accountUser && !isCloudJourney(trip));
  $$('[data-open-moment]').forEach((button) => { button.disabled = false; });
  $('#edit-journey-button').disabled = accountWithoutJourney;
  $('#event-manager-button').disabled = accountWithoutJourney;
  renderAccountState();
}

function momentLabel(kind, kindLabel = '') {
  if (kind === 'other') return kindLabel || 'A shared note';
  return MOMENT_TYPES.find(([value]) => value === kind)?.[1] || 'Moment';
}

function momentThemeAttribute(value) {
  const theme = normalizeMomentTheme(value);
  return theme ? ` data-moment-theme="${theme}"` : '';
}

function localDayKey() {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function guidanceEndedToday() {
  return localStorage.getItem('together-ledger-guidance-ended-on') === localDayKey();
}

function journeyPeriod(trip) {
  const pieces = [];
  if (trip.location) pieces.push(trip.location);
  pieces.push(trip.startDateStatus === 'unknown' ? 'Began at an unknown time' : `Began ${dateLabel(trip.startDate)}`);
  pieces.push(trip.endDateStatus === 'forever' ? 'No end date planned' : trip.endDateStatus === 'unsure' ? 'Ending not decided yet' : `Ends ${dateLabel(trip.endDate)}`);
  return pieces.join(' · ');
}

function renderSharedJourney(trip, moments, isEmptyStart) {
  const threads = state.concerns.filter((concern) => concern.tripId === trip.id && concern.status === 'open');
  const recent = [...moments].sort((a, b) => `${b.occurredOn}-${b.updatedAt}`.localeCompare(`${a.occurredOn}-${a.updatedAt}`));

  const prompts = conversationPrompts();
  guidanceIndex = Math.min(guidanceIndex, prompts.length - 1);
  $('#guidance-progress').textContent = `Check-in ${guidanceIndex + 1} of ${prompts.length}`;
  $('#guidance-prompt').textContent = prompts[guidanceIndex];
  $('#guidance-prev').disabled = guidanceIndex === 0;
  $('#guidance-skip').hidden = guidanceIndex === prompts.length - 1;
  $('#guidance-done').hidden = guidanceIndex !== prompts.length - 1;
  const kindsInUse = new Set(recent.map((moment) => moment.kind));
  const filters = [['all', 'All moments'], ...MOMENT_TYPES.filter(([value]) => kindsInUse.has(value))];
  if (!filters.some(([value]) => value === momentFilter)) momentFilter = 'all';
  $('#moments-eyebrow').textContent = isEmptyStart ? 'A place to begin' : 'Our shared journey';
  $('#moments-title').textContent = isEmptyStart ? 'What can live here?' : 'Recent moments';
  $('#moments-copy').textContent = isEmptyStart ? 'A ledger can hold the things you want to remember, name, or return to. It begins empty.' : 'Hold what happened in words that feel true.';
  $('#moment-filters').hidden = !momentsExpanded || !recent.length;
  $('#moment-filters').innerHTML = momentsExpanded ? filters.map(([value, label]) => `<button class="${momentFilter === value ? 'active' : ''}" data-moment-filter="${value}" aria-pressed="${momentFilter === value}">${label}</button>`).join('') : '';
  $$('[data-moment-filter]').forEach((button) => button.addEventListener('click', () => { momentFilter = button.dataset.momentFilter; renderSharedJourney(trip, moments); }));
  $('#toggle-moments-button').hidden = !seeAllShown(recent.length, momentsExpanded);
  $('#toggle-moments-button').textContent = momentsExpanded ? 'Show recent' : `See all ${countOf(recent.length, 'moment', 'moments')}`;
  const visible = (momentsExpanded ? recent.filter((moment) => momentFilter === 'all' || moment.kind === momentFilter) : recent.slice(0, RECENT_MOMENTS_SHOWN));
  $('#moment-timeline').innerHTML = visible.length ? visible.map((moment) => {
    const attribution = `<span>Held by ${escapeHtml(moment.createdBy || 'Journey member')}</span>${moment.shapedByBoth ? '<span class="moment-collaboration-badge">Shaped by more than one journeyer</span>' : ''}`;
    const shareAction = isCloudJourney(trip) && moment.visibility === 'share-later' ? `<button data-share-moment="${escapeHtml(moment.id)}">Share now</button>` : '';
    const attachments = moment.images?.length ? `<div class="moment-attachments">${moment.images.map((image) => `<button type="button" class="moment-image-attachment" data-open-moment-image="${escapeHtml(image.id)}" aria-label="Open photo ${escapeHtml(image.filename || 'Image')}"><img data-moment-image-preview="${escapeHtml(image.id)}" alt="Photo held with ${escapeHtml(moment.title)}" /><span class="moment-image-attachment-copy"><span>Photo</span><strong>${escapeHtml(image.filename || 'Image')}</strong><small>Open larger</small></span></button>`).join('')}</div>` : '';
    const removed = moment.removedImages?.length ? `<details class="moment-removed-photos"><summary>Removed photo</summary>${moment.removedImages.map((image) => `<button type="button" class="moment-image-attachment" data-open-moment-image="${escapeHtml(image.id)}" aria-label="Open removed photo ${escapeHtml(image.filename || 'Image')}"><span class="moment-image-attachment-copy"><span>Removed photo</span><strong>${escapeHtml(image.filename || 'Image')}</strong><small>Open larger</small></span></button>`).join('')}</details>` : '';
    const locations = Array.isArray(moment.locations) ? moment.locations : [];
    const locationContext = locations.length ? `<div class="location-context">${escapeHtml(locations.map((location) => location.label).join(' · '))}</div>` : '';
    return `<article class="moment-card ${moment.visibility}"${momentThemeAttribute(moment.theme)}><div class="moment-meta"><span class="moment-kind">${escapeHtml(momentLabel(moment.kind, moment.kindLabel))}</span><span>${dateLabel(moment.occurredOn)}</span><span class="visibility-chip ${moment.visibility}"><span class="visibility-glyph" aria-hidden="true">${visibilityCue(moment.visibility).glyph}</span>${escapeHtml(visibilityCue(moment.visibility).label)}</span></div><strong>${escapeHtml(moment.title)}</strong>${moment.detail ? `<p>${escapeHtml(moment.detail)}</p>` : ''}${locationContext}${attachments}${removed}${moment.moneyCents != null ? `<details class="money-context"><summary>Practical money context</summary><p>${money(moment.moneyCents, moment.moneyCurrency)} is held here as context, not a score.</p></details>` : ''}<div class="moment-actions"><small class="moment-author">${attribution}</small>${shareAction}<button data-edit-moment="${escapeHtml(moment.id)}">Edit</button></div></article>`;
  }).join('') : isEmptyStart ? `<div class="log-types"><p>There are no examples here—only possibilities:</p><div>${MOMENT_TYPES.filter(([value]) => value !== 'other').map(([, label]) => `<span>${escapeHtml(label)}</span>`).join('')}<button type="button" data-open-custom-moment>＋ Add your own moment</button></div></div>` : emptyState('No moments in this view', 'A small truth is enough to begin, or choose another filter to see more.');
  $$('[data-edit-moment]').forEach((button) => button.addEventListener('click', () => openMoment(button.dataset.editMoment)));
  $$('[data-open-moment-image]').forEach((button) => button.addEventListener('click', () => openMomentImage(button.dataset.openMomentImage)));
  $$('[data-share-moment]').forEach((button) => button.addEventListener('click', () => shareMoment(button.dataset.shareMoment)));
  $$('[data-open-custom-moment]').forEach((button) => button.addEventListener('click', () => {
    if (accountUser && !isCloudJourney(trip)) { openJourney(); return; }
    openMoment('', 'other');
  }));
  $('#open-threads').innerHTML = threads.length ? threads.map((thread) => `<article class="thread-row"><div><span class="status-chip open">open</span><strong>${escapeHtml(thread.title)}</strong>${thread.detail ? `<p>${escapeHtml(thread.detail)}</p>` : ''}</div><button data-edit-thread="${escapeHtml(thread.id)}">Open</button></article>`).join('') : emptyState('No open threads', 'That can be a good place to rest.', { compact: true });
  $$('[data-edit-thread]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editThread)));
  hydrateMomentImagePreviews(trip);
}

async function imageUrlForMoment(trip, moment, image) {
  const key = `${trip.id}/${moment.id}/${image.id}`;
  if (momentImageUrls.has(key)) return momentImageUrls.get(key);
  const blob = await api.momentImageBlob(trip.id, moment.id, image.id);
  const url = URL.createObjectURL(blob);
  momentImageUrls.set(key, url);
  return url;
}

async function hydrateMomentImagePreviews(trip) {
  const previews = $$('[data-moment-image-preview]');
  await Promise.all(previews.map(async (preview) => {
    const imageId = preview.dataset.momentImagePreview;
    const moment = activeMoments(state).find((item) => item.images?.some((image) => image.id === imageId));
    const image = moment?.images.find((item) => item.id === imageId);
    if (!moment || !image) return;
    try {
      preview.src = await imageUrlForMoment(trip, moment, image);
    } catch {
      preview.closest('.moment-image-attachment')?.classList.add('image-unavailable');
      preview.alt = 'Photo could not be loaded. Select to try again.';
    }
  }));
}

async function openMomentImage(imageId) {
  const trip = activeTrip(state);
  const moment = activeMoments(state).find((item) => item.images?.some((image) => image.id === imageId));
  const image = moment?.images.find((item) => item.id === imageId);
  if (!trip || !moment || !image) return;
  $('#moment-image-viewer-name').textContent = image.filename || 'Image';
  const viewer = $('#moment-image-viewer-image');
  const error = $('#moment-image-viewer-error');
  viewer.hidden = true;
  error.hidden = true;
  viewer.alt = `Photo held with ${moment.title}`;
  $('#moment-image-viewer').showModal();
  try {
    viewer.src = await imageUrlForMoment(trip, moment, image);
    viewer.hidden = false;
  } catch (loadError) {
    error.textContent = loadError.message;
    error.hidden = false;
  }
}

function updateMomentKindField(form) {
  const custom = form.elements.kind.value === 'other';
  $('#moment-kind-label-field').hidden = !custom;
  form.elements.kindLabel.required = custom;
  form.elements.kindLabel.disabled = !custom;
}

function syncMomentThemePreview(form) {
  const theme = normalizeMomentTheme(form.elements.theme?.value);
  const preview = $('#moment-theme-preview');
  if (theme) preview.dataset.momentTheme = theme;
  else delete preview.dataset.momentTheme;
  $('#moment-theme-preview-name').textContent = momentThemeLabel(theme);
}

function renderMomentThemeChooser(form, selectedTheme = '') {
  const selected = normalizeMomentTheme(selectedTheme);
  const choices = [{ id: '', label: 'Use my theme' }, ...MOMENT_THEMES];
  $('#moment-theme-options').innerHTML = choices.map(({ id, label }) => `<label><input type="radio" name="theme" value="${id}"${id === selected ? ' checked' : ''} /><span class="moment-theme-swatch${id ? '' : ' inherited'}"${momentThemeAttribute(id)} aria-hidden="true"></span><span>${escapeHtml(label)}</span></label>`).join('');
  $$('input[name="theme"]', form).forEach((input) => input.addEventListener('change', () => syncMomentThemePreview(form)));
  syncMomentThemePreview(form);
}

function renderMomentLocations() {
  const list = $('#moment-locations');
  list.innerHTML = momentLocations.map((location, index) => `<li><strong>${escapeHtml(location.label)}</strong><small>${index === 0 ? 'Included' : '$1/month'}</small><button type="button" data-remove-location="${index}" aria-label="Remove ${escapeHtml(location.label)}">Remove</button></li>`).join('');
  $$('[data-remove-location]', list).forEach((button) => button.addEventListener('click', () => {
    momentLocations.splice(Number(button.dataset.removeLocation), 1);
    renderMomentLocations();
  }));
}

function addMomentLocation(location) {
  if (!location.label?.trim()) return;
  if (momentLocations.length >= 12) { showToast('A moment can hold up to 12 places.'); return; }
  momentLocations.push({ ...location, label: location.label.trim() });
  renderMomentLocations();
}

// The photo picked in the moment dialog, its location and camera details already removed (#258).
// The line beneath the picker says so only once that has happened, so it is never a promise.
let preparedMomentPhoto = null;

function forgetMomentPhoto() {
  preparedMomentPhoto = null;
  clearStatus('photo');
  const note = $('#moment-image-privacy');
  note.hidden = true;
  note.textContent = '';
}

async function prepareMomentPhoto(input) {
  forgetMomentPhoto();
  const file = input.files?.[0];
  if (!file) return;
  try {
    const { bytes, contentType } = stripPhotoMetadata(new Uint8Array(await file.arrayBuffer()));
    if (input.files?.[0] !== file) return; // another photo was picked meanwhile
    preparedMomentPhoto = { source: file, photo: new File([bytes], file.name, { type: contentType }) };
    const note = $('#moment-image-privacy');
    note.textContent = PHOTO_METADATA_REMOVED;
    note.hidden = false;
  } catch (error) {
    if (input.files?.[0] !== file) return; // a newer pick is not this one's to clear
    input.value = '';
    showStatus(error.message, { source: 'photo' });
  }
}

function openMoment(id = '', initialKind = '') {
  const form = $('#moment-form');
  const trip = activeTrip(state);
  const moment = state.moments.find((item) => item.id === id && item.tripId === trip?.id);
  const hosted = isCloudJourney();
  form.reset();
  forgetMomentPhoto();
  // A new moment must never inherit an ID from a dialog that previously edited one.
  form.elements.id.value = '';
  form.elements.kind.innerHTML = MOMENT_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  form.elements.occurredOn.value = localDay();
  form.elements.visibility.value = 'shared-now';
  renderMomentThemeChooser(form, moment?.theme);
  momentLocations = [];
  $('#moment-dialog-title').textContent = moment ? 'Edit this moment' : 'Hold a moment';
  $('#save-moment').textContent = moment ? 'Save moment' : 'Hold this moment';
  $('#moment-dialog-copy').textContent = hosted ? 'Choose whether this stays with you, is shared now, or waits until you are ready.' : 'Choose visibility with care. In browser-only mode, it is a local cue, not separate-account privacy.';
  $('#moment-visibility-help').textContent = hosted
    ? moment?.visibility === 'shared-now'
      ? 'Already shared: everyone in this journey can see this moment, including anyone who joins later. Prior access cannot be undone.'
      : 'Private stays with you. Shared now opens it to everyone in this journey, including anyone who joins later. Share later stays with you until you deliberately share it.'
    : 'Browser only: Private and Share later are local cues, not separate-account privacy controls.';
  $('#moment-visibility-field').hidden = false;
  $('#moment-image-field').hidden = !hosted;
  $$('input[name="visibility"]', form).forEach((input) => { input.disabled = Boolean(hosted && moment?.visibility === 'shared-now' && input.value !== 'shared-now'); });
  $('#moment-location-label').closest('.location-field').hidden = false;
  if (moment) {
    form.elements.id.value = moment.id; form.elements.kind.value = moment.kind; form.elements.kindLabel.value = moment.kindLabel || ''; form.elements.title.value = moment.title; form.elements.detail.value = moment.detail; form.elements.occurredOn.value = moment.occurredOn; form.elements.visibility.value = moment.visibility; form.elements.money.value = moment.moneyCents == null ? '' : (moment.moneyCents / 100).toFixed(2); form.elements.moneyCurrency.value = moment.moneyCurrency || ''; momentLocations = Array.isArray(moment.locations) ? structuredClone(moment.locations) : [];
  } else if (initialKind) {
    form.elements.kind.value = initialKind;
  }
  const hasIncludedImage = Boolean(moment?.images?.length);
  const includedImage = moment?.images?.[0];
  form.elements.image.disabled = hasIncludedImage;
  $('#moment-image-help').textContent = hasIncludedImage ? 'This moment already holds its included image. Another image is a $1/month add-on.' : 'JPEG, PNG, or WebP, up to 25 MB. One image is included with every hosted moment.';
  $('#remove-moment-image-button').hidden = !hosted || !includedImage;
  $('#remove-moment-image-button').dataset.momentId = moment?.id || '';
  $('#remove-moment-image-button').dataset.imageId = includedImage?.id || '';
  $('#buy-image-slot-button').hidden = !hosted || !moment || !hasIncludedImage;
  $('#buy-image-slot-button').dataset.momentId = moment?.id || '';
  $('#buy-location-slot-button').hidden = !hosted || !moment || momentLocations.length === 0;
  $('#buy-location-slot-button').dataset.momentId = moment?.id || '';
  delete form.dataset.paidSlotId;
  if (hosted && moment && hasIncludedImage) {
    api.imageSlots(activeTrip(state).id, moment.id).then(({ slots }) => {
      const slot = slots.find((item) => ['active', 'grace'].includes(item.state));
      if (!slot || !$('#moment-dialog').open) return;
      form.elements.image.disabled = false;
      form.dataset.paidSlotId = slot.id;
      $('#moment-image-help').textContent = 'Your $1/month image add-on is ready. Choose the additional image, up to 25 MB.';
    }).catch(() => {});
  }
  form.elements.kind.onchange = () => updateMomentKindField(form);
  updateMomentKindField(form);
  renderMomentLocations();
  $('#moment-dialog').showModal(); form.elements.title.focus({ preventScroll: true });
}

async function shareMoment(id) {
  const moment = state.moments.find((item) => item.id === id);
  const trip = activeTrip(state);
  if (!moment || !isCloudJourney(trip) || moment.visibility !== 'share-later') return;
  if (!await confirmConsequence({ title: 'Share this moment now?', consequence: 'Everyone in this journey will be able to see it, including anyone who joins later. That access cannot be undone.', confirmLabel: 'Share this moment' })) return;
  try {
    const payload = { kind: moment.kind, kindLabel: moment.kindLabel || '', title: moment.title, detail: moment.detail, occurredOn: moment.occurredOn, visibility: 'shared-now', theme: normalizeMomentTheme(moment.theme), moneyCents: moment.moneyCents, moneyCurrency: moment.moneyCurrency || '', locations: moment.locations || [], version: moment.version };
    await api.mutate(`/journeys/${trip.id}/moments/${moment.id}`, 'PATCH', payload);
    await refreshCloudState();
    showToast('Moment shared with your journeyer.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
}

function currentActor(trip = activeTrip(state)) {
  if (isCloudJourney(trip)) return accountUser.displayName;
  const selected = state.preferences.activeActorByTrip[trip.id];
  return trip.members.includes(selected) ? selected : trip.members[0];
}

function eventRecord(input) {
  appendJourneyEvent(state, { ...input, actorName: input.actorName || currentActor(), tripId: input.tripId || activeTrip(state).id });
}

function renderSummary(summary, count) {
  const cards = [
    ['Total trip cost', money(summary.totalCents), `${count} ${count === 1 ? 'expense' : 'expenses'}`, ''],
    ['Budget left', money(summary.budgetLeftCents), `${money(summary.budgetCents)} planned`, summary.budgetLeftCents < 0 ? 'alert' : ''],
    ['Still due', money(summary.dueCents), summary.dueCents ? 'Worth agreeing on next' : 'Nothing waiting', summary.dueCents ? 'alert' : ''],
    ['Shared clarity', count ? 'Up to date' : 'Start here', count ? 'A common picture for the next talk' : 'Add the first cost together', ''],
  ];
  $('#summary-grid').innerHTML = cards.map(([label, value, note, className]) => `<article class="card summary ${className}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');
}

function renderCategoryChart(summary) {
  const rows = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] || 1;
  $('#category-chart').innerHTML = rows.length ? rows.map(([category, total]) => `<div class="bar-row"><div class="bar-copy"><span>${escapeHtml(category)}</span><strong>${money(total)}</strong></div><div class="bar-track"><i style="width:${Math.max(1, total / max * 100)}%"></i></div></div>`).join('') : '<p class="empty">Add an expense to see the category mix.</p>';
}

function renderPayerChart(summary, members) {
  const totals = members.map((member) => [member, summary.byPayer[member] || 0]);
  const combined = totals.reduce((total, [, amount]) => total + amount, 0) || 1;
  $('#payer-chart').innerHTML = `<div class="payer-track" role="img" aria-label="${totals.map(([name, amount]) => `${name} ${money(amount)}`).join(', ')}">${totals.map(([, amount]) => `<i style="width:${amount / combined * 100}%"></i>`).join('')}</div><div class="payer-key">${totals.map(([name, amount]) => `<div><span>${escapeHtml(name)}</span><strong>${money(amount)}</strong></div>`).join('')}</div>`;
}

function renderFilters() {
  const filters = ['All', 'Bookings', 'Meals', 'Transportation', 'Due'];
  $('#filters').innerHTML = filters.map((name) => `<button class="${filter === name ? 'active' : ''}" data-filter="${name}" aria-pressed="${filter === name}">${name}</button>`).join('');
  $$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    renderFilters();
    renderLedger(activeEntries(state));
  }));
}

function filteredEntries(entries) {
  if (filter === 'Bookings') return entries.filter((entry) => ['Flights', 'Hotel'].includes(entry.category));
  if (filter === 'Meals') return entries.filter((entry) => entry.category === 'Restaurants');
  if (filter === 'Transportation') return entries.filter((entry) => entry.category === 'Transportation');
  if (filter === 'Due') return entries.filter((entry) => entry.status === 'due');
  return entries;
}

function renderLedger(entries) {
  const list = filteredEntries(entries).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
  if (!list.length) {
    $('#ledger').innerHTML = `<div class="empty"><strong>${entries.length ? 'Nothing in this view.' : 'Start with one shared fact.'}</strong><p>${entries.length ? 'Choose another filter.' : 'Add a flight, hotel, meal, ride, activity, or any other trip cost.'}</p></div>`;
    return;
  }
  $('#ledger').innerHTML = list.map((entry) => `<article class="entry">
    <span class="entry-icon" aria-hidden="true">${CATEGORY_ICONS[entry.category] || '·'}</span>
    <div class="entry-main"><strong>${escapeHtml(entry.merchant)}</strong><div class="entry-meta"><span>${escapeHtml(entry.category)}</span><span>${dateLabel(entry.occurredOn)}</span><span>Paid by ${escapeHtml(entry.paidBy)}</span>${entry.account ? `<span>From ${escapeHtml(entry.account)}</span>` : ''}${entry.reference ? `<span>Ref ${escapeHtml(entry.reference)}</span>` : ''}</div></div>
    <div class="entry-amount"><strong>${money(entry.amountCents)}</strong><small>${entry.status === 'due' ? 'Still due' : 'Paid'}</small></div>
    <div class="entry-actions"><button data-edit="${escapeHtml(entry.id)}">Edit</button><button data-remove="${escapeHtml(entry.id)}">Remove</button></div>
  </article>`).join('');
  $$('[data-edit]').forEach((button) => button.addEventListener('click', () => openExpense(button.dataset.edit)));
  $$('[data-remove]').forEach((button) => button.addEventListener('click', () => confirmRemove(button.dataset.remove)));
}

function renderTimeline(trip, entries, summary) {
  const days = dateRange(trip.startDate, trip.endDate, entries);
  const peak = Math.max(...days.map((date) => summary.byDay[date] || 0), 1);
  $('#timeline-chart').innerHTML = days.map((date) => {
    const total = summary.byDay[date] || 0;
    const height = total ? Math.max(3, total / peak * 100) : 1;
    return `<button class="day-button${selectedDay === date ? ' selected' : ''}" data-day="${date}" aria-pressed="${selectedDay === date}" aria-label="${dateLabel(date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${money(total)}. Show details."><span class="day-bar-space"><i class="day-bar" style="height:${height}%">${total ? `<em>${money(total)}</em>` : ''}</i></span><span class="day-label">${dateLabel(date)}<br>${dateLabel(date, { weekday: 'short' })}</span></button>`;
  }).join('');
  $$('[data-day]').forEach((button) => button.addEventListener('click', () => {
    selectedDay = button.dataset.day;
    selectedCategory = null;
    renderTimeline(trip, entries, summary);
    $('#timeline-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  renderTimelineDetail(entries);
}

function renderTimelineDetail(entries) {
  const detail = $('#timeline-detail');
  if (!selectedDay) {
    detail.hidden = true;
    detail.innerHTML = '';
    return;
  }
  detail.hidden = false;
  const groups = groupDayByCategory(entries, selectedDay);
  const dayEntries = Object.values(groups).flat();
  const dayTotal = dayEntries.reduce((total, entry) => total + entry.amountCents, 0);
  const head = `<div class="detail-head"><div><h3>${dateLabel(selectedDay, { weekday: 'long', month: 'long', day: 'numeric' })}</h3><p>${money(dayTotal)} across ${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'}</p></div><button class="icon-button" data-close-day aria-label="Close day details">×</button></div>`;
  if (!dayEntries.length) {
    detail.innerHTML = `${head}<p class="empty">No spending is recorded for this day.</p>`;
  } else if (!selectedCategory) {
    const categories = Object.entries(groups).map(([category, items]) => [category, items.reduce((total, entry) => total + entry.amountCents, 0), items.length]).sort((a, b) => b[1] - a[1]);
    detail.innerHTML = head + categories.map(([category, total, count]) => `<button class="category-button" data-detail-category="${escapeHtml(category)}"><span><strong>${escapeHtml(category)}</strong><small>${count} ${count === 1 ? 'entry' : 'entries'}</small></span><strong>${money(total)} →</strong></button>`).join('');
  } else {
    const categoryEntries = groups[selectedCategory] || [];
    detail.innerHTML = `${head}<button class="back-button" data-back-day>← All spending for this day</button>${categoryEntries.map((entry) => `<div class="detail-entry"><span><strong>${escapeHtml(entry.merchant)}</strong><small>${escapeHtml(entry.paidBy)} · ${entry.status === 'due' ? 'Still due' : 'Paid'}</small></span><strong>${money(entry.amountCents)}</strong></div>`).join('')}`;
  }
  $('[data-close-day]')?.addEventListener('click', () => {
    selectedDay = null;
    selectedCategory = null;
    render();
  });
  $$('[data-detail-category]').forEach((button) => button.addEventListener('click', () => {
    selectedCategory = button.dataset.detailCategory;
    renderTimelineDetail(entries);
  }));
  $('[data-back-day]')?.addEventListener('click', () => {
    selectedCategory = null;
    renderTimelineDetail(entries);
  });
}

function openExpense(id = '') {
  const dialog = $('#expense-dialog');
  const form = $('#expense-form');
  const trip = activeTrip(state);
  form.reset();
  form.elements.category.innerHTML = CATEGORIES.map((category) => `<option>${category}</option>`).join('');
  form.elements.paidBy.innerHTML = trip.members.map((member) => `<option>${escapeHtml(member)}</option>`).join('');
  form.elements.occurredOn.value = localDay();
  form.elements.category.value = 'Restaurants';
  $('#expense-title').textContent = 'Add an expense';
  $('#save-expense').textContent = 'Save expense';
  const entry = state.entries.find((item) => item.id === id);
  if (entry) {
    form.elements.id.value = entry.id;
    form.elements.merchant.value = entry.merchant;
    form.elements.category.value = entry.category;
    form.elements.amount.value = (entry.amountCents / 100).toFixed(2);
    form.elements.occurredOn.value = entry.occurredOn;
    form.elements.paidBy.value = entry.paidBy;
    form.elements.account.value = entry.account;
    form.elements.status.value = entry.status;
    form.elements.reference.value = entry.reference;
    form.elements.notes.value = entry.notes;
    $('#expense-title').textContent = 'Edit expense';
    $('#save-expense').textContent = 'Save changes';
  }
  dialog.showModal();
  form.elements.merchant.focus({ preventScroll: true });
}

function openJourney(trip = null) {
  const form = $('#journey-form');
  form.reset();
  const today = localDay();
  form.elements.startDate.value = today;
  form.elements.endDate.value = today;
  form.elements.startDateStatus.value = 'exact';
  form.elements.endDateStatus.value = 'forever';
  $('#journey-dialog-title').textContent = trip ? 'Edit journey details' : 'Begin a shared journey';
  $('#journey-dialog-eyebrow').textContent = accountUser ? 'Private journey details' : 'Local journey details';
  $('#journey-dialog-copy').textContent = accountUser
    ? 'Begin with a name. The optional details can wait until they feel useful.'
    : 'Two people share the journey. The information stays in this browser until you export it.';
  $('#save-journey-button').textContent = trip ? 'Save journey changes' : 'Create journey';
  $$('.member-field').forEach((field) => {
    field.hidden = Boolean(accountUser);
    const input = field.querySelector('input');
    input.disabled = Boolean(accountUser);
    input.required = !accountUser;
  });
  if (trip) {
    form.elements.id.value = trip.id;
    form.elements.name.value = trip.name;
    form.elements.location.value = trip.location;
    form.elements.startDateStatus.value = trip.startDateStatus || 'exact';
    form.elements.endDateStatus.value = trip.endDateStatus || 'forever';
    form.elements.startDate.value = trip.startDate || today;
    form.elements.endDate.value = trip.endDate || today;
    form.elements.budget.value = (trip.budgetCents / 100).toFixed(2);
    form.elements.memberOne.value = trip.members[0];
    form.elements.memberTwo.value = trip.members[1];
  }
  syncJourneyDateFields(form);
  $('#journey-dialog').showModal();
  form.elements.name.focus({ preventScroll: true });
}

function syncJourneyDateFields(form = $('#journey-form')) {
  const hasExactStart = form.elements.startDateStatus.value === 'exact';
  const hasExactEnd = form.elements.endDateStatus.value === 'date';
  $('#start-date-field').hidden = !hasExactStart;
  $('#end-date-field').hidden = !hasExactEnd;
  form.elements.startDate.disabled = !hasExactStart;
  form.elements.endDate.disabled = !hasExactEnd;
  form.elements.startDate.required = hasExactStart;
  form.elements.endDate.required = hasExactEnd;
}

function meaningfulChanges(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).map((key) => ({ key, before: before?.[key], after: after?.[key] }));
}

function valueLabel(key, value) {
  if (value == null || value === '') return 'none';
  if (key === 'budgetCents' || key === 'amountCents') return money(value);
  if (key === 'theme') return momentThemeLabel(value);
  // A list of places is a list of values: each is written out, rather than read as [object Object].
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderEventManager() {
  const trip = activeTrip(state);
  const concerns = state.concerns.filter((concern) => concern.tripId === trip.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const events = state.events.filter((event) => event.tripId === trip.id).sort((a, b) => b.sequence - a.sequence);
  $('#event-dialog-title').textContent = `${trip.name} history`;
  $('#event-manager-copy').textContent = isCloudJourney(trip) ? 'Server-authoritative, account-attributed history. HMAC chaining makes database changes detectable; deleted records retain privacy-bounded tombstones.' : 'Browser-local preview. Production attribution requires separate signed-in accounts.';
  // The guide explains what the server writes, so a browser-only journey, whose history this
  // browser keeps for itself, isn't sent to it.
  $('#history-guide-link').hidden = !isCloudJourney(trip);
  $('#history-guide').hidden = !isCloudJourney(trip);
  renderHistoryGuide();
  $('#concern-list').innerHTML = concerns.length ? concerns.map((concern) => `<article class="concern-row"><div><span class="status-chip ${concern.status}">${concern.status}</span><strong>${escapeHtml(concern.title)}</strong>${concern.detail ? `<p>${escapeHtml(concern.detail)}</p>` : ''}<small>Updated by ${escapeHtml(concern.updatedBy)} · ${new Date(concern.updatedAt).toLocaleString()}</small></div><div><button type="button" data-edit-concern="${escapeHtml(concern.id)}">Edit</button><button type="button" data-remove-concern="${escapeHtml(concern.id)}">Delete</button></div></article>`).join('') : emptyState('Nothing to return to yet', 'Conversations you want to come back to together will appear here.', { compact: true });
  $('#event-list').innerHTML = events.length ? events.map((event) => {
    const changes = meaningfulChanges(event.before, event.after);
    return `<details class="event-row"><summary><span><strong>#${event.sequence} · ${escapeHtml(event.summary)}</strong><small>${escapeHtml(event.actorName)} · ${new Date(event.occurredAt).toLocaleString()}</small></span><span aria-hidden="true">＋</span></summary>${changes.length ? `<dl>${changes.map(({ key, before, after }) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(valueLabel(key, before))} → ${escapeHtml(valueLabel(key, after))}</dd></div>`).join('')}</dl>` : '<p>No field-level value change was stored for this event.</p>'}<small>Event ID ${escapeHtml(event.id)} · Previous ${escapeHtml(event.previousEventId || 'none')} · ${escapeHtml(event.source)}${event.eventHash ? ` · Hash ${escapeHtml(event.eventHash.slice(0, 12))}…` : ''}</small></details>`;
  }).join('') : emptyState('No recorded changes yet', 'Changes appear here as they happen. Activity from before the Event Manager began cannot be reconstructed.', { compact: true });
  $$('[data-edit-concern]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editConcern)));
  $$('[data-remove-concern]').forEach((button) => button.addEventListener('click', () => removeConcern(button.dataset.removeConcern)));
}

// "How to read your history" (#349), in the phone's words too: both draw src/history-guide.js.
// The words never change while the page is open, so they are drawn once.
function renderHistoryGuide() {
  const section = $('#history-guide');
  if (section.childElementCount) return;
  const paragraphs = (texts) => texts.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const terms = (entries) => `<dl class="history-guide-terms">${Object.entries(entries).map(([name, meaning]) => `<div><dt><code>${escapeHtml(name)}</code></dt><dd>${escapeHtml(meaning)}</dd></div>`).join('')}</dl>`;
  const kinds = HISTORY_EVENT_GROUPS.map((group) => `<h5>${escapeHtml(group.heading)}</h5>${group.kinds.map((kind) => `<article class="history-guide-kind"><strong>${escapeHtml(kind.reads.join(' / '))}</strong><code>${escapeHtml(kind.action)}</code><p>${escapeHtml(kind.when)}</p><p><b>${escapeHtml(HISTORY_RECORDS_LABEL)}:</b> ${escapeHtml(kind.records.length ? kind.records.join(', ') : HISTORY_RECORDS_NOTHING)}</p><p><b>${escapeHtml(HISTORY_NEVER_LABEL)}:</b> ${escapeHtml(kind.never)}</p></article>`).join('')}`).join('');
  section.innerHTML = `<h3 id="history-guide-title">${escapeHtml(HISTORY_GUIDE_TITLE)}</h3>${paragraphs(HISTORY_GUIDE_INTRO)}`
    + HISTORY_GUIDE_SECTIONS.map((part) => `<h4>${escapeHtml(part.heading)}</h4>${paragraphs(part.paragraphs)}`).join('')
    + `<h4>${escapeHtml(HISTORY_KINDS_HEADING)}</h4>${kinds}`
    + `<h4>${escapeHtml(HISTORY_FIELDS_HEADING)}</h4>${terms(HISTORY_FIELDS)}`
    + `<h4>${escapeHtml(HISTORY_ENTRY_PARTS_HEADING)}</h4>${terms(HISTORY_ENTRY_PARTS)}`;
}

function openConcern(id = '') {
  const form = $('#concern-form');
  const concern = state.concerns.find((item) => item.id === id);
  form.reset();
  $('#concern-dialog-title').textContent = concern ? 'Edit return-to conversation' : 'Start a return-to conversation';
  $('#save-concern-button').textContent = concern ? 'Save conversation changes' : 'Keep this open';
  if (concern) {
    form.elements.id.value = concern.id;
    form.elements.title.value = concern.title;
    form.elements.detail.value = concern.detail;
    form.elements.status.value = concern.status;
  }
  $('#concern-dialog').showModal();
  form.elements.title.focus({ preventScroll: true });
}

async function removeConcern(id) {
  const concern = state.concerns.find((item) => item.id === id);
  if (!concern) return;
  if (!await confirmConsequence({ title: 'Delete this conversation to return to?', consequence: `“${concern.title}” will be removed. The event history keeps a deletion tombstone, so the change stays attributable.`, confirmLabel: 'Delete conversation', destructive: true })) return;
  if (isCloudJourney()) {
    try {
      await api.mutate(`/journeys/${activeTrip(state).id}/concerns/${id}`, 'DELETE', { version: concern.version });
      await refreshCloudState();
      renderEventManager();
      showToast('Concern deleted; the event tombstone remains.');
    } catch (error) {
      showStatus(accountMessage(error));
    }
    return;
  }
  state.concerns = state.concerns.filter((item) => item.id !== id);
  eventRecord({ action: 'concern_deleted', entityType: 'concern', entityId: concern.id, summary: `Deleted concern: ${concern.title}`, before: concern, after: null });
  saveWorkingState();
  render();
  renderEventManager();
  showToast('Concern deleted; tombstone retained in event history.');
}

function confirmRemove(id) {
  removeId = id;
  removeSnapshot = structuredClone(state.entries.find((entry) => entry.id === id));
  $('#confirm-dialog').returnValue = '';
  $('#confirm-dialog').showModal();
}

function persistAndRender(message) {
  saveWorkingState();
  render();
  showToast(message);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function setButtonPending(button, pending, pendingLabel = 'Working…') {
  if (!button) return;
  if (pending) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = pendingLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.idleLabel || button.textContent;
    delete button.dataset.idleLabel;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

$$('[data-open-expense]').forEach((button) => button.addEventListener('click', () => openExpense()));
$$('[data-open-moment]').forEach((button) => button.addEventListener('click', () => {
  if (accountUser && !isCloudJourney()) { openJourney(); return; }
  openMoment();
}));
$('#add-manual-location').addEventListener('click', () => {
  const input = $('#manual-location');
  if (!input.value.trim()) { input.focus(); return; }
  addMomentLocation({ label: input.value });
  input.value = '';
  input.focus();
});
$('#manual-location').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); $('#add-manual-location').click(); }
});
$('#use-device-location').addEventListener('click', () => {
  if (!navigator.geolocation) { showToast('This browser cannot share a device location. You can still enter a place.'); return; }
  const button = $('#use-device-location');
  button.disabled = true;
  button.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      addMomentLocation({ label: `Device location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`, latitude, longitude, accuracyMeters: accuracy });
      button.disabled = false;
      button.textContent = 'Use my device location';
    },
    () => {
      button.disabled = false;
      button.textContent = 'Use my device location';
      showToast('Location was not shared. You can still enter a place in your own words.');
    },
    { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 },
  );
});
$$('[data-close-moment]').forEach((button) => button.addEventListener('click', () => $('#moment-dialog').close()));
$$('[data-close-image-viewer]').forEach((button) => button.addEventListener('click', () => $('#moment-image-viewer').close()));
$$('[data-close-journey]').forEach((button) => button.addEventListener('click', () => $('#journey-dialog').close()));

$('#journey-select').addEventListener('change', (event) => {
  state.activeTripId = event.target.value;
  filter = 'All';
  selectedDay = null;
  selectedCategory = null;
  guidanceIndex = 0;
  persistAndRender('Journey switched.');
  refreshBillingState().catch((error) => showStatus(accountMessage(error)));
});

$('#new-journey-button').addEventListener('click', () => openJourney());
$('#edit-journey-button').addEventListener('click', () => openJourney(activeTrip(state)));
$('#journey-form').elements.startDateStatus.addEventListener('change', () => syncJourneyDateFields());
$('#journey-form').elements.endDateStatus.addEventListener('change', () => syncJourneyDateFields());
$('#actor-select').addEventListener('change', (event) => {
  state.preferences.activeActorByTrip[activeTrip(state).id] = event.target.value;
  saveWorkingState();
  showToast(`New local events will be attributed to ${event.target.value}.`);
});
$('#event-manager-button').addEventListener('click', () => {
  renderEventManager();
  $('#event-dialog').showModal();
});
$('#history-guide-link').addEventListener('click', () => {
  const guide = $('#history-guide');
  guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
  guide.focus({ preventScroll: true });
});
$('#add-thread-button').addEventListener('click', () => openConcern());
$('#journey-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (accountUser) {
      const existing = state.trips.find((trip) => trip.id === input.id && cloudJourneyIds.has(trip.id));
      const payload = {
        name: input.name,
        location: input.location,
        startDateStatus: input.startDateStatus,
        endDateStatus: input.endDateStatus,
        startDate: input.startDateStatus === 'exact' ? input.startDate : null,
        endDate: input.endDateStatus === 'date' ? input.endDate : null,
        budgetCents: Math.round(Number(input.budget) * 100),
        ...(existing ? { version: existing.version } : {}),
      };
      const result = existing
        ? await api.mutate(`/journeys/${existing.id}`, 'PATCH', payload)
        : await api.mutate('/journeys', 'POST', payload);
      state.activeTripId = result.journey.id;
      $('#journey-dialog').close();
      await refreshCloudState();
      showToast(existing ? 'Journey changes synced.' : 'Private journey created. Invite your journeyer in Settings.');
      return;
    }
    const existingIndex = state.trips.findIndex((trip) => trip.id === input.id);
    const before = existingIndex >= 0 ? structuredClone(state.trips[existingIndex]) : null;
    const actorName = existingIndex >= 0 ? currentActor(state.trips[existingIndex]) : input.memberOne;
    const normalized = normalizeTrip(input);
    const trip = existingIndex >= 0 ? { ...normalized, milestones: before.milestones, archivedAt: before.archivedAt } : normalized;
    if (existingIndex >= 0) state.trips[existingIndex] = trip;
    else state.trips.push(trip);
    state.activeTripId = trip.id;
    state.preferences.activeActorByTrip[trip.id] = trip.members.includes(actorName) ? actorName : trip.members[0];
    eventRecord({ actorName, action: existingIndex >= 0 ? 'journey_updated' : 'journey_created', entityType: 'journey', entityId: trip.id, summary: existingIndex >= 0 ? `Updated journey details for ${trip.name}` : `Created the ${trip.name} journey`, before, after: trip });
    if (before) {
      before.members.forEach((oldName, memberIndex) => {
        const newName = trip.members[memberIndex];
        if (oldName === newName) return;
        state.entries.filter((entry) => entry.tripId === trip.id && entry.paidBy === oldName).forEach((entry) => {
          const entryBefore = structuredClone(entry);
          entry.paidBy = newName;
          eventRecord({ actorName, action: 'expense_updated', entityType: 'expense', entityId: entry.id, summary: `Updated payer name on expense: ${entry.merchant}`, before: entryBefore, after: entry });
        });
      });
    }
    guidanceIndex = 0;
    selectedDay = null;
    selectedCategory = null;
    $('#journey-dialog').close();
    persistAndRender(existingIndex >= 0 ? 'Journey details updated.' : 'New journey created in this browser.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#guidance-skip').addEventListener('click', () => {
  const prompts = conversationPrompts();
  guidanceIndex = Math.min(prompts.length - 1, guidanceIndex + 1);
  renderSharedJourney(activeTrip(state), activeMoments(state));
});
$('#guidance-prev').addEventListener('click', () => {
  guidanceIndex = Math.max(0, guidanceIndex - 1);
  renderSharedJourney(activeTrip(state), activeMoments(state));
});
function endGuidanceForToday(message) {
  localStorage.setItem('together-ledger-guidance-ended-on', localDayKey());
  $('#guidance').open = false;
  render();
  showToast(message);
}

$('#guidance-end').addEventListener('click', () => endGuidanceForToday('Check-in set aside for today.'));
$('#guidance-done').addEventListener('click', () => endGuidanceForToday('Check-in complete. It can rest until tomorrow.'));

$('#remove-moment-image-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const trip = activeTrip(state);
  const momentId = button.dataset.momentId;
  const imageId = button.dataset.imageId;
  if (!trip || !momentId || !imageId || !isCloudJourney(trip)) return;
  if (!await confirmConsequence({ title: 'Remove this photo?', consequence: 'This cannot be undone. Removing the photo does not cancel a paid image add-on.', confirmLabel: 'Remove photo', destructive: true })) return;
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Removing photo…';
  try {
    await api.deleteMomentImage(trip.id, momentId, imageId);
    $('#moment-dialog').close();
    await refreshCloudState();
    showToast('Photo removed from this moment.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

$('#moment-form').elements.image.addEventListener('change', (event) => prepareMomentPhoto(event.currentTarget));

$('#moment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const input = { ...Object.fromEntries(new FormData(form)), locations: structuredClone(momentLocations) };
    // The browser stops an empty name; a name of only spaces gets past it, so it is caught here,
    // in the form's own name for the field, and the person is taken back to it (#354).
    if (!String(input.title || '').trim()) {
      showStatus(MOMENT_NAME_MISSING, { source: 'moment' });
      form.elements.title.focus();
      return;
    }
    clearStatus('moment');
    const trip = activeTrip(state);
    const existingIndex = state.moments.findIndex((moment) => moment.id === input.id && moment.tripId === trip?.id);
    const before = existingIndex >= 0 ? structuredClone(state.moments[existingIndex]) : null;
    if (isCloudJourney(trip)) {
      const moneyCents = input.money === '' ? null : Math.round(Number(input.money) * 100);
      const payload = { kind: input.kind, kindLabel: input.kindLabel || '', title: input.title, detail: input.detail, occurredOn: input.occurredOn, visibility: input.visibility, theme: normalizeMomentTheme(input.theme), moneyCents, moneyCurrency: input.moneyCurrency || '', locations: input.locations, ...(before ? { version: before.version } : {}) };
      const result = before ? await api.mutate(`/journeys/${trip.id}/moments/${before.id}`, 'PATCH', payload) : await api.mutate(`/journeys/${trip.id}/moments`, 'POST', payload);
      const image = form.elements.image.files[0];
      if (image) await api.uploadMomentImage(trip.id, result.moment.id, preparedMomentPhoto?.source === image ? preparedMomentPhoto.photo : image, form.dataset.paidSlotId || '');
      $('#moment-dialog').close();
      await refreshCloudState();
      showToast(before ? 'Moment updated.' : input.visibility === 'shared-now' ? 'Moment shared.' : 'Moment held with you.');
      return;
    }
    const actorName = currentActor();
    const moment = normalizeMoment({ ...input, createdBy: actorName, updatedBy: actorName }, activeTrip(state).id, before);
    if (existingIndex >= 0) state.moments[existingIndex] = moment;
    else state.moments.push(moment);
    eventRecord({ action: existingIndex >= 0 ? 'moment_updated' : 'moment_added', entityType: 'moment', entityId: moment.id, summary: `${existingIndex >= 0 ? 'Updated' : 'Held'} ${momentLabel(moment.kind, moment.kindLabel).toLowerCase()}: ${moment.title}`, before, after: moment });
    if (before && before.theme !== moment.theme) eventRecord({ action: 'moment_theme_changed', entityType: 'moment', entityId: moment.id, summary: 'Changed moment theme', before: { theme: before.theme }, after: { theme: moment.theme } });
    $('#moment-dialog').close();
    persistAndRender(existingIndex >= 0 ? 'Moment updated.' : 'Moment held in this browser.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#toggle-moments-button').addEventListener('click', () => {
  momentsExpanded = !momentsExpanded;
  momentFilter = 'all';
  renderSharedJourney(activeTrip(state), activeMoments(state));
});
$('#buy-image-slot-button').addEventListener('click', async (event) => {
  const momentId = event.currentTarget.dataset.momentId;
  const trip = activeTrip(state);
  if (!momentId || !isCloudJourney(trip)) return;
  try {
    const session = await api.createImageCheckout(trip.id, momentId);
    window.location.assign(session.url);
  } catch (error) {
    showStatus(accountMessage(error));
  }
});
$('#buy-location-slot-button').addEventListener('click', async (event) => {
  const momentId = event.currentTarget.dataset.momentId;
  const trip = activeTrip(state);
  if (!momentId || !isCloudJourney(trip)) return;
  try {
    const session = await api.createLocationCheckout(trip.id, momentId);
    const checkout = new URL(session.url);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'checkout.stripe.com') throw new Error('Unexpected checkout destination.');
    window.location.assign(checkout.href);
  } catch (error) {
    showStatus(accountMessage(error));
  }
});
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$$('[data-close-settings]').forEach((button) => button.addEventListener('click', () => $('#settings-dialog').close()));
$('#sharing-create-journey-button').addEventListener('click', () => {
  $('#settings-dialog').close();
  openJourney();
});
function openAccountDialog() {
  renderAccountState();
  $('#account-dialog').showModal();
  if (accountUser) refreshBillingState().catch((error) => showStatus(accountMessage(error)));
  else offerSocialSignIn();
}

$('#account-button').addEventListener('click', openAccountDialog);
$$('[data-open-account]').forEach((button) => button.addEventListener('click', openAccountDialog));
$$('[data-begin-ledger]').forEach((button) => button.addEventListener('click', beginLedger));
$$('.welcome-menu a').forEach((link) => link.addEventListener('click', () => { link.closest('details').open = false; }));
$$('[data-close-account]').forEach((button) => button.addEventListener('click', () => $('#account-dialog').close()));

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  setButtonPending(button, true, 'Signing in…');
  try {
    accountUser = await api.login(Object.fromEntries(new FormData(event.currentTarget)));
    await refreshCloudState({ announce: true });
    refreshBillingState().catch((error) => showStatus(accountMessage(error)));
    showLedgerSurface({ persist: true });
    renderAccountState();
    $('#account-dialog').close();
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    setButtonPending(button, false);
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  setButtonPending(button, true, 'Creating account…');
  try {
    accountUser = await api.register(Object.fromEntries(new FormData(event.currentTarget)));
    await refreshCloudState();
    refreshBillingState().catch((error) => showStatus(accountMessage(error)));
    showLedgerSurface({ persist: true });
    renderAccountState();
    showToast(api.lastVerificationSent ? 'Account created. Check your email to verify it.' : 'Account created, but email is delayed. Use resend verification shortly.');
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    setButtonPending(button, false);
  }
});

// Continue with Google and Continue with Apple (#216). Neither button shows until the server says
// both are configured and both companies' own scripts have loaded: a button that can't work is
// worse than none. The scripts come only from Google's and Apple's own addresses, and only once a
// signed-out person opens this dialog, so neither company hears about a visit that never asks for
// them. The ID token goes to our server and nowhere else; the reply is a password sign-in's cookie
// and CSRF pair, and nothing is written to localStorage.
const PROVIDER_SCRIPTS = {
  google: 'https://accounts.google.com/gsi/client',
  apple: 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js',
};
// Google draws its button 40px high; styles.css scales it to the 44px the Apple button is.
const GOOGLE_BUTTON_SCALE = 1.1;
// Closing Apple's window, or choosing Cancel in it, puts the person back where they were.
const APPLE_CANCELLED = new Set(['popup_closed_by_user', 'user_cancelled_authorize']);
const providerScripts = new Map();
let socialSignInReady = null;
let appleState = '';
let googleButtonWidth = 0;
let pendingLink = null;

function loadProviderScript(src) {
  if (!providerScripts.has(src)) {
    providerScripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => {
        providerScripts.delete(src);
        script.remove();
        reject(new Error(`${src} did not load.`));
      }, { once: true });
      document.head.append(script);
    }));
  }
  return providerScripts.get(src);
}

async function prepareSocialSignIn() {
  const { google, apple } = await api.providers() || {};
  if (!google?.clientId || !apple?.clientId || !apple.redirectUri) return false;
  // Apple hands its answer back to the Return URL's own address, so anywhere else its button
  // could never finish.
  if (new URL(apple.redirectUri).origin !== window.location.origin) return false;
  await Promise.all([loadProviderScript(PROVIDER_SCRIPTS.google), loadProviderScript(PROVIDER_SCRIPTS.apple)]);
  if (!window.google?.accounts?.id || !window.AppleID?.auth) return false;
  window.google.accounts.id.initialize({
    client_id: google.clientId,
    callback: ({ credential }) => signInWith(() => api.socialSignIn('google', { idToken: credential }), (error) => askForLinkPassword('google', { idToken: credential }, error)),
    ux_mode: 'popup',
    auto_select: false,
  });
  appleState = crypto.randomUUID();
  window.AppleID.auth.init({ clientId: apple.clientId, scope: 'name email', redirectURI: apple.redirectUri, state: appleState, usePopup: true });
  new ResizeObserver(() => renderGoogleButton()).observe($('.google-slot'));
  return true;
}

function offerSocialSignIn() {
  if (accountUser || !api.accountsAvailable) return;
  socialSignInReady ??= prepareSocialSignIn().catch(() => false);
  socialSignInReady.then((ready) => {
    // Not ready is asked again the next time the dialog opens; ready stays ready.
    if (!ready) {
      socialSignInReady = null;
      return;
    }
    $('#social-sign-in').hidden = false;
    renderGoogleButton();
  });
}

// Google takes a width, not a height, so it is asked for the width that fills the slot once scaled.
function renderGoogleButton() {
  const slot = $('.google-slot');
  if (!slot.clientWidth || $('#social-sign-in').hidden) return;
  const width = Math.min(400, Math.max(200, Math.floor(slot.clientWidth / GOOGLE_BUTTON_SCALE)));
  if (width === googleButtonWidth) return;
  googleButtonWidth = width;
  window.google.accounts.id.renderButton($('#google-sign-in-button'), {
    type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'center', width,
  });
}

async function signInWith(signIn, onRefused = () => {}) {
  try {
    accountUser = await signIn();
    forgetPendingLink();
    await refreshCloudState({ announce: true });
    refreshBillingState().catch((error) => showStatus(accountMessage(error)));
    showLedgerSurface({ persist: true });
    renderAccountState();
    $('#account-dialog').close();
  } catch (error) {
    onRefused(error);
    showStatus(accountMessage(error));
  }
}

// An email that already has a password account is never signed in or merged because the
// addresses match (#214). The server says so in its own words, and the password is asked for
// once, here; the sign-in it answers is held in memory only until then.
function askForLinkPassword(provider, body, error) {
  if (!(error instanceof ApiError) || error.code !== 'link_required') return;
  pendingLink = { provider, ...body };
  const form = $('#link-identity-form');
  form.reset();
  $('#link-identity-title').textContent = provider === 'apple' ? 'Connect Apple to your account' : 'Connect Google to your account';
  $('#link-identity-email').textContent = error.details?.email || 'this email';
  form.hidden = false;
  form.elements.password.focus({ preventScroll: true });
}

function forgetPendingLink() {
  pendingLink = null;
  $('#link-identity-form').reset();
  $('#link-identity-form').hidden = true;
}

$('#apple-sign-in-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  let answer;
  try {
    answer = await window.AppleID.auth.signIn();
  } catch (error) {
    if (!APPLE_CANCELLED.has(error?.error)) showStatus(accountMessage(error));
    return;
  }
  const { authorization = {}, user } = answer || {};
  if (authorization.state !== appleState) {
    showStatus(accountMessage(null));
    return;
  }
  // Apple sends the person's name on their first sign-in only.
  const displayName = [user?.name?.firstName, user?.name?.lastName].filter(Boolean).join(' ');
  const body = { idToken: authorization.id_token, authorizationCode: authorization.code };
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  await signInWith(() => api.socialSignIn('apple', displayName ? { ...body, displayName } : body), (error) => askForLinkPassword('apple', body, error));
  button.disabled = false;
  button.removeAttribute('aria-busy');
});

$('#link-identity-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingLink) return;
  const button = event.currentTarget.querySelector('button:not([type])');
  const { password } = Object.fromEntries(new FormData(event.currentTarget));
  setButtonPending(button, true, 'Connecting…');
  await signInWith(() => api.linkIdentity({ ...pendingLink, password }), (error) => {
    // A wrong password can be tried again. A sign-in that has run out, or that belongs to
    // another account, has to start again from its button.
    if (error instanceof ApiError && ['invalid_token', 'identity_in_use'].includes(error.code)) forgetPendingLink();
  });
  setButtonPending(button, false);
});

$('#link-identity-cancel').addEventListener('click', () => {
  forgetPendingLink();
  clearStatus();
});
$('#account-dialog').addEventListener('close', forgetPendingLink);

$('#recovery-button').addEventListener('click', () => {
  $('#account-dialog').close();
  $('#recovery-request-form').reset();
  $('#recovery-request-dialog').showModal();
  $('#recovery-request-form').elements.email.focus({ preventScroll: true });
});
$$('[data-close-recovery-request]').forEach((button) => button.addEventListener('click', () => $('#recovery-request-dialog').close()));
$('#recovery-request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  // Recovery sends mail, so it is the slowest thing in the dialog and the one reached by
  // someone already locked out. It should say it is working, as every other form does.
  const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  setButtonPending(button, true, 'Sending…');
  try {
    await api.request('/recovery/request', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
    $('#recovery-request-dialog').close();
    showToast('If that account exists, a recovery link is on its way.');
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    setButtonPending(button, false);
  }
});
$$('[data-close-recovery-confirm]').forEach((button) => button.addEventListener('click', () => $('#recovery-confirm-dialog').close()));
$('#recovery-confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  // A mismatch has to be fixed by retyping, which takes longer than a toast lasts. It stays.
  if (input.password !== input.confirmPassword) {
    showStatus('The new passwords do not match.');
    return;
  }
  const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  setButtonPending(button, true, 'Changing…');
  try {
    clearStatus();
    await api.request('/recovery/confirm', { method: 'POST', body: { token: input.token, password: input.password } });
    accountUser = null;
    billingState = null;
    cloudJourneyIds = new Set();
    state = loadState();
    $('#recovery-confirm-dialog').close();
    render();
    showToast('Password changed. Sign in again on every device.');
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    setButtonPending(button, false);
  }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api.logout(); } catch (error) { showStatus(accountMessage(error)); return; }
  accountUser = null;
  billingState = null;
  cloudJourneyIds = new Set();
  state = loadState();
  $('#account-dialog').close();
  render();
  if (state.preferences.onboardingComplete) showLedgerSurface();
  else showWelcomeSurface();
  showToast('Signed out.');
});

$('#refresh-sync-button').addEventListener('click', async () => {
  try {
    await refreshCloudState({ announce: true });
    refreshBillingState().catch((error) => showStatus(accountMessage(error)));
  } catch (error) { showStatus(accountMessage(error)); }
});

$('#grace-request-button').addEventListener('click', requestMoreGrace);
$('#billing-capacity-range').addEventListener('input', syncCapacityFromRange);
$('#billing-capacity-number').addEventListener('input', previewCapacityFromNumber);
$('#billing-capacity-number').addEventListener('change', normalizeCapacityNumber);

$('#billing-offers').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-billing-offer]');
  if (!button) return;
  setButtonPending(button, true, 'Opening secure checkout…');
  try {
    const journey = activeTrip(state);
    if (!isCloudJourney(journey) || journey.role !== 'owner') throw new Error('Only a hosted journey owner can add another person.');
    const result = await api.mutate(`/journeys/${journey.id}/billing/checkout-sessions`, 'POST', {
      offerId: button.dataset.billingOffer,
      paidCapacity: capacityQuantity(),
      requestId: crypto.randomUUID(),
    });
    const checkout = new URL(result.url);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'checkout.stripe.com') throw new Error('Unexpected checkout destination.');
    window.location.assign(checkout.href);
  } catch (error) {
    showStatus(accountMessage(error));
    setButtonPending(button, false);
  }
});

$('#billing-portal-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonPending(button, true, 'Opening secure billing…');
  try {
    const journey = activeTrip(state);
    if (!isCloudJourney(journey) || journey.role !== 'owner') throw new Error('Only a hosted journey owner can manage this billing relationship.');
    const result = await api.mutate(`/journeys/${journey.id}/billing/portal-sessions`, 'POST', {});
    const portal = new URL(result.url);
    if (portal.protocol !== 'https:' || portal.hostname !== 'billing.stripe.com') throw new Error('Unexpected billing destination.');
    window.location.assign(portal.href);
  } catch (error) {
    showStatus(accountMessage(error));
    setButtonPending(button, false);
  }
});

$('#resend-verification-button').addEventListener('click', async () => {
  try {
    const result = await api.mutate('/auth/resend-verification', 'POST', {});
    showToast(result.delivered ? 'A new verification link is on its way.' : 'Email delivery is still unavailable. Please try again later.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
});

$('#display-name-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const { displayName } = Object.fromEntries(new FormData(form));
  try {
    const { user } = await api.mutate('/account', 'PATCH', { displayName });
    accountUser = user;
    form.querySelector('[name=displayName]').blur();
    renderAccountState();
    if (isCloudJourney()) await refreshCloudState();
    showToast('Name saved. Your journeyers see it now.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
});

$('#delete-account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  if (!await confirmConsequence({ title: 'Permanently delete this account?', consequence: 'This follows the journey ownership rules shown here and cannot be undone.', confirmLabel: 'Permanently delete account', destructive: true })) return;
  try {
    await api.mutate('/account', 'DELETE', input);
    accountUser = null;
    billingState = null;
    cloudJourneyIds = new Set();
    state = loadState();
    $('#account-dialog').close();
    render();
    showToast('Account deleted and sessions revoked.');
  } catch (error) {
    showStatus(accountMessage(error));
  }
});

$('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  setButtonPending(button, true, 'Proposing…');
  try {
    const result = await api.mutate(`/journeys/${activeTrip(state).id}/invitations`, 'POST', Object.fromEntries(new FormData(form)));
    form.reset();
    // A journey of one has nobody to ask, so the invitation goes out there and then. Everywhere
    // else this has only asked a question, and saying "sent" would not be true.
    showToast(result?.invitationSent
      ? 'Invitation sent. The journeyer must use their own verified account.'
      : 'Proposed. Nothing is sent to them until every journeyer agrees.');
    await refreshCloudState();
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    setButtonPending(button, false);
  }
});

$('#member-list').addEventListener('click', async (event) => {
  const transferButton = event.target.closest('[data-transfer-owner]');
  const removeButton = event.target.closest('[data-remove-member]');
  const button = transferButton || removeButton;
  if (!button) return;
  const memberName = button.dataset.memberName || 'this person';
  try {
    if (transferButton) {
      if (!await confirmConsequence({ title: `Make ${memberName} the journey owner?`, consequence: 'You will remain here as a journeyer. Ownership moves to them.', confirmLabel: 'Transfer ownership' })) return;
      await api.mutate(`/journeys/${activeTrip(state).id}/ownership`, 'POST', { userId: button.dataset.transferOwner });
      showToast(`${memberName} is now the journey owner.`);
    } else {
      if (!await confirmConsequence({ title: `Remove ${memberName} from this journey?`, consequence: 'Their private moments will be removed. Already shared history remains.', confirmLabel: 'Remove journeyer', destructive: true })) return;
      await api.mutate(`/journeys/${activeTrip(state).id}/members/${button.dataset.removeMember}`, 'DELETE', {});
      showToast(`${memberName} was removed from this journey.`);
    }
    await refreshCloudState();
  } catch (error) {
    showStatus(accountMessage(error));
  }
});

async function onProposalClick(event) {
  const agreeButton = event.target.closest('[data-agree-proposal]');
  const declineButton = event.target.closest('[data-decline-proposal]');
  const withdrawButton = event.target.closest('[data-withdraw-proposal]');
  const button = agreeButton || declineButton || withdrawButton;
  if (!button) return;
  const proposalId = agreeButton ? button.dataset.agreeProposal : declineButton ? button.dataset.declineProposal : button.dataset.withdrawProposal;
  const proposal = (activeTrip(state).inviteProposalRecords || []).find((entry) => entry.id === proposalId);
  if (!proposal) return;
  if (withdrawButton) {
    if (!await confirmConsequence({
      title: `Withdraw the proposal to add ${proposal.email}?`,
      consequence: 'The question is taken back, and nothing is sent to them. Nobody is recorded as having refused, and this person can be proposed again later.',
      confirmLabel: 'Withdraw the proposal',
    })) return;
    try {
      await api.mutate(`/journeys/${activeTrip(state).id}/invite-proposals/${proposalId}`, 'DELETE', {});
      showToast('Withdrawn. Nothing was sent, and nobody was added.');
      await refreshCloudState();
    } catch (error) {
      showStatus(accountMessage(error));
    }
    return;
  }
  const agreeing = Boolean(agreeButton);
  const consequence = agreeing
    ? { title: `Agree to add ${proposal.email}?`, consequence: 'Once every journeyer has agreed and they join, they can read every moment this journey has shared, including moments shared long before they arrived. Moments you kept private stay private.', confirmLabel: 'Agree to add them' }
    : { title: `Decline adding ${proposal.email}?`, consequence: 'This settles it for everybody straight away, and nothing is ever sent to them. Your name and the time are kept with the decision, where the other journeyers can see them.', confirmLabel: 'Decline', destructive: true };
  if (!await confirmConsequence(consequence)) return;
  try {
    const result = await api.mutate(`/journeys/${activeTrip(state).id}/invite-proposals/${proposalId}/decision`, 'POST', { decision: agreeing ? 'agree' : 'decline' });
    if (result?.invitationSent) showToast('Everyone agreed. The invitation is on its way to them.');
    else if (agreeing) showToast('Your agreement is recorded. Nothing is sent until everyone has answered.');
    else showToast('Recorded. Nobody was added, and nothing was sent to them.');
    await refreshCloudState();
  } catch (error) {
    showStatus(accountMessage(error));
  }
}

$('#invite-proposal-list')?.addEventListener('click', onProposalClick);

// Withdrawing frees the place at once; sending again is one tap, because everyone has already
// agreed and that agreement still holds (#347).
async function onInvitationClick(event) {
  const withdrawButton = event.target.closest('[data-withdraw-invitation]');
  const againButton = event.target.closest('[data-send-invitation-again]');
  const button = withdrawButton || againButton;
  if (!button) return;
  const invitationId = withdrawButton ? button.dataset.withdrawInvitation : button.dataset.sendInvitationAgain;
  const invitation = (activeTrip(state).invitationRecords || []).find((entry) => entry.id === invitationId);
  if (!invitation) return;
  try {
    if (withdrawButton) {
      if (!await confirmConsequence({
        title: `Withdraw the invitation to ${invitation.email}?`,
        consequence: 'Their link stops working, and the place it held is free again straight away. The journey’s history keeps a record that it was withdrawn.',
        confirmLabel: 'Withdraw the invitation',
      })) return;
      await api.mutate(`/journeys/${activeTrip(state).id}/invitations/${invitationId}`, 'DELETE', {});
      showToast('Withdrawn. The link no longer works, and the place is free again.');
    } else {
      setButtonPending(button, true, 'Sending…');
      await api.mutate(`/journeys/${activeTrip(state).id}/invitations/${invitationId}/send-again`, 'POST', {});
      showToast('Sent again. Everyone had already agreed, so nobody was asked again.');
    }
    await refreshCloudState();
  } catch (error) {
    if (againButton) setButtonPending(button, false);
    showStatus(accountMessage(error));
  }
}

$('#reserved-place-list')?.addEventListener('click', onInvitationClick);
$('#invitation-list')?.addEventListener('click', onInvitationClick);

$('#expense-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const trip = activeTrip(state);
    if (isCloudJourney(trip)) {
      const existing = state.entries.find((entry) => entry.id === input.id);
      const payer = trip.memberRecords.find((member) => member.displayName === input.paidBy);
      const payload = {
        merchant: input.merchant,
        category: input.category,
        amountCents: Math.round(Number(input.amount) * 100),
        occurredOn: input.occurredOn,
        paidByUserId: payer?.id || null,
        payerLabel: input.paidBy,
        account: input.account,
        status: input.status,
        reference: input.reference,
        notes: input.notes,
        ...(existing ? { version: existing.version } : {}),
      };
      if (existing) await api.mutate(`/journeys/${trip.id}/expenses/${existing.id}`, 'PATCH', payload);
      else await api.mutate(`/journeys/${trip.id}/expenses`, 'POST', payload);
      $('#expense-dialog').close();
      await refreshCloudState();
      showToast(existing ? 'Expense changes synced.' : 'Expense securely synced.');
      return;
    }
    const entry = normalizeEntry(input, activeTrip(state).id);
    const index = state.entries.findIndex((item) => item.id === entry.id);
    const before = index >= 0 ? structuredClone(state.entries[index]) : null;
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
    eventRecord({ action: index >= 0 ? 'expense_updated' : 'expense_added', entityType: 'expense', entityId: entry.id, summary: `${index >= 0 ? 'Edited' : 'Added'} expense: ${entry.merchant}`, before, after: entry });
    $('#expense-dialog').close();
    persistAndRender(index >= 0 ? 'Expense updated.' : 'Expense added to the shared picture.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#confirm-dialog').addEventListener('close', async () => {
  if ($('#confirm-dialog').returnValue === 'confirm' && removeId) {
    if (isCloudJourney()) {
      try {
        await api.mutate(`/journeys/${activeTrip(state).id}/expenses/${removeId}`, 'DELETE', { version: removeSnapshot.version });
        await refreshCloudState();
        showToast('Expense deleted; the event tombstone remains.');
      } catch (error) {
        showStatus(accountMessage(error));
      }
      removeId = null;
      removeSnapshot = null;
      return;
    }
    state.entries = state.entries.filter((entry) => entry.id !== removeId);
    eventRecord({ action: 'expense_deleted', entityType: 'expense', entityId: removeId, summary: `Deleted expense: ${removeSnapshot?.merchant || removeId}`, before: removeSnapshot, after: null });
    persistAndRender('Expense removed.');
  }
  removeId = null;
  removeSnapshot = null;
});

$('#add-concern-button').addEventListener('click', () => openConcern());
$$('[data-close-concern]').forEach((button) => button.addEventListener('click', () => $('#concern-dialog').close()));
$('#concern-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (isCloudJourney()) {
      const existing = state.concerns.find((concern) => concern.id === input.id);
      const payload = { title: input.title, detail: input.detail, status: input.status, ...(existing ? { version: existing.version } : {}) };
      if (existing) await api.mutate(`/journeys/${activeTrip(state).id}/concerns/${existing.id}`, 'PATCH', payload);
      else await api.mutate(`/journeys/${activeTrip(state).id}/concerns`, 'POST', payload);
      $('#concern-dialog').close();
      await refreshCloudState();
      renderEventManager();
      showToast(existing ? 'Concern changes synced.' : 'Concern securely synced.');
      return;
    }
    const index = state.concerns.findIndex((concern) => concern.id === input.id);
    const before = index >= 0 ? structuredClone(state.concerns[index]) : null;
    const concern = normalizeConcern(input, activeTrip(state).id, currentActor(), before);
    if (index >= 0) state.concerns[index] = concern;
    else state.concerns.push(concern);
    eventRecord({ action: index >= 0 ? 'concern_updated' : 'concern_added', entityType: 'concern', entityId: concern.id, summary: `${index >= 0 ? 'Edited' : 'Logged'} concern: ${concern.title}`, before, after: concern });
    $('#concern-dialog').close();
    saveWorkingState();
    render();
    renderEventManager();
    showToast(index >= 0 ? 'Concern updated.' : 'Concern logged in this browser.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#export-button').addEventListener('click', () => {
  const blob = new Blob([exportState(state)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `together-ledger-${localDay()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Private backup downloaded.');
});

$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state = importState(await file.text());
    state.preferences.onboardingComplete = true;
    saveWorkingState();
    selectedDay = null;
    selectedCategory = null;
    render();
    showLedgerSurface();
    showToast('Ledger imported on this browser.');
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = '';
  }
});

$('#reset-button').addEventListener('click', async () => {
  if (!await confirmConsequence({ title: 'Clear this browser’s ledger?', consequence: 'This browser begins again with an empty shared space. Export first if you need a backup.', confirmLabel: 'Clear ledger', destructive: true })) return;
  state = resetState();
  selectedDay = null;
  selectedCategory = null;
  render();
  showWelcomeSurface();
  showToast('This browser has a fresh shared space.');
});

initializeDialogBranding();
initializeThemePicker();
render();
if (state.preferences.onboardingComplete) showLedgerSurface();
else showWelcomeSurface();

async function initializeAccount() {
  const params = new URLSearchParams(window.location.search);
  try {
    if (params.has('verify')) {
      await api.request('/auth/verify-email', { method: 'POST', body: { token: params.get('verify') } });
      showToast('Email verified. You can now accept invitations.');
    }
    if (params.has('recovery')) {
      $('#recovery-confirm-form').elements.token.value = params.get('recovery');
      $('#recovery-confirm-dialog').showModal();
      $('#recovery-confirm-form').elements.password.focus({ preventScroll: true });
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
      renderAccountState();
      return;
    }
    try { accountUser = await api.session(); } catch (error) {
      if (![401, 404].includes(error.status)) throw error;
    }
    if (accountUser) {
      await refreshCloudState();
      refreshBillingState().catch((error) => showStatus(accountMessage(error)));
      showLedgerSurface({ persist: true });
      if (params.has('invite')) {
        await api.acceptInvitation(params.get('invite'));
        await refreshCloudState({ announce: true });
      }
    } else if (params.has('invite')) {
      $('#account-dialog').showModal();
      showToast('Sign in with the invited email, then reopen the invitation link.');
    }
    if (params.get('billing') === 'success') {
      showToast(accountUser ? 'Payment received. Paid capacity will appear after Stripe confirms it.' : 'Payment received. Sign in to see the journey’s paid capacity.');
    } else if (params.get('billing') === 'canceled') {
      showToast('Checkout closed without changing this journey’s paid capacity.');
    } else if (params.get('billing') === 'portal') {
      showToast('Billing settings closed. Stripe updates may take a moment to appear.');
    }
  } catch (error) {
    showStatus(accountMessage(error));
  } finally {
    if ([...params.keys()].some((key) => ['verify', 'recovery', 'invite', 'billing', 'session_id'].includes(key))) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
    }
    renderAccountState();
  }
}

initializeAccount();

document.querySelector('#status-banner-dismiss')?.addEventListener('click', () => clearStatus());

// A problem belonging to a dialog leaves with it, and the region goes back above the work so
// the next page-level problem is not stranded inside something that is closed.
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', () => {
  const banner = document.querySelector('#status-banner');
  if (!banner || !dialog.contains(banner)) return;
  banner.hidden = true;
  statusBannerSource = '';
  statusHomeParent?.insertBefore(banner, statusHomeNext);
}));

// Being offline is a condition, not a failure. It is stated plainly, and it clears itself
// when the connection returns rather than leaving a stale warning on the page.
function reportConnection() {
  if (navigator.onLine) clearStatus('connection');
  else showStatus('You are offline. This journey is still here, and anything needing the account service will wait until you reconnect.', { tone: 'caution', source: 'connection' });
}
window.addEventListener('online', reportConnection);
window.addEventListener('offline', reportConnection);
if (!navigator.onLine) reportConnection();

// A minute is the smallest unit either countdown shows, so it is also how often they are redrawn.
// Nothing is fetched to do it: the deadline is already on the page, and only the reading changes.
window.setInterval(refreshCountdowns, 60000);
