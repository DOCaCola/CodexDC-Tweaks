import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { createRegistry } = require("../tweaks/codex-lb/index.js").__test;
const { STATE_KEY, createUsageController, isMainPage } = require("../tweaks/codex-lb/usage.js");
const { configureUsagePopover } = require("../tweaks/codex-lb/usage-popover.js");

const quiet = { info() {}, warn() {}, error() {} };

test("usage is offered by the providers that confirm it, with the default provider for new threads", async () => {
  const documents: Record<string, unknown> = {
    "https://lb.example/v1/codex-lb/capabilities": {
      object: "codex_lb.capabilities",
      service: "codex-lb",
      capabilities: [{ id: "usage", models: ["gpt-6.1-sol"] }],
    },
    "https://other.example/v1/codex-lb/capabilities": {
      object: "codex_lb.capabilities",
      service: "codex-lb",
      capabilities: [{ id: "composer_predictions", models: ["gpt-6.1-sol"] }],
    },
  };
  const registry = createRegistry({
    fetch: async (url: string) => ({ status: 200, ok: true, json: async () => documents[url] }),
    readConfig: () => [
      'profile = "lb"',
      "[profiles.lb]",
      'model_provider = "codex-lb"',
      "[model_providers.codex-lb]",
      'base_url = "https://lb.example/v1"',
      "[model_providers.other]",
      'base_url = "https://other.example/v1"',
    ].join("\n"),
    env: {},
    log: quiet,
  });
  await registry.refresh();
  assert.deepEqual(registry.providers("usage").map((provider: any) => provider.baseUrl), ["https://lb.example/v1"]);
  assert.equal(registry.defaultProvider(), "codex-lb");
});

test("only the main window's page is a usage page", () => {
  assert.equal(isMainPage("app://-/index.html"), true);
  assert.equal(isMainPage("app://-/index.html?initialRoute=%2Favatar-overlay"), false);
  assert.equal(isMainPage("app://-/detached-window.html?initialRoute=%2Fdetached-window"), false);
});

// A main window whose page runs the popover script and answers its requests.
function fakeHost() {
  const app = new EventEmitter() as any;
  const window = { visible: true, minimized: false };
  const states: any[] = [];
  const signals: unknown[] = [];
  let waiting: ((signal: unknown) => void) | null = null;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => "app://-/index.html",
    async executeJavaScript(code: string) {
      if (code.startsWith("(function configureUsagePopover")) {
        const args = JSON.parse(code.slice(code.lastIndexOf(")(") + 2, -1));
        states.push(args.state);
        return { status: args.state == null ? "stopped" : "active" };
      }
      return signals.length > 0 ? signals.shift() : new Promise((resolve) => { waiting = resolve; });
    },
  });
  const opened: string[] = [];
  const host = {
    app,
    webContents: { getAllWebContents: () => [contents] },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: contents, isVisible: () => window.visible, isMinimized: () => window.minimized }],
    },
    shell: { openExternal: async (url: string) => { opened.push(url); } },
  };
  function signal(value: unknown) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    } else {
      signals.push(value);
    }
  }
  return { host, window, states, signal, opened };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

const provider = { id: "codex-lb", baseUrl: "https://lb.example/backend-api/codex", query: {}, headers: {} };

