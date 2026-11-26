'use strict';

/*
 * Hourly — time tracker + monthly bill progress.
 *
 * Timing accuracy: the clock never counts ticks. Every start / pause / resume
 * stores a wall-clock timestamp (Date.now()), and elapsed time is always
 * computed from those timestamps. Refreshing, closing the tab, sleeping the
 * laptop or background-tab throttling cannot make it drift or lose time.
 *
 * All data lives in localStorage under STORAGE_KEY.
 */

const STORAGE_KEY = 'hourly-tracker:v1';
const DEFAULT_CAD_USD = 0.72;
const HOUR = 3600e3;
const MINUTE = 60e3;
/** Pay is on whole minutes only: leftover seconds are shown but not paid. */
const billableMs = (ms) => Math.floor(Math.max(0, ms) / MINUTE) * MINUTE;

// ---------- State ----------

function blankState() {
  return {
    version: 1,
    projects: [],          // {id, name, rate}
    bills: [],             // recurring costs {id, name, amount, currency, kind: 'bill'|'estimate', category, dueDay}
    oneOffs: [],           // {id, name, amount, currency, month: '2026-11'} costs for one month only
    income: [],            // {id, name, amount, currency, recurring, month} other income, after tax
    entries: [],           // {id, projectId, projectName, rate, desc, segments: [{start, end}]}
    outside: {},           // {'2026-11': 1234.56} USD earned outside the app, per month
    dailyGoals: {},        // {'2026-11-25': 212.4} each weekday's goal, as it stood that day
    daysOff: {},           // {'2026-11-26': true} weekdays taken off (no goal)
    timer: null,           // {projectName, rate, desc, segments: [{start, end|null}]}
    settings: { allocation: 'smallest', taxEnabled: false, taxRate: 25 },
    fx: { rate: DEFAULT_CAD_USD, date: null, fetchedOn: null },
  };
}

let storageOk = true;

function load() {
  const base = blankState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw);
    if (!s || s.version !== 1) return base;
    return {
      ...base, ...s,
      settings: { ...base.settings, ...(s.settings || {}) },
      fx: { ...base.fx, ...(s.fx || {}) },
      outside: s.outside || {},
    };
  } catch (e) {
    return base;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
    storageOk = true;
  } catch (e) {
    storageOk = false;
  }
  $('storage-warning').hidden = storageOk;
}

let S = load();
let viewMonth = monthKey(Date.now());

// ---------- Helpers ----------

