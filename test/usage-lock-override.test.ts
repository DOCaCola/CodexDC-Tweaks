import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";

const require = createRequire(import.meta.url);
const { configureUsageLocks } = require("../tweaks/usage-lock-override/usage-locks.js");
const { findReserveLayer, findUsageGate, isAppPage, createController } =
  require("../tweaks/usage-lock-override/index.js").__test;
const layerId = "2458863263";
const key = "__testUsageLocks";
const usageGate = { module: "/assets/test.js", selector: "gate", initialize: "initialize" };
const configuration = { layer: layerId, usageGate };

function usageScope() {
  const scope = { __scopeBrand: "AppScope", id: Symbol() };
  const exhausted = atom(true);
  const readOnly = atom(false);
  const blocked = atom((get) => get(exhausted));
  const disabled = atom((get) => get(blocked) || get(readOnly));
  const store = createStore();
  const selector = {
    scope,
    resolve(node: { cachedBindings: Map<unknown, unknown> }, _chain?: Map<unknown, unknown>) {
      return node.cachedBindings.get(selector);
    },
  };
  const node = { token: scope, store, cachedBindings: new Map([[selector, blocked]]) };
  const chain = new Map([[scope.id, node]]);
  return { selector, node, chain, store, exhausted, readOnly, blocked, disabled };
}

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
  const usage = usageScope();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const errors: unknown[][] = [];
  const context = createContext({
    Map,
    location: { href: url },
    document: { body: { querySelectorAll: () => [
      { __reactFiber$test: { memoizedProps: { value: usage.chain } } },
    ] } },
    __loadModule: async () => ({ initialize() {}, gate: usage.selector }),
    __STATSIG__: { instances: client ? { local: client } : {}, firstInstance: client },
    console: { info() {}, error: (...args: unknown[]) => errors.push(args) },
    setInterval(fn: () => void) { timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval(id: number) { timers.delete(id); },
  });
  function configureArgs(args: unknown) {
    return runInContext(`(${configureUsageLocks})(${JSON.stringify(args)}, __loadModule)`, context);
  }
  function configure(enabled = true, owner = "first") {
    return configureArgs({ key, owner, ...configuration, enabled });
  }
  return { context, configure, configureArgs, usage, timers, errors, tick: () => [...timers.values()].forEach((fn) => fn()) };
}

test("discovers the reserve setting independently of minified symbols and rejects ambiguity", () => {
  const source = "function x(client){return renamed(client,`2458863263`,{disableExposureLog:!0}).get(`reserve_enabled`,!1)}";
  assert.equal(findReserveLayer(source), layerId);
  assert.throws(() => findReserveLayer("const versions=[]"), /Unsupported/);
  assert.throws(() => findReserveLayer(source + source.replace(layerId, "other")), /Unsupported/);
});

test("discovers the exported shared usage gate and rejects missing or ambiguous gates", () => {
  const source = "var lock;function init(){return(init=once((()=>{lock=derived(scope,({get:g})=>{"
    + "let a=g(auth),q=g(quota).data;"
    + "if(a.authMethod!==`chatgpt`||a.accountId!==a.authenticatedAccountId||q.rate_limit?.allowed!==!1)return!1;"
    + "return windows.some(w=>w.windowMinutes===1&&w.resetsAt===2)"
    + "})})))()}export{lock as gate,init as setup};";
  assert.deepEqual(findUsageGate(source), { selector: "gate", initialize: "setup" });
  assert.throws(() => findUsageGate("export{};"), /expected one/);
  assert.throws(() => findUsageGate(source + source), /expected one/);
  assert.throws(() => findUsageGate(source.replace("lock as gate", "other as gate")), /export missing/);
});

test("shared quota lock notifies mounted composers without disabling unrelated restrictions", async () => {
  const p = page(featureClient().client);
  const { store, blocked, disabled, exhausted, readOnly } = p.usage;
  const originalRead = blocked.read;
  const originalResolve = p.usage.selector.resolve;
  const observed: boolean[] = [];
  const unsubscribe = store.sub(disabled, () => observed.push(store.get(disabled)));
  assert.equal(store.get(disabled), true);
  await p.configure();
  assert.equal(store.get(blocked), false);
  assert.equal(store.get(disabled), false);
  assert.equal(store.get(exhausted), true);
  assert.deepEqual(observed, [false]);
  assert.equal("init" in blocked, false);
  assert.equal("write" in blocked, false);
  store.set(readOnly, true);
  assert.equal(store.get(disabled), true);
  store.set(readOnly, false);
  store.set(exhausted, false);
  store.set(exhausted, true);
  assert.equal(store.get(disabled), false);
  await p.configure(false);
  assert.equal(store.get(disabled), true);
  assert.equal(blocked.read, originalRead);
  assert.equal(p.usage.selector.resolve, originalResolve);
  store.set(exhausted, false);
  assert.equal(store.get(disabled), false);
  unsubscribe();
});

test("restores current usage after reset and patches newly created scopes", async () => {
  const p = page(featureClient().client);
  await p.configure();
  const next = usageScope();
  next.node.cachedBindings.set(p.usage.selector, next.blocked);
  const nextChain = new Map([[p.usage.selector.scope.id, next.node]]);
  p.usage.selector.resolve(next.node, nextChain);
  assert.equal(next.store.get(next.blocked), false);
  p.usage.store.set(p.usage.exhausted, false);
  await p.configure(false);
  assert.equal(p.usage.store.get(p.usage.blocked), false);
  assert.equal(next.store.get(next.blocked), true);
});

