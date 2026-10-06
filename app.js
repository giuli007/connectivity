"use strict";

const APP_PATH = new URL(".", document.baseURI).pathname;
const DATA_KEY = `connectivity-monitor:v1:${APP_PATH}`;
const LEASE_KEY = `connectivity-monitor:lease:v1:${APP_PATH}`;
const EXPECTED_PROBE = "connectivity-monitor-ok";
const PROBE_TIMEOUT_MS = 7000;
const MAX_EVENTS = 1000;
const MAX_RECENT_CHECKS = 6000;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const INTERVALS = [15000, 30000, 60000];
const tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const elements = Object.fromEntries([
  "storage-warning", "status-symbol", "status-title", "status-description",
  "status-tag", "last-success", "last-check", "last-check-caption",
  "today-down", "today-unknown", "interval", "start", "stop", "export",
  "import", "import-file", "import-status", "clear", "history-days",
  "history-empty", "browser-hint", "status-freshness",
  "timeline-hour", "timeline-day", "timeline-plot", "timeline-axis",
  "timeline-summary", "timeline-empty", "timeline-latest", "timeline-detail",
  "timeline-detail-title", "timeline-detail-copy", "timeline-changes", "timeline-events"
].map(id => [id, document.getElementById(id)]));

function emptyState() {
  return {
    version: 1,
    enabled: false,
    intervalMs: 15000,
    status: "unknown",
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureReason: null,
    activeOutage: null,
    outages: [],
    unknowns: [],
    recentChecks: [],
    gapOnNextCheck: false
  };
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOutage(value) {
  return value && isTimestamp(value.firstFailureAt) &&
    isTimestamp(value.lastFailureAt) &&
    (value.lastSuccessBeforeAt === null || isTimestamp(value.lastSuccessBeforeAt)) &&
    (value.firstSuccessAfterAt === undefined || value.firstSuccessAfterAt === null || isTimestamp(value.firstSuccessAfterAt));
}

function isRecentCheck(value) {
  return value && isTimestamp(value.checkedAt) && typeof value.ok === "boolean" &&
    (value.reason === null || typeof value.reason === "string") &&
    INTERVALS.includes(value.intervalMs) && typeof value.gapBefore === "boolean";
}

function retainRecentChecks(records, now) {
  return records.filter(record => Date.parse(record.checkedAt) >= now - RECENT_WINDOW_MS)
    .slice(-MAX_RECENT_CHECKS);
}

function normalizeState(raw) {
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || saved.version !== 1 || typeof saved.enabled !== "boolean" ||
      !INTERVALS.includes(saved.intervalMs) ||
      !["unknown", "online", "offline"].includes(saved.status) ||
      !Array.isArray(saved.outages) || !Array.isArray(saved.unknowns) ||
      (saved.recentChecks !== undefined &&
        (!Array.isArray(saved.recentChecks) || !saved.recentChecks.every(isRecentCheck))) ||
      (saved.activeOutage !== null && !isOutage(saved.activeOutage)) ||
      !saved.outages.every(isOutage) ||
      !saved.unknowns.every(item => item && isTimestamp(item.startAt) && isTimestamp(item.endAt)) ||
      (saved.lastCheckedAt !== null && !isTimestamp(saved.lastCheckedAt)) ||
      (saved.lastSuccessAt !== null && !isTimestamp(saved.lastSuccessAt))) {
    throw new Error("Invalid saved history");
  }
  const { exportedAt, ...fields } = saved;
  return {
    ...emptyState(), ...fields,
    outages: saved.outages.slice(-MAX_EVENTS),
    unknowns: saved.unknowns.slice(-MAX_EVENTS),
    recentChecks: retainRecentChecks(saved.recentChecks || [], Date.now())
  };
}

function parseState(raw) {
  try {
    return normalizeState(raw);
  } catch {
    warning = "Saved history could not be read. Monitoring starts with an empty history.";
    return emptyState();
  }
}

let warning = "";
let storage = null;
try {
  storage = window.localStorage;
  const probeKey = `${DATA_KEY}:storage-test`;
  storage.setItem(probeKey, "ok");
  storage.removeItem(probeKey);
} catch {
  storage = null;
  warning = "Browser storage is unavailable. Checks work in this tab, but history will be lost when it closes; export a copy if needed.";
}

