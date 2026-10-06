const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const dataKey = "connectivity-monitor:v1:/connectivity/";

function createNode(tagName = "div") {
  return {
    tagName,
    children: [],
    dataset: {},
    style: {},
    attributes: new Map(),
    listeners: new Map(),
    textContent: "",
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    click() { this.listeners.get("click")?.(); },
    addEventListener(event, listener) { this.listeners.set(event, listener); },
    append(...nodes) {
      for (const node of nodes) {
        this.children.push(...(node.tagName === "#fragment" ? node.children : [node]));
      }
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "details[open]");
      const matches = [];
      function visit(node) {
        for (const child of node.children) {
          if (child.tagName === "details" && child.open) matches.push(child);
          visit(child);
        }
      }
      visit(this);
      return matches;
    }
  };
}

function createBrowser({ shared = new Map(), clock = { now: Date.parse("2026-09-27T12:00:00Z") }, storageAvailable = true } = {}) {
  class TestDate extends Date {
    constructor(...arguments_) { super(...(arguments_.length ? arguments_ : [clock.now])); }
    static now() { return clock.now; }
  }

  const nodes = new Map();
  const timers = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const intervals = [];
  const downloads = [];
  const responses = [];
  const requests = [];
  let nextTimerId = 0;
  let unqueuedRequests = 0;
  function createElement(tagName) {
    const node = createNode(tagName);
    node.focus = () => {
      document.activeElement = node;
      node.listeners.get("focus")?.();
    };
    return node;
  }
  const document = {
    baseURI: "https://example.github.io/connectivity/",
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElement());
      return nodes.get(id);
    },
    createElement,
    createElementNS(namespace, tagName) { return createElement(tagName); },
    createDocumentFragment() { return createElement("#fragment"); },
    addEventListener(event, listener) { documentListeners.set(event, listener); }
  };
  const window = {
    get localStorage() {
      if (!storageAvailable) throw new Error("Storage unavailable");
      return {
        getItem(key) { return shared.get(key) ?? null; },
        setItem(key, value) { shared.set(key, value); },
        removeItem(key) { shared.delete(key); }
      };
    },
    addEventListener(event, listener) { windowListeners.set(event, listener); },
    confirm() { return true; }
  };
  class TestURL extends URL {
    static createObjectURL(blob) { downloads.push(blob); return "blob:test"; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    document, window, navigator: { onLine: true }, URL: TestURL, Intl, Date: TestDate,
    Math, AbortController, Blob,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { intervals.push(callback); },
    fetch(url, options) {
      requests.push({ url, options });
      const response = responses.shift();
      if (response === undefined) unqueuedRequests += 1;
      if (response === "timeout") {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        });
      }
      if (response === "network-error") return Promise.reject(new Error("Network error"));
      return Promise.resolve({ ok: response !== "http-error", text: async () => response ?? "connectivity-monitor-ok" });
    }
  });
  vm.runInContext(source, context, { filename: "app.js" });

  return {
    clock, nodes, requests, responses, downloads, document, window,
    state() { return shared.has(dataKey) ? JSON.parse(shared.get(dataKey)) : vm.runInContext("state", context); },
    memoryState() { return vm.runInContext("state", context); },
    evaluate(expression) { return vm.runInContext(expression, context); },
    click(id) { nodes.get(id).listeners.get("click")(); },
    dispatch(event, value) { windowListeners.get(event)(value); },
    dispatchDocument(event) { documentListeners.get(event)(); },
    pulse() { intervals.forEach(callback => callback()); },
    async importFile(raw, { name = "history.json", size = raw.length } = {}) {
      const input = nodes.get("import-file");
      input.files = [{ name, size, text: async () => raw }];
      await input.listeners.get("change")();
    },
    async fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(unqueuedRequests, 0, "A probe ran without a queued response");
    }
  };
}