test("waits for an AppScope to mount and restores a captured resolver on stop", async () => {
  const p = page(featureClient().client);
  const elements = p.context.document.body.querySelectorAll;
  p.context.document.body.querySelectorAll = () => [];
  assert.equal((await p.configure()).status, "waiting");
  p.context.document.body.querySelectorAll = elements;
  p.tick();
  assert.equal((await p.configure()).status, "active");
  const captured = p.usage.selector.resolve;
  p.usage.selector.resolve = (...args: Parameters<typeof captured>) => captured(...args);
  await p.configure(false);
  const next = usageScope();
  next.node.cachedBindings.set(p.usage.selector, next.blocked);
  p.usage.selector.resolve(next.node, new Map([[p.usage.selector.scope.id, next.node]]));
  assert.equal(next.store.get(next.blocked), true);
});

test("enabling updates subscribed selectors immediately and restores current server values on disable", async () => {
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
  assert.equal((await p.configure()).status, "active");
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
  await p.configure(false);
  assert.equal(client.getLayer, original);
  assert.equal(reserveActive, true);
  assert.equal(cached.get("reserve_enabled", false), true);
  assert.equal(p.timers.size, 0);
});

test("handles delayed clients, account replacements, and repeated injection", async () => {
  const p = page();
  assert.equal((await p.configure()).status, "waiting");
  const first = featureClient(), second = featureClient();
  const original = first.client.getLayer;
  p.context.__STATSIG__ = { instances: { local: first.client }, firstInstance: first.client };
  p.tick();
  assert.equal(first.client.getLayer(layerId).get("reserve_enabled", true), false);
  await p.configure();
  assert.equal(p.timers.size, 1);
  p.context.__STATSIG__ = { instances: { local: second.client }, firstInstance: second.client };
  p.tick();
  assert.equal(first.client.getLayer, original);
  assert.equal(second.client.getLayer(layerId).get("reserve_enabled", true), false);
  await p.configure(false);
  assert.equal(second.client.getLayer(layerId).get("reserve_enabled", false), true);
});

test("an old stop cannot disable a replacement instance or another wrapper", async () => {
  const { client } = featureClient();
  const p = page(client);
  await p.configure(true, "first");
  await p.configure(true, "second");
  await p.configure(false, "first");
  assert.equal(client.getLayer(layerId).get("reserve_enabled", true), false);
  const wrapped = client.getLayer;
  const laterWrapper = function (...args: Parameters<typeof wrapped>) {
    return wrapped.apply(client, args);
  };
  client.getLayer = laterWrapper;
  await p.configure(false, "second");
  assert.equal(client.getLayer, laterWrapper);
  assert.equal(client.getLayer(layerId).get("reserve_enabled", false), true);
});

test("never runs on embedded websites and fails explicitly for unsupported clients", async () => {
  for (const url of ["https://chatgpt.com", "app://-/other.html", "app://evil/index.html", "about:blank"]) {
    assert.equal(isAppPage(url), false);
    const { client } = featureClient(), original = client.getLayer;
    assert.equal((await page(client, url).configure()).status, "skipped");
    assert.equal(client.getLayer, original);
  }
  const p = page();
  p.context.__STATSIG__ = { instances: { unsupported: {} } };
  await assert.rejects(() => p.configure(), /Unsupported/);
  assert.equal(p.timers.size, 0);
  assert.equal(p.context[key], undefined);
  assert.equal(p.usage.store.get(p.usage.blocked), true);
});

test("a client incompatibility after startup restores hooks and reports failure", async () => {
  const { client } = featureClient(), original = client.getLayer;
  const p = page(client);
  await p.configure();
  p.context.__STATSIG__.instances.unsupported = {};
  p.tick();
  assert.equal(client.getLayer, original);
  assert.equal(p.timers.size, 0);
  assert.equal((await p.configure()).status, "failed");
  assert.match((await p.configure()).error, /Unsupported/);
  assert.equal(p.errors.length, 1);
  await p.configure(false);
  assert.equal(p.context[key], undefined);
});

class Contents extends EventEmitter {
  id = 1;
  destroyed = false;
  constructor(readonly page: ReturnType<typeof page>) { super(); }
  getURL() { return this.page.context.location.href; }
  isDestroyed() { return this.destroyed; }
  async executeJavaScript(source: string) {
    return this.page.configureArgs(JSON.parse(source.slice(source.lastIndexOf(")(") + 2, -1)));
  }
}

test("host lifecycle covers existing/new app windows, navigation and stop/start races", async () => {
  const first = new Contents(page(featureClient().client));
  const browser = new Contents(page(featureClient().client, "https://example.com"));
  const app = new EventEmitter();
  const host = { app, webContents: { getAllWebContents: () => [first, browser] } };
  const queues = new WeakMap();
  const errors: unknown[] = [];
  const log = { info() {}, error: (...args: unknown[]) => errors.push(args) };
  const old = createController(host, configuration, log, queues);
  await queues.get(first);
  assert.equal(first.page.timers.size, 1);
  assert.equal(browser.page.timers.size, 0);
  const added = new Contents(page(featureClient().client, "app://-/detached-window.html?initialRoute=x"));
  app.emit("web-contents-created", {}, added);
  added.emit("dom-ready");
  await queues.get(added);
  assert.equal(added.page.timers.size, 1);
  const stopping = old.stop();
  const next = createController(host, configuration, log, queues);
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