const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const cad = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'CAD' });
const money = (n) => usd.format(Math.round(n * 100) / 100 || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function monthKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1).getTime());
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function localDateStr(ts = Date.now()) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
}
function fmtHours(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function dayLabel(ts) {
  const today = localDateStr();
  const yest = localDateStr(Date.now() - 86400e3);
  const k = localDateStr(ts);
  if (k === today) return 'Today';
  if (k === yest) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
// Timestamp -> "YYYY-MM-DDTHH:MM:SS" in local time (used in the CSV export)
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const segMs = (seg, now = Date.now()) => (seg.end ?? now) - seg.start;
const entryMs = (e) => e.segments.reduce((a, s) => a + segMs(s), 0);
const entryStart = (e) => Math.min(...e.segments.map((s) => s.start));
const entryEnd = (e) => Math.max(...e.segments.map((s) => s.end));
const entryBillableMs = (e) => billableMs(entryMs(e));
const entryGross = (e) => (entryBillableMs(e) / HOUR) * e.rate;

function projectById(id) { return S.projects.find((p) => p.id === id); }
function projectByName(name) {
  const n = name.trim().toLowerCase();
  return n ? S.projects.find((p) => p.name.toLowerCase() === n) : undefined;
}
function entryProjectName(e) { return projectById(e.projectId)?.name || e.projectName || 'No project'; }

/** Find or create a project and remember the rate as its latest. */
function upsertProject(name, rate) {
  name = name.trim();
  if (!name) return null;
  let p = projectByName(name);
  if (!p) { p = { id: uid(), name, rate }; S.projects.push(p); }
  else if (Number.isFinite(rate)) p.rate = rate;
  return p;
}

/** Net = what counts toward bills, after the optional tax set-aside. */
function toNet(gross) {
  const st = S.settings;
  return st.taxEnabled ? gross * (1 - Math.min(90, Math.max(0, st.taxRate || 0)) / 100) : gross;
}
const billUsd = (b) => (b.currency === 'CAD' ? b.amount * S.fx.rate : b.amount);

// ---------- Timer ----------

const timerRunning = () => !!S.timer && S.timer.segments.some((s) => s.end == null);
const timerMs = () => (S.timer ? S.timer.segments.reduce((a, s) => a + segMs(s), 0) : 0);
function currentRate() { const r = parseFloat($('t-rate').value); return Number.isFinite(r) && r >= 0 ? r : 0; }

function timerGo() {
  const now = Date.now();
  if (!S.timer) {
    S.timer = {
      projectName: $('t-project').value.trim(),
      rate: currentRate(),
      desc: $('t-desc').value.trim(),
      segments: [{ start: now, end: null }],
    };
  } else if (timerRunning()) {
    S.timer.segments.find((s) => s.end == null).end = now; // pause
  } else {
    S.timer.segments.push({ start: now, end: null }); // resume
  }
  save();
  renderAll();
}

function timerStop() {
  if (!S.timer) return;
  const now = Date.now();
  S.timer.segments.forEach((s) => { if (s.end == null) s.end = now; });
  const t = S.timer;
  const segments = t.segments.filter((s) => s.end > s.start);
  S.timer = null;
  if (segments.length) {
    const p = upsertProject(t.projectName, t.rate);
    S.entries.push({ id: uid(), projectId: p?.id || null, projectName: p?.name || '', rate: t.rate, desc: t.desc, segments });
  }
  viewMonth = monthKey(now);
  save();
  $('t-desc').value = '';
  renderAll();
}

function timerDiscard() {
  if (!S.timer) return;
  const prev = S.timer;
  S.timer = null;
  save();
  $('t-desc').value = '';
  renderAll();
  toast('Timer discarded', () => { S.timer = prev; save(); syncTimerInputs(); renderAll(); });
}

/** Keep the timer's project / rate / description in sync with the inputs while it exists. */
function onTimerInput() {
  if (!S.timer) return;
  S.timer.projectName = $('t-project').value.trim();
  S.timer.rate = currentRate();
  S.timer.desc = $('t-desc').value.trim();
  save();
  renderTick();
}

function syncTimerInputs() {
  if (!S.timer) return;
  $('t-project').value = S.timer.projectName || '';
  $('t-rate').value = S.timer.rate;
  $('t-desc').value = S.timer.desc || '';
}

// ---------- Rendering ----------

function renderTick() {
  const ms = timerMs();
  const running = timerRunning();
  const card = $('timer-card');
  card.classList.toggle('running', running);
  card.classList.toggle('paused', !!S.timer && !running);
  $('clock').textContent = fmtClock(ms);
  $('t-earn').textContent = money((billableMs(ms) / HOUR) * (S.timer ? S.timer.rate : currentRate()));
  const n = S.timer ? S.timer.segments.length : 0;
  $('t-state').textContent = !S.timer ? 'Ready' : running ? 'Running' : `Paused${n > 1 ? ` · ${n} blocks` : ''}`;
  document.title = S.timer ? `${running ? '▶' : '❚❚'} ${fmtClock(ms)} · Hourly` : 'Hourly';
}

function renderTimerButtons() {
  const running = timerRunning();
  $('t-go').textContent = !S.timer ? 'Start' : running ? 'Pause' : 'Resume';
  $('t-stop').hidden = !S.timer;
  $('t-discard').hidden = !S.timer;
}

/** Earnings for a month. With `beforeTs`, only entries started before then (used for "today"). */
function monthGross(key, beforeTs = Infinity) {
  let g = 0, ms = 0;
  for (const e of S.entries) {
    const st = entryStart(e);
    if (monthKey(st) === key && st < beforeTs) { g += entryGross(e); ms += entryMs(e); }
  }
  if (S.timer) {
    const st = S.timer.segments[0].start;
    if (monthKey(st) === key && st < beforeTs) { const t = timerMs(); ms += t; g += (billableMs(t) / HOUR) * S.timer.rate; }
  }
  return { gross: g, ms, outside: S.outside[key] || 0 };
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** Everything to cover in a month (recurring bills and estimates, plus that month's one-offs), in USD, smallest first. */
function costItems(key = monthKey(Date.now())) {
  return [
    ...S.bills.map((b) => ({ ...b, kind: b.kind || 'bill' })),
    ...S.oneOffs.filter((o) => o.month === key).map((o) => ({ ...o, kind: 'oneoff' })),
  ]
    .filter((b) => b.amount > 0)
    .map((b) => ({ ...b, usd: billUsd(b) }))
    .sort((a, b) => a.usd - b.usd);
}
/** Other income for a month in USD. Treated as already after tax. */
const monthIncome = (key) => S.income.filter((i) => i.amount > 0 && (i.recurring || i.month === key)).reduce((a, i) => a + billUsd(i), 0);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const isDone = (put, b) => b.usd <= 0 || put >= b.usd - 0.005;

/** USD put toward each bill (keyed by id) out of `net` dollars. `bills` must be sorted smallest first. */
function allocate(net, bills) {
  const total = bills.reduce((a, b) => a + b.usd, 0);
  const out = {};
  let left = Math.max(0, net);
  for (const b of bills) {
    let put;
    if (S.settings.allocation === 'smallest') { put = Math.min(left, b.usd); left -= put; }
    else put = total > 0 ? Math.min(b.usd, Math.max(0, net) * (b.usd / total)) : 0;
    out[b.id] = Math.max(0, put);
  }
  return out;
}

/** What today's work did: earnings, and how much went to each bill. */
function todayBreakdown(bills) {
  const cur = monthKey(Date.now());
  const all = monthGross(cur);
  const before = monthGross(cur, startOfToday());
  const total = bills.reduce((a, b) => a + b.usd, 0);
  const income = monthIncome(cur);
  const netAll = toNet(all.gross + all.outside) + income;
  const netBefore = toNet(before.gross + all.outside) + income;
  const putAll = allocate(netAll, bills);
  const putBefore = allocate(netBefore, bills);
  const perBill = {};
  for (const b of bills) {
    const diff = putAll[b.id] - putBefore[b.id];
    if (diff > 0.004) perBill[b.id] = { usd: diff, finished: isDone(putAll[b.id], b) && !isDone(putBefore[b.id], b) };
  }
  return {
    gross: all.gross - before.gross,
    ms: all.ms - before.ms,
    perBill,
    putAll,
    extra: Math.max(0, netAll - total) - Math.max(0, netBefore - total),
  };
}

// ---------- Daily goal ----------
//
// Weekdays (Mon–Fri) get a goal; weekends don't (anything earned is extra).
// Goal = monthly costs still uncovered at the start of today ÷ workdays left in the
// month, including today. Today's own earnings don't move today's goal, so it
// stays put while you work; beating it lowers tomorrow's, falling short raises it.

const isWeekday = (ts) => { const d = new Date(ts).getDay(); return d >= 1 && d <= 5; };
const isDayOff = (ts) => !!S.daysOff[localDateStr(ts)];
/** A workday is a weekday you haven't taken off. Only workdays get a goal. */
const isWorkday = (ts) => isWeekday(ts) && !isDayOff(ts);

/** Weekdays from the day of `ts` through the end of its month, including that day. */
function workdaysLeftInMonth(ts) {
  const d = new Date(ts);
  d.setHours(12, 0, 0, 0);
  const m = d.getMonth();
  let n = 0;
  while (d.getMonth() === m) { if (isWorkday(d.getTime())) n++; d.setDate(d.getDate() + 1); }
  return n;
}

/** Gross earnings needed to end up with `net` after the optional tax set-aside. */
const grossFromNet = (net) => (S.settings.taxEnabled ? net / (1 - Math.min(90, Math.max(0, S.settings.taxRate || 0)) / 100) : net);

function dailyGoal(bills) {
  const now = Date.now();
  const total = bills.reduce((a, b) => a + b.usd, 0);
  const before = monthGross(monthKey(now), startOfToday());
  const remaining = Math.max(0, total - toNet(before.gross + before.outside) - monthIncome(monthKey(now)));
  const workday = isWorkday(now);
  const daysLeft = workdaysLeftInMonth(now);
  const target = workday && daysLeft > 0 ? grossFromNet(remaining / daysLeft) : 0;
  return { total, remaining, workday, dayOff: isWeekday(now) && isDayOff(now), daysLeft, target };
}

/**
 * Average hourly rate you actually earned (paid earnings ÷ paid hours) this month.
 * Falls back to last month, then to the timer's rate, when there's no history yet.
 */
function averageRate() {
  const calc = (key) => {
    let g = 0, ms = 0;
    for (const e of S.entries) if (monthKey(entryStart(e)) === key) { g += entryGross(e); ms += entryBillableMs(e); }
    return ms >= MINUTE ? g / (ms / HOUR) : null;
  };
  const name = (key) => new Date(+key.slice(0, 4), +key.slice(5) - 1, 1).toLocaleDateString(undefined, { month: 'long' });
  const cur = monthKey(Date.now());
  const prev = shiftMonth(cur, -1);
  const a = calc(cur);
  if (a > 0) return { rate: a, label: `your ${name(cur)} average` };
  const b = calc(prev);
  if (b > 0) return { rate: b, label: `your ${name(prev)} average` };
  const r = S.timer ? S.timer.rate : currentRate();
  return r > 0 ? { rate: r, label: 'your current rate' } : null;
}

/** Work time needed to earn `usdAmount` at `rate`, rounded up to the whole minute (pay is per whole minute). */
const timeToEarn = (usdAmount, rate) => Math.ceil(((usdAmount / rate) * HOUR) / MINUTE) * MINUTE;

/** Save today's goal so history shows the goal you had that day. Only writes when it changes. */
function recordGoal(goal) {
  if (!goal.workday || goal.total <= 0) return;
  const k = localDateStr();
  const v = Math.round(goal.target * 100) / 100;
  if (S.dailyGoals[k] !== v) { S.dailyGoals[k] = v; save(); }
}

/** Small grey CAD amount shown next to a USD figure for CAD bills. */
const cadNote = (usdAmt, b, cls = 'cad-inline') => (b.currency === 'CAD' ? `<span class="${cls}">${esc(cad.format(usdAmt / S.fx.rate))}</span>` : '');

/** " · about 3h 26m of work at $32.00/hr (your November average)" */
function timeLeft(usdLeft) {
  const avg = averageRate();
  if (!avg) return '';
  return ` · about ${fmtHours(timeToEarn(usdLeft, avg.rate))} of work <span class="muted time-basis">at ${money(avg.rate)}/hr (${esc(avg.label)})</span>`;
}

function renderToday(bills, today, goal) {
  const earned = today.gross;
  $('today-total').textContent = today.ms > 0 ? fmtHours(today.ms) : '';
  const offCount = upcomingDaysOff();
  const offLink = `<button type="button" class="link-btn" data-open-daysoff>${offCount ? `Days off (${offCount})` : 'Days off'}</button>`;
  const big = `<div class="goal-line"><span class="goal-big">${money(earned)}</span>`;
  let head;
  if (!bills.length) {
    head = `${big}<span class="muted">earned today</span></div><p class="muted small">Add your monthly costs to get a daily goal.</p>`;
  } else if (goal.dayOff) {
    head = `${big}<span class="muted">earned today</span></div><p class="muted small">You've taken today off, so there's no goal. Anything you earn is extra. · ${offLink}</p>`;
  } else if (!goal.workday) {
    head = `${big}<span class="muted">earned today</span></div><p class="muted small">It's the weekend, so there's no goal today. Everything you earn is extra. · ${offLink}</p>`;
  } else if (goal.target <= 0) {
    head = `${big}<span class="muted">earned today</span></div><p class="muted small">Your costs for this month are covered. Everything you earn today is extra. · ${offLink}</p>`;
  } else {
    const extra = Math.max(0, earned - goal.target);
    const scale = Math.max(earned, goal.target);
    const blue = (Math.min(earned, goal.target) / scale) * 100;
    const green = (extra / scale) * 100;
    const status = extra > 0.004
      ? `<span class="goal-hit">✓ Goal reached</span> · +${money(extra)} extra`
      : earned >= goal.target - 0.004 ? '<span class="goal-hit">✓ Goal reached</span>' : `${money(goal.target - earned)} to go${timeLeft(goal.target - earned)}`;
    const tax = S.settings.taxEnabled ? `, plus your ${S.settings.taxRate}% tax set-aside` : '';
    head = `${big}<span class="muted">of ${money(goal.target)} goal</span></div>
      <div class="bar big ${green > 0 ? 'has-today' : ''}"><div style="width:${blue}%"></div><div class="today" style="width:${green}%"></div></div>
      <div class="goal-status small">${status}</div>
      <p class="muted small goal-basis">${money(goal.remaining)} left to cover ÷ ${goal.daysLeft} workday${goal.daysLeft === 1 ? '' : 's'} left this month${tax} · ${offLink}</p>`;
  }

  let items = [];
  if (today.ms > 0) {
    items = bills.filter((b) => today.perBill[b.id]).map((b) => {
      const t = today.perBill[b.id];
      return `<div class="today-item ${t.finished ? 'finished' : ''}">
        <span>${t.finished ? '<span class="tick">✓</span>' : ''}${esc(b.name || 'Bill')}${t.finished ? ' <span class="muted">paid off</span>' : ''}</span>
        <span class="today-amt">+${money(t.usd)}${cadNote(t.usd, b)}</span>
      </div>`;
    });
    if (today.extra > 0.004) items.push(`<div class="today-item finished"><span>Extra beyond costs</span><span class="today-amt">+${money(today.extra)}</span></div>`);
  }
  $('today-body').innerHTML = head
    + (items.length ? `<div class="today-sub-head">Where today's money went</div>${items.join('')}` : '');
}

function renderBills() {
  const isCurrent = viewMonth === monthKey(Date.now());
  $('m-label').textContent = monthLabel(viewMonth);
  const lastMonth = shiftMonth(monthKey(Date.now()), 12);
  $('m-next').disabled = viewMonth >= lastMonth;
  $('m-next').style.visibility = viewMonth >= lastMonth ? 'hidden' : 'visible';

  // The Today card is always about this month; the list below follows the month you're viewing.
  const curItems = costItems();
  const today = todayBreakdown(curItems);
  const goal = dailyGoal(curItems);
  recordGoal(goal);
  renderToday(curItems, today, goal);

  const bills = isCurrent ? curItems : costItems(viewMonth);
  const { gross, ms, outside } = monthGross(viewMonth);
  const totalGross = gross + outside;
  const income = monthIncome(viewMonth);
  const net = toNet(totalGross) + income; // money available for costs
  const total = bills.reduce((a, b) => a + b.usd, 0);
  const extra = Math.max(0, net - total);
  const tax = S.settings.taxEnabled;

  const stats = [
    { k: tax ? 'Earned (before tax)' : 'Earned', v: money(totalGross) },
    { k: 'Hours logged', v: fmtHours(ms) },
  ];
  if (tax) stats.push({ k: `After ${S.settings.taxRate}% set-aside`, v: money(toNet(totalGross)) });
  if (total > 0) {
    stats.push(extra > 0
      ? { k: 'Extra beyond costs', v: '+' + money(extra), cls: 'good' }
      : { k: 'Left to cover', v: money(total - net) });
  }
  $('stats').innerHTML = stats.map((s) => `<div class="stat ${s.cls || ''}"><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div></div>`).join('');

  const pct = total > 0 ? Math.min(100, (net / total) * 100) : 0;
  const big = $('big-bar');
  const bigDone = total > 0 && net >= total;
  const todayToBills = isCurrent && !bigDone ? Object.values(today.perBill).reduce((a, t) => a + t.usd, 0) : 0;
  const pctToday = total > 0 ? (todayToBills / total) * 100 : 0;
  big.children[0].style.width = Math.max(0, pct - pctToday) + '%';
  big.children[1].style.width = pctToday + '%';
  big.classList.toggle('has-today', pctToday > 0);
  big.classList.toggle('done', bigDone);
  big.hidden = total === 0;
  $('big-caption').textContent = '';

  const monthName = new Date(+viewMonth.slice(0, 4), +viewMonth.slice(5) - 1, 1).toLocaleDateString(undefined, { month: 'long' });
  const puts = allocate(net, bills);
  // Unfinished first (smallest first), paid off at the bottom.
  const rows = bills.map((b) => ({ b, put: puts[b.id], done: isDone(puts[b.id], b) }))
    .sort((x, y) => (x.done - y.done) || (x.b.usd - y.b.usd));
  const paidOff = rows.filter((r) => r.done).length;
  if (total > 0) {
    $('big-caption').textContent = `${money(Math.min(net, total))} of ${money(total)} covered · ${paidOff} of ${rows.length} paid off`
      + (income > 0 ? ` · includes ${money(income)} other income` : '')
      + (extra > 0 ? ` · ${money(extra)} extra` : '');
  }

  const rowHtml = ({ b, put, done }) => {
    // Blue = covered before today, green = added today (this month only).
    const tUsd = !done && isCurrent && today.perBill[b.id] ? today.perBill[b.id].usd : 0;
    const wToday = b.usd > 0 ? (tUsd / b.usd) * 100 : 0;
    const wBefore = done ? 100 : b.usd > 0 ? (Math.max(0, put - tUsd) / b.usd) * 100 : 100;
    const sub = done ? `${money(b.usd)} · paid off` : `${money(put)} of ${money(b.usd)}`;
    const t = isCurrent ? today.perBill[b.id] : null;
    const right = done
      ? '<span class="covered-label">Covered</span>'
      : `${money(b.usd - put)} <span class="muted">to go</span>${cadNote(b.usd - put, b, 'cad-sub')}`;
    const tag = b.kind === 'estimate' ? '<span class="kind-tag">Estimate</span>' : '';
    const due = b.kind === 'bill' && b.dueDay ? `<span class="due">due ${ordinal(b.dueDay)}</span>` : '';
    const kind = b.kind === 'oneoff' ? 'oneoff' : 'bill';
    return `<div class="bill-row tap ${done ? 'is-done' : ''}" role="button" tabindex="0" data-kind="${kind}" data-id="${b.id}" aria-label="Edit ${esc(b.name || 'item')}">
      <div class="bill-name"><div class="bn">${done ? '<span class="tick">✓</span>' : ''}${esc(b.name || 'Cost')}${tag}${due}</div><div class="bill-sub">${sub}</div></div>
      <div class="bar ${done ? 'done' : ''} ${wToday > 0 ? 'has-today' : ''}"><div style="width:${wBefore}%"></div><div class="today" style="width:${wToday}%"></div></div>
      <div class="bill-amt">${right}${t ? `<span class="today-tag">+${money(t.usd)} today</span>` : ''}</div>
    </div>`;
  };
  const section = (title, totalLabel, addKind, addLabel, items, emptyText) => `
    <div class="cost-group">
      <div class="sec-head"><h3>${title}</h3><span class="sec-total">${totalLabel}</span></div>
      ${items.length ? items.join('') : `<p class="muted small sec-empty">${emptyText}</p>`}
      <button type="button" class="add-btn" data-add="${addKind}">+ ${addLabel}</button>
    </div>`;

  const recurring = rows.filter((r) => r.b.kind !== 'oneoff');
  const extras = rows.filter((r) => r.b.kind === 'oneoff');
  const sumUsd = (list) => list.reduce((a, r) => a + r.b.usd, 0);
  const incomeItems = S.income.filter((i) => i.amount > 0 && (i.recurring || i.month === viewMonth));
  let html = section('Monthly bills', recurring.length ? `${money(sumUsd(recurring))}/mo` : '', 'bill', 'Add monthly bill',
    recurring.map(rowHtml), 'Rent, phone, insurance and anything else you pay every month.');
  html += section(`One-off expenses`, extras.length ? money(sumUsd(extras)) : '', 'oneoff', 'Add one-off expense',
    extras.map(rowHtml), `Nothing planned for ${esc(monthName)} yet. Add one-time costs like a repair or a gift.`);
  if (incomeItems.length) {
    html += `<div class="cost-group">
      <div class="sec-head"><h3>Other income</h3><span class="sec-total">${money(income)}</span></div>
      ${incomeItems.map((i) => `<div class="income-row tap" role="button" tabindex="0" data-kind="income" data-id="${i.id}" aria-label="Edit ${esc(i.name || 'income')}">
        <span>${esc(i.name || 'Income')}<span class="due">${i.recurring ? 'every month' : 'this month only'}</span></span>
        <span class="income-amt">+${money(billUsd(i))}${cadNote(billUsd(i), i)}</span>
      </div>`).join('')}
      <button type="button" class="add-btn" data-add="income">+ Add other income</button>
    </div>`;
  }
  $('cost-sections').innerHTML = html;
  $('add-income').hidden = incomeItems.length > 0;

  const fx = S.fx;
  $('fx-note').textContent = [...bills, ...incomeItems].some((b) => b.currency === 'CAD')
    ? `1 CAD = ${fx.rate.toFixed(4)} USD${fx.date ? ` · ${fx.date}` : ' · default rate'}`
    : '';
}

// ---------- History (collapsible days and weeks) ----------
//
// This week: one collapsible group per day (today open by default).
// Earlier weeks: one collapsible group per week, with collapsible days inside.
// Open/closed choices are remembered per browser under UI_KEY.

const UI_KEY = 'hourly-tracker:ui';
let uiOpen = {};
try { uiOpen = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { uiOpen = {}; }

/** Monday 00:00 of the week containing `ts`. */
function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function weekLabel(startTs) {
  const end = new Date(startTs);
  end.setDate(end.getDate() + 6);
  const s = new Date(startTs);
  const sameMonth = s.getMonth() === end.getMonth();
  const a = s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const b = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `Week of ${a} – ${b}`;
}
const isOpen = (key, dflt) => (key in uiOpen ? uiOpen[key] : dflt);
const totals = (items) => `${fmtHours(items.reduce((a, e) => a + entryMs(e), 0))} · ${money(items.reduce((a, e) => a + entryGross(e), 0))}`;

function entryRow(e) {
  const blocks = e.segments.length;
  const meta = [
    e.desc ? esc(entryProjectName(e)) : '',
    `${fmtTime(entryStart(e))} – ${fmtTime(entryEnd(e))}`,
    `${money(e.rate)}/hr`,
    blocks > 1 ? `paused ${blocks - 1}×` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="entry" data-id="${e.id}">
    <div><div class="t1">${esc(e.desc || entryProjectName(e))}</div><div class="t2">${meta}</div></div>
    <div class="dur">${fmtClock(entryMs(e))}${entryMs(e) % MINUTE >= 1000 ? `<span class="billed">${fmtHours(entryBillableMs(e))} billed</span>` : ''}</div>
    <div class="amt">${money(entryGross(e))}</div>
    <div class="acts">
      <button class="ghost" data-act="edit" aria-label="Edit entry">Edit</button>
      <button class="ghost danger-text" data-act="del" aria-label="Delete entry">Delete</button>
    </div>
  </div>`;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const e of list) { const k = keyFn(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
  return m;
}

function goalBadge(dayKey, items) {
  if (S.daysOff[dayKey]) return '<span class="goal-badge">Day off</span>';
  const goal = S.dailyGoals[dayKey];
  if (!(goal > 0)) return '';
  const earned = items.reduce((a, e) => a + entryGross(e), 0);
  return earned >= goal - 0.004
    ? `<span class="goal-badge hit" title="Goal that day: ${money(goal)}">✓ Goal</span>`
    : `<span class="goal-badge" title="Goal that day">Goal ${money(goal)}</span>`;
}

function dayGroup(dayKey, items) {
  const key = 'd:' + dayKey;
  const open = isOpen(key, dayKey === localDateStr());
  return `<details class="day-group" data-key="${key}" ${open ? 'open' : ''}>
    <summary class="day-head"><span class="chev" aria-hidden="true"></span><span class="lbl">${esc(dayLabel(entryStart(items[0])))}</span>${goalBadge(dayKey, items)}<span class="tot">${totals(items)}</span></summary>
    ${items.map(entryRow).join('')}
  </details>`;
}

function renderHistory() {
  const list = S.entries.filter((e) => monthKey(entryStart(e)) === viewMonth).sort((a, b) => entryStart(b) - entryStart(a));
  const outside = S.outside[viewMonth] || 0;
  let html = '';

  if (!list.length && !outside) {
    html = `<div class="empty">No time logged in ${esc(monthLabel(viewMonth))}.</div>`;
  } else {
    const thisWeek = weekStart(Date.now());
    const weeks = groupBy(list, (e) => weekStart(entryStart(e)));
    for (const [ws, weekItems] of weeks) {
      const days = groupBy(weekItems, (e) => localDateStr(entryStart(e)));
      const daysHtml = [...days].map(([k, items]) => dayGroup(k, items)).join('');
      if (ws === thisWeek) {
        html += `<div class="week-label"><span>This week</span><span>${totals(weekItems)}</span></div>${daysHtml}`;
      } else {
        const key = 'w:' + localDateStr(ws);
        html += `<details class="week-group" data-key="${key}" ${isOpen(key, false) ? 'open' : ''}>
          <summary class="week-head"><span class="chev" aria-hidden="true"></span><span class="lbl">${esc(weekLabel(ws))}</span><span class="tot">${totals(weekItems)}</span></summary>
          <div class="week-days">${daysHtml}</div>
        </details>`;
      }
    }
    if (outside) {
      html += `<div class="extra-line"><span>Outside earnings added for ${esc(monthLabel(viewMonth))}</span><span><b>${money(outside)}</b> <button class="ghost small-btn" id="hist-edit-outside">Edit</button></span></div>`;
    }
  }
  $('history').innerHTML = html;
  $('history').querySelectorAll('details[data-key]').forEach((d) => {
    let shown = d.open;
    d.addEventListener('toggle', () => {
      // Browsers fire "toggle" for groups rendered open; only save real changes.
      if (d.open === shown) return;
      shown = d.open;
      uiOpen[d.dataset.key] = d.open;
      try { localStorage.setItem(UI_KEY, JSON.stringify(uiOpen)); } catch (e) { /* not critical */ }
    });
  });
  const eo = $('hist-edit-outside');
  if (eo) eo.onclick = openOutside;
}

function renderProjectsList() {
  $('project-list').innerHTML = S.projects.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
}

function renderAll() {
  renderTimerButtons();
  renderTick();
  renderBills();
  renderHistory();
  renderProjectsList();
}

// ---------- Entry dialog (edit + manual add) ----------
//
// Each time block is {start, ms}. Fields only write back to a block when you
// change them, so untouched values keep their exact millisecond precision.

let editing = null; // {id|null, blocks: [{start, ms}]}

const MIN = MINUTE;
const pad2 = (n) => String(n).padStart(2, '0');
const timeOfDay = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const totalBlockMs = () => editing.blocks.reduce((a, b) => a + b.ms, 0);

/** Same calendar day as `ts`, at the "HH:MM" given. */
function setTimeOfDay(ts, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  const d = new Date(ts);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function openEntry(id) {
  const e = id ? S.entries.find((x) => x.id === id) : null;
  const roundedNow = Math.floor(Date.now() / MIN) * MIN;
  editing = {
    id: e?.id || null,
    blocks: e
      ? e.segments.map((s) => ({ start: s.start, ms: s.end - s.start })).sort((a, b) => a.start - b.start)
      : [{ start: roundedNow - HOUR, ms: HOUR }],
  };
  $('entry-title').textContent = e ? 'Edit entry' : 'Add time';
  $('e-desc').value = e?.desc || '';
  $('e-project').value = e ? (projectById(e.projectId)?.name || e.projectName || '') : $('t-project').value;
  $('e-rate').value = e ? e.rate : currentRate();
  $('e-error').textContent = '';
  renderEntryEditor();
  $('entry-dialog').showModal();
  $('e-m').focus();
  $('e-m').select();
}

function renderDateOptions() {
  const sel = localDateStr(editing.blocks[0].start);
  const opts = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < 120; i++) {
    const k = localDateStr(d.getTime());
    opts.push([k, i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })]);
    d.setDate(d.getDate() - 1);
  }
  if (!opts.some(([k]) => k === sel)) {
    opts.push([sel, new Date(editing.blocks[0].start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })]);
  }
  $('e-date').innerHTML = opts.map(([k, label]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(label)}</option>`).join('');
}

function fillDuration() {
  const totalMin = Math.floor(totalBlockMs() / MIN);
  $('e-h').value = Math.floor(totalMin / 60);
  $('e-m').value = totalMin % 60;
}

function renderEntryEditor() {
  const multi = editing.blocks.length > 1;
  renderDateOptions();
  $('e-start-wrap').hidden = multi;
  $('e-start').value = timeOfDay(editing.blocks[0].start);
  $('e-dur-label').textContent = multi ? 'Total duration (changes the last block)' : 'Duration';
  fillDuration();
  $('e-blocks').innerHTML = multi
    ? `<div class="blocks-head">Time blocks · paused ${editing.blocks.length - 1}×</div>` + editing.blocks.map((b, i) => {
        const min = Math.floor(b.ms / MIN);
        return `<div class="block-row" data-i="${i}">
          <span class="bl">Block ${i + 1}</span>
          <input type="time" step="60" data-k="start" value="${timeOfDay(b.start)}" aria-label="Block ${i + 1} start time">
          <input type="number" min="0" step="1" inputmode="numeric" data-k="h" value="${Math.floor(min / 60)}" aria-label="Block ${i + 1} hours"><span>h</span>
          <input type="number" min="0" step="1" inputmode="numeric" data-k="m" value="${min % 60}" aria-label="Block ${i + 1} minutes"><span>m</span>
          <button type="button" class="ghost danger-text" data-rm="${i}" aria-label="Remove block ${i + 1}">✕</button>
        </div>`;
      }).join('')
    : '';
  updateEntrySummary();
}

function readMinutes(hEl, mEl) {
  const h = parseInt(hEl.value || '0', 10);
  const m = parseInt(mEl.value || '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return NaN;
  return h * 60 + m;
}

/** Set the entry's total duration. With several blocks, the last block absorbs the change. */
function setTotalMs(ms) {
  if (editing.blocks.length === 1) { editing.blocks[0].ms = ms; return true; }
  const last = editing.blocks[editing.blocks.length - 1];
  const others = totalBlockMs() - last.ms;
  if (ms - others <= 0) return false;
  last.ms = ms - others;
  return true;
}

function updateEntrySummary() {
  const blocks = editing.blocks;
  const ms = totalBlockMs();
  const rate = parseFloat($('e-rate').value) || 0;
  const last = blocks[blocks.length - 1];
  const ok = blocks.every((b) => Number.isFinite(b.start) && b.ms > 0);
  $('e-summary').textContent = ok
    ? `${fmtTime(blocks[0].start)} – ${fmtTime(last.start + last.ms)} · ${fmtClock(ms)}${ms % MINUTE ? ` (${fmtHours(billableMs(ms))} billed)` : ''} · ${money((billableMs(ms) / HOUR) * rate)}`
    : '';
}

function onEntryField(ev) {
  const t = ev.target;
  $('e-error').textContent = '';
  if (t.id === 'e-date') {
    const oldDay = new Date(localDateStr(editing.blocks[0].start) + 'T12:00:00');
    const newDay = new Date(t.value + 'T12:00:00');
    const diff = Math.round((newDay - oldDay) / 86400e3);
    editing.blocks.forEach((b) => { const d = new Date(b.start); d.setDate(d.getDate() + diff); b.start = d.getTime(); });
  } else if (t.id === 'e-start') {
    const v = setTimeOfDay(editing.blocks[0].start, t.value);
    if (Number.isFinite(v)) editing.blocks[0].start = v;
  } else if (t.id === 'e-h' || t.id === 'e-m') {
    const min = readMinutes($('e-h'), $('e-m'));
    if (Number.isFinite(min) && min > 0) {
      if (!setTotalMs(min * MIN)) $('e-error').textContent = "That's shorter than the earlier blocks. Edit or remove a block instead.";
      else syncBlockRows();
    }
  } else if (t.closest('.block-row')) {
    const row = t.closest('.block-row');
    const b = editing.blocks[+row.dataset.i];
    if (t.dataset.k === 'start') {
      const v = setTimeOfDay(editing.blocks[0].start, t.value);
      if (Number.isFinite(v)) {
        b.start = v;
        // A block that starts "earlier" than the previous one ran past midnight.
        const prev = editing.blocks[+row.dataset.i - 1];
        if (prev && b.start < prev.start) b.start += 86400e3;
      }
    } else {
      const min = readMinutes(row.querySelector('[data-k=h]'), row.querySelector('[data-k=m]'));
      if (Number.isFinite(min) && min > 0) b.ms = min * MIN;
    }
    if (document.activeElement !== $('e-h') && document.activeElement !== $('e-m')) fillDuration();
  }
  updateEntrySummary();
}

/** Refresh block rows' duration fields after the total changed (keeps focus where it is). */
function syncBlockRows() {
  $('e-blocks').querySelectorAll('.block-row').forEach((row) => {
    const min = Math.floor(editing.blocks[+row.dataset.i].ms / MIN);
    row.querySelector('[data-k=h]').value = Math.floor(min / 60);
    row.querySelector('[data-k=m]').value = min % 60;
  });
}

function stepMinutes(delta) {
  const cur = readMinutes($('e-h'), $('e-m'));
  const next = (Number.isFinite(cur) ? cur : Math.floor(totalBlockMs() / MIN)) + delta;
  if (next < 1) return;
  if (!setTotalMs(next * MIN)) { $('e-error').textContent = "That's shorter than the earlier blocks. Edit or remove a block instead."; return; }
  $('e-error').textContent = '';
  fillDuration();
  syncBlockRows();
  updateEntrySummary();
}

function saveEntry(ev) {
  ev.preventDefault();
  const err = $('e-error');
  const rate = parseFloat($('e-rate').value);
  if (!Number.isFinite(rate) || rate < 0) { err.textContent = 'Enter an hourly rate.'; return; }
  const totalMin = readMinutes($('e-h'), $('e-m'));
  if (!Number.isFinite(totalMin) || totalMin < 1) { err.textContent = 'Enter a duration of at least 1 minute.'; return; }
  for (const b of editing.blocks) {
    if (!Number.isFinite(b.start)) { err.textContent = 'Enter a start time.'; return; }
    if (!(b.ms > 0)) { err.textContent = 'Each time block needs at least 1 minute.'; return; }
  }
  const segments = editing.blocks.map((b) => ({ start: b.start, end: b.start + b.ms })).sort((a, b) => a.start - b.start);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) { err.textContent = "Two time blocks overlap. Adjust a start time so they don't double-count."; return; }
  }
  const p = upsertProject($('e-project').value, rate);
  const data = { projectId: p?.id || null, projectName: p?.name || '', rate, desc: $('e-desc').value.trim(), segments };
  if (editing.id) Object.assign(S.entries.find((x) => x.id === editing.id), data);
  else S.entries.push({ id: uid(), ...data });
  viewMonth = monthKey(segments[0].start);
  save();
  $('entry-dialog').close();
  renderAll();
}

function deleteEntry(id) {
  const i = S.entries.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [removed] = S.entries.splice(i, 1);
  save();
  renderAll();
  toast('Entry deleted', () => { S.entries.push(removed); save(); renderAll(); });
}

// ---------- Days off ----------

let calMonth = null;

/** Weekdays taken off from today through the end of this month. */
function upcomingDaysOff() {
  const today = localDateStr();
  const month = today.slice(0, 7);
  return Object.keys(S.daysOff).filter((k) => S.daysOff[k] && k >= today && k.startsWith(month)).length;
}

function openDaysOff() {
  calMonth = monthKey(Date.now());
  renderCal();
  $('daysoff-dialog').showModal();
}

function renderCal() {
  const [y, m] = calMonth.split('-').map(Number);
  const todayStr = localDateStr();
  const isCurrent = calMonth === monthKey(Date.now());
  $('cal-label').textContent = monthLabel(calMonth);
  $('cal-prev').style.visibility = isCurrent ? 'hidden' : 'visible';
  $('cal-next').style.visibility = calMonth >= shiftMonth(monthKey(Date.now()), 12) ? 'hidden' : 'visible';

  const d = new Date(y, m - 1, 1, 12);
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => `<div class="cal-h">${n}</div>`).join('');
  html += '<div></div>'.repeat((d.getDay() + 6) % 7);
  let work = 0, workLeft = 0, off = 0;
  while (d.getMonth() === m - 1) {
    const k = localDateStr(d.getTime());
    const wd = isWeekday(d.getTime());
    const past = k < todayStr;
    const isOff = wd && !!S.daysOff[k];
    if (wd) { if (isOff) off++; else { work++; if (!past) workLeft++; } }
    const cls = `cal-d ${wd ? 'wd' : 'we'}${isOff ? ' off' : ''}${past ? ' past' : ''}${k === todayStr ? ' today' : ''}`;
    const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const inner = `${d.getDate()}${isOff ? '<span>Off</span>' : k === todayStr ? '<span>Today</span>' : ''}`;
    html += wd && !past
      ? `<button type="button" class="${cls}" data-date="${k}" aria-pressed="${isOff}" aria-label="${esc(label)}${isOff ? ', day off' : ''}">${inner}</button>`
      : `<div class="${cls}">${inner}</div>`;
    d.setDate(d.getDate() + 1);
  }
  $('cal-grid').innerHTML = html;
  const parts = [isCurrent ? `${workLeft} workday${workLeft === 1 ? '' : 's'} left this month` : `${work} workday${work === 1 ? '' : 's'}`];
  if (off) parts.push(`${off} day${off === 1 ? '' : 's'} off`);
  if (isCurrent) {
    const g = dailyGoal(costItems());
    if (g.workday && g.target > 0) parts.push(`today's goal ${money(g.target)}`);
  }
  $('cal-summary').textContent = parts.join(' · ');
}

function toggleDayOff(k) {
  if (S.daysOff[k]) delete S.daysOff[k];
  else {
    S.daysOff[k] = true;
    delete S.dailyGoals[k]; // a day off has no goal
  }
  save();
  renderCal();
  renderBills();
  renderHistory();
}

// ---------- Bill / expense / income form ----------
//
// One small form for everything in the bills card:
//   bill    -> S.bills   (kind 'bill', or 'estimate' when the amount varies)
//   oneoff  -> S.oneOffs (extra expense for one month: the month being viewed)
//   income  -> S.income  (every month, or one month only)

let editingItem = null; // {kind, id|null, month}

function costStore(kind) { return kind === 'oneoff' ? S.oneOffs : kind === 'income' ? S.income : S.bills; }

function openItem(kind, id) {
  const it = id ? costStore(kind).find((x) => x.id === id) : null;
  const month = it?.month || viewMonth;
  editingItem = { kind, id: it?.id || null, month };
  const label = monthLabel(month);
  const titles = {
    bill: ['Add monthly bill', 'Edit monthly bill'],
    oneoff: [`Add one-off expense for ${label}`, 'Edit one-off expense'],
    income: ['Add other income', 'Edit other income'],
  };
  const placeholders = { bill: 'Rent', oneoff: 'Car repair', income: 'Side gig' };
  $('item-title').textContent = titles[kind][it ? 1 : 0];
  $('i-name').value = it?.name || '';
  $('i-name').placeholder = placeholders[kind];
  $('i-amount').value = it?.amount || '';
  $('i-currency').value = it?.currency || (kind === 'income' ? 'USD' : 'CAD');
  $('i-bill-extra').hidden = kind !== 'bill';
  $('i-category').value = it?.category || '';
  $('i-due').value = it?.dueDay || '';
  $('i-varies').checked = it?.kind === 'estimate';
  $('i-when-wrap').hidden = kind !== 'income';
  $('i-when-once').textContent = `Only in ${label}`;
  $('i-when').value = it && !it.recurring ? '0' : '1';
  $('i-note').textContent = kind === 'oneoff' ? `Only counts in ${label}.` : kind === 'income' ? 'After tax. It lowers what you need to earn.' : '';
  $('i-delete').hidden = !it;
  $('i-error').textContent = '';
  $('item-dialog').showModal();
  $('i-name').focus();
}

function saveItem(ev) {
  ev.preventDefault();
  const name = $('i-name').value.trim();
  const amount = parseFloat($('i-amount').value);
  if (!name) { $('i-error').textContent = 'Enter a name.'; return; }
  if (!Number.isFinite(amount) || amount <= 0) { $('i-error').textContent = 'Enter an amount above 0.'; return; }
  const { kind, id, month } = editingItem;
  const store = costStore(kind);
  const data = { name, amount: Math.round(amount * 100) / 100, currency: $('i-currency').value };
  if (kind === 'bill') {
    const due = parseInt($('i-due').value, 10);
    Object.assign(data, {
      kind: $('i-varies').checked ? 'estimate' : 'bill',
      category: $('i-category').value.trim(),
      dueDay: due >= 1 && due <= 31 ? due : null,
    });
  } else if (kind === 'oneoff') {
    data.month = month;
  } else {
    data.recurring = $('i-when').value === '1';
    data.month = data.recurring ? undefined : month;
  }
  if (id) Object.assign(store.find((x) => x.id === id), data);
  else store.push({ id: uid(), ...data });
  save();
  $('item-dialog').close();
  renderBills();
}

function deleteItem() {
  const { kind, id } = editingItem;
  const store = costStore(kind);
  const i = store.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [removed] = store.splice(i, 1);
  save();
  $('item-dialog').close();
  renderBills();
  toast(`${removed.name} removed`, () => { store.splice(i, 0, removed); save(); renderBills(); });
}

// ---------- Outside earnings ----------

function openOutside() {
  $('extra-help').textContent = `Money you earned in ${monthLabel(viewMonth)} that isn't logged here, like hours tracked before you started using this app. It counts toward that month's bills.`;
  $('x-amount').value = S.outside[viewMonth] || '';
  $('extra-dialog').showModal();
}
function saveOutside(ev) {
  ev.preventDefault();
  const v = parseFloat($('x-amount').value);
  if (Number.isFinite(v) && v > 0) S.outside[viewMonth] = Math.round(v * 100) / 100;
  else delete S.outside[viewMonth];
  save();
  $('extra-dialog').close();
  renderAll();
}

// ---------- Settings ----------

function openSettings() {
  renderProjectsEditor();
  $('s-alloc').value = S.settings.allocation;
  $('s-tax-on').checked = S.settings.taxEnabled;
  $('s-tax-rate').value = S.settings.taxRate;
  $('s-tax-rate').disabled = !S.settings.taxEnabled;
  renderFxSetting();
  $('settings-dialog').showModal();
}

function renderFxSetting() {
  const fx = S.fx;
  $('s-fx').textContent = fx.date
    ? `1 CAD = ${fx.rate.toFixed(4)} USD (European Central Bank rate from ${fx.date}). Updates once a day automatically.`
    : `Using a default of 1 CAD = ${fx.rate} USD until a live rate can be loaded.`;
}

function renderProjectsEditor() {
  $('projects-edit').innerHTML = S.projects.length ? S.projects.map((p) => `
    <div class="edit-row project" data-id="${p.id}">
      <input type="text" data-k="name" value="${esc(p.name)}" aria-label="Project name">
      <input type="number" data-k="rate" value="${p.rate}" min="0" step="0.5" inputmode="decimal" aria-label="Rate">
      <button type="button" class="ghost danger-text" data-del aria-label="Delete project">✕</button>
    </div>`).join('') : '<p class="muted small">Projects are added automatically when you start a timer with a new project name.</p>';
}

function onProjectsEdit(ev) {
  const row = ev.target.closest('.edit-row');
  if (!row) return;
  const p = S.projects.find((x) => x.id === row.dataset.id);
  if (!p) return;
  if (ev.type === 'click' && ev.target.closest('[data-del]')) {
    const i = S.projects.indexOf(p);
    S.projects.splice(i, 1); // entries keep their projectName snapshot
    save(); renderProjectsEditor(); renderAll();
    toast(`${p.name} removed (its time entries stay)`, () => { S.projects.splice(i, 0, p); save(); renderProjectsEditor(); renderAll(); });
    return;
  }
  const k = ev.target.dataset.k;
  if (k === 'rate') { const v = parseFloat(ev.target.value); if (Number.isFinite(v) && v >= 0) p.rate = v; }
  else if (k === 'name' && ev.target.value.trim()) {
    p.name = ev.target.value.trim();
    S.entries.forEach((e) => { if (e.projectId === p.id) e.projectName = p.name; });
  }
  save(); renderAll();
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  download(`hourly-backup-${localDateStr()}.json`, JSON.stringify(S, null, 2), 'application/json');
}

function exportCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Start', 'End', 'Project', 'Description', 'Hours worked', 'Hours billed', 'Rate (USD)', 'Earned (USD)', 'Time blocks']];
  [...S.entries].sort((a, b) => entryStart(a) - entryStart(b)).forEach((e) => {
    rows.push([
      localDateStr(entryStart(e)), toLocalInput(entryStart(e)).replace('T', ' '), toLocalInput(entryEnd(e)).replace('T', ' '),
      entryProjectName(e), e.desc, (entryMs(e) / HOUR).toFixed(4), (entryBillableMs(e) / HOUR).toFixed(4), e.rate.toFixed(2), entryGross(e).toFixed(2), e.segments.length,
    ]);
  });
  download(`hourly-time-${localDateStr()}.csv`, rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s || s.version !== 1 || !Array.isArray(s.entries)) throw new Error('bad');
      if (!confirm(`Replace everything in this browser with this backup (${s.entries.length} time entries)?`)) return;
      const prev = S;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      S = load();
      save();
      syncTimerInputs();
      $('settings-dialog').close();
      renderAll();
      toast('Backup imported', () => { S = prev; save(); renderAll(); });
    } catch (e) {
      alert("That file isn't a Hourly backup.");
    }
  };
  reader.readAsText(file);
}