test("manual start checks the relative uncached probe and records a recovery", async () => {
  const browser = createBrowser();
  assert.equal(browser.state().enabled, false);
  assert.equal(browser.requests.length, 0);

  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().status, "online");
  assert.equal(browser.requests[0].url.pathname, "/connectivity/health.txt");
  assert.ok(browser.requests[0].url.searchParams.has("check"));
  assert.equal(browser.requests[0].options.cache, "no-store");

  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  assert.equal(browser.state().status, "offline");
  assert.equal(browser.state().activeOutage.lastSuccessBeforeAt, "2026-09-27T12:00:00.000Z");

  browser.clock.now += 15000;
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(15000);
  assert.equal(browser.state().outages.length, 1);
  assert.equal(browser.state().activeOutage, null);
  assert.equal(browser.state().outages[0].firstSuccessAfterAt, "2026-09-27T12:00:30.000Z");
  assert.equal(browser.evaluate("dailyHistory().get(dayKey(Date.now())).downtime"), 15000);
  assert.deepEqual(browser.state().recentChecks.map(record => record.ok), [true, false, true]);
  assert.ok(browser.state().recentChecks.every(record => record.intervalMs === 15000 && record.gapBefore === false));
  assert.equal(browser.state().recentChecks[1].reason, "The probe could not be reached.");
});

test("a long unchecked gap splits an outage instead of counting it as downtime", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);

  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  browser.clock.now += 600000;
  browser.responses.push("network-error");
  await browser.fire(15000);

  const state = browser.state();
  assert.equal(state.outages.length, 1);
  assert.equal(state.outages[0].firstSuccessAfterAt, undefined);
  assert.equal(state.activeOutage.lastSuccessBeforeAt, null);
  assert.equal(state.unknowns.length, 1);
  assert.equal(Date.parse(state.unknowns[0].endAt) - Date.parse(state.unknowns[0].startAt), 600000);
  const today = browser.evaluate("dailyHistory().get(dayKey(Date.now()))");
  assert.equal(today.downtime, 22500);
  assert.equal(today.unobserved, 600000);
});

test("pausing archives an active outage and treats even a short pause as unknown", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("network-error");
  await browser.fire(0);

  browser.click("stop");
  assert.equal(browser.state().enabled, false);
  assert.equal(browser.state().outages.length, 1);
  assert.equal(browser.state().activeOutage, null);

  browser.clock.now += 2000;
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().unknowns.length, 1);
  assert.equal(browser.state().outages.length, 1);
  assert.equal(browser.state().lastCheckedAt, new Date(browser.clock.now).toISOString());
});

test("monitoring resumes after reopening and records elapsed time as unknown", async () => {
  const shared = new Map();
  const clock = { now: Date.parse("2026-09-27T12:00:00Z") };
  const first = createBrowser({ shared, clock });
  first.click("start");
  first.responses.push("connectivity-monitor-ok");
  await first.fire(0);
  first.dispatch("pagehide");

  clock.now += 300000;
  const reopened = createBrowser({ shared, clock });
  reopened.responses.push("connectivity-monitor-ok");
  await reopened.fire(0);
  assert.equal(reopened.state().enabled, true);
  assert.equal(reopened.state().unknowns.length, 1);
  assert.equal(Date.parse(reopened.state().unknowns[0].endAt) - Date.parse(reopened.state().unknowns[0].startAt), 300000);
});

test("a storage lease allows only one tab to check, then permits takeover", async () => {
  const shared = new Map();
  const clock = { now: Date.parse("2026-09-27T12:00:00Z") };
  const leader = createBrowser({ shared, clock });
  leader.click("start");
  leader.responses.push("connectivity-monitor-ok");
  await leader.fire(0);

  const follower = createBrowser({ shared, clock });
  await follower.fire(0);
  assert.equal(follower.requests.length, 0);
  assert.equal(follower.state().recentChecks.length, 1);
  leader.dispatch("pagehide");
  clock.now += 5000;
  follower.responses.push("connectivity-monitor-ok");
  await follower.fire(5000);
  assert.equal(follower.requests.length, 1);
  assert.equal(follower.state().outages.length, 0);
  assert.equal(follower.state().recentChecks.length, 2);
});

test("an unexpected response and a timed-out probe are failures", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("wrong content");
  await browser.fire(0);
  assert.match(browser.state().lastFailureReason, /unexpected response/);

  browser.clock.now += 15000;
  browser.responses.push("timeout");
  await browser.fire(15000);
  browser.clock.now += 7000;
  await browser.fire(7000);
  assert.equal(browser.state().lastFailureReason, "The check timed out.");
  assert.equal(browser.state().outages.length, 0);
});