function readState() {
  if (!storage) return state;
  try {
    const raw = storage.getItem(DATA_KEY);
    return raw === null ? emptyState() : parseState(raw);
  } catch {
    storage = null;
    warning = "Browser storage is unavailable. History is only kept in this tab; export a copy if needed.";
    return state;
  }
}

let state = emptyState();
if (storage) state = readState();
let timer = null;
let controller = null;
let checking = false;
let generation = 0;
let timelineWindowMs = 60 * 60 * 1000;
let timelineSelection = null;

function save(nextState) {
  state = nextState;
  if (storage) {
    try {
      storage.setItem(DATA_KEY, JSON.stringify(state));
    } catch {
      storage = null;
      warning = "Browser storage is full or unavailable. New history is only kept in this tab; export a copy if needed.";
    }
  }
  render();
}

function readLease() {
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(LEASE_KEY));
  } catch {
    return null;
  }
}

function ownsLease() {
  const lease = readLease();
  return !storage || (lease && lease.id === tabId && lease.expiresAt > Date.now());
}

function claimLease() {
  if (!storage) return true;
  const lease = readLease();
  if (lease && lease.id !== tabId && lease.expiresAt > Date.now()) return false;
  try {
    storage.setItem(LEASE_KEY, JSON.stringify({
      id: tabId,
      expiresAt: Date.now() + Math.max(state.intervalMs * 3, 45000)
    }));
    return ownsLease();
  } catch {
    storage = null;
    warning = "Browser storage is unavailable. History is only kept in this tab; export a copy if needed.";
    render();
    return true;
  }
}

function releaseLease() {
  if (!storage || !ownsLease()) return;
  try {
    storage.removeItem(LEASE_KEY);
  } catch {
    storage = null;
  }
}

function gapThreshold(intervalMs) {
  return Math.max(intervalMs * 2.5, intervalMs + 15000);
}

function lastObservationInterval(snapshot) {
  const records = snapshot.recentChecks || [];
  const latest = records[records.length - 1];
  return latest?.checkedAt === snapshot.lastCheckedAt ? latest.intervalMs : snapshot.intervalMs;
}

function appendEvent(events, event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
}

function applyCheck(previous, ok, checkedAt, reason) {
  const next = { ...previous, outages: [...previous.outages], unknowns: [...previous.unknowns] };
  const elapsed = previous.lastCheckedAt ? Date.parse(checkedAt) - Date.parse(previous.lastCheckedAt) : 0;
  const observedInterval = lastObservationInterval(previous);
  const gapBefore = Boolean(previous.lastCheckedAt &&
    (previous.gapOnNextCheck || elapsed > gapThreshold(observedInterval)));
  if (gapBefore) {
    if (previous.activeOutage) appendEvent(next.outages, previous.activeOutage);
    next.activeOutage = null;
    appendEvent(next.unknowns, { startAt: previous.lastCheckedAt, endAt: checkedAt });
  }

  next.recentChecks = retainRecentChecks([
    ...(previous.recentChecks || []),
    { checkedAt, ok, reason: ok ? null : reason, intervalMs: previous.intervalMs, gapBefore }
  ], Date.parse(checkedAt));
  next.gapOnNextCheck = false;
  next.lastCheckedAt = checkedAt;
  if (ok) {
    if (next.activeOutage) {
      appendEvent(next.outages, { ...next.activeOutage, firstSuccessAfterAt: checkedAt });
      next.activeOutage = null;
    }
    next.lastSuccessAt = checkedAt;
    next.lastFailureReason = null;
    next.status = "online";
  } else {
    if (next.activeOutage) {
      next.activeOutage = { ...next.activeOutage, lastFailureAt: checkedAt };
    } else {
      next.activeOutage = {
        firstFailureAt: checkedAt,
        lastFailureAt: checkedAt,
        lastSuccessBeforeAt: previous.status === "online" &&
          !previous.gapOnNextCheck && elapsed <= gapThreshold(observedInterval) ? previous.lastSuccessAt : null
      };
    }
    next.lastFailureReason = reason;
    next.status = "offline";
  }
  return next;
}

function markObservationGap(previous) {
  const next = { ...previous, gapOnNextCheck: true, outages: [...previous.outages], activeOutage: null };
  if (previous.activeOutage) appendEvent(next.outages, previous.activeOutage);
  return next;
}

function importedState(imported, current) {
  // Nothing was observed between the file's last check and the next one here.
  const next = markObservationGap(imported);
  return { ...next, enabled: current.enabled, intervalMs: current.intervalMs,
    gapOnNextCheck: next.lastCheckedAt !== null };
}