// ---------- Exchange rate ----------

async function refreshFx(force = false) {
  const today = localDateStr();
  if (!force && S.fx.fetchedOn === today) return true;
  const sources = [
    'https://api.frankfurter.dev/v1/latest?base=CAD&symbols=USD',
    'https://api.frankfurter.app/latest?from=CAD&to=USD',
  ];
  for (const url of sources) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      const rate = j?.rates?.USD;
      if (typeof rate === 'number' && rate > 0) {
        S.fx = { rate, date: j.date || today, fetchedOn: today };
        save();
        renderBills();
        renderFxSetting();
        return true;
      }
    } catch (e) { /* try next source */ }
  }
  return false;
}

// ---------- Toast ----------

let toastTimer = null, toastUndo = null;
function toast(msg, undo) {
  $('toast-msg').textContent = msg;
  toastUndo = undo || null;
  $('toast-undo').hidden = !undo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; toastUndo = null; }, 7000);
}

// ---------- Wiring ----------

function wire() {
  $('t-go').onclick = timerGo;
  $('t-stop').onclick = timerStop;
  $('t-discard').onclick = timerDiscard;
  $('t-desc').addEventListener('input', onTimerInput);
  $('t-rate').addEventListener('input', onTimerInput);
  $('t-project').addEventListener('input', () => {
    const p = projectByName($('t-project').value);
    if (p) $('t-rate').value = p.rate;
    onTimerInput();
  });

  $('m-prev').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); renderBills(); renderHistory(); };
  $('m-next').onclick = () => { if (viewMonth < shiftMonth(monthKey(Date.now()), 12)) { viewMonth = shiftMonth(viewMonth, 1); renderBills(); renderHistory(); } };

  $('s-alloc').onchange = (e) => { S.settings.allocation = e.target.value; save(); renderBills(); };
  $('add-income').onclick = () => openItem('income', null);
  const onCostTap = (ev) => {
    const add = ev.target.closest('[data-add]');
    if (add) return openItem(add.dataset.add, null);
    const row = ev.target.closest('.tap');
    if (row) openItem(row.dataset.kind, row.dataset.id);
  };
  $('cost-sections').addEventListener('click', onCostTap);
  $('cost-sections').addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('tap')) { ev.preventDefault(); onCostTap(ev); } });
  $('open-extra').onclick = openOutside;
  $('open-settings').onclick = openSettings;
  $('add-manual').onclick = () => openEntry(null);

  $('history').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.entry').dataset.id;
    if (btn.dataset.act === 'edit') openEntry(id);
    else deleteEntry(id);
  });

  // Entry dialog
  $('entry-form').addEventListener('submit', saveEntry);
  $('entry-form').addEventListener('input', (ev) => { if (ev.target.closest('#e-date, #e-start, #e-h, #e-m, .block-row')) onEntryField(ev); });
  $('e-date').addEventListener('change', onEntryField);
  ['e-h', 'e-m'].forEach((id) => $(id).addEventListener('blur', () => { if (Number.isFinite(readMinutes($('e-h'), $('e-m')))) fillDuration(); }));
  $('entry-form').querySelectorAll('[data-step]').forEach((btn) => { btn.onclick = () => stepMinutes(+btn.dataset.step); });
  $('e-blocks').addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (!rm || editing.blocks.length < 2) return;
    editing.blocks.splice(+rm.dataset.rm, 1);
    renderEntryEditor();
  });
  $('e-add-seg').onclick = () => {
    const last = editing.blocks[editing.blocks.length - 1];
    editing.blocks.push({ start: last.start + last.ms + 15 * MIN, ms: 30 * MIN });
    renderEntryEditor();
  };
  $('e-rate').addEventListener('input', () => { $('e-error').textContent = ''; updateEntrySummary(); });
  $('e-project').addEventListener('input', () => {
    const p = projectByName($('e-project').value);
    if (p && !editing.id) { $('e-rate').value = p.rate; updateEntrySummary(); }
  });

  // Bill / expense / income form
  $('item-form').addEventListener('submit', saveItem);
  $('i-delete').onclick = deleteItem;
  $('item-form').addEventListener('input', () => { $('i-error').textContent = ''; });

  // Outside earnings
  $('extra-form').addEventListener('submit', saveOutside);

  // Days off
  $('today-body').addEventListener('click', (ev) => { if (ev.target.closest('[data-open-daysoff]')) openDaysOff(); });
  $('cal-grid').addEventListener('click', (ev) => { const b = ev.target.closest('[data-date]'); if (b) toggleDayOff(b.dataset.date); });
  $('cal-prev').onclick = () => { calMonth = shiftMonth(calMonth, -1); renderCal(); };
  $('cal-next').onclick = () => { calMonth = shiftMonth(calMonth, 1); renderCal(); };

  // Settings
  $('projects-edit').addEventListener('change', onProjectsEdit);
  $('projects-edit').addEventListener('click', onProjectsEdit);
  $('project-add').onclick = () => {
    S.projects.push({ id: uid(), name: 'New project', rate: 30 });
    save(); renderProjectsEditor(); renderProjectsList();
    const inputs = $('projects-edit').querySelectorAll('input[data-k="name"]');
    inputs[inputs.length - 1]?.select();
  };
  $('s-tax-on').onchange = (e) => { S.settings.taxEnabled = e.target.checked; $('s-tax-rate').disabled = !e.target.checked; save(); renderBills(); };
  $('s-tax-rate').oninput = (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { S.settings.taxRate = Math.min(90, Math.max(0, v)); save(); renderBills(); } };
  $('s-fx-refresh').onclick = async () => {
    $('s-fx-refresh').textContent = 'Refreshing…';
    const ok = await refreshFx(true);
    $('s-fx-refresh').textContent = 'Refresh rate';
    if (!ok) toast("Couldn't load the exchange rate. Check your connection.");
  };
  $('s-export').onclick = exportJson;
  $('s-csv').onclick = exportCsv;
  $('s-import').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };

  // Close buttons + click outside to close
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d || ev.target.closest('[data-close]')) d.close(); });
  });

  $('toast-undo').onclick = () => { if (toastUndo) toastUndo(); toastUndo = null; $('toast').hidden = true; };

  // Another tab changed the data: reload it.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    S = load();
    syncTimerInputs();
    renderAll();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAll(); refreshFx(); } });
}

// Live clock: redraw 4x a second (display only — time comes from timestamps).
let lastBillsRender = 0;
setInterval(() => {
  if (!S.timer) return;
  renderTick();
  if (timerRunning() && Date.now() - lastBillsRender > 5000) {
    lastBillsRender = Date.now();
    renderBills();
  }
}, 250);

wire();
syncTimerInputs();
save();
renderAll();
refreshFx();