test("checking continues in memory when localStorage is unavailable", async () => {
  const browser = createBrowser({ storageAvailable: false });
  assert.match(browser.nodes.get("storage-warning").textContent, /storage is unavailable/i);
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.memoryState().status, "online");
  assert.ok(browser.memoryState().lastSuccessAt);
  assert.equal(browser.memoryState().recentChecks.length, 1);
  assert.equal(browser.nodes.get("timeline-summary").textContent, "1 successful · 0 failed checks");
});

test("clearing history preserves the enabled setting and interval", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);

  browser.nodes.get("interval").value = "30000";
  browser.nodes.get("interval").listeners.get("change")();
  browser.responses.push("network-error");
  await browser.fire(0);
  assert.ok(browser.state().activeOutage);

  browser.click("clear");
  const cleared = browser.state();
  assert.equal(cleared.enabled, true);
  assert.equal(cleared.intervalMs, 30000);
  assert.equal(cleared.lastCheckedAt, null);
  assert.equal(cleared.activeOutage, null);
  assert.equal(cleared.outages.length, 0);
  assert.equal(cleared.unknowns.length, 0);
  assert.equal(cleared.recentChecks.length, 0);

  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().status, "online");
  assert.equal(browser.state().recentChecks.length, 1);
});

test("daily totals split at local midnight even across a daylight-saving day", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const browser = createBrowser();
    const state = browser.memoryState();
    state.unknowns.push({
      startAt: "2026-03-28T23:59:30.000Z",
      endAt: "2026-03-29T00:00:30.000Z"
    });
    state.outages.push({
      firstFailureAt: "2026-03-29T22:59:30.000Z",
      lastFailureAt: "2026-03-29T23:00:30.000Z",
      lastSuccessBeforeAt: null
    });
    const days = browser.evaluate("dailyHistory()");
    assert.equal(days.get("2026-03-28").unobserved, 30000);
    assert.equal(days.get("2026-03-29").unobserved, 30000);
    assert.equal(days.get("2026-03-29").downtime, 30000);
    assert.equal(days.get("2026-03-30").downtime, 30000);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("existing version-1 history loads without fabricating individual checks", async () => {
  const initial = createBrowser();
  const saved = JSON.parse(initial.evaluate("JSON.stringify(emptyState())"));
  delete saved.recentChecks;
  saved.intervalMs = 30000;
  saved.status = "online";
  saved.lastCheckedAt = "2026-09-27T11:59:00.000Z";
  saved.lastSuccessAt = saved.lastCheckedAt;
  saved.outages.push({
    firstFailureAt: "2026-09-27T11:00:00.000Z", lastFailureAt: "2026-09-27T11:00:30.000Z",
    lastSuccessBeforeAt: null, firstSuccessAfterAt: "2026-09-27T11:01:00.000Z"
  });
  const browser = createBrowser({ shared: new Map([[dataKey, JSON.stringify(saved)]]) });
  assert.equal(browser.memoryState().recentChecks.length, 0);
  assert.equal(browser.memoryState().outages.length, 1);
  assert.equal(browser.memoryState().intervalMs, 30000);
  assert.equal(browser.nodes.get("timeline-summary").textContent, "0 successful · 0 failed checks");
  assert.match(browser.nodes.get("timeline-empty").textContent, /not reconstructed/);
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().recentChecks.length, 1);
  assert.equal(browser.state().outages.length, 1);
});

test("recent-check validation rejects malformed data and prunes expired saved checks", () => {
  const browser = createBrowser();
  const saved = JSON.parse(browser.evaluate("JSON.stringify(emptyState())"));
  saved.recentChecks = [
    { checkedAt: "2026-09-26T11:59:59.000Z", ok: true, reason: null, intervalMs: 15000, gapBefore: false },
    { checkedAt: "2026-09-26T12:00:00.000Z", ok: true, reason: null, intervalMs: 15000, gapBefore: false },
    { checkedAt: "2026-09-27T12:00:00.000Z", ok: false, reason: "Network error", intervalMs: 30000, gapBefore: true }
  ];
  const loaded = createBrowser({ shared: new Map([[dataKey, JSON.stringify(saved)]]) });
  assert.equal(loaded.memoryState().recentChecks.length, 2);
  assert.equal(loaded.memoryState().recentChecks[0].checkedAt, "2026-09-26T12:00:00.000Z");
  assert.equal(loaded.nodes.get("timeline-summary").textContent, "0 successful · 1 failed checks");
  saved.recentChecks[2].gapBefore = "yes";
  const invalid = createBrowser({ shared: new Map([[dataKey, JSON.stringify(saved)]]) });
  assert.equal(invalid.memoryState().recentChecks.length, 0);
  assert.match(invalid.nodes.get("storage-warning").textContent, /could not be read/);
});

