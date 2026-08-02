import {
  activeEntries,
  activeTrip,
  appendJourneyEvent,
  CATEGORIES,
  CATEGORY_ICONS,
  conversationPrompts,
  dateLabel,
  dateRange,
  groupDayByCategory,
  money,
  normalizeConcern,
  normalizeEntry,
  normalizeTrip,
  summarize,
} from './model.js';
import { exportState, importState, loadState, resetState, saveState } from './store.js';

let state = loadState();
let filter = 'All';
let selectedDay = null;
let selectedCategory = null;
let removeId = null;
let removeSnapshot = null;
let guidanceIndex = 0;
let onboardingIndex = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

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
  const entries = activeEntries(state);
  const summary = summarize(entries, trip.budgetCents);
  renderJourneyControls(trip);
  $('#trip-name').textContent = trip.name;
  $('#trip-period').textContent = `${trip.location} · ${dateLabel(trip.startDate)}–${dateLabel(trip.endDate)}`;
  renderSummary(summary, entries.length);
  renderGuidance(summary, trip);
  renderCategoryChart(summary);
  renderPayerChart(summary, trip.members);
  renderFilters();
  renderLedger(entries);
  renderTimeline(trip, entries, summary);
}

function renderJourneyControls(trip) {
  $('#journey-select').innerHTML = state.trips.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  $('#journey-select').value = trip.id;
  $('#journey-count').textContent = `${state.trips.length} ${state.trips.length === 1 ? 'journey' : 'journeys'} stored in this browser`;
  const actor = currentActor(trip);
  $('#actor-select').innerHTML = trip.members.map((member) => `<option>${escapeHtml(member)}</option>`).join('');
  $('#actor-select').value = actor;
  $('#event-count').textContent = `(${state.events.filter((event) => event.tripId === trip.id).length})`;
}

