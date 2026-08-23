import {
  activeEntries,
  activeMoments,
  activeTrip,
  appendJourneyEvent,
  CATEGORIES,
  CATEGORY_ICONS,
  conversationPrompts,
  CURRENT_SCHEMA_VERSION,
  dateLabel,
  dateRange,
  groupDayByCategory,
  money,
  MOMENT_TYPES,
  normalizeConcern,
  normalizeEntry,
  normalizeMoment,
  normalizeTrip,
  summarize,
} from './model.js';
import { exportState, importState, loadState, resetState, saveState } from './store.js';
import { ApiError, TogetherApi } from './api.js';

let state = loadState();
const api = new TogetherApi();
let accountUser = null;
let cloudJourneyIds = new Set();
let filter = 'All';
let selectedDay = null;
let selectedCategory = null;
let removeId = null;
let removeSnapshot = null;
let guidanceIndex = 0;
let onboardingIndex = 0;
let momentFilter = 'all';
let momentsExpanded = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function saveWorkingState() {
  if (!accountUser) saveState(state);
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
    trips.push({ ...snapshot.journey, members: snapshot.members.map((member) => member.displayName), memberRecords: snapshot.members, invitationRecords: snapshot.invitations || [], createdByUserId, createdByDisplayName, createdAt: creationEvent?.createdAt || snapshot.journey.createdAt, milestones, archivedAt: '' });
    entries.push(...snapshot.expenses.map((expense) => ({ ...expense, tripId: expense.journeyId, paidBy: expense.payerLabel })));
    moments.push(...snapshot.moments.map((moment) => ({ ...moment, tripId: moment.journeyId })));
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

function renderAccountState() {
  const signedIn = Boolean(accountUser);
  const accountsAvailable = api.accountsAvailable;
  $('#account-unavailable').hidden = signedIn || accountsAvailable;
  $('#signed-out-account').hidden = signedIn || !accountsAvailable;
  $('#signed-in-account').hidden = !signedIn;
  $('#account-button').textContent = signedIn ? 'Account settings' : accountsAvailable ? 'Sign in' : 'Accounts soon';
  $('#account-dialog-copy').textContent = accountsAvailable ? 'Passwords are never shared between journeyers.' : 'The private account service is not live on this public page yet.';
  $('#account-name').textContent = signedIn ? accountUser.displayName : '';
  $('#account-username').textContent = signedIn ? `@${accountUser.username}` : '';
  $('#account-email').textContent = signedIn ? accountUser.email : '';
  $('#verification-status').textContent = signedIn ? (accountUser.emailVerified ? 'Email verified' : 'Email verification is still required before accepting an invitation.') : '';
  $('#resend-verification-button').hidden = !signedIn || accountUser.emailVerified;
  $('#account-sync-copy').textContent = isCloudJourney() ? 'Private journey sync is active. Shared moments, threads, and practical context are recorded by the account service.' : 'Your account is ready. Create a private journey when you are ready to invite another journeyer.';
  $('#settings-storage-copy').textContent = isCloudJourney() ? 'This signed-in journey is loaded from the private service. Sign out to return to your browser-only journey.' : 'Browser-only journeys stay on this device unless you download a backup.';
  $('#sync-badge').textContent = isCloudJourney() ? 'Private sync' : signedIn ? 'Account ready' : accountsAvailable ? 'Browser only' : 'Accounts soon';
  $('#sync-badge').classList.toggle('cloud', signedIn);
  $('#actor-control').hidden = isCloudJourney();
  const sharing = isCloudJourney();
  const needsPrivateJourney = signedIn && !sharing;
  $('#invite-form').hidden = !sharing || activeTrip(state).members.length >= 2 || activeTrip(state).role !== 'owner';
  $('#sharing-create-journey-button').hidden = !needsPrivateJourney;
  $('#sharing-copy').textContent = sharing
    ? `${activeTrip(state).members.length} of 2 journey seats are active. Each journeyer signs in separately.`
    : needsPrivateJourney
      ? 'Your account is ready. Create a private journey to invite another journeyer.'
      : 'Sign in and create a private journey to invite another journeyer.';
  $('#journey-record').hidden = !sharing;
  if (sharing) {
    const trip = activeTrip(state);
    const members = trip.memberRecords || [];
    const createdByCurrentUser = trip.createdByUserId === accountUser.id;
    const creatorRow = `<div class="journey-record-row"><div><strong>Created by ${escapeHtml(trip.createdByDisplayName)}</strong><small>Created <time datetime="${escapeHtml(trip.createdAt)}">${escapeHtml(dateTimeLabel(trip.createdAt))}</time></small></div><span class="journey-role">Creator${createdByCurrentUser ? ' · You' : ''}</span></div>`;
    const joinedRows = members.filter((member) => member.id !== trip.createdByUserId).map((member) => `<div class="journey-record-row"><div><strong>${escapeHtml(member.displayName)} joined the journey</strong><small>Joined <time datetime="${escapeHtml(member.joinedAt)}">${escapeHtml(dateTimeLabel(member.joinedAt))}</time></small></div><span class="journey-role">${member.role === 'owner' ? 'Owner' : 'Journeyer'}${member.id === accountUser.id ? ' · You' : ''}</span></div>`).join('');
    $('#member-list').innerHTML = creatorRow + joinedRows;
    const invitations = trip.invitationRecords || [];
    $('#invitation-history').hidden = !invitations.length;
    $('#invitation-list').innerHTML = invitations.map((invitation) => `<div class="journey-record-row"><div><strong>Invitation sent to ${escapeHtml(invitation.email)}</strong><small>Sent by ${escapeHtml(invitation.invitedByDisplayName)} · <time datetime="${escapeHtml(invitation.sentAt)}">${escapeHtml(dateTimeLabel(invitation.sentAt))}</time></small></div><span class="invitation-status ${escapeHtml(invitation.status)}">${escapeHtml(invitationStatusLabel(invitation.status))}</span></div>`).join('');
  } else {
    $('#member-list').innerHTML = '';
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

function invitationStatusLabel(status) {
  return ({ accepted: 'Accepted', expired: 'Expired', pending: 'Pending', revoked: 'Revoked' })[status] || 'Recorded';
}

function initializeThemePicker() {
  const selects = [$('#theme-select'), $('#settings-theme-select')].filter(Boolean);
  const themes = window.TOGETHER_THEMES || [];
  selects.forEach((select) => {
    select.innerHTML = themes.map((theme) => `<option value="${theme.id}">${theme.icon} ${theme.label}</option>`).join('');
    select.value = document.documentElement.dataset.theme || 'light';
    select.addEventListener('change', () => {
      const id = window.applyTogetherTheme(select.value);
      localStorage.setItem('theme', id);
      selects.forEach((item) => { item.value = id; });
      showToast(`${themes.find((theme) => theme.id === id)?.label || 'Theme'} applied.`);
    });
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

function renderJourneyControls(trip) {
  $('#journey-select').innerHTML = state.trips.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  $('#journey-select').value = trip.id;
  const actor = currentActor(trip);
  $('#actor-select').innerHTML = trip.members.map((member) => `<option>${escapeHtml(member)}</option>`).join('');
  $('#actor-select').value = actor;
  $('#event-count').textContent = `(${state.events.filter((event) => event.tripId === trip.id).length})`;
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
  $('#toggle-moments-button').hidden = !recent.length;
  $('#toggle-moments-button').textContent = momentsExpanded ? 'Show recent' : `See all ${recent.length} moments`;
  const visible = (momentsExpanded ? recent.filter((moment) => momentFilter === 'all' || moment.kind === momentFilter) : recent.slice(0, 3));
  $('#moment-timeline').innerHTML = visible.length ? visible.map((moment) => {
    const attribution = `<span>Held by ${escapeHtml(moment.createdBy || 'Journey member')}</span>${moment.shapedByBoth ? '<span class="moment-collaboration-badge">Shaped by both journeyers</span>' : ''}`;
    return `<article class="moment-card ${moment.visibility}"><div class="moment-meta"><span class="moment-kind">${escapeHtml(momentLabel(moment.kind, moment.kindLabel))}</span><span>${dateLabel(moment.occurredOn)}</span><span class="visibility-chip ${moment.visibility}">${escapeHtml(moment.visibility.replaceAll('-', ' '))}</span></div><strong>${escapeHtml(moment.title)}</strong>${moment.detail ? `<p>${escapeHtml(moment.detail)}</p>` : ''}${moment.moneyCents != null ? `<details class="money-context"><summary>Practical money context</summary><p>${money(moment.moneyCents, moment.moneyCurrency)} is held here as context, not a score.</p></details>` : ''}<div class="moment-actions"><small class="moment-author">${attribution}</small><button data-edit-moment="${escapeHtml(moment.id)}">Edit</button></div></article>`;
  }).join('') : isEmptyStart ? `<div class="log-types"><p>There are no examples here—only possibilities:</p><div>${MOMENT_TYPES.filter(([value]) => value !== 'other').map(([, label]) => `<span>${escapeHtml(label)}</span>`).join('')}<button type="button" data-open-custom-moment>＋ Add your own moment</button></div></div>` : '<p class="empty">No moments in this view yet. A small truth is enough to begin.</p>';
  $$('[data-edit-moment]').forEach((button) => button.addEventListener('click', () => openMoment(button.dataset.editMoment)));
  $$('[data-open-custom-moment]').forEach((button) => button.addEventListener('click', () => {
    if (accountUser && !isCloudJourney(trip)) { openJourney(); return; }
    openMoment('', 'other');
  }));
  $('#open-threads').innerHTML = threads.length ? threads.map((thread) => `<article class="thread-row"><div><span class="status-chip open">open</span><strong>${escapeHtml(thread.title)}</strong>${thread.detail ? `<p>${escapeHtml(thread.detail)}</p>` : ''}</div><button data-edit-thread="${escapeHtml(thread.id)}">Open</button></article>`).join('') : '<p class="empty compact">No open threads. That can be a good place to rest.</p>';
  $$('[data-edit-thread]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editThread)));
}

function updateMomentKindField(form) {
  const custom = form.elements.kind.value === 'other';
  $('#moment-kind-label-field').hidden = !custom;
  form.elements.kindLabel.required = custom;
  form.elements.kindLabel.disabled = !custom;
}

function openMoment(id = '', initialKind = '') {
  const form = $('#moment-form');
  const moment = state.moments.find((item) => item.id === id);
  const shared = isCloudJourney();
  form.reset();
  form.elements.kind.innerHTML = MOMENT_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  form.elements.occurredOn.value = new Date().toISOString().slice(0, 10);
  form.elements.visibility.value = 'shared-now';
  $('#moment-dialog-title').textContent = moment ? 'Edit this moment' : 'Hold a moment';
  $('#save-moment').textContent = moment ? 'Save moment' : 'Hold this moment';
  $('#moment-dialog-copy').textContent = shared ? 'This is a shared moment. Both journeyers can see it and return to it with care.' : 'Choose visibility with care. In browser-only mode, it is a local cue, not separate-account privacy.';
  $('#moment-visibility-field').hidden = shared;
  $$('input[name="visibility"]', form).forEach((input) => { input.disabled = shared; });
  if (moment) {
    form.elements.id.value = moment.id; form.elements.kind.value = moment.kind; form.elements.kindLabel.value = moment.kindLabel || ''; form.elements.title.value = moment.title; form.elements.detail.value = moment.detail; form.elements.occurredOn.value = moment.occurredOn; form.elements.visibility.value = moment.visibility; form.elements.money.value = moment.moneyCents == null ? '' : (moment.moneyCents / 100).toFixed(2); form.elements.moneyCurrency.value = moment.moneyCurrency || '';
  } else if (initialKind) {
    form.elements.kind.value = initialKind;
  }
  form.elements.kind.onchange = () => updateMomentKindField(form);
  updateMomentKindField(form);
  $('#moment-dialog').showModal(); form.elements.title.focus({ preventScroll: true });
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
  form.elements.occurredOn.value = new Date().toISOString().slice(0, 10);
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
  const today = new Date().toISOString().slice(0, 10);
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
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderEventManager() {
  const trip = activeTrip(state);
  const concerns = state.concerns.filter((concern) => concern.tripId === trip.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const events = state.events.filter((event) => event.tripId === trip.id).sort((a, b) => b.sequence - a.sequence);
  $('#event-dialog-title').textContent = `${trip.name} history`;
  $('#event-manager-copy').textContent = isCloudJourney(trip) ? 'Server-authoritative, account-attributed history. HMAC chaining makes database changes detectable; deleted records retain privacy-bounded tombstones.' : 'Browser-local preview. Production attribution requires separate signed-in accounts.';
  $('#concern-list').innerHTML = concerns.length ? concerns.map((concern) => `<article class="concern-row"><div><span class="status-chip ${concern.status}">${concern.status}</span><strong>${escapeHtml(concern.title)}</strong>${concern.detail ? `<p>${escapeHtml(concern.detail)}</p>` : ''}<small>Updated by ${escapeHtml(concern.updatedBy)} · ${new Date(concern.updatedAt).toLocaleString()}</small></div><div><button type="button" data-edit-concern="${escapeHtml(concern.id)}">Edit</button><button type="button" data-remove-concern="${escapeHtml(concern.id)}">Delete</button></div></article>`).join('') : '<p class="empty compact">No return-to conversations have been recorded for this journey.</p>';
  $('#event-list').innerHTML = events.length ? events.map((event) => {
    const changes = meaningfulChanges(event.before, event.after);
    return `<details class="event-row"><summary><span><strong>#${event.sequence} · ${escapeHtml(event.summary)}</strong><small>${escapeHtml(event.actorName)} · ${new Date(event.occurredAt).toLocaleString()}</small></span><span aria-hidden="true">＋</span></summary>${changes.length ? `<dl>${changes.map(({ key, before, after }) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(valueLabel(key, before))} → ${escapeHtml(valueLabel(key, after))}</dd></div>`).join('')}</dl>` : '<p>No field-level value change was stored for this event.</p>'}<small>Event ID ${escapeHtml(event.id)} · Previous ${escapeHtml(event.previousEventId || 'none')} · ${escapeHtml(event.source)}${event.eventHash ? ` · Hash ${escapeHtml(event.eventHash.slice(0, 12))}…` : ''}</small></details>`;
  }).join('') : '<p class="empty compact">No events have been recorded since Event Manager began. Earlier browser activity cannot be reconstructed.</p>';
  $$('[data-edit-concern]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editConcern)));
  $$('[data-remove-concern]').forEach((button) => button.addEventListener('click', () => removeConcern(button.dataset.removeConcern)));
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
  if (!concern || !window.confirm(`Delete the concern “${concern.title}”? The event history will retain a deletion tombstone.`)) return;
  if (isCloudJourney()) {
    try {
      await api.mutate(`/journeys/${activeTrip(state).id}/concerns/${id}`, 'DELETE', { version: concern.version });
      await refreshCloudState();
      renderEventManager();
      showToast('Concern deleted; the event tombstone remains.');
    } catch (error) {
      showToast(accountMessage(error));
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

const onboardingSteps = [
  {
    title: 'One shared journey, held in your own words.',
    body: '<strong>Create or switch journeys without mixing moments, open threads, or practical context.</strong><p>Every journey keeps its own people, dates, and history.</p>',
  },
  {
    title: 'Facts first. Meaning stays human.',
    body: '<strong>Hold a moment, then use Guidance for a short conversation.</strong><p>Prompts are optional, answers are never recorded, and money is only optional context—not a relationship score.</p>',
  },
  {
    title: 'Your browser is the current home.',
    body: '<strong>Browser-only is the default; private sync is an explicit choice.</strong><p>Signing in never uploads this browser ledger. Signed-in journeys use separate accounts and disappear from view on sign-out.</p>',
  },
];

function renderOnboarding() {
  const step = onboardingSteps[onboardingIndex];
  $('#onboarding-title').textContent = step.title;
  $('#onboarding-step').innerHTML = `<span>${onboardingIndex + 1} / ${onboardingSteps.length}</span>${step.body}`;
  $('#onboarding-back').disabled = onboardingIndex === 0;
  $('#onboarding-next').textContent = onboardingIndex === onboardingSteps.length - 1 ? 'Open my journey' : 'Next';
}

function completeOnboarding() {
  state.preferences.onboardingComplete = true;
  saveWorkingState();
  $('#onboarding-dialog').close();
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

$$('[data-open-expense]').forEach((button) => button.addEventListener('click', () => openExpense()));
$$('[data-open-moment]').forEach((button) => button.addEventListener('click', () => {
  if (accountUser && !isCloudJourney()) { openJourney(); return; }
  openMoment();
}));
$$('[data-close-moment]').forEach((button) => button.addEventListener('click', () => $('#moment-dialog').close()));
$$('[data-close-journey]').forEach((button) => button.addEventListener('click', () => $('#journey-dialog').close()));

$('#journey-select').addEventListener('change', (event) => {
  state.activeTripId = event.target.value;
  filter = 'All';
  selectedDay = null;
  selectedCategory = null;
  guidanceIndex = 0;
  persistAndRender('Journey switched.');
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

$('#moment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const existingIndex = state.moments.findIndex((moment) => moment.id === input.id);
    const before = existingIndex >= 0 ? structuredClone(state.moments[existingIndex]) : null;
    const trip = activeTrip(state);
    if (isCloudJourney(trip)) {
      const moneyCents = input.money === '' ? null : Math.round(Number(input.money) * 100);
      const payload = { kind: input.kind, kindLabel: input.kindLabel || '', title: input.title, detail: input.detail, occurredOn: input.occurredOn, moneyCents, moneyCurrency: input.moneyCurrency || '', ...(before ? { version: before.version } : {}) };
      if (before) await api.mutate(`/journeys/${trip.id}/moments/${before.id}`, 'PATCH', payload);
      else await api.mutate(`/journeys/${trip.id}/moments`, 'POST', payload);
      $('#moment-dialog').close();
      await refreshCloudState();
      showToast(before ? 'Shared moment updated.' : 'Shared moment held.');
      return;
    }
    const actorName = currentActor();
    const moment = normalizeMoment({ ...input, createdBy: actorName, updatedBy: actorName }, activeTrip(state).id, before);
    if (existingIndex >= 0) state.moments[existingIndex] = moment;
    else state.moments.push(moment);
    eventRecord({ action: existingIndex >= 0 ? 'moment_updated' : 'moment_added', entityType: 'moment', entityId: moment.id, summary: `${existingIndex >= 0 ? 'Updated' : 'Held'} ${momentLabel(moment.kind, moment.kindLabel).toLowerCase()}: ${moment.title}`, before, after: moment });
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
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$$('[data-close-settings]').forEach((button) => button.addEventListener('click', () => $('#settings-dialog').close()));
$('#sharing-create-journey-button').addEventListener('click', () => {
  $('#settings-dialog').close();
  openJourney();
});
$('#account-button').addEventListener('click', () => {
  renderAccountState();
  $('#account-dialog').showModal();
});
$$('[data-close-account]').forEach((button) => button.addEventListener('click', () => $('#account-dialog').close()));

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
  button.disabled = true;
  try {
    accountUser = await api.login(Object.fromEntries(new FormData(event.currentTarget)));
    await refreshCloudState({ announce: true });
    renderAccountState();
    $('#account-dialog').close();
  } catch (error) {
    showToast(accountMessage(error));
  } finally {
    button.disabled = false;
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    accountUser = await api.register(Object.fromEntries(new FormData(event.currentTarget)));
    await refreshCloudState();
    renderAccountState();
    showToast(api.lastVerificationSent ? 'Account created. Check your email to verify it.' : 'Account created, but email is delayed. Use resend verification shortly.');
  } catch (error) {
    showToast(accountMessage(error));
  } finally {
    button.disabled = false;
  }
});

$('#recovery-button').addEventListener('click', () => {
  $('#account-dialog').close();
  $('#recovery-request-form').reset();
  $('#recovery-request-dialog').showModal();
  $('#recovery-request-form').elements.email.focus({ preventScroll: true });
});
$$('[data-close-recovery-request]').forEach((button) => button.addEventListener('click', () => $('#recovery-request-dialog').close()));
$('#recovery-request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api.request('/recovery/request', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
    $('#recovery-request-dialog').close();
    showToast('If that account exists, a recovery link is on its way.');
  } catch (error) {
    showToast(accountMessage(error));
  }
});
$$('[data-close-recovery-confirm]').forEach((button) => button.addEventListener('click', () => $('#recovery-confirm-dialog').close()));
$('#recovery-confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  if (input.password !== input.confirmPassword) {
    showToast('The new passwords do not match.');
    return;
  }
  try {
    await api.request('/recovery/confirm', { method: 'POST', body: { token: input.token, password: input.password } });
    accountUser = null;
    cloudJourneyIds = new Set();
    state = loadState();
    $('#recovery-confirm-dialog').close();
    render();
    showToast('Password changed. Sign in again on every device.');
  } catch (error) {
    showToast(accountMessage(error));
  }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api.logout(); } catch (error) { showToast(accountMessage(error)); return; }
  accountUser = null;
  cloudJourneyIds = new Set();
  state = loadState();
  $('#account-dialog').close();
  render();
  showToast('Signed out.');
});

$('#refresh-sync-button').addEventListener('click', async () => {
  try { await refreshCloudState({ announce: true }); } catch (error) { showToast(accountMessage(error)); }
});

$('#resend-verification-button').addEventListener('click', async () => {
  try {
    const result = await api.mutate('/auth/resend-verification', 'POST', {});
    showToast(result.delivered ? 'A new verification link is on its way.' : 'Email delivery is still unavailable. Please try again later.');
  } catch (error) {
    showToast(accountMessage(error));
  }
});

$('#delete-account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  if (!window.confirm('Permanently delete this account according to the journey ownership rules shown here?')) return;
  try {
    await api.mutate('/account', 'DELETE', input);
    accountUser = null;
    cloudJourneyIds = new Set();
    state = loadState();
    $('#account-dialog').close();
    render();
    showToast('Account deleted and sessions revoked.');
  } catch (error) {
    showToast(accountMessage(error));
  }
});

$('#invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api.mutate(`/journeys/${activeTrip(state).id}/invitations`, 'POST', Object.fromEntries(new FormData(form)));
    form.reset();
    showToast('Invitation sent. The journeyer must use their own verified account.');
  } catch (error) {
    showToast(accountMessage(error));
  } finally {
    button.disabled = false;
  }
});

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
        showToast(accountMessage(error));
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
  link.download = `together-ledger-${new Date().toISOString().slice(0, 10)}.json`;
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
    selectedDay = null;
    selectedCategory = null;
    render();
    showToast('Ledger imported on this browser.');
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = '';
  }
});

$('#reset-button').addEventListener('click', () => {
  if (!window.confirm('Clear this browser’s ledger and begin with an empty shared space? Export first if you need a backup.')) return;
  state = resetState();
  selectedDay = null;
  selectedCategory = null;
  render();
  showToast('This browser has a fresh shared space.');
});

$('#onboarding-back').addEventListener('click', () => {
  onboardingIndex = Math.max(0, onboardingIndex - 1);
  renderOnboarding();
});
$('#onboarding-next').addEventListener('click', () => {
  if (onboardingIndex === onboardingSteps.length - 1) completeOnboarding();
  else {
    onboardingIndex += 1;
    renderOnboarding();
  }
});
$('#onboarding-skip').addEventListener('click', completeOnboarding);
$('#skip-onboarding').addEventListener('click', completeOnboarding);

initializeThemePicker();
render();
if (!state.preferences.onboardingComplete) {
  renderOnboarding();
  $('#onboarding-dialog').showModal();
}

async function initializeAccount() {
  const params = new URLSearchParams(window.location.search);
  try {
    if (params.has('verify')) {
      await api.request('/auth/verify-email', { method: 'POST', body: { token: params.get('verify') } });
      showToast('Email verified. You can now accept invitations.');
    }
    if (params.has('recovery')) {
      if ($('#onboarding-dialog').open) $('#onboarding-dialog').close();
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
      if (params.has('invite')) {
        await api.mutate(`/invitations/${encodeURIComponent(params.get('invite'))}/accept`, 'POST', {});
        await refreshCloudState({ announce: true });
      }
    } else if (params.has('invite')) {
      if ($('#onboarding-dialog').open) $('#onboarding-dialog').close();
      $('#account-dialog').showModal();
      showToast('Sign in with the invited email, then reopen the invitation link.');
    }
  } catch (error) {
    showToast(accountMessage(error));
  } finally {
    if ([...params.keys()].some((key) => ['verify', 'recovery', 'invite'].includes(key))) {
      window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
    }
    renderAccountState();
  }
}

initializeAccount();