test("recent history is time-bounded, capped, and does not mutate the input", () => {
  const browser = createBrowser();
  const result = browser.evaluate(`(() => {
    const records = Array.from({ length: 6001 }, (_value, index) => ({ checkedAt: new Date(Date.now() - 6000 + index).toISOString() }));
    const retained = retainRecentChecks(records, Date.now());
    return { count: retained.length, original: records.length, first: retained[0].checkedAt };
  })()`);
  assert.equal(result.count, 6000);
  assert.equal(result.original, 6001);
  assert.equal(result.first, new Date(browser.clock.now - 5999).toISOString());
  assert.equal(browser.evaluate(`retainRecentChecks([
    { checkedAt: new Date(Date.now() - RECENT_WINDOW_MS - 1).toISOString() },
    { checkedAt: new Date(Date.now() - RECENT_WINDOW_MS).toISOString() }
  ], Date.now()).length`), 1);
});

test("the timeline clips observations and estimated bounds to its window without changing history", () => {
  const browser = createBrowser();
  const snapshot = browser.memoryState();
  snapshot.recentChecks = ["2026-09-27T10:59:59.000Z", "2026-09-27T11:00:00.000Z", "2026-09-27T12:00:00.000Z", "2026-09-27T12:00:01.000Z"]
    .map(checkedAt => ({ checkedAt, ok: true, reason: null, intervalMs: 15000, gapBefore: false }));
  snapshot.outages.push({
    firstFailureAt: "2026-09-27T10:59:00.000Z", lastFailureAt: "2026-09-27T11:15:00.000Z",
    lastSuccessBeforeAt: "2026-09-27T10:58:00.000Z", firstSuccessAfterAt: "2026-09-27T11:16:00.000Z"
  });
  snapshot.outages.push({ firstFailureAt: "2026-09-27T12:00:00.000Z", lastFailureAt: "2026-09-27T12:00:00.000Z", lastSuccessBeforeAt: null });
  snapshot.unknowns.push({ startAt: "2026-09-27T11:55:00.000Z", endAt: "2026-09-27T12:05:00.000Z" });
  const original = JSON.stringify(snapshot);
  const data = browser.evaluate("timelineData(state, Date.now(), 60 * 60 * 1000)");
  assert.equal(data.checks.length, 2);
  assert.equal(data.outages[0].from, Date.parse("2026-09-27T11:00:00Z"));
  assert.equal(data.outages[0].sourceFrom, Date.parse("2026-09-27T10:58:30Z"));
  assert.equal(data.outages[0].to, Date.parse("2026-09-27T11:15:30Z"));
  assert.equal(data.outages[1].from, data.outages[1].to);
  assert.equal(data.gaps[0].to, browser.clock.now);
  assert.equal(data.gaps[0].sourceTo, Date.parse("2026-09-27T12:05:00Z"));
  assert.equal(JSON.stringify(snapshot), original);
});

test("stale tails become unobserved without saving probes or extending downtime", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  const recorded = JSON.stringify(browser.state());
  browser.clock.now += 40000;
  browser.pulse();
  assert.equal(browser.nodes.get("status-title").textContent, "Awaiting a fresh check");
  assert.match(browser.nodes.get("status-freshness").textContent, /40s ago · stale result/);
  const data = browser.evaluate("timelineData(state, Date.now(), timelineWindowMs)");
  assert.equal(data.gaps.length, 1);
  assert.equal(data.gaps[0].open, true);
  assert.equal(data.gaps[0].sourceFrom, Date.parse("2026-09-27T12:00:15Z"));
  assert.equal(data.outages[0].sourceTo, Date.parse("2026-09-27T12:00:15Z"));
  assert.equal(browser.evaluate("dailyHistory().get(dayKey(Date.now())).downtime"), 7500);
  assert.equal(JSON.stringify(browser.state()), recorded);
  assert.match(browser.nodes.get("timeline-changes").children[0].children[0].children[0].textContent, /overdue/);
});