function currentActor(trip = activeTrip(state)) {
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
  $$('[data-milestone]').forEach((input) => input.addEventListener('change', () => {
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
  requestAnimationFrame(() => form.elements.merchant.focus());
}

function openJourney(trip = null) {
  const form = $('#journey-form');
  form.reset();
  const today = new Date().toISOString().slice(0, 10);
  form.elements.startDate.value = today;
  form.elements.endDate.value = today;
  $('#journey-dialog-title').textContent = trip ? 'Edit journey details' : 'Start another trip ledger';
  $('#save-journey-button').textContent = trip ? 'Save journey changes' : 'Create journey';
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
  requestAnimationFrame(() => form.elements.name.focus());
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
  $('#concern-list').innerHTML = concerns.length ? concerns.map((concern) => `<article class="concern-row"><div><span class="status-chip ${concern.status}">${concern.status}</span><strong>${escapeHtml(concern.title)}</strong>${concern.detail ? `<p>${escapeHtml(concern.detail)}</p>` : ''}<small>Updated by ${escapeHtml(concern.updatedBy)} · ${new Date(concern.updatedAt).toLocaleString()}</small></div><div><button type="button" data-edit-concern="${escapeHtml(concern.id)}">Edit</button><button type="button" data-remove-concern="${escapeHtml(concern.id)}">Delete</button></div></article>`).join('') : '<p class="empty compact">No concerns have been explicitly logged for this journey.</p>';
  $('#event-list').innerHTML = events.length ? events.map((event) => {
    const changes = meaningfulChanges(event.before, event.after);
    return `<details class="event-row"><summary><span><strong>#${event.sequence} · ${escapeHtml(event.summary)}</strong><small>${escapeHtml(event.actorName)} · ${new Date(event.occurredAt).toLocaleString()}</small></span><span aria-hidden="true">＋</span></summary>${changes.length ? `<dl>${changes.map(({ key, before, after }) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(valueLabel(key, before))} → ${escapeHtml(valueLabel(key, after))}</dd></div>`).join('')}</dl>` : '<p>No field-level value change was stored for this event.</p>'}<small>Event ID ${escapeHtml(event.id)} · Previous ${escapeHtml(event.previousEventId || 'none')} · ${escapeHtml(event.source)}</small></details>`;
  }).join('') : '<p class="empty compact">No events have been recorded since Event Manager began. Earlier browser activity cannot be reconstructed.</p>';
  $$('[data-edit-concern]').forEach((button) => button.addEventListener('click', () => openConcern(button.dataset.editConcern)));
  $$('[data-remove-concern]').forEach((button) => button.addEventListener('click', () => removeConcern(button.dataset.removeConcern)));
}

function openConcern(id = '') {
  const form = $('#concern-form');
  const concern = state.concerns.find((item) => item.id === id);
  form.reset();
  $('#concern-dialog-title').textContent = concern ? 'Edit concern' : 'Log a concern';
  $('#save-concern-button').textContent = concern ? 'Save concern changes' : 'Log concern';
  if (concern) {
    form.elements.id.value = concern.id;
    form.elements.title.value = concern.title;
    form.elements.detail.value = concern.detail;
    form.elements.status.value = concern.status;
  }
  $('#concern-dialog').showModal();
  requestAnimationFrame(() => form.elements.title.focus());
}

function removeConcern(id) {
  const concern = state.concerns.find((item) => item.id === id);
  if (!concern || !window.confirm(`Delete the concern “${concern.title}”? The event history will retain a deletion tombstone.`)) return;
  state.concerns = state.concerns.filter((item) => item.id !== id);
  eventRecord({ action: 'concern_deleted', entityType: 'concern', entityId: concern.id, summary: `Deleted concern: ${concern.title}`, before: concern, after: null });
  saveState(state);
  render();
  renderEventManager();
  showToast('Concern deleted; tombstone retained in event history.');
}

const onboardingSteps = [
  {
    title: 'One shared picture, organized trip by trip.',
    body: '<strong>Create or switch journeys without mixing their expenses.</strong><p>Every journey keeps its own people, dates, budget, entries, charts, and action milestones.</p>',
  },
  {
    title: 'Facts first. Meaning stays human.',
    body: '<strong>Use the ledger for facts and Guidance for a short conversation.</strong><p>Prompts are optional, answers are never recorded, and payment totals never become a relationship score.</p>',
  },
  {
    title: 'Your browser is the current home.',
    body: '<strong>No login or automatic sync exists yet.</strong><p>Export a backup before switching devices or clearing browser data. Real accounts and private sharing belong to PR#0003.</p>',
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
  saveState(state);
  $('#onboarding-dialog').close();
}

function confirmRemove(id) {
  removeId = id;
  removeSnapshot = structuredClone(state.entries.find((entry) => entry.id === id));
  $('#confirm-dialog').returnValue = '';
  $('#confirm-dialog').showModal();
}

function persistAndRender(message) {
  saveState(state);
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
$$('[data-close-expense]').forEach((button) => button.addEventListener('click', () => $('#expense-dialog').close()));
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
  saveState(state);
  showToast(`New local events will be attributed to ${event.target.value}.`);
});
$('#event-manager-button').addEventListener('click', () => {
  renderEventManager();
  $('#event-dialog').showModal();
});
$('#journey-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
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
  const prompts = conversationPrompts(summarize(activeEntries(state), activeTrip(state).budgetCents));
  guidanceIndex = (guidanceIndex + 1) % prompts.length;
  renderGuidance(summarize(activeEntries(state), activeTrip(state).budgetCents), activeTrip(state));
});
$('#guidance-prev').addEventListener('click', () => {
  guidanceIndex = Math.max(0, guidanceIndex - 1);
  renderGuidance(summarize(activeEntries(state), activeTrip(state).budgetCents), activeTrip(state));
});
$('#guidance-next').addEventListener('click', () => {
  const trip = activeTrip(state);
  if (!trip.milestones.chosePrompt) {
    trip.milestones.chosePrompt = true;
    eventRecord({ action: 'milestone_updated', entityType: 'milestone', entityId: 'chosePrompt', summary: 'Completed: We chose one question to discuss', before: { chosePrompt: false }, after: { chosePrompt: true } });
  }
  guidanceIndex += 1;
  saveState(state);
  renderGuidance(summarize(activeEntries(state), trip.budgetCents), trip);
});
$('#guidance-done').addEventListener('click', () => {
  const trip = activeTrip(state);
  if (!trip.milestones.chosePrompt) {
    trip.milestones.chosePrompt = true;
    eventRecord({ action: 'milestone_updated', entityType: 'milestone', entityId: 'chosePrompt', summary: 'Completed: We chose one question to discuss', before: { chosePrompt: false }, after: { chosePrompt: true } });
  }
  persistAndRender('Check-in complete. Agree on one next action together.');
});

$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());

$('#expense-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
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

$('#confirm-dialog').addEventListener('close', () => {
  if ($('#confirm-dialog').returnValue === 'confirm' && removeId) {
    state.entries = state.entries.filter((entry) => entry.id !== removeId);
    eventRecord({ action: 'expense_deleted', entityType: 'expense', entityId: removeId, summary: `Deleted expense: ${removeSnapshot?.merchant || removeId}`, before: removeSnapshot, after: null });
    persistAndRender('Expense removed.');
  }
  removeId = null;
  removeSnapshot = null;
});

$('#add-concern-button').addEventListener('click', () => openConcern());
$$('[data-close-concern]').forEach((button) => button.addEventListener('click', () => $('#concern-dialog').close()));
$('#concern-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const index = state.concerns.findIndex((concern) => concern.id === input.id);
    const before = index >= 0 ? structuredClone(state.concerns[index]) : null;
    const concern = normalizeConcern(input, activeTrip(state).id, currentActor(), before);
    if (index >= 0) state.concerns[index] = concern;
    else state.concerns.push(concern);
    eventRecord({ action: index >= 0 ? 'concern_updated' : 'concern_added', entityType: 'concern', entityId: concern.id, summary: `${index >= 0 ? 'Edited' : 'Logged'} concern: ${concern.title}`, before, after: concern });
    $('#concern-dialog').close();
    saveState(state);
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
