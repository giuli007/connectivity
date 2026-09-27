"use strict";

const APP_PATH = new URL(".", document.baseURI).pathname;
const DATA_KEY = `connectivity-monitor:v1:${APP_PATH}`;
const LEASE_KEY = `connectivity-monitor:lease:v1:${APP_PATH}`;
const EXPECTED_PROBE = "connectivity-monitor-ok";
const PROBE_TIMEOUT_MS = 7000;
const MAX_EVENTS = 1000;
const INTERVALS = [15000, 30000, 60000];
const tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const elements = Object.fromEntries([
  "storage-warning", "status-symbol", "status-title", "status-description",
  "status-tag", "last-success", "last-check", "last-check-caption",
  "today-down", "today-unknown", "interval", "start", "stop", "export",
  "clear", "history-days", "history-empty", "browser-hint"
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

function parseState(raw) {
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || typeof saved.enabled !== "boolean" ||
        !INTERVALS.includes(saved.intervalMs) ||
        !["unknown", "online", "offline"].includes(saved.status) ||
        !Array.isArray(saved.outages) || !Array.isArray(saved.unknowns) ||
        (saved.activeOutage !== null && !isOutage(saved.activeOutage)) ||
        !saved.outages.every(isOutage) ||
        !saved.unknowns.every(item => item && isTimestamp(item.startAt) && isTimestamp(item.endAt)) ||
        (saved.lastCheckedAt !== null && !isTimestamp(saved.lastCheckedAt)) ||
        (saved.lastSuccessAt !== null && !isTimestamp(saved.lastSuccessAt))) {
      throw new Error("Invalid saved history");
    }
    return {
      ...emptyState(), ...saved,
      outages: saved.outages.slice(-MAX_EVENTS),
      unknowns: saved.unknowns.slice(-MAX_EVENTS)
    };
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

function appendEvent(events, event) {
  events.push(event);
  if (events.length > MAX_EVENTS) events.shift();
}

function applyCheck(previous, ok, checkedAt, reason) {
  const next = { ...previous, outages: [...previous.outages], unknowns: [...previous.unknowns] };
  const elapsed = previous.lastCheckedAt ? Date.parse(checkedAt) - Date.parse(previous.lastCheckedAt) : 0;
  if (previous.lastCheckedAt && (previous.gapOnNextCheck || elapsed > gapThreshold(previous.intervalMs))) {
    if (previous.activeOutage) appendEvent(next.outages, previous.activeOutage);
    next.activeOutage = null;
    appendEvent(next.unknowns, { startAt: previous.lastCheckedAt, endAt: checkedAt });
  }

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
          !previous.gapOnNextCheck && elapsed <= gapThreshold(previous.intervalMs) ? previous.lastSuccessAt : null
      };
    }
    next.lastFailureReason = reason;
    next.status = "offline";
  }
  return next;
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
    const firstFailure = Date.parse(record.firstFailureAt);
    const lastFailure = Date.parse(record.lastFailureAt);
    const before = record.lastSuccessBeforeAt ? Date.parse(record.lastSuccessBeforeAt) : firstFailure;
    const after = record.firstSuccessAfterAt ? Date.parse(record.firstSuccessAfterAt) : lastFailure;
    add("outages", record, (before + firstFailure) / 2, (lastFailure + after) / 2);
  }
  for (const record of state.unknowns) {
    add("unknowns", record, Date.parse(record.startAt), Date.parse(record.endAt));
  }
  return days;
}

function renderStatus() {
  const stale = state.lastCheckedAt && Date.now() - Date.parse(state.lastCheckedAt) > gapThreshold(state.intervalMs);
  let status = "paused";
  let title = "Monitoring paused";
  let description = "Start monitoring to make the next check.";
  if (state.enabled) {
    if (checking) {
      status = "unknown";
      title = "Checking connection…";
      description = "Requesting this site's probe now.";
    } else if (stale || state.status === "unknown") {
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
  elements["status-tag"].textContent = status.toUpperCase();
  elements["last-success"].textContent = formatDateTime(state.lastSuccessAt);
  elements["last-check"].textContent = formatDateTime(state.lastCheckedAt);
  elements["last-check-caption"].textContent = state.lastCheckedAt ?
    (stale ? "Result is stale" : state.status === "online" ? "Probe succeeded" : "Probe failed") : "No checks yet";
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
  renderHistory();
}

elements.start.addEventListener("click", () => {
  if (state.enabled) return;
  save({ ...readState(), enabled: true, status: "unknown" });
  schedule(0);
});

elements.stop.addEventListener("click", () => {
  if (!state.enabled) return;
  cancel();
  const next = { ...readState(), enabled: false, gapOnNextCheck: true };
  if (next.activeOutage) {
    next.outages = [...next.outages];
    appendEvent(next.outages, next.activeOutage);
    next.activeOutage = null;
  }
  save(next);
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
  if (document.visibilityState === "visible" && state.enabled && !checking &&
      (!state.lastCheckedAt || Date.now() - Date.parse(state.lastCheckedAt) >= state.intervalMs)) {
    schedule(0);
  }
});

window.addEventListener("online", renderStatus);
window.addEventListener("offline", renderStatus);
setInterval(renderStatus, 5000);
render();
if (state.enabled) schedule(0);