test("usage refreshes every minute while the main window is visible, and on request", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-11-07T11:00:00Z") });
  try {
    const { host, window, states, signal, opened } = fakeHost();
    const reads: string[] = [];
    let release: (() => void) | null = null;
    const controller = createUsageController({
      host,
      log: quiet,
      queues: new WeakMap(),
      load: async (_provider: unknown, since: Date) => {
        reads.push(since.toISOString());
        if (reads.length === 4) await new Promise<void>((resolve) => { release = resolve; });
        return { object: "codex_lb.usage", pools: [], today: null };
      },
    });
    await controller.update([provider], "codex-lb");
    await settle();
    assert.equal(reads.length, 1);
    const expectedMidnight = new Date("2026-11-07T11:00:00Z");
    expectedMidnight.setHours(0, 0, 0, 0);
    assert.equal(reads[0], expectedMidnight.toISOString());
    const shown = states.at(-1);
    assert.equal(shown.defaultProvider, "codex-lb");
    assert.equal(shown.providers[0].dashboard, "https://lb.example/");
    assert.equal(shown.providers[0].fetchedAt, "2026-11-07T11:00:00.000Z");

    // Fresh readings answer returning to the app and opening the popover.
    signal("visible");
    signal("open");
    await settle();
    assert.equal(reads.length, 1);
    mock.timers.tick(6_000);
    signal("open");
    await settle();
    assert.equal(reads.length, 2);

    mock.timers.tick(60_000);
    await settle();
    assert.equal(reads.length, 3);

    // A hidden window stops the polling until it is visible again.
    window.minimized = true;
    mock.timers.tick(120_000);
    await settle();
    assert.equal(reads.length, 3);
    window.minimized = false;
    signal("visible");
    await settle();
    assert.equal(reads.length, 4);

    // Refreshing while a read is in flight waits for that read.
    signal("refresh");
    await settle();
    assert.equal(reads.length, 4);
    assert.equal(states.at(-1).refreshing, true);
    release!();
    await settle();
    assert.equal(states.at(-1).refreshing, false);
    signal("refresh");
    await settle();
    assert.equal(reads.length, 5);

    signal({ type: "dashboard", url: "https://lb.example/" });
    signal({ type: "dashboard", url: "https://elsewhere.example/" });
    await settle();
    assert.deepEqual(opened, ["https://lb.example/"]);

    await controller.update([], "codex-lb");
    assert.equal(states.at(-1), null);
    mock.timers.tick(120_000);
    await settle();
    assert.equal(reads.length, 5);
    await controller.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a failed read keeps the last reading next to the error", async () => {
  const { host, states } = fakeHost();
  let fail = false;
  const controller = createUsageController({
    host,
    log: quiet,
    queues: new WeakMap(),
    load: async () => {
      if (fail) throw new Error("HTTP 502");
      return { object: "codex_lb.usage", pools: [], today: null };
    },
  });
  await controller.update([provider], "codex-lb");
  await settle();
  fail = true;
  await controller.update([provider], "codex-lb");
  await settle();
  const shown = states.at(-1).providers[0];
  assert.equal(shown.error, "HTTP 502");
  assert.deepEqual(shown.snapshot, { object: "codex_lb.usage", pools: [], today: null });
  await controller.stop();
});

const SNAPSHOT = {
  object: "codex_lb.usage",
  generated_at: "2026-11-07T11:00:00Z",
  pools: [
    {
      id: "chatgpt",
      kind: "chatgpt",
      label: "ChatGPT",
      models: ["gpt-6.1-sol"],
      accounts: { total: 3, ready: 1 },
      windows: [{ id: "weekly", window_seconds: 604800, left_percent: 33, resets_at: "2026-11-07T19:52:00Z", exhausts_at: null, relief: { at: "2026-11-07T19:52:00Z", left_percent: 79.5 } }],
      credits: null,
      updated_at: "2026-11-07T10:59:00Z",
      stale: false,
    },
    {
      id: "claude",
      kind: "claude",
      label: "Claude",
      models: ["anthropic/claude-opus-5-5"],
      accounts: { total: 1, ready: 1 },
      windows: [
        { id: "five_hour", window_seconds: 18000, left_percent: 18, resets_at: "2026-11-07T12:40:00Z", exhausts_at: null, relief: null },
        { id: "weekly", window_seconds: 604800, left_percent: 12, resets_at: "2026-11-07T22:00:00Z", exhausts_at: "2026-11-07T17:40:00Z", relief: { at: "2026-11-07T22:00:00Z", left_percent: 100 } },
      ],
      credits: null,
      updated_at: "2026-11-07T10:59:00Z",
      stale: false,
    },
    {
      id: "openrouter",
      kind: "openrouter",
      label: "OpenRouter",
      models: ["openrouter/glm-5"],
      accounts: { total: 1, ready: 1 },
      windows: [],
      credits: { total_usd: 10, used_usd: 4.26 },
      updated_at: "2026-11-07T10:59:00Z",
      stale: false,
    },
  ],
  today: { since: "2026-11-06T23:00:00Z", requests: 3673, cost_usd: 326.4 },
};

// The rail's usage menu button and a composer whose thread runs on the given provider.
function appPage(threadProvider: string | null) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><nav><button aria-haspopup="menu" aria-label="Usage"><svg class="stock"></svg></button></nav><div data-composer-navigation-target="reasoning"></div></body></html>', {
    url: "app://-/index.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  const fiber = (props: object, parent: object | null, memoizedState: object | null = null) => ({ memoizedProps: props, memoizedState, return: parent });
  const menu = fiber({ menu: {}, usage: {}, actions: [], source: "rail" }, null);
  (document.querySelector("button") as any).__reactFiber$test = fiber({}, fiber({}, menu));
  const thread = threadProvider == null ? null : { memoizedState: { threadId: "t1", modelProvider: threadProvider }, next: null };
  const root = fiber({}, null, thread);
  const composer = fiber({ model: "anthropic/claude-opus-5-5", modelOptions: [] }, fiber({}, root));
  const target = document.querySelector("[data-composer-navigation-target]") as any;
  target.__reactFiber$test = fiber({}, composer);
  target.getClientRects = () => [{}];
  let stockOpened = 0;
  document.querySelector("button")!.addEventListener("pointerdown", () => stockOpened++);
  const configure = (state: unknown) =>
    dom.window.eval("(" + configureUsagePopover + ")(" + JSON.stringify({ key: STATE_KEY, owner: "test", state }) + ")");
  return { dom, document, configure, stockOpened: () => stockOpened };
}

