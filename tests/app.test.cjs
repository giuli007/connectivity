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
    listeners: new Map(),
    textContent: "",
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
  const responses = [];
  const requests = [];
  let nextTimerId = 0;
  let unqueuedRequests = 0;
  const document = {
    baseURI: "https://example.github.io/connectivity/",
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createNode());
      return nodes.get(id);
    },
    createElement: createNode,
    createDocumentFragment() { return createNode("#fragment"); },
    addEventListener() {}
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
  const context = vm.createContext({
    document, window, navigator: { onLine: true }, URL, Intl, Date: TestDate,
    Math, AbortController, Blob,
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() {},
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
    clock, nodes, requests, responses,
    state() { return shared.has(dataKey) ? JSON.parse(shared.get(dataKey)) : vm.runInContext("state", context); },
    memoryState() { return vm.runInContext("state", context); },
    evaluate(expression) { return vm.runInContext(expression, context); },
    click(id) { nodes.get(id).listeners.get("click")(); },
    dispatch(event) { windowListeners.get(event)(); },
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
  leader.dispatch("pagehide");
  clock.now += 5000;
  follower.responses.push("connectivity-monitor-ok");
  await follower.fire(5000);
  assert.equal(follower.requests.length, 1);
  assert.equal(follower.state().outages.length, 0);
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

  browser.responses.push("connectivity-monitor-ok");
  await browser.fire(0);
  assert.equal(browser.state().status, "online");
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
