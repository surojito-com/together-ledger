import {
  activeEntries,
  activeMoments,
  activeTrip,
  appendJourneyEvent,
  CATEGORIES,
  CATEGORY_ICONS,
  conversationPrompts,
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
  const concerns = [];
  const events = [];
  for (const snapshot of snapshots) {
    const membersById = Object.fromEntries(snapshot.members.map((member) => [member.id, member.displayName]));
    const milestones = { reviewedPicture: false, chosePrompt: false, agreedNextAction: false };
    snapshot.milestones.forEach((item) => { milestones[item.key] = item.completed; });
    trips.push({ ...snapshot.journey, members: snapshot.members.map((member) => member.displayName), memberRecords: snapshot.members, milestones, archivedAt: '' });
    entries.push(...snapshot.expenses.map((expense) => ({ ...expense, tripId: expense.journeyId, paidBy: expense.payerLabel })));
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
    schemaVersion: 3,
    activeTripId: trips.some((trip) => trip.id === previousActive) ? previousActive : trips[0].id,
    preferences,
    trips,
    entries,
    moments: [],
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
  $('#signed-out-account').hidden = signedIn;
  $('#signed-in-account').hidden = !signedIn;
  $('#account-button').textContent = signedIn ? accountUser.displayName : 'Sign in';
  $('#account-name').textContent = signedIn ? accountUser.displayName : '';
  $('#account-email').textContent = signedIn ? accountUser.email : '';
  $('#verification-status').textContent = signedIn ? (accountUser.emailVerified ? 'Email verified' : 'Email verification is still required before accepting an invitation.') : '';
  $('#resend-verification-button').hidden = !signedIn || accountUser.emailVerified;
  $('#account-sync-copy').textContent = isCloudJourney() ? 'Private journey sync is active. The current hosted service records journey changes in its Event Manager.' : 'Your account is ready. Browser-only moments are not uploaded when you sign in.';
  $('#settings-storage-copy').textContent = isCloudJourney() ? 'This signed-in journey is loaded from the private service. Sign out to return to your browser-only journey.' : 'Browser-only journeys stay on this device unless you download a backup.';
  $('#sync-badge').textContent = isCloudJourney() ? 'Private sync' : signedIn ? 'Account ready' : 'Browser only';
  $('#sync-badge').classList.toggle('cloud', signedIn);
  $('#actor-control').hidden = isCloudJourney();
  const sharing = isCloudJourney();
  $('#invite-form').hidden = !sharing || activeTrip(state).members.length >= 2 || activeTrip(state).role !== 'owner';
  $('#sharing-copy').textContent = sharing ? `${activeTrip(state).members.length} of 2 journey seats are active. Each journeyer signs in separately.` : 'Sign in and create a private journey to invite another journeyer.';
  $('#member-list').innerHTML = sharing ? activeTrip(state).members.map((name) => `<div class="member-chip"><strong>${escapeHtml(name)}</strong><span>${name === accountUser.displayName ? 'You' : 'Journeyer'}</span></div>`).join('') : '';
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
  renderJourneyControls(trip);
  $('#trip-name').textContent = trip.name;
  $('#trip-period').textContent = `${trip.location} · ${dateLabel(trip.startDate)}–${dateLabel(trip.endDate)}`;
  renderSharedJourney(trip, moments);
}

function renderJourneyControls(trip) {
  $('#journey-select').innerHTML = state.trips.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  $('#journey-select').value = trip.id;
  $('#journey-count').textContent = isCloudJourney(trip) ? `${state.trips.length} private ${state.trips.length === 1 ? 'journey' : 'journeys'} synced` : `${state.trips.length} ${state.trips.length === 1 ? 'journey' : 'journeys'} stored in this browser`;
  const actor = currentActor(trip);
  $('#actor-select').innerHTML = trip.members.map((member) => `<option>${escapeHtml(member)}</option>`).join('');
  $('#actor-select').value = actor;
  $('#event-count').textContent = `(${state.events.filter((event) => event.tripId === trip.id).length})`;
  const accountWithoutJourney = Boolean(accountUser && !isCloudJourney(trip));
  $$('[data-open-moment]').forEach((button) => { button.disabled = accountWithoutJourney || isCloudJourney(trip); });
  $('#edit-journey-button').disabled = accountWithoutJourney;
  $('#event-manager-button').disabled = accountWithoutJourney;
  renderAccountState();
}

function momentLabel(kind) {
  return MOMENT_TYPES.find(([value]) => value === kind)?.[1] || 'Moment';
}

function renderSharedJourney(trip, moments) {
  const threads = state.concerns.filter((concern) => concern.tripId === trip.id && concern.status === 'open');
  const shared = moments.filter((moment) => moment.visibility === 'shared-now');
  const recent = [...moments].sort((a, b) => `${b.occurredOn}-${b.updatedAt}`.localeCompare(`${a.occurredOn}-${a.updatedAt}`));
  $('#journey-summary').innerHTML = [
    ['Current check-in', shared.length ? 'Ready together' : 'Make room', shared.length ? 'A shared place to begin' : 'Name one small thing'],
    ['Recent moments', `${recent.length}`, recent.length === 1 ? 'One moment held here' : 'Moments held with care'],
    ['Open threads', `${threads.length}`, threads.length ? 'Choose one gentle next step' : 'Nothing waiting right now'],
  ].map(([label, value, note]) => `<article class="card summary"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');

  const prompts = conversationPrompts();
  guidanceIndex = Math.min(guidanceIndex, prompts.length - 1);
  $('#guidance-progress').textContent = `Check-in ${guidanceIndex + 1} of ${prompts.length}`;
  $('#guidance-prompt').textContent = prompts[guidanceIndex];
  $('#guidance-prev').disabled = guidanceIndex === 0;
  $('#guidance-next').hidden = guidanceIndex === prompts.length - 1;
  $('#guidance-done').hidden = guidanceIndex !== prompts.length - 1;
  $('#milestone-list').innerHTML = [['reviewedPicture', 'We paused to notice what is here'], ['chosePrompt', 'We chose one question to hold together'], ['agreedNextAction', 'We named one next step']].map(([key, label]) => `<label><input type="checkbox" data-milestone="${key}" ${trip.milestones[key] ? 'checked' : ''} /> <span>${label}</span></label>`).join('');
  $$('[data-milestone]').forEach((input) => input.addEventListener('change', () => {
    if (isCloudJourney(trip)) { input.checked = !input.checked; showToast('Check-ins for private sync will arrive with the shared-moment service.'); return; }
    const before = { [input.dataset.milestone]: !input.checked };
    trip.milestones[input.dataset.milestone] = input.checked;
    eventRecord({ action: 'checkin_updated', entityType: 'checkin', entityId: input.dataset.milestone, summary: `${input.checked ? 'Completed' : 'Reopened'} check-in: ${input.nextElementSibling.textContent}`, before, after: { [input.dataset.milestone]: input.checked } });
    persistAndRender('Check-in updated.');
  }));

  const filters = [['all', 'All moments'], ...MOMENT_TYPES.map(([value, label]) => [value, label])];
  $('#moment-filters').innerHTML = filters.map(([value, label]) => `<button class="${momentFilter === value ? 'active' : ''}" data-moment-filter="${value}" aria-pressed="${momentFilter === value}">${label}</button>`).join('');
  $$('[data-moment-filter]').forEach((button) => button.addEventListener('click', () => { momentFilter = button.dataset.momentFilter; renderSharedJourney(trip, moments); }));
  const visible = recent.filter((moment) => momentFilter === 'all' || moment.kind === momentFilter);
  $('#moment-timeline').innerHTML = visible.length ? visible.map((moment) => `<article class="moment-card ${moment.visibility}"><div class="moment-meta"><span class="moment-kind">${escapeHtml(momentLabel(moment.kind))}</span><span>${dateLabel(moment.occurredOn)}</span><span class="visibility-chip ${moment.visibility}">${escapeHtml(moment.visibility.replaceAll('-', ' '))}</span></div><strong>${escapeHtml(moment.title)}</strong>${moment.detail ? `<p>${escapeHtml(moment.detail)}</p>` : ''}${moment.moneyCents != null ? `<details class="money-context"><summary>Practical money context</summary><p>${money(moment.moneyCents)} is held here as context, not a score.</p></details>` : ''}<div class="moment-actions"><button data-edit-moment="${escapeHtml(moment.id)}">Edit</button></div></article>`).join('') : '<p class="empty">No moments in this view yet. A small truth is enough to begin.</p>';
  $$('[data-edit-moment]').forEach((button) => button.addEventListener('click', () => openMoment(button.dataset.editMoment)));
  $('#open-threads').innerHTML = threads.length ? threads.map((thread) => `<article class="thread-row"><div><span class="status-chip open">open</span><strong>${escapeHtml(thread.title)}</strong>${thread.detail ? `<p>${escapeHtml(thread.detail)}</p>` : ''}</div><button data-edit-thread="${escapeHtml(thread.id)}">Open</button></article>`).join('') : '<p class="empty compact">No open threads. That can be a good place to rest.</p>';
  $$('[data-edit-thread]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editThread)));
  $('#privacy-boundary-copy').textContent = isCloudJourney(trip)
    ? 'This journey is signed in, but private / shared-now / share-later moments are not yet supported by the hosted service. Do not use this preview for a confidential reflection.'
    : 'Browser-only visibility is a local cue, not account-separated privacy: anyone who can use this browser can see it. Shared-now and share-later will gain real per-person sharing when the private service adds moment authorization.';
}

function openMoment(id = '') {
  const form = $('#moment-form');
  const moment = state.moments.find((item) => item.id === id);
  form.reset();
  form.elements.kind.innerHTML = MOMENT_TYPES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  form.elements.occurredOn.value = new Date().toISOString().slice(0, 10);
  form.elements.visibility.value = 'shared-now';
  $('#moment-dialog-title').textContent = moment ? 'Edit this moment' : 'Hold a moment';
  $('#save-moment').textContent = moment ? 'Save moment' : 'Hold this moment';
  if (moment) {
    form.elements.id.value = moment.id; form.elements.kind.value = moment.kind; form.elements.title.value = moment.title; form.elements.detail.value = moment.detail; form.elements.occurredOn.value = moment.occurredOn; form.elements.visibility.value = moment.visibility; form.elements.money.value = moment.moneyCents == null ? '' : (moment.moneyCents / 100).toFixed(2);
  }
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

function renderGuidance(summary, trip) {
  const prompts = conversationPrompts(summary);
  guidanceIndex = Math.min(guidanceIndex, Math.max(0, prompts.length - 1));
  $('#guidance-progress').textContent = `Prompt ${guidanceIndex + 1} of ${prompts.length}`;
  $('#guidance-prompt').textContent = prompts[guidanceIndex];
  $('#guidance-prev').disabled = guidanceIndex === 0;
  $('#guidance-next').hidden = guidanceIndex === prompts.length - 1;
  $('#guidance-done').hidden = guidanceIndex !== prompts.length - 1;
  const milestones = [
    ['reviewedPicture', 'We reviewed the same trip totals'],
    ['chosePrompt', 'We chose one question to discuss'],
    ['agreedNextAction', 'We agreed on one next action'],
  ];
  $('#milestone-list').innerHTML = milestones.map(([key, label]) => `<label><input type="checkbox" data-milestone="${key}" ${trip.milestones[key] ? 'checked' : ''} /> <span>${label}</span></label>`).join('');
  $$('[data-milestone]').forEach((input) => input.addEventListener('change', async () => {
    if (isCloudJourney(trip)) {
      try {
        await api.mutate(`/journeys/${trip.id}/milestones/${input.dataset.milestone}`, 'PATCH', { completed: input.checked });
        await refreshCloudState();
        showToast('Journey action synced.');
      } catch (error) {
        input.checked = !input.checked;
        showToast(accountMessage(error));
      }
      return;
    }
    const before = { [input.dataset.milestone]: !input.checked };
    trip.milestones[input.dataset.milestone] = input.checked;
    eventRecord({ action: 'milestone_updated', entityType: 'milestone', entityId: input.dataset.milestone, summary: `${input.checked ? 'Completed' : 'Reopened'}: ${input.nextElementSibling.textContent}`, before, after: { [input.dataset.milestone]: input.checked } });
    persistAndRender('Journey action updated.');
  }));
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
  $('#journey-dialog-title').textContent = trip ? 'Edit journey details' : 'Begin a shared journey';
  $('#save-journey-button').textContent = trip ? 'Save journey changes' : 'Create journey';
  $$('.member-field').forEach((field) => {
    field.hidden = Boolean(accountUser);
    field.querySelector('input').disabled = Boolean(accountUser);
  });
  if (trip) {
    form.elements.id.value = trip.id;
    form.elements.name.value = trip.name;
    form.elements.location.value = trip.location;
    form.elements.startDate.value = trip.startDate;
    form.elements.endDate.value = trip.endDate;
    form.elements.budget.value = (trip.budgetCents / 100).toFixed(2);
    form.elements.memberOne.value = trip.members[0];
    form.elements.memberTwo.value = trip.members[1];
  }
  $('#journey-dialog').showModal();
  form.elements.name.focus({ preventScroll: true });
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
  $('#concern-list').innerHTML = concerns.length ? concerns.map((concern) => `<article class="concern-row"><div><span class="status-chip ${concern.status}">${concern.status}</span><strong>${escapeHtml(concern.title)}</strong>${concern.detail ? `<p>${escapeHtml(concern.detail)}</p>` : ''}<small>Updated by ${escapeHtml(concern.updatedBy)} · ${new Date(concern.updatedAt).toLocaleString()}</small></div><div><button type="button" data-edit-concern="${escapeHtml(concern.id)}">Edit</button><button type="button" data-remove-concern="${escapeHtml(concern.id)}">Delete</button></div></article>`).join('') : '<p class="empty compact">No open threads have been recorded for this journey.</p>';
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
  $('#concern-dialog-title').textContent = concern ? 'Edit thread' : 'Start a thread';
  $('#save-concern-button').textContent = concern ? 'Save thread changes' : 'Start thread';
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
  if (isCloudJourney()) { showToast('Moments are browser-only until the private service adds visibility authorization.'); return; }
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
        startDate: input.startDate,
        endDate: input.endDate,
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
  guidanceIndex = (guidanceIndex + 1) % prompts.length;
  renderSharedJourney(activeTrip(state), activeMoments(state));
});
$('#guidance-prev').addEventListener('click', () => {
  guidanceIndex = Math.max(0, guidanceIndex - 1);
  renderSharedJourney(activeTrip(state), activeMoments(state));
});
$('#guidance-next').addEventListener('click', async () => {
  const trip = activeTrip(state);
  if (!trip.milestones.chosePrompt) {
    if (isCloudJourney(trip)) {
      try { await api.mutate(`/journeys/${trip.id}/milestones/chosePrompt`, 'PATCH', { completed: true }); } catch (error) { showToast(accountMessage(error)); return; }
    }
    trip.milestones.chosePrompt = true;
    if (!isCloudJourney(trip)) eventRecord({ action: 'milestone_updated', entityType: 'milestone', entityId: 'chosePrompt', summary: 'Completed: We chose one question to discuss', before: { chosePrompt: false }, after: { chosePrompt: true } });
  }
  guidanceIndex += 1;
  saveWorkingState();
  renderSharedJourney(trip, activeMoments(state));
});

$('#moment-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const existingIndex = state.moments.findIndex((moment) => moment.id === input.id);
    const before = existingIndex >= 0 ? structuredClone(state.moments[existingIndex]) : null;
    const moment = normalizeMoment(input, activeTrip(state).id, before);
    if (existingIndex >= 0) state.moments[existingIndex] = moment;
    else state.moments.push(moment);
    eventRecord({ action: existingIndex >= 0 ? 'moment_updated' : 'moment_added', entityType: 'moment', entityId: moment.id, summary: `${existingIndex >= 0 ? 'Updated' : 'Held'} ${momentLabel(moment.kind).toLowerCase()}: ${moment.title}`, before, after: moment });
    $('#moment-dialog').close();
    persistAndRender(existingIndex >= 0 ? 'Moment updated.' : 'Moment held in this browser.');
  } catch (error) {
    showToast(error.message);
  }
});
$('#guidance-done').addEventListener('click', async () => {
  const trip = activeTrip(state);
  if (!trip.milestones.chosePrompt) {
    if (isCloudJourney(trip)) {
      try { await api.mutate(`/journeys/${trip.id}/milestones/chosePrompt`, 'PATCH', { completed: true }); } catch (error) { showToast(accountMessage(error)); return; }
    }
    trip.milestones.chosePrompt = true;
    if (!isCloudJourney(trip)) eventRecord({ action: 'milestone_updated', entityType: 'milestone', entityId: 'chosePrompt', summary: 'Completed: We chose one question to discuss', before: { chosePrompt: false }, after: { chosePrompt: true } });
  }
  persistAndRender('Check-in complete. Agree on one next action together.');
});

$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$$('[data-close-settings]').forEach((button) => button.addEventListener('click', () => $('#settings-dialog').close()));
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
  try {
    await api.mutate(`/journeys/${activeTrip(state).id}/invitations`, 'POST', Object.fromEntries(new FormData(event.currentTarget)));
    event.currentTarget.reset();
    showToast('Invitation sent. The journeyer must use their own verified account.');
  } catch (error) {
    showToast(accountMessage(error));
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
  if (!window.confirm('Replace this browser’s ledger with synthetic demo data? Export first if you need a backup.')) return;
  state = resetState();
  selectedDay = null;
  selectedCategory = null;
  render();
  showToast('Synthetic demo restored.');
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