function usageState(defaultProvider = "codex-lb") {
  return {
    defaultProvider,
    refreshing: false,
    providers: [{ id: "codex-lb", dashboard: "https://lb.example/", snapshot: SNAPSHOT, fetchedAt: "2026-11-07T11:00:00Z", error: null }],
  };
}

test("the popover leads with the pool serving the chat's model and replaces the stock menu", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-07T11:00:00Z") });
  const { dom, document, configure, stockOpened } = appPage("codex-lb");
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(configure(usageState()))), { status: "active", button: true });
    const button = document.querySelector("button")!;
    assert.ok(button.hasAttribute("data-codexlb-usage-ring"));
    const fill = button.querySelector(".codexlb-ring .fill")!;
    const [arc, length] = fill.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    assert.ok(Math.abs(arc / length - 0.12) < 0.001);
    assert.equal((button.querySelector(".codexlb-ring") as HTMLElement).dataset.tone, "warning");

    const { PointerEvent, MouseEvent } = dom.window as any;
    button.dispatchEvent(new (PointerEvent ?? MouseEvent)("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(stockOpened(), 0);
    const popover = document.querySelector(".codexlb-pop") as HTMLElement;
    assert.equal(popover.hidden, false);
    const controller = (dom.window as any)[STATE_KEY];
    // A visible page asks for fresh readings as soon as it starts.
    assert.equal(await controller.next(), "visible");
    assert.equal(await controller.next(), "open");
    assert.equal(document.activeElement, popover);

    const chat = popover.querySelector(".codexlb-chat")!.textContent!;
    assert.match(chat, /Claude · this chat/);
    assert.match(chat, /Running low/);
    assert.match(chat, /Empty around/);
    const pools = [...popover.querySelectorAll(".codexlb-pool")].map((line) => line.textContent);
    assert.equal(pools.length, 2);
    assert.match(pools[0]!, /^ChatGPT33%Weekly · 1 of 3 accounts ready · Back to 80% at /);
    assert.match(pools[1]!, /^OpenRouter\$5\.74Credits · \$4\.26 of \$10\.00 spent/);
    const events = [...popover.querySelectorAll(".codexlb-events li > span:last-child")].map((item) => item.textContent);
    assert.deepEqual(events, [
      "Claude 5-hour refills",
      "Claude weekly may run out",
      "ChatGPT weekly back to 80%",
      "Claude weekly refills",
    ]);
    assert.match(popover.querySelector(".codexlb-foot")!.textContent!, /Today 3,673 requests · \$326\.40 est\./);

    (popover.querySelector("[data-dashboard]") as HTMLElement).click();
    assert.deepEqual(JSON.parse(JSON.stringify(await controller.next())), { type: "dashboard", url: "https://lb.example/" });

    popover.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(popover.hidden, true);
    assert.equal(document.activeElement, button);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(popover.hidden, false);
    document.body.dispatchEvent(new (PointerEvent ?? MouseEvent)("pointerdown", { bubbles: true }));
    assert.equal(popover.hidden, true);

    configure(null);
    assert.equal(document.querySelector(".codexlb-pop"), null);
    assert.equal(button.hasAttribute("data-codexlb-usage-ring"), false);
    assert.equal(button.querySelector(".codexlb-ring"), null);
    button.dispatchEvent(new (PointerEvent ?? MouseEvent)("pointerdown", { bubbles: true, cancelable: true }));
    assert.equal(stockOpened(), 1);
  } finally {
    dom.window.close();
    mock.timers.reset();
  }
});

test("chats on other providers show every pool and keep the stock icon", () => {
  for (const [threadProvider, defaultProvider] of [["openai", "codex-lb"], [null, "openai"]] as const) {
    const { dom, document, configure } = appPage(threadProvider);
    try {
      configure(usageState(defaultProvider));
      const button = document.querySelector("button")!;
      assert.equal(button.hasAttribute("data-codexlb-usage-ring"), false);
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      const popover = document.querySelector(".codexlb-pop")!;
      assert.equal(popover.querySelector(".codexlb-chat"), null);
      assert.equal(popover.querySelectorAll(".codexlb-pool").length, 3);
      configure(null);
    } finally {
      dom.window.close();
    }
  }
});

test("a new chat on the default codex-lb provider shows its pool", () => {
  const { dom, document, configure } = appPage(null);
  try {
    configure(usageState("codex-lb"));
    assert.ok(document.querySelector("button")!.hasAttribute("data-codexlb-usage-ring"));
    configure(null);
  } finally {
    dom.window.close();
  }
});
