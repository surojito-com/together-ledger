import {
  activeEntries,
  activeTrip,
  CATEGORIES,
  CATEGORY_ICONS,
  conversationPrompts,
  dateLabel,
  dateRange,
  groupDayByCategory,
  money,
  normalizeEntry,
  summarize,
} from './model.js';
import { exportState, importState, loadState, resetState, saveState } from './store.js';

let state = loadState();
let filter = 'All';
let selectedDay = null;
let selectedCategory = null;
let removeId = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

function render() {
  const trip = activeTrip(state);
  const entries = activeEntries(state);
  const summary = summarize(entries, trip.budgetCents);
  $('#trip-name').textContent = trip.name;
  $('#trip-period').textContent = `${trip.location} · ${dateLabel(trip.startDate)}–${dateLabel(trip.endDate)}`;
  renderSummary(summary, entries.length);
  renderPrompts(summary);
  renderCategoryChart(summary);
  renderPayerChart(summary, trip.members);
  renderFilters();
  renderLedger(entries);
  renderTimeline(trip, entries, summary);
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

function renderPrompts(summary) {
  $('#prompt-list').innerHTML = conversationPrompts(summary).map((prompt, index) => `<button class="prompt"><span>${index + 1}.</span>${escapeHtml(prompt)}</button>`).join('');
  $$('.prompt').forEach((button) => button.addEventListener('click', () => {
    $$('.prompt').forEach((item) => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'true');
    showToast('Prompt selected. Take two minutes each.');
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

function confirmRemove(id) {
  removeId = id;
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

$('#expense-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const entry = normalizeEntry(input, activeTrip(state).id);
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
    $('#expense-dialog').close();
    persistAndRender(index >= 0 ? 'Expense updated.' : 'Expense added to the shared picture.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#confirm-dialog').addEventListener('close', () => {
  if ($('#confirm-dialog').returnValue === 'confirm' && removeId) {
    state.entries = state.entries.filter((entry) => entry.id !== removeId);
    persistAndRender('Expense removed.');
  }
  removeId = null;
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

render();