test("a short pause is visible immediately and a later success is not a recovery across the gap", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("network-error");
  await browser.fire(0);
  browser.clock.now += 1000;
  browser.click("stop");
  assert.match(browser.nodes.get("status-freshness").textContent, /monitoring paused/);
  assert.equal(browser.evaluate("timelineData(state, Date.now(), timelineWindowMs).gaps[0].open"), true);
  browser.clock.now += 1000;
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().recentChecks[1].gapBefore, true);
  const data = browser.evaluate("timelineData(state, Date.now(), timelineWindowMs)");
  assert.equal(data.gaps[0].open, false);
  assert.ok(data.changes.some(change => change.title === "Checks resumed · site reachable"));
  assert.ok(data.changes.every(change => change.title !== "Site reachable again"));
  assert.equal(browser.evaluate("dailyHistory().get(dayKey(Date.now())).downtime"), 0);
});

test("even a short page close splits an outage while closing a follower leaves monitoring alone", async () => {
  const shared = new Map();
  const clock = { now: Date.parse("2026-09-27T12:00:00Z") };
  const leader = createBrowser({ shared, clock });
  leader.click("start");
  leader.responses.push("network-error");
  await leader.fire(0);
  const follower = createBrowser({ shared, clock });
  const before = shared.get(dataKey);
  follower.dispatch("pagehide");
  assert.equal(shared.get(dataKey), before);
  leader.dispatch("pagehide");
  assert.equal(leader.state().gapOnNextCheck, true);
  assert.equal(leader.state().activeOutage, null);
  clock.now += 1000;
  const reopened = createBrowser({ shared, clock });
  reopened.responses.push("connectivity-monitor-ok");
  await reopened.fire(0);
  assert.equal(reopened.state().recentChecks[1].gapBefore, true);
  assert.equal(reopened.state().unknowns.length, 1);
  assert.equal(reopened.state().outages[0].firstSuccessAfterAt, undefined);
});

test("changing the check interval preserves context and cannot hide an already overdue gap", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.clock.now += 60000;
  browser.nodes.get("interval").value = "60000";
  browser.nodes.get("interval").listeners.get("change")();
  assert.equal(browser.nodes.get("status-title").textContent, "Awaiting a fresh check");
  browser.responses.push("network-error");
  await browser.fire(0);
  assert.equal(browser.state().recentChecks[0].intervalMs, 15000);
  assert.equal(browser.state().recentChecks[1].intervalMs, 60000);
  assert.equal(browser.state().recentChecks[1].gapBefore, true);
  assert.equal(browser.state().activeOutage.lastSuccessBeforeAt, null);
  browser.clock.now += 60000;
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(60000);
  assert.equal(browser.state().recentChecks[2].gapBefore, false);
  assert.equal(browser.state().unknowns.length, 1);
});

test("dense groups keep failures and provide the actual recorded timestamps", () => {
  const browser = createBrowser();
  const groups = browser.evaluate(`groupTimelineChecks([
    { checkedAt: "2026-09-27T12:00:00Z", ok: true, reason: null },
    { checkedAt: "2026-09-27T12:00:15Z", ok: false, reason: "Timed out" },
    { checkedAt: "2026-09-27T12:00:30Z", ok: true, reason: null }
  ], 60000)`);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].failed, 1);
  assert.equal(groups[0].records.length, 3);
  assert.equal(groups[0].from, Date.parse("2026-09-27T12:00:00Z"));
  assert.equal(groups[0].to, Date.parse("2026-09-27T12:00:30Z"));
  browser.memoryState().recentChecks = groups[0].records;
  const description = browser.evaluate("describeTimelineItem(groupTimelineChecks(state.recentChecks, 60000)[0])");
  assert.equal(description.title, "3 checks · 1 failed");
  assert.match(description.copy, /2 successful, 1 failed.*Timed out/);
});