async function probe(signal) {
  const url = new URL("health.txt", document.baseURI);
  url.searchParams.set("check", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok || (await response.text()).trim() !== EXPECTED_PROBE) {
      return { ok: false, reason: "The probe returned an unexpected response." };
    }
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: signal.aborted ? "The check timed out." : "The probe could not be reached." };
  }
}

function schedule(delay) {
  clearTimeout(timer);
  if (state.enabled) timer = setTimeout(tick, delay);
}

function cancel() {
  generation += 1;
  clearTimeout(timer);
  timer = null;
  if (controller) controller.abort();
  controller = null;
  checking = false;
}

async function tick() {
  timer = null;
  if (!state.enabled || checking) return;
  if (!claimLease()) {
    schedule(Math.min(state.intervalMs, 5000));
    return;
  }

  const currentGeneration = generation;
  const currentController = new AbortController();
  controller = currentController;
  checking = true;
  renderStatus();
  const timeout = setTimeout(() => currentController.abort(), PROBE_TIMEOUT_MS);
  const result = await probe(currentController.signal);
  clearTimeout(timeout);
  if (controller === currentController) controller = null;
  if (currentGeneration !== generation) return;

  checking = false;
  if (!ownsLease()) {
    renderStatus();
    schedule(Math.min(state.intervalMs, 5000));
    return;
  }
  const latest = readState();
  if (!latest.enabled) {
    state = latest;
    releaseLease();
    render();
    return;
  }
  save(applyCheck(latest, result.ok, new Date().toISOString(), result.reason));
  schedule(state.intervalMs);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function outageBounds(record) {
  const firstFailure = Date.parse(record.firstFailureAt);
  const lastFailure = Date.parse(record.lastFailureAt);
  const before = record.lastSuccessBeforeAt ? Date.parse(record.lastSuccessBeforeAt) : firstFailure;
  const after = record.firstSuccessAfterAt ? Date.parse(record.firstSuccessAfterAt) : lastFailure;
  return { from: (before + firstFailure) / 2, to: (lastFailure + after) / 2 };
}

function timelineData(snapshot, now, windowMs) {
  const from = now - windowMs;
  const checks = snapshot.recentChecks.filter(record => {
    const time = Date.parse(record.checkedAt);
    return time >= from && time <= now;
  });
  const outages = [];
  const gaps = [];
  function clip(target, item) {
    if (item.to < from || item.from > now) return;
    target.push({ ...item, sourceFrom: item.from, sourceTo: item.to,
      from: Math.max(from, item.from), to: Math.min(now, item.to) });
  }
  for (const record of [...snapshot.outages, ...(snapshot.activeOutage ? [snapshot.activeOutage] : [])]) {
    clip(outages, { kind: "outage", key: `outage:${record.firstFailureAt}`, record, ...outageBounds(record) });
  }
  for (const record of snapshot.unknowns) {
    clip(gaps, { kind: "gap", key: `gap:${record.startAt}`, from: Date.parse(record.startAt), to: Date.parse(record.endAt), open: false });
  }
  const lastChecked = snapshot.lastCheckedAt ? Date.parse(snapshot.lastCheckedAt) : null;
  if (lastChecked !== null && now > lastChecked &&
      (!snapshot.enabled || snapshot.gapOnNextCheck || now - lastChecked > gapThreshold(lastObservationInterval(snapshot)))) {
    clip(gaps, { kind: "gap", key: `gap:open:${snapshot.lastCheckedAt}`, from: lastChecked, to: now, open: true });
  }

  const changes = new Map();
  function change(kind, time, title, detail, current = false) {
    if (time >= from && time <= now && !changes.has(`${kind}:${time}`)) {
      changes.set(`${kind}:${time}`, { kind, time, title, detail, current });
    }
  }
  snapshot.recentChecks.forEach((record, index, records) => {
    const previous = records[index - 1];
    if (!previous || record.gapBefore || previous.ok !== record.ok) {
      const title = record.gapBefore ? `Checks resumed · ${record.ok ? "site reachable" : "probe failing"}` :
        record.ok ? (previous ? "Site reachable again" : "Site reachable") : "Probe failing";
      change(record.ok ? "online" : "offline", Date.parse(record.checkedAt), title,
        record.gapBefore ? "First observation after a period without checks." :
          record.ok ? "The site's probe responded successfully." : record.reason || "The probe could not be reached.");
    }
  });
  for (const item of outages) {
    change("offline", Date.parse(item.record.firstFailureAt), "Probe failing", "First failed check of this estimated outage.");
    if (item.record.firstSuccessAfterAt) {
      change("online", Date.parse(item.record.firstSuccessAfterAt), "Site reachable again", "Recovery confirmed by a successful probe.");
    }
  }
  for (const item of gaps) {
    change("unknown", item.sourceTo, item.open ? (snapshot.enabled ? "Fresh check overdue" : "Monitoring paused") : "Unobserved interval",
      `${formatDuration(item.sourceTo - item.sourceFrom)} without checks · not downtime.`, item.open);
  }
  return { from, to: now, checks, outages, gaps,
    changes: [...changes.values()].sort((first, second) => second.time - first.time).slice(0, 3) };
}

function groupTimelineChecks(checks, bucketMs) {
  const groups = new Map();
  for (const record of checks) {
    const bucket = Math.floor(Date.parse(record.checkedAt) / bucketMs);
    if (!groups.has(bucket)) groups.set(bucket, { kind: "check", key: `check:${bucket}`, records: [] });
    groups.get(bucket).records.push(record);
  }
  return [...groups.values()].map(group => ({ ...group,
    from: Date.parse(group.records[0].checkedAt),
    to: Date.parse(group.records[group.records.length - 1].checkedAt),
    failed: group.records.filter(record => !record.ok).length }));
}

function dailyHistory() {
  const days = new Map();
  function add(kind, record, start, end) {
    function addPiece(from, to) {
      const key = dayKey(from);
      if (!days.has(key)) days.set(key, { outages: [], unknowns: [], downtime: 0, unobserved: 0 });
      const day = days.get(key);
      const duration = to - from;
      day[kind].push({ record, from, to, duration });
      day[kind === "outages" ? "downtime" : "unobserved"] += duration;
    }

    if (end <= start) {
      addPiece(start, start);
      return;
    }
    for (let cursor = start; cursor < end;) {
      const date = new Date(cursor);
      const nextMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const segmentEnd = Math.min(end, nextMidnight);
      addPiece(cursor, segmentEnd);
      cursor = segmentEnd;
    }
  }

  for (const record of [...state.outages, ...(state.activeOutage ? [state.activeOutage] : [])]) {
    const { from, to } = outageBounds(record);
    add("outages", record, from, to);
  }
  for (const record of state.unknowns) {
    add("unknowns", record, Date.parse(record.startAt), Date.parse(record.endAt));
  }
  return days;
}

function renderStatus() {
  const stale = state.lastCheckedAt && Date.now() - Date.parse(state.lastCheckedAt) > gapThreshold(lastObservationInterval(state));
  let status = "paused";
  let title = "Monitoring paused";
  let description = "Start monitoring to make the next check.";
  if (state.enabled) {
    if (checking) {
      status = "unknown";
      title = "Checking connection…";
      description = "Requesting this site's probe now.";
    } else if (stale || state.gapOnNextCheck || state.status === "unknown") {
      status = "unknown";
      title = "Awaiting a fresh check";
      description = "The last result is no longer current. Unchecked time is not counted as an outage.";
    } else if (state.status === "online") {
      status = "online";
      title = "Site reachable";
      description = `Probe succeeded at ${formatDateTime(state.lastCheckedAt)}. This does not verify every internet service.`;
    } else {
      status = "offline";
      title = "Probe failing";
      description = `${state.lastFailureReason || "The probe could not be reached."} The outage is still being observed.`;
    }
  }

  elements["status-symbol"].dataset.status = status;
  if (elements["status-title"].textContent !== title) elements["status-title"].textContent = title;
  elements["status-description"].textContent = description;
  const age = state.lastCheckedAt ? Math.max(0, Date.now() - Date.parse(state.lastCheckedAt)) : null;
  elements["status-freshness"].textContent = age === null ? "No checks recorded yet" :
    `Last checked ${age < 5000 ? "just now" : `${formatDuration(age)} ago`}${!state.enabled ? " · monitoring paused" : stale ? " · stale result" : ""}`;
  elements["status-tag"].textContent = status.toUpperCase();
  elements["last-success"].textContent = formatDateTime(state.lastSuccessAt);
  elements["last-check"].textContent = formatDateTime(state.lastCheckedAt);
  const latestRecord = state.recentChecks[state.recentChecks.length - 1];
  const lastResult = latestRecord?.checkedAt === state.lastCheckedAt ? latestRecord.ok :
    state.status === "unknown" ? null : state.status === "online";
  elements["last-check-caption"].textContent = state.lastCheckedAt ?
    (stale ? "Result is stale" : lastResult === null ? "Previous observation" : lastResult ? "Probe succeeded" : "Probe failed") : "No checks yet";
  elements["start"].disabled = state.enabled;
  elements["stop"].disabled = !state.enabled;
  elements.interval.value = String(state.intervalMs);
  elements["browser-hint"].textContent = `Browser network hint: ${navigator.onLine ? "online" : "offline"} (not a connectivity check)`;
  elements["storage-warning"].hidden = !warning;
  elements["storage-warning"].textContent = warning;
}

function addText(parent, tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function addSvg(parent, tag, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  parent.append(node);
  return node;
}

function observationTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit", second: "2-digit", timeZoneName: "short"
  }).format(new Date(timestamp));
}

