"use strict";

const { randomUUID } = require("node:crypto");
const { configureUsagePopover } = require("./usage-popover.js");

const STATE_KEY = "__codexdcCodexLbUsage__";
const FETCH_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 60_000;
// Returning to the app and opening the popover refresh readings older than these.
const VISIBLE_MIN_AGE_MS = 10_000;
const OPEN_MIN_AGE_MS = 5_000;

// The main window's page; other pages load the same document with an initialRoute.
function isMainPage(url) {
  return /^app:\/\/-\/index\.html(?:[?#]|$)/.test(url) && !new URL(url).searchParams.has("initialRoute");
}

function localMidnight(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

// Reads the usage snapshot of a codex-lb provider since the given time.
async function fetchUsage(fetch, url, provider, since) {
  const response = await fetch(url(provider, "/codex-lb/usage", { since: since.toISOString() }), {
    headers: provider.headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const document = await response.json();
  if (document?.object !== "codex_lb.usage") throw new Error("not a codex-lb usage document");
  return document;
}

// Shows the usage of confirmed codex-lb providers in the main window's usage
// popover. Readings refresh every minute while a main window is visible, when
// one becomes visible again, and when the popover asks; never concurrently.
function createUsageController({ host, log, queues, load, now = Date.now }) {
  const owner = randomUUID();
  const pages = new Map();
  let providers = [];
  let defaultProvider = "openai";
  let results = new Map();
  let lastFetch = -Infinity;
  let inflight = null;
  let timer;

  function windowVisible() {
    return host.BrowserWindow.getAllWindows()
      .some((window) => isMainPage(window.webContents.getURL()) && window.isVisible() && !window.isMinimized());
  }

  function pageState() {
    if (providers.length === 0) return null;
    return {
      defaultProvider,
      refreshing: inflight != null,
      providers: providers.map((provider) => ({
        id: provider.id,
        dashboard: new URL("/", provider.baseUrl).toString(),
        ...(results.get(provider.id) ?? { snapshot: null, fetchedAt: null, error: null }),
      })),
    };
  }

  function enqueue(contents, page) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (contents.isDestroyed() || !isMainPage(contents.getURL())) return;
      const args = JSON.stringify({ key: STATE_KEY, owner, state: pageState() });
      const result = await contents.executeJavaScript("(" + configureUsagePopover + ")(" + args + ")");
      if (result.status === "active" && page != null && !page.listening) void listen(contents, page);
    }).catch((error) => {
      if (!contents.isDestroyed()) log.error("codex-lb: usage popover update failed", error);
    });
    queues.set(contents, next);
    return next;
  }

  function broadcast() {
    return Promise.all([...pages].map(([contents, page]) => enqueue(contents, page)));
  }

  // Waits for the page's next request until the page reloads or the popover stops.
  async function listen(contents, page) {
    const generation = page.generation;
    page.listening = true;
    const key = JSON.stringify(STATE_KEY);
    const next = "globalThis[" + key + "]?.owner === " + JSON.stringify(owner) + " ? globalThis[" + key + "].next() : null";
    try {
      while (pages.get(contents) === page && page.generation === generation) {
        // A reload rejects the pending request; dom-ready starts the next listener.
        const signal = await contents.executeJavaScript(next).catch(() => null);
        if (signal == null || pages.get(contents) !== page || page.generation !== generation) return;
        handle(signal);
      }
    } finally {
      if (page.generation === generation) page.listening = false;
    }
  }

  function handle(signal) {
    if (signal === "refresh") void refresh(0);
    else if (signal === "open") void refresh(OPEN_MIN_AGE_MS);
    else if (signal === "visible") void refresh(VISIBLE_MIN_AGE_MS);
    else if (signal.type === "dashboard") {
      const dashboard = pageState()?.providers.find((provider) => provider.dashboard === signal.url);
      if (dashboard != null) void host.shell.openExternal(dashboard.dashboard);
    }
  }

  function arm() {
    if (timer != null || providers.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Hidden windows resume polling through their "visible" request.
      if (windowVisible()) void refresh(0);
    }, Math.max(0, lastFetch + POLL_INTERVAL_MS - now()));
  }

  async function refresh(minAge) {
    if (inflight != null) return inflight;
    if (providers.length === 0) return;
    if (now() - lastFetch < minAge) {
      arm();
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    const targets = providers;
    inflight = Promise.all(targets.map(async (provider) => {
      const previous = results.get(provider.id);
      try {
        const snapshot = await load(provider, localMidnight(now()));
        results.set(provider.id, { snapshot, fetchedAt: new Date(now()).toISOString(), error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (previous?.error !== message) log.warn("codex-lb: cannot read the usage of provider " + provider.id, message);
        // The last reading stays visible next to the failure.
        results.set(provider.id, { snapshot: previous?.snapshot ?? null, fetchedAt: previous?.fetchedAt ?? null, error: message });
      }
    }));
    void broadcast();
    try {
      await inflight;
    } finally {
      inflight = null;
      lastFetch = now();
      void broadcast();
      // Providers configured during the fetch are read right away.
      if (providers !== targets) void refresh(0);
      else arm();
    }
  }

  function attach(contents) {
    if (pages.has(contents)) return;
    const page = { generation: 0, listening: false };
    const ready = () => {
      page.generation++;
      page.listening = false;
      void enqueue(contents, page);
    };
    const destroyed = () => pages.delete(contents);
    page.ready = ready;
    page.destroyed = destroyed;
    pages.set(contents, page);
    contents.on("dom-ready", ready);
    contents.once("destroyed", destroyed);
    ready();
  }

  const created = (_event, contents) => attach(contents);
  host.app.on("web-contents-created", created);
  for (const contents of host.webContents.getAllWebContents()) attach(contents);

  return {
    // Shows the given usage providers; the default provider serves chats that have no thread yet.
    update(next, nextDefault) {
      const ids = new Set(next.map((provider) => provider.id));
      results = new Map([...results].filter(([id]) => ids.has(id)));
      providers = next;
      defaultProvider = nextDefault;
      lastFetch = -Infinity;
      clearTimeout(timer);
      timer = undefined;
      const shown = broadcast();
      if (providers.length > 0 && windowVisible()) void refresh(0);
      return shown;
    },
    async stop() {
      host.app.removeListener("web-contents-created", created);
      clearTimeout(timer);
      providers = [];
      const pending = [];
      for (const [contents, { ready, destroyed }] of pages) {
        contents.removeListener("dom-ready", ready);
        contents.removeListener("destroyed", destroyed);
        pending.push(enqueue(contents, null));
      }
      pages.clear();
      await Promise.all(pending);
    },
  };
}

module.exports = { STATE_KEY, fetchUsage, isMainPage, localMidnight, createUsageController };