test("timeline range controls and roving keyboard focus work across live refreshes", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  function targets(node = browser.nodes.get("timeline-plot")) {
    return [...(node.getAttribute("role") === "button" ? [node] : []), ...node.children.flatMap(child => targets(child))];
  }
  const initial = targets();
  assert.ok(initial.length >= 2);
  assert.equal(initial.filter(node => node.getAttribute("tabindex") === "0").length, 1);
  initial[0].focus();
  let prevented = false;
  initial[0].listeners.get("keydown")({ key: "End", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(browser.document.activeElement.dataset.timelineKey, "outage:2026-09-27T12:00:15.000Z");
  const key = browser.document.activeElement.dataset.timelineKey;
  browser.clock.now += 5000;
  browser.pulse();
  assert.equal(browser.document.activeElement.dataset.timelineKey, key);
  assert.notEqual(browser.document.activeElement, initial[initial.length - 1]);
  browser.click("timeline-day");
  assert.equal(browser.nodes.get("timeline-day").getAttribute("aria-pressed"), "true");
  assert.equal(browser.evaluate("timelineWindowMs"), 24 * 60 * 60 * 1000);
  assert.equal(targets().filter(node => node.getAttribute("tabindex") === "0").length, 1);
  browser.click("timeline-hour");
  assert.equal(browser.nodes.get("timeline-hour").getAttribute("aria-pressed"), "true");
});

test("JSON exports include recent observations", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.click("export");
  const exported = JSON.parse(await browser.downloads[0].text());
  assert.deepEqual(exported.recentChecks, browser.state().recentChecks);
  assert.equal(exported.exportedAt, new Date(browser.clock.now).toISOString());
});

test("resuming and checking do not relabel a successful previous observation as failed", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.click("stop");
  browser.clock.now += 1000;
  browser.click("start");
  assert.equal(browser.nodes.get("last-check-caption").textContent, "Probe succeeded");
  browser.responses.push("timeout");
  await browser.fire(0);
  assert.equal(browser.nodes.get("status-title").textContent, "Checking connection…");
  assert.equal(browser.nodes.get("last-check-caption").textContent, "Probe succeeded");
  assert.equal(browser.state().recentChecks.length, 1);
  browser.clock.now += 7000;
  await browser.fire(7000);
  assert.equal(browser.nodes.get("last-check-caption").textContent, "Probe failed");
  assert.equal(browser.state().recentChecks[1].gapBefore, true);
});