function describeTimelineItem(item) {
  if (item.kind === "check") {
    const failed = item.records.filter(record => !record.ok);
    const latest = item.records[item.records.length - 1];
    const single = item.records.length === 1;
    return {
      kind: failed.length ? "offline" : "online",
      title: single ? (latest.ok ? "Successful probe" : "Failed probe") : `${item.records.length} checks · ${failed.length} failed`,
      copy: single ? `${observationTime(latest.checkedAt)} · ${latest.ok ? "This site was reachable at this check." : latest.reason || "The probe could not be reached."}` :
        `${observationTime(item.from)} – ${observationTime(item.to)} · ${item.records.length - failed.length} successful, ${failed.length} failed.${failed.length ? ` Last failure: ${failed[failed.length - 1].reason || "The probe could not be reached."}` : ""}`
    };
  }
  if (item.kind === "outage") {
    const observed = item.record === state.activeOutage && state.enabled && state.lastCheckedAt &&
      !state.gapOnNextCheck && Date.now() - Date.parse(state.lastCheckedAt) <= gapThreshold(lastObservationInterval(state));
    return {
      kind: "offline",
      title: `Estimated outage · ${item.record.firstSuccessAfterAt ? "recovered" : observed ? "being observed" : "recovery unconfirmed"}`,
      copy: `${observationTime(item.sourceFrom)} – ${observationTime(item.sourceTo)} · ${formatDuration(item.sourceTo - item.sourceFrom)} estimated. ${item.record.lastSuccessBeforeAt ? "Bounds use check midpoints." : "Start unbounded."}`
    };
  }
  return {
    kind: "unknown",
    title: item.open ? "Unchecked since the last probe" : "Unobserved interval",
    copy: `${observationTime(item.sourceFrom)} – ${item.open ? "now" : observationTime(item.sourceTo)} · ${formatDuration(item.sourceTo - item.sourceFrom)} without checks. Not counted as downtime.`
  };
}

