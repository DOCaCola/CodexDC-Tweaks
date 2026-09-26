import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { configureReserveMode } = require("../tweaks/unlimited-model-selection/reserve-mode.js");
const { findReserveLayer, isAppPage, createController } =
  require("../tweaks/unlimited-model-selection/index.js").__test;
const layerId = "2458863263";
const key = "__testReserveMode";

function featureClient() {
  const events = new EventEmitter();
  const values = { reserve_enabled: true, other_setting: 17 };
  const layer = {
    name: layerId,
    get(name: string, fallback: unknown) { return values[name as keyof typeof values] ?? fallback; },
  };
  const calls: unknown[][] = [];
  const client = {
    loadingStatus: "Ready",
    getContext: () => ({ values }),
    getLayer(name: string, options?: unknown) {
      assert.equal(this, client);
      calls.push([name, options]);
      return layer;
    },
    $emt(event: { name: string; values?: unknown }) { events.emit(event.name, event); },
    on: events.on.bind(events),
  };
  return { client, values, layer, calls };
}

function page(client?: ReturnType<typeof featureClient>["client"], url = "app://-/index.html") {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const errors: unknown[][] = [];
  const context = createContext({
    location: { href: url },
    __STATSIG__: { instances: client ? { local: client } : {}, firstInstance: client },
    console: { info() {}, error: (...args: unknown[]) => errors.push(args) },
    setInterval(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval(id: number) { timers.delete(id); },
  });
  function configure(enabled = true, owner = "first") {
    return runInContext(`(${configureReserveMode})(${JSON.stringify({
      key, owner, layer: layerId, enabled,
    })})`, context);
  }
  return { context, configure, timers, errors, tick: () => [...timers.values()].forEach((fn) => fn()) };
}

test("discovers the reserve setting independently of minified symbols and rejects ambiguity", () => {
  const source = "function x(client){return renamed(client,`2458863263`,{disableExposureLog:!0}).get(`reserve_enabled`,!1)}";
  assert.equal(findReserveLayer(source), layerId);
  assert.throws(() => findReserveLayer("const versions=[]"), /Unsupported/);
  assert.throws(() => findReserveLayer(source + source.replace(layerId, "other")), /Unsupported/);
});

test("enabling updates subscribed selectors immediately and restores current server values on disable", () => {
  const { client, values, layer, calls } = featureClient();
  const original = client.getLayer;
  const options = { disableExposureLog: true };
  const readReserve = () => client.getLayer(layerId, options).get("reserve_enabled", false);
  let reserveActive = readReserve();
  client.on("values_updated", (event) => {
    assert.equal(event.values, values);
    reserveActive = readReserve();
  });
  const p = page(client);
  assert.equal(reserveActive, true);
  assert.equal(p.configure().status, "active");
  assert.equal(reserveActive, false);
  assert.equal(values.reserve_enabled, true);
  assert.equal(client.getLayer("unrelated"), layer);
  assert.equal(client.getLayer(layerId).get("other_setting", 0), 17);
  assert.equal(calls.some((call) => call[1] === options), true);
  const cached = client.getLayer(layerId);
  assert.equal(client.getLayer(layerId), cached);
  // Server refreshes still flow through, while forced reserve stays off.
  values.other_setting = 42;
  client.$emt({ name: "values_updated", values });
  assert.equal(cached.get("other_setting", 0), 42);
  assert.equal(reserveActive, false);
  p.configure(false);
  assert.equal(client.getLayer, original);
  assert.equal(reserveActive, true);
  assert.equal(cached.get("reserve_enabled", false), true);
  assert.equal(p.timers.size, 0);
});

test("handles delayed clients, account replacements, and repeated injection", () => {
  const p = page();
  assert.equal(p.configure().status, "waiting");
  const first = featureClient(), second = featureClient();
  const original = first.client.getLayer;
  p.context.__STATSIG__ = { instances: { local: first.client }, firstInstance: first.client };
  p.tick();
  assert.equal(first.client.getLayer(layerId).get("reserve_enabled", true), false);
  p.configure();
  assert.equal(p.timers.size, 1);
  p.context.__STATSIG__ = { instances: { local: second.client }, firstInstance: second.client };
  p.tick();
  assert.equal(first.client.getLayer, original);
  assert.equal(second.client.getLayer(layerId).get("reserve_enabled", true), false);
  p.configure(false);
  assert.equal(second.client.getLayer(layerId).get("reserve_enabled", false), true);
});

test("an old stop cannot disable a replacement instance or another wrapper", () => {
  const { client } = featureClient();
  const p = page(client);
  p.configure(true, "first");
  p.configure(true, "second");
  p.configure(false, "first");
  assert.equal(client.getLayer(layerId).get("reserve_enabled", true), false);
  const wrapped = client.getLayer;
  const laterWrapper = function (...args: Parameters<typeof wrapped>) {
    return wrapped.apply(client, args);
  };
  client.getLayer = laterWrapper;
  p.configure(false, "second");
  assert.equal(client.getLayer, laterWrapper);
  assert.equal(client.getLayer(layerId).get("reserve_enabled", false), true);
});

test("never runs on embedded websites and fails explicitly for unsupported clients", () => {
  for (const url of ["https://chatgpt.com", "app://-/other.html", "app://evil/index.html", "about:blank"]) {
    assert.equal(isAppPage(url), false);
    const { client } = featureClient(), original = client.getLayer;
    assert.equal(page(client, url).configure().status, "skipped");
    assert.equal(client.getLayer, original);
  }
  const p = page();
  p.context.__STATSIG__ = { instances: { unsupported: {} } };
  assert.throws(() => p.configure(), /Unsupported/);
  assert.equal(p.timers.size, 0);
  assert.equal(p.context[key], undefined);
});

test("a client incompatibility after startup restores hooks and reports failure", () => {
  const { client } = featureClient(), original = client.getLayer;
  const p = page(client);
  p.configure();
  p.context.__STATSIG__.instances.unsupported = {};
  p.tick();
  assert.equal(client.getLayer, original);
  assert.equal(p.timers.size, 0);
  assert.equal(p.configure().status, "failed");
  assert.match(p.configure().error, /Unsupported/);
  assert.equal(p.errors.length, 1);
  p.configure(false);
  assert.equal(p.context[key], undefined);
});

class Contents extends EventEmitter {
  id = 1;
  destroyed = false;
  constructor(readonly page: ReturnType<typeof page>) { super(); }
  getURL() { return this.page.context.location.href; }
  isDestroyed() { return this.destroyed; }
  async executeJavaScript(source: string) { return runInContext(source, this.page.context); }
}

test("host lifecycle covers existing/new app windows, navigation and stop/start races", async () => {
  const first = new Contents(page(featureClient().client));
  const browser = new Contents(page(featureClient().client, "https://example.com"));
  const app = new EventEmitter();
  const host = { app, webContents: { getAllWebContents: () => [first, browser] } };
  const queues = new WeakMap();
  const errors: unknown[] = [];
  const log = { info() {}, error: (...args: unknown[]) => errors.push(args) };
  const old = createController(host, layerId, log, queues);
  await queues.get(first);
  assert.equal(first.page.timers.size, 1);
  assert.equal(browser.page.timers.size, 0);
  const added = new Contents(page(featureClient().client, "app://-/detached-window.html?initialRoute=x"));
  app.emit("web-contents-created", {}, added);
  added.emit("dom-ready");
  await queues.get(added);
  assert.equal(added.page.timers.size, 1);
  const stopping = old.stop();
  const next = createController(host, layerId, log, queues);
  await stopping;
  await queues.get(first);
  assert.equal(first.page.timers.size, 1);
  assert.equal(added.page.timers.size, 0);
  assert.equal(first.listenerCount("dom-ready"), 1);
  await next.stop();
  assert.equal(first.page.timers.size, 0);
  assert.equal(app.listenerCount("web-contents-created"), 0);
  assert.equal(first.listenerCount("dom-ready"), 0);
  assert.deepEqual(errors, []);
});