test("24-hour windows remain UTC-based through DST and local timestamps distinguish repeated times", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/London";
  try {
    const browser = createBrowser({ clock: { now: Date.parse("2026-10-25T02:15:00Z") } });
    const snapshot = browser.memoryState();
    snapshot.recentChecks = ["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]
      .map(checkedAt => ({ checkedAt, ok: true, reason: null, intervalMs: 60000, gapBefore: true }));
    const data = browser.evaluate("timelineData(state, Date.now(), RECENT_WINDOW_MS)");
    assert.equal(data.to - data.from, 24 * 60 * 60 * 1000);
    assert.equal(data.checks.length, 2);
    assert.equal(browser.evaluate("dayKey(state.recentChecks[0].checkedAt)"), "2026-10-25");
    assert.notEqual(browser.evaluate("observationTime(state.recentChecks[0].checkedAt)"), browser.evaluate("observationTime(state.recentChecks[1].checkedAt)"));
    assert.equal(snapshot.recentChecks[0].checkedAt, "2026-10-25T00:30:00.000Z");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("importing an older export replaces history, keeps settings, and leaves the time since export unobserved", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  browser.clock.now += 15000;
  browser.responses.push("network-error");
  await browser.fire(15000);
  assert.ok(browser.state().activeOutage);

  const exported = {
    version: 1, enabled: false, intervalMs: 60000, status: "offline",
    lastCheckedAt: "2026-09-26T10:00:00.000Z", lastSuccessAt: "2026-09-26T09:59:00.000Z",
    lastFailureReason: "The probe could not be reached.",
    activeOutage: { firstFailureAt: "2026-09-26T09:59:30.000Z", lastFailureAt: "2026-09-26T10:00:00.000Z", lastSuccessBeforeAt: "2026-09-26T09:59:00.000Z" },
    outages: [{ firstFailureAt: "2026-09-26T08:00:00.000Z", lastFailureAt: "2026-09-26T08:01:00.000Z",
      lastSuccessBeforeAt: null, firstSuccessAfterAt: "2026-09-26T08:02:00.000Z" }],
    unknowns: [{ startAt: "2026-09-26T09:00:00.000Z", endAt: "2026-09-26T09:30:00.000Z" }],
    gapOnNextCheck: false, exportedAt: "2026-09-26T10:00:05.000Z"
  };
  await browser.importFile(JSON.stringify(exported));
  const imported = browser.state();
  assert.equal(imported.enabled, true);
  assert.equal(imported.intervalMs, 15000);
  assert.equal(imported.lastCheckedAt, exported.lastCheckedAt);
  assert.equal(imported.activeOutage, null);
  assert.deepEqual(imported.outages, [...exported.outages, exported.activeOutage]);
  assert.deepEqual(imported.unknowns, exported.unknowns);
  assert.deepEqual(imported.recentChecks, []);
  assert.equal(imported.gapOnNextCheck, true);
  assert.equal("exportedAt" in imported, false);
  assert.equal(browser.nodes.get("import-status").textContent,
    "Imported history.json: 2 outages, 1 unobserved interval, 0 recent checks.");

  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  const resumed = browser.state();
  assert.deepEqual(resumed.unknowns[resumed.unknowns.length - 1],
    { startAt: exported.lastCheckedAt, endAt: new Date(browser.clock.now).toISOString() });
  assert.equal(resumed.outages.length, 2);
  assert.equal(resumed.outages[1].firstSuccessAfterAt, undefined);
  assert.equal(resumed.recentChecks[0].gapBefore, true);
  assert.equal(resumed.status, "online");
});

test("an exported history imports back into another browser unchanged", async () => {
  const source = createBrowser();
  source.click("start");
  for (const response of ["connectivity-monitor-ok", "network-error", "connectivity-monitor-ok"]) {
    source.responses.push(response);
    await source.fire(source.state().lastCheckedAt ? 15000 : 0);
    source.clock.now += 15000;
  }
  source.click("export");
  const raw = await source.downloads[0].text();

  const target = createBrowser({ clock: source.clock });
  await target.importFile(raw);
  const original = source.state();
  const imported = target.state();
  assert.equal(imported.enabled, false);
  for (const key of ["outages", "unknowns", "recentChecks", "activeOutage", "lastCheckedAt", "lastSuccessAt", "status"]) {
    assert.deepEqual(imported[key], original[key], key);
  }
  assert.equal(imported.outages.length, 1);
  assert.equal(imported.recentChecks.length, 3);
  assert.equal(imported.gapOnNextCheck, true);
  assert.equal(target.nodes.get("timeline-summary").textContent, "2 successful · 1 failed checks");
});

test("invalid, oversized, or declined imports leave history unchanged", async () => {
  const browser = createBrowser();
  browser.click("start");
  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  const before = browser.state();
  let confirms = 0;
  browser.window.confirm = () => { confirms += 1; return false; };
  const valid = JSON.parse(browser.evaluate("JSON.stringify(emptyState())"));

  for (const raw of ["not json", "null", JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, outages: [{ firstFailureAt: "soon" }] })]) {
    await browser.importFile(raw, { name: "bad.json" });
    assert.equal(browser.nodes.get("import-status").textContent,
      "bad.json is not a connectivity history export. Nothing was changed.");
  }
  await browser.importFile(JSON.stringify(valid), { name: "big.json", size: 11 * 1024 * 1024 });
  assert.match(browser.nodes.get("import-status").textContent, /^big\.json is larger than 10 MB/);
  assert.equal(confirms, 0);

  browser.nodes.get("import-status").textContent = "";
  await browser.importFile(JSON.stringify(valid));
  assert.equal(confirms, 1);
  assert.equal(browser.nodes.get("import-status").textContent, "");
  assert.deepEqual(browser.state(), before);
});

test("imported history is capped and expired recent checks are pruned", async () => {
  const browser = createBrowser();
  const saved = JSON.parse(browser.evaluate("JSON.stringify(emptyState())"));
  saved.outages = Array.from({ length: 1001 }, (_value, index) => {
    const at = new Date(Date.parse("2026-09-01T00:00:00Z") + index * 60000).toISOString();
    return { firstFailureAt: at, lastFailureAt: at, lastSuccessBeforeAt: null, firstSuccessAfterAt: null };
  });
  saved.recentChecks = ["2026-09-26T11:59:59.000Z", "2026-09-27T11:59:00.000Z"]
    .map(checkedAt => ({ checkedAt, ok: true, reason: null, intervalMs: 15000, gapBefore: false }));
  saved.lastCheckedAt = "2026-09-27T11:59:00.000Z";
  await browser.importFile(JSON.stringify(saved));
  assert.equal(browser.state().outages.length, 1000);
  assert.equal(browser.state().outages[0].firstFailureAt, "2026-09-01T00:01:00.000Z");
  assert.deepEqual(browser.state().recentChecks.map(record => record.checkedAt), ["2026-09-27T11:59:00.000Z"]);
});