function showTimelineDetail(item) {
  const detail = item ? describeTimelineItem(item) : {
    kind: "empty", title: "No observation selected", copy: "New checks appear here while monitoring is running. Older successful checks cannot be reconstructed."
  };
  elements["timeline-detail"].dataset.kind = detail.kind;
  elements["timeline-detail-title"].textContent = detail.title;
  elements["timeline-detail-copy"].textContent = detail.copy;
}

function renderTimeline() {
  const now = Date.now();
  const data = timelineData(state, now, timelineWindowMs);
  const failed = data.checks.filter(record => !record.ok).length;
  elements["timeline-summary"].textContent = `${data.checks.length - failed} successful · ${failed} failed checks`;
  elements["timeline-hour"].setAttribute("aria-pressed", String(timelineWindowMs !== RECENT_WINDOW_MS));
  elements["timeline-day"].setAttribute("aria-pressed", String(timelineWindowMs === RECENT_WINDOW_MS));
  elements["timeline-empty"].hidden = data.checks.length > 0;
  elements["timeline-empty"].textContent = state.lastCheckedAt ?
    "No individual check history in this window. Older successes are not reconstructed; new probes appear as monitoring runs." :
    "No check history yet. Start monitoring to build the recent picture.";

  const plot = elements["timeline-plot"];
  const width = plot.clientWidth || 1000;
  const unit = 1000 / width;
  const position = timestamp => Math.max(0, Math.min(1000, (timestamp - data.from) / timelineWindowMs * 1000));
  const groups = groupTimelineChecks(data.checks, timelineWindowMs / Math.max(20, Math.min(100, Math.floor(width / 12))));
  const items = [...groups, ...data.outages, ...data.gaps].sort((first, second) => first.from - second.from);
  const activeKey = document.activeElement?.dataset.timelineKey;
  const focusedKey = items.some(item => item.key === activeKey) ? activeKey : null;
  const selected = items.find(item => item.key === timelineSelection);
  const fragment = document.createDocumentFragment();
  const defs = addSvg(fragment, "defs", {});
  const pattern = addSvg(defs, "pattern", { id: "timeline-gap-pattern", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: `scale(${unit} 1)` });
  addSvg(pattern, "rect", { width: 8, height: 8, fill: "#e9eae4" });
  addSvg(pattern, "path", { d: "M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6", stroke: "#a6afa5", "stroke-width": 1 });
  addSvg(fragment, "rect", { x: 0, y: 26, width: 1000, height: 28, rx: 4, class: "timeline-track" });
  addSvg(fragment, "rect", { x: 0, y: 72, width: 1000, height: 10, rx: 3, class: "timeline-track" });
  const intervalsLayer = addSvg(fragment, "g", {});
  const checksLayer = addSvg(fragment, "g", {});

  const targets = [];
  items.forEach((item, index) => {
    const detail = describeTimelineItem(item);
    const group = addSvg(item.kind === "check" ? checksLayer : intervalsLayer, "g", {
      class: `timeline-item timeline-item-${item.kind}`, role: "button",
      tabindex: item.key === focusedKey || (!focusedKey && index === items.length - 1) ? 0 : -1,
      "aria-label": `${detail.title}. ${detail.copy}`
    });
    group.dataset.timelineKey = item.key;
    group.dataset.selected = String(item.key === timelineSelection);
    addSvg(group, "title", {}).textContent = `${detail.title}\n${detail.copy}`;
    if (item.kind === "check") {
      const latestSuccess = item.records.filter(record => record.ok).slice(-1)[0];
      const latestFailure = item.records.filter(record => !record.ok).slice(-1)[0];
      for (const record of [latestSuccess, latestFailure].filter(Boolean)) {
        const center = position(Date.parse(record.checkedAt));
        const markWidth = (record.ok ? 3 : 4) * unit;
        addSvg(group, "rect", { x: Math.min(1000 - 12 * unit, Math.max(0, center - 6 * unit)), y: 16, width: 12 * unit, height: 45, fill: "transparent" });
        addSvg(group, "rect", { x: Math.min(1000 - markWidth, Math.max(0, center - markWidth / 2)), y: record.ok ? 31 : 27,
          width: markWidth, height: record.ok ? 17 : 25, rx: unit, class: `timeline-mark ${record.ok ? "probe-success" : "probe-failed"}` });
        if (!record.ok) addSvg(group, "path", { d: `M ${Math.max(0, center - 4 * unit)} 22 L ${center} 16 L ${Math.min(1000, center + 4 * unit)} 22 Z`, class: "probe-failed" });
      }
    } else {
      const left = Math.min(1000 - 2 * unit, position(item.from));
      const markWidth = Math.min(1000 - left, Math.max(2 * unit, position(item.to) - left));
      addSvg(group, "rect", { x: left, y: item.kind === "gap" ? 24 : 63, width: markWidth, height: item.kind === "gap" ? 34 : 27, fill: "transparent" });
      addSvg(group, "rect", { x: left, y: item.kind === "gap" ? 26 : 72, width: markWidth, height: item.kind === "gap" ? 28 : 10,
        rx: 2, class: "timeline-mark", fill: item.kind === "gap" ? "url(#timeline-gap-pattern)" : "#ce8976" });
    }
    targets.push(group);
    function select() {
      timelineSelection = item.key;
      targets.forEach(target => {
        const active = target.dataset.timelineKey === item.key;
        target.dataset.selected = String(active);
        target.setAttribute("tabindex", active ? "0" : "-1");
      });
      showTimelineDetail(item);
    }
    group.addEventListener("pointerenter", () => showTimelineDetail(item));
    group.addEventListener("focus", select);
    group.addEventListener("click", () => { select(); group.focus(); });
    group.addEventListener("keydown", event => {
      const directions = { ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(items.length - 1, index + 1), Home: 0, End: items.length - 1 };
      if (event.key in directions) {
        event.preventDefault();
        targets[directions[event.key]].focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });

  addSvg(fragment, "line", { x1: 999, x2: 999, y1: 18, y2: 88, class: "timeline-now" });
  const latestAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
  const latestVisible = latestAt !== null && latestAt >= data.from && latestAt <= now;
  elements["timeline-latest"].hidden = !latestVisible;
  if (latestVisible) {
    const latestPosition = position(latestAt);
    elements["timeline-latest"].style.left = `${latestPosition / 10}%`;
    elements["timeline-latest"].dataset.edge = latestPosition < 150 ? "start" : "end";
    addSvg(fragment, "line", { x1: latestPosition, x2: latestPosition, y1: 18, y2: 88, class: "timeline-latest-line" });
  }
  plot.replaceChildren(fragment);
  const focused = targets.find(target => target.dataset.timelineKey === focusedKey);
  if (focused) focused.focus({ preventScroll: true });
  if (!selected && timelineSelection) timelineSelection = null;
  const latest = data.checks[data.checks.length - 1];
  showTimelineDetail(selected || (latest ? { kind: "check", records: [latest] } : data.gaps[data.gaps.length - 1] || data.outages[data.outages.length - 1]));

  const axis = document.createDocumentFragment();
  for (let index = 0; index <= 4; index += 1) {
    const time = data.from + timelineWindowMs * index / 4;
    const label = index === 4 ? "Now" : new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit", ...(timelineWindowMs === RECENT_WINDOW_MS ? { month: "short", day: "numeric" } : {})
    }).format(time);
    addText(axis, "span", "", label);
  }
  elements["timeline-axis"].replaceChildren(axis);
  const changes = document.createDocumentFragment();
  for (const change of data.changes) {
    const entry = document.createElement("li");
    entry.className = `timeline-change change-${change.kind}`;
    const copy = document.createElement("div");
    addText(copy, "p", "change-title", change.title);
    addText(copy, "p", "change-time", change.current ? "Now · no fresh observation" : observationTime(change.time));
    addText(copy, "p", "change-description", change.detail);
    entry.append(copy);
    changes.append(entry);
  }
  elements["timeline-events"].hidden = data.changes.length === 0;
  elements["timeline-changes"].replaceChildren(changes);
}

function renderHistory() {
  const openDays = new Set([...elements["history-days"].querySelectorAll("details[open]")].map(day => day.dataset.day));
  const previouslyEmpty = elements["history-days"].children.length === 0;
  const days = dailyHistory();
  const today = days.get(dayKey(Date.now()));
  elements["today-down"].textContent = formatDuration(today?.downtime || 0);
  elements["today-unknown"].textContent = `${formatDuration(today?.unobserved || 0)} unobserved`;
  elements["history-empty"].hidden = days.size > 0;
  const fragment = document.createDocumentFragment();
  [...days].sort(([first], [second]) => second.localeCompare(first)).forEach(([key, day], index) => {
    const details = document.createElement("details");
    details.className = "day";
    details.dataset.day = key;
    details.open = openDays.has(key) || (previouslyEmpty && index === 0);
    const summary = document.createElement("summary");
    const localDate = new Date(`${key}T12:00:00`);
    const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(localDate);
    addText(summary, "span", "day-title", key === dayKey(Date.now()) ? `Today · ${dayName}` : dayName);
    const totals = document.createElement("span");
    totals.className = "day-totals";
    addText(totals, "strong", "", `${formatDuration(day.downtime)} estimated down`);
    addText(totals, "span", "", `${formatDuration(day.unobserved)} unknown`);
    summary.append(totals);
    details.append(summary);

    const entries = document.createElement("ul");
    entries.className = "day-entries";
    const events = [
      ...day.outages.map(piece => ({ ...piece, kind: "outage" })),
      ...day.unknowns.map(piece => ({ ...piece, kind: "unknown" }))
    ].sort((first, second) => second.from - first.from);
    for (const event of events) {
      const item = document.createElement("li");
      item.className = `day-entry entry-${event.kind}`;
      const info = document.createElement("span");
      const time = timestamp => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(timestamp);
      if (event.kind === "outage") {
        const suffix = state.activeOutage === event.record ? " · ongoing" :
          event.record.firstSuccessAfterAt ? " · recovered" : " · recovery unconfirmed";
        addText(info, "span", "entry-label", `Estimated outage${suffix}`);
        addText(info, "span", "entry-detail", `${time(event.from)} – ${time(event.to)} estimated · ${event.record.lastSuccessBeforeAt ? `last OK ${formatDateTime(event.record.lastSuccessBeforeAt)}` : "start unbounded"} · first failed ${formatDateTime(event.record.firstFailureAt)} · last failed ${formatDateTime(event.record.lastFailureAt)}${event.record.firstSuccessAfterAt ? ` · first OK ${formatDateTime(event.record.firstSuccessAfterAt)}` : ""}`);
      } else {
        addText(info, "span", "entry-label", "Unobserved interval");
        addText(info, "span", "entry-detail", `${time(event.from)} – ${time(event.to)} · no checks recorded`);
      }
      item.append(info);
      addText(item, "span", "entry-duration", formatDuration(event.duration));
      entries.append(item);
    }
    details.append(entries);
    fragment.append(details);
  });
  elements["history-days"].replaceChildren(fragment);
}

function render() {
  renderStatus();
  renderTimeline();
  renderHistory();
}

for (const [id, windowMs] of [["timeline-hour", 60 * 60 * 1000], ["timeline-day", RECENT_WINDOW_MS]]) {
  elements[id].addEventListener("click", () => {
    timelineWindowMs = windowMs;
    timelineSelection = null;
    renderTimeline();
  });
}

elements.start.addEventListener("click", () => {
  if (state.enabled) return;
  save({ ...readState(), enabled: true, status: "unknown" });
  schedule(0);
});

elements.stop.addEventListener("click", () => {
  if (!state.enabled) return;
  cancel();
  save({ ...markObservationGap(readState()), enabled: false });
  releaseLease();
});

elements.interval.addEventListener("change", () => {
  const intervalMs = Number(elements.interval.value);
  if (!INTERVALS.includes(intervalMs)) return;
  save({ ...readState(), intervalMs });
  if (state.enabled && !checking) schedule(0);
});

elements.export.addEventListener("click", () => {
  const exported = { ...readState(), exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `connectivity-history-${dayKey(Date.now())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

elements.import.addEventListener("click", () => elements["import-file"].click());

elements["import-file"].addEventListener("change", async () => {
  const input = elements["import-file"];
  const file = input.files?.[0];
  if (!file) return;
  input.value = "";
  const status = elements["import-status"];
  if (file.size > MAX_IMPORT_BYTES) {
    status.textContent = `${file.name} is larger than 10 MB and was not imported. Nothing was changed.`;
    return;
  }
  let imported;
  try {
    imported = normalizeState(await file.text());
  } catch {
    status.textContent = `${file.name} is not a connectivity history export. Nothing was changed.`;
    return;
  }
  if (!window.confirm(`Replace all recorded outages, unobserved intervals, and check history in this browser with ${file.name}? Export first if you want to keep the current history.`)) return;
  cancel();
  save(importedState(imported, readState()));
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  status.textContent = `Imported ${file.name}: ${plural(state.outages.length, "outage")}, ` +
    `${plural(state.unknowns.length, "unobserved interval")}, ${plural(state.recentChecks.length, "recent check")}.`;
  if (state.enabled) schedule(0);
});

elements.clear.addEventListener("click", () => {
  if (!window.confirm("Delete all recorded outages, unobserved intervals, and check history in this browser?")) return;
  cancel();
  const latest = readState();
  save({ ...emptyState(), enabled: latest.enabled, intervalMs: latest.intervalMs });
  if (state.enabled) schedule(0);
});

window.addEventListener("storage", event => {
  if (event.key !== DATA_KEY) return;
  const wasEnabled = state.enabled;
  state = event.newValue ? parseState(event.newValue) : emptyState();
  if (!state.enabled) {
    cancel();
    releaseLease();
  } else if (!wasEnabled || !checking) {
    schedule(0);
  }
  render();
});

window.addEventListener("pagehide", () => {
  cancel();
  if (state.enabled && ownsLease()) save(markObservationGap(readState()));
  releaseLease();
});

window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  state = readState();
  render();
  if (state.enabled) schedule(0);
});

document.addEventListener("visibilitychange", () => {
  renderStatus();
  renderTimeline();
  if (document.visibilityState === "visible" && state.enabled && !checking &&
      (!state.lastCheckedAt || Date.now() - Date.parse(state.lastCheckedAt) >= state.intervalMs)) {
    schedule(0);
  }
});

window.addEventListener("online", renderStatus);
window.addEventListener("offline", renderStatus);
window.addEventListener("resize", renderTimeline);
setInterval(() => {
  renderStatus();
  renderTimeline();
}, 5000);
render();
if (state.enabled) schedule(0);
