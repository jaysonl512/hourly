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

// ---------- State ----------

function blankState() {
  return {
    version: 1,
    projects: [],          // {id, name, rate}
    bills: [],             // {id, name, amount, currency: 'CAD'|'USD'}
    entries: [],           // {id, projectId, projectName, rate, desc, segments: [{start, end}]}
    outside: {},           // {'2026-11': 1234.56} USD earned outside the app, per month
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
const fmtBill = (amount, currency) => (currency === 'CAD' ? cad : usd).format(amount);
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
  const m = Math.round(ms / 60000);
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
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
// datetime-local <-> timestamp (local time, seconds precision)
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fromLocalInput(v) {
  if (!v) return NaN;
  return new Date(v).getTime(); // "YYYY-MM-DDTHH:MM[:SS]" parses as local time
}

const segMs = (seg, now = Date.now()) => (seg.end ?? now) - seg.start;
const entryMs = (e) => e.segments.reduce((a, s) => a + segMs(s), 0);
const entryStart = (e) => Math.min(...e.segments.map((s) => s.start));
const entryEnd = (e) => Math.max(...e.segments.map((s) => s.end));
const entryGross = (e) => (entryMs(e) / HOUR) * e.rate;

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
  $('t-earn').textContent = money((ms / HOUR) * (S.timer ? S.timer.rate : currentRate()));
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

function monthGross(key) {
  let g = 0, ms = 0;
  for (const e of S.entries) {
    if (monthKey(entryStart(e)) === key) { g += entryGross(e); ms += entryMs(e); }
  }
  if (S.timer && monthKey(S.timer.segments[0].start) === key) {
    const t = timerMs(); ms += t; g += (t / HOUR) * S.timer.rate;
  }
  return { gross: g, ms, outside: S.outside[key] || 0 };
}

function renderBills() {
  $('m-label').textContent = monthLabel(viewMonth);
  $('m-next').disabled = viewMonth >= monthKey(Date.now());
  $('m-next').style.visibility = viewMonth >= monthKey(Date.now()) ? 'hidden' : 'visible';

  const { gross, ms, outside } = monthGross(viewMonth);
  const totalGross = gross + outside;
  const net = toNet(totalGross);
  const bills = S.bills.map((b) => ({ ...b, usd: billUsd(b) })).sort((a, b) => a.usd - b.usd);
  const total = bills.reduce((a, b) => a + b.usd, 0);
  const extra = Math.max(0, net - total);
  const tax = S.settings.taxEnabled;

  const stats = [
    { k: tax ? 'Earned (before tax)' : 'Earned', v: money(totalGross) },
    { k: 'Hours logged', v: fmtHours(ms) },
  ];
  if (tax) stats.push({ k: `After ${S.settings.taxRate}% set-aside`, v: money(net) });
  if (total > 0) {
    stats.push(extra > 0
      ? { k: 'Extra beyond bills', v: '+' + money(extra), cls: 'good' }
      : { k: 'Left to cover bills', v: money(total - net) });
  }
  $('stats').innerHTML = stats.map((s) => `<div class="stat ${s.cls || ''}"><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div></div>`).join('');

  const pct = total > 0 ? Math.min(100, (net / total) * 100) : 0;
  const big = $('big-bar');
  big.firstElementChild.style.width = pct + '%';
  big.classList.toggle('done', total > 0 && net >= total);
  big.hidden = total === 0;
  $('big-caption').textContent = total > 0
    ? `${money(Math.min(net, total))} of ${money(total)} in bills (${Math.floor(pct)}%)${extra > 0 ? ` · ${money(extra)} extra` : ''}`
    : '';

  const alloc = S.settings.allocation;
  $('alloc-smallest').classList.toggle('on', alloc === 'smallest');
  $('alloc-prop').classList.toggle('on', alloc === 'proportional');
  $('alloc-smallest').setAttribute('aria-pressed', alloc === 'smallest');
  $('alloc-prop').setAttribute('aria-pressed', alloc === 'proportional');

  if (!bills.length) {
    $('covered').textContent = '';
    $('bill-list').innerHTML = `<div class="empty">Add your monthly bills to see how close you are to covering them.<br><button class="primary" id="empty-add-bills">Add bills</button></div>`;
    $('empty-add-bills').onclick = openBills;
  } else {
    let left = net, covered = 0;
    $('bill-list').innerHTML = bills.map((b) => {
      let put;
      if (alloc === 'smallest') { put = Math.min(left, b.usd); left -= put; }
      else put = total > 0 ? Math.min(b.usd, net * (b.usd / total)) : 0;
      put = Math.max(0, put);
      const done = b.usd <= 0 || put >= b.usd - 0.005;
      if (done) covered++;
      const w = b.usd > 0 ? (put / b.usd) * 100 : 100;
      const sub = b.currency === 'CAD' ? `<span class="sub">≈ ${money(b.usd)} USD</span>` : '';
      return `<div class="bill-row">
        <div class="bill-name">${done ? '<span class="tick">✓</span>' : ''}${esc(b.name)}</div>
        <div class="bar ${done ? 'done' : ''}"><div style="width:${w}%"></div></div>
        <div class="bill-amt"><span class="pill">${b.currency}</span>${esc(fmtBill(b.amount, b.currency))}${sub}</div>
      </div>`;
    }).join('');
    $('covered').textContent = `${covered} of ${bills.length} bills covered`;
  }

  const fx = S.fx;
  $('fx-note').textContent = S.bills.some((b) => b.currency === 'CAD')
    ? `1 CAD = ${fx.rate.toFixed(4)} USD${fx.date ? ` · ${fx.date}` : ' · default rate'}`
    : '';
}

function renderHistory() {
  const list = S.entries.filter((e) => monthKey(entryStart(e)) === viewMonth).sort((a, b) => entryStart(b) - entryStart(a));
  const outside = S.outside[viewMonth] || 0;
  let html = '';

  if (!list.length && !outside) {
    html = `<div class="empty">No time logged in ${esc(monthLabel(viewMonth))}.</div>`;
  } else {
    const days = new Map();
    for (const e of list) {
      const k = localDateStr(entryStart(e));
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(e);
    }
    for (const [, items] of days) {
      const dms = items.reduce((a, e) => a + entryMs(e), 0);
      const dg = items.reduce((a, e) => a + entryGross(e), 0);
      html += `<div class="day-head"><span>${esc(dayLabel(entryStart(items[0])))}</span><span>${fmtHours(dms)} · ${money(dg)}</span></div>`;
      for (const e of items) {
        const blocks = e.segments.length;
        const meta = [
          e.desc ? esc(entryProjectName(e)) : '',
          `${fmtTime(entryStart(e))} – ${fmtTime(entryEnd(e))}`,
          `${money(e.rate)}/hr`,
          blocks > 1 ? `paused ${blocks - 1}×` : '',
        ].filter(Boolean).join(' · ');
        html += `<div class="entry" data-id="${e.id}">
          <div><div class="t1">${esc(e.desc || entryProjectName(e))}</div><div class="t2">${meta}</div></div>
          <div class="dur">${fmtClock(entryMs(e))}</div>
          <div class="amt">${money(entryGross(e))}</div>
          <div class="acts">
            <button class="ghost" data-act="edit" aria-label="Edit entry">Edit</button>
            <button class="ghost danger-text" data-act="del" aria-label="Delete entry">Delete</button>
          </div>
        </div>`;
      }
    }
    if (outside) {
      html += `<div class="extra-line"><span>Outside earnings added for ${esc(monthLabel(viewMonth))}</span><span><b>${money(outside)}</b> <button class="ghost small-btn" id="hist-edit-outside">Edit</button></span></div>`;
    }
  }
  $('history').innerHTML = html;
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

let editing = null; // {id|null, segments:[{start,end, origStart, origEnd}]}

function openEntry(id) {
  const e = id ? S.entries.find((x) => x.id === id) : null;
  const now = Date.now();
  const roundedNow = Math.floor(now / 60000) * 60000;
  editing = {
    id: e?.id || null,
    segments: e
      ? e.segments.map((s) => ({ start: s.start, end: s.end }))
      : [{ start: roundedNow - HOUR, end: roundedNow }],
  };
  $('entry-title').textContent = e ? 'Edit entry' : 'Add time';
  $('e-desc').value = e?.desc || '';
  $('e-project').value = e ? (projectById(e.projectId)?.name || e.projectName || '') : $('t-project').value;
  $('e-rate').value = e ? e.rate : currentRate();
  $('e-error').textContent = '';
  renderSegEditor();
  $('entry-dialog').showModal();
}

function renderSegEditor() {
  const multi = editing.segments.length > 1;
  $('e-segments').innerHTML = editing.segments.map((s, i) => `
    <div class="seg-row" data-i="${i}">
      <label class="field"><span>Start</span><input type="datetime-local" step="1" data-k="start" value="${toLocalInput(s.start)}" required></label>
      <label class="field"><span>End</span><input type="datetime-local" step="1" data-k="end" value="${toLocalInput(s.end)}" required></label>
      <button type="button" class="ghost danger-text" data-rm="${i}" aria-label="Remove time block" ${multi ? '' : 'hidden'}>✕</button>
    </div>`).join('');
  updateSegSummary();
}

/** Read inputs back into editing.segments. Untouched inputs keep their exact original millisecond value. */
function readSegInputs() {
  $('e-segments').querySelectorAll('.seg-row').forEach((row) => {
    const seg = editing.segments[+row.dataset.i];
    row.querySelectorAll('input').forEach((inp) => {
      const k = inp.dataset.k;
      if (inp.value !== toLocalInput(seg[k])) seg[k] = fromLocalInput(inp.value);
    });
  });
}

function updateSegSummary() {
  readSegInputs();
  const ok = editing.segments.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const ms = editing.segments.reduce((a, s) => a + (s.end > s.start ? s.end - s.start : 0), 0);
  const rate = parseFloat($('e-rate').value) || 0;
  $('e-summary').textContent = ok ? `Total ${fmtClock(ms)} · ${money((ms / HOUR) * rate)}` : '';
}

function saveEntry(ev) {
  ev.preventDefault();
  readSegInputs();
  const err = $('e-error');
  const rate = parseFloat($('e-rate').value);
  if (!Number.isFinite(rate) || rate < 0) { err.textContent = 'Enter an hourly rate.'; return; }
  for (const s of editing.segments) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) { err.textContent = 'Fill in every start and end time.'; return; }
    if (s.end <= s.start) { err.textContent = 'Each end time has to be after its start time.'; return; }
  }
  const segments = editing.segments.map((s) => ({ start: s.start, end: s.end })).sort((a, b) => a.start - b.start);
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) { err.textContent = 'Two time blocks overlap. Adjust them so they don\'t double-count.'; return; }
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

// ---------- Bills dialog ----------

function openBills() { renderBillsEditor(); $('bills-dialog').showModal(); }

function renderBillsEditor() {
  $('bills-edit').innerHTML = S.bills.length ? S.bills.map((b) => `
    <div class="edit-row bill" data-id="${b.id}">
      <input type="text" data-k="name" value="${esc(b.name)}" placeholder="Bill name" aria-label="Bill name">
      <input type="number" data-k="amount" value="${b.amount}" min="0" step="0.01" inputmode="decimal" aria-label="Amount">
      <select data-k="currency" aria-label="Currency"><option ${b.currency === 'CAD' ? 'selected' : ''}>CAD</option><option ${b.currency === 'USD' ? 'selected' : ''}>USD</option></select>
      <button type="button" class="ghost danger-text" data-del aria-label="Delete bill">✕</button>
    </div>`).join('') : '<p class="muted small">No bills yet.</p>';
}

function onBillsEdit(ev) {
  const row = ev.target.closest('.edit-row');
  if (!row) return;
  const b = S.bills.find((x) => x.id === row.dataset.id);
  if (!b) return;
  if (ev.type === 'click' && ev.target.closest('[data-del]')) {
    const i = S.bills.indexOf(b);
    S.bills.splice(i, 1);
    save(); renderBillsEditor(); renderBills();
    toast(`${b.name || 'Bill'} removed`, () => { S.bills.splice(i, 0, b); save(); renderBillsEditor(); renderBills(); });
    return;
  }
  const k = ev.target.dataset.k;
  if (!k) return;
  if (k === 'amount') { const v = parseFloat(ev.target.value); b.amount = Number.isFinite(v) && v >= 0 ? v : 0; }
  else b[k] = ev.target.value;
  save(); renderBills();
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
  const rows = [['Date', 'Start', 'End', 'Project', 'Description', 'Hours', 'Rate (USD)', 'Earned (USD)', 'Time blocks']];
  [...S.entries].sort((a, b) => entryStart(a) - entryStart(b)).forEach((e) => {
    rows.push([
      localDateStr(entryStart(e)), toLocalInput(entryStart(e)).replace('T', ' '), toLocalInput(entryEnd(e)).replace('T', ' '),
      entryProjectName(e), e.desc, (entryMs(e) / HOUR).toFixed(4), e.rate.toFixed(2), entryGross(e).toFixed(2), e.segments.length,
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
  $('m-next').onclick = () => { if (viewMonth < monthKey(Date.now())) { viewMonth = shiftMonth(viewMonth, 1); renderBills(); renderHistory(); } };

  $('alloc-smallest').onclick = () => { S.settings.allocation = 'smallest'; save(); renderBills(); };
  $('alloc-prop').onclick = () => { S.settings.allocation = 'proportional'; save(); renderBills(); };
  $('open-bills').onclick = openBills;
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
  $('e-segments').addEventListener('input', () => { $('e-error').textContent = ''; updateSegSummary(); });
  $('e-segments').addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (!rm) return;
    readSegInputs();
    editing.segments.splice(+rm.dataset.rm, 1);
    renderSegEditor();
  });
  $('e-add-seg').onclick = () => {
    readSegInputs();
    const last = editing.segments[editing.segments.length - 1];
    const start = Number.isFinite(last?.end) ? last.end + 15 * 60e3 : Math.floor(Date.now() / 60000) * 60000;
    editing.segments.push({ start, end: start + HOUR });
    renderSegEditor();
  };
  $('e-rate').addEventListener('input', () => { $('e-error').textContent = ''; updateSegSummary(); });
  $('e-project').addEventListener('input', () => {
    const p = projectByName($('e-project').value);
    if (p && !editing.id) { $('e-rate').value = p.rate; updateSegSummary(); }
  });

  // Bills dialog
  $('bills-edit').addEventListener('input', onBillsEdit);
  $('bills-edit').addEventListener('change', onBillsEdit);
  $('bills-edit').addEventListener('click', onBillsEdit);
  $('bill-add').onclick = () => {
    S.bills.push({ id: uid(), name: '', amount: 0, currency: 'CAD' });
    save(); renderBillsEditor(); renderBills();
    const inputs = $('bills-edit').querySelectorAll('input[data-k="name"]');
    inputs[inputs.length - 1]?.focus();
  };
  $('bills-dialog').addEventListener('close', () => {
    const before = S.bills.length;
    S.bills = S.bills.filter((b) => b.name.trim() || b.amount > 0);
    if (S.bills.length !== before) save();
    renderBills();
  });

  // Outside earnings
  $('extra-form').addEventListener('submit', saveOutside);

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
