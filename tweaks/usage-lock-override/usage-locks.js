"use strict";

// Serialized into the app's main JavaScript world by the Owl compatibility API.
// Keep this function self-contained; findUsageModules is serialized beside it.
async function configureUsageLocks({ key, owner, enabled }, findUsageModules, loadModule = (url) => import(url)) {
  if (!/^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(location.href)) {
    return { status: "skipped" };
  }
  const existing = globalThis[key];
  if (!enabled) {
    if (existing?.owner === owner) {
      existing.stop();
      delete globalThis[key];
    }
    return { status: "stopped" };
  }
  if (existing?.owner === owner) return existing.status();
  existing?.stop();

  // Each app page loads one Rspack runtime entry. Importing the page's own,
  // already evaluated module scripts returns those instances without side effects.
  const runtimes = [];
  for (const script of document.querySelectorAll("script[type=module][src]")) {
    const module = await loadModule(script.src);
    if (typeof module.__webpack_require__ === "function") runtimes.push(module.__webpack_require__);
  }
  const runtime = runtimes[0];
  if (runtimes.length !== 1 || typeof runtime.m !== "object" || typeof runtime.c !== "object") {
    throw new Error("Unsupported Codex module runtime");
  }

  const selectors = [];
  const selectorModules = { gates: new Set(), presentations: new Set() };
  const sidebarAlertModules = new Set();
  const sidebarAlertLayers = new Set();
  const scannedModules = new Set();
  const usageAtoms = new Map();
  const presentationAtoms = new Map();
  const resolvers = new Map();
  const clients = new Map();
  let stopped = false;
  let failure;
  let timer;
  let reportedMissingClient = false;
  const startedAt = Date.now();

  // Publish through the store's normal write path so mounted editors and send
  // buttons update immediately. The selector stays derived: its read function
  // still tracks every original dependency. Write support exists only during
  // this synchronous publication and is removed before returning.
  function publish(atom, store) {
    Object.defineProperties(atom, {
      init: { value: store.get(atom), configurable: true },
      write: {
        value: (get, set) => set(atom, atom.read(get)),
        configurable: true,
      },
    });
    try {
      store.set(atom);
    } finally {
      delete atom.init;
      delete atom.write;
    }
  }

  function patchAtom(atom, store, atoms, transform) {
    if (atoms.has(atom)) return;
    if (typeof atom.read !== "function" || "init" in atom || "write" in atom) {
      throw new Error("Unsupported Codex usage-block atom");
    }
    const originalRead = atom.read;
    // Initialize cached dependencies before replacing the read function.
    store.get(atom);
    let active = true;
    function read(...args) {
      const value = Reflect.apply(originalRead, this, args);
      return active ? transform(value) : value;
    }
    atom.read = read;
    atoms.set(atom, () => {
      active = false;
      if (atom.read === read) atom.read = originalRead;
      publish(atom, store);
    });
    publish(atom, store);
  }

  function suppressUsageNotices() {
    const results = new WeakMap();
    return (result) => {
      const data = result.data;
      if (data == null) return result;
      // Hide sidebar warning presentations at any usage level, alongside the
      // exhausted-usage modal. Keep quotas, credits, polling and model upsells.
      const hideUpsell = data.rate_limit?.allowed === false && data.rate_limit_upsell != null
        && data.rate_limit_upsell.banner_type !== "image_generation_limit_reached"
        && data.rate_limit_upsell.model_slug == null
        && data.rate_limit_upsell.blocked_model_slug == null;
      const ambient = data.ambient_usage?.default;
      const hideAmbientExhaustion = ambient?.source?.kind === "unavailable";
      if (!hideUpsell && !hideAmbientExhaustion && data.rate_limit_warning == null
        && data.sidebar_usage_warnings == null) return result;
      let wrapped = results.get(result);
      if (!wrapped) {
        const presentation = {
          ...data,
          ...(hideUpsell ? { rate_limit_upsell: undefined } : {}),
          // Without a source, the navigation-rail usage button shows its neutral
          // usage gauge and the profile omits the server's out-of-usage subtext.
          // The usage menu keeps its quota and credit rows and actions.
          ...(hideAmbientExhaustion ? {
            ambient_usage: { ...data.ambient_usage, default: { ...ambient, source: undefined, profile_subtext: undefined } },
          } : {}),
          ...(data.rate_limit_warning != null ? { rate_limit_warning: undefined } : {}),
          // An empty presentation keeps the current sidebar renderer from
          // falling back to an older warning implementation.
          ...(data.sidebar_usage_warnings != null ? { sidebar_usage_warnings: { default: null } } : {}),
        };
        wrapped = new Proxy(result, {
          get(target, property, receiver) {
            return property === "data" ? presentation : Reflect.get(target, property, receiver);
          },
        });
        results.set(result, wrapped);
      }
      return wrapped;
    };
  }

  function hookSelector(selector, index) {
    if (typeof selector?.resolve !== "function" || selector.scope?.__scopeBrand !== "AppScope") {
      throw new Error("Unsupported Codex usage selector");
    }
    const originalResolve = selector.resolve;
    const atoms = index === 0 ? usageAtoms : presentationAtoms;
    const transform = index === 0 ? () => false : suppressUsageNotices();
    function resolve(node, chain) {
      const atom = Reflect.apply(originalResolve, this, [node, chain]);
      if (!stopped) patchAtom(atom, chain.get(selector.scope.id).store, atoms, transform);
      return atom;
    }
    selector.resolve = resolve;
    resolvers.set(selector, () => {
      if (selector.resolve === resolve) selector.resolve = originalResolve;
    });
    selectors.push(selector);
  }

  // Codex loads usage modules lazily. Inspect each module once after the app
  // has executed it, and hook the exports the app itself uses.
  function discoverModules() {
    const sources = [];
    for (const id of Object.keys(runtime.c)) {
      if (scannedModules.has(id)) continue;
      scannedModules.add(id);
      sources.push([id, String(runtime.m[id])]);
    }
    if (!sources.length) return;
    const found = findUsageModules(sources);
    for (const [index, kind, label] of [[0, "gates", "shared usage-block selector"], [1, "presentations", "shared usage presentation query"]]) {
      for (const { id, name } of found[kind]) {
        if (selectorModules[kind].size) throw new Error(`Unsupported Codex build: expected one ${label}`);
        selectorModules[kind].add(id);
        hookSelector(runtime.c[id].exports[name], index);
      }
    }
    for (const { id, layers } of found.sidebarAlertLayers) {
      if (sidebarAlertModules.size) throw new Error("Unsupported Codex build: expected one sidebar usage-alert configuration");
      sidebarAlertModules.add(id);
      for (const name of layers) sidebarAlertLayers.add(name);
      for (const client of clients.keys()) notify(client);
    }
  }

  function refreshUsageScopes() {
    // Existing readers already hold atoms. Find their AppScope provider through
    // React; new readers/scopes are handled by resolve above.
    const visited = new Set();
    for (const element of document.body.querySelectorAll("*")) {
      const fiberKey = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      for (let fiber = element[fiberKey]; fiber && !visited.has(fiber); fiber = fiber.return) {
        visited.add(fiber);
        const chain = fiber.memoizedProps?.value;
        if (!(chain instanceof Map)) continue;
        for (const selector of selectors) {
          const node = chain.get(selector.scope.id);
          if (node) selector.resolve(node, chain);
        }
      }
    }
  }

  function notify(client) {
    // Use the app's normal notification path to invalidate the subscribed
    // reserve selector immediately, including when enabled in an open chat.
    client.$emt({
      name: "values_updated",
      status: client.loadingStatus,
      values: client.getContext().values,
    });
  }

  function patch(client) {
    if (clients.has(client)) return;
    if (typeof client.getLayer !== "function" || typeof client.$emt !== "function"
      || typeof client.getContext !== "function") {
      throw new Error("Unsupported Codex feature client");
    }
    const original = client.getLayer;
    const descriptor = Object.getOwnPropertyDescriptor(client, "getLayer");
    const wrappedLayers = new Map();
    let enabled = true;
    // reserve_enabled exists only for forced Luna Reserve selection, so it is
    // overridden on every layer without waiting for its lazy module to load.
    function overridden(name, parameter) {
      return parameter === "reserve_enabled" || (parameter === "enabled" && sidebarAlertLayers.has(name));
    }
    function getLayer(name, ...args) {
      const value = Reflect.apply(original, this, [name, ...args]);
      if (!enabled) return value;
      let cache = wrappedLayers.get(name);
      if (!cache) {
        cache = new WeakMap();
        wrappedLayers.set(name, cache);
      }
      let wrapped = cache.get(value);
      if (!wrapped) {
        wrapped = {
          ...value,
          get(parameter, ...args) {
            if (enabled && overridden(name, parameter)) return false;
            return Reflect.apply(value.get, value, [parameter, ...args]);
          },
        };
        cache.set(value, wrapped);
      }
      return wrapped;
    }
    client.getLayer = getLayer;
    clients.set(client, () => {
      enabled = false;
      if (client.getLayer === getLayer) {
        if (descriptor) Object.defineProperty(client, "getLayer", descriptor);
        else delete client.getLayer;
      }
      notify(client);
    });
    notify(client);
    console.info("[codexdc] Forced Luna Reserve selection and sidebar usage alerts disabled");
  }

  function refresh() {
    if (stopped) return;
    discoverModules();
    if (!usageAtoms.size || !presentationAtoms.size) refreshUsageScopes();
    const registry = globalThis.__STATSIG__;
    const current = new Set(Object.values(registry?.instances ?? {}));
    if (registry?.firstInstance) current.add(registry.firstInstance);
    // Account changes can replace the feature client without navigating.
    for (const [client, restore] of clients) {
      if (!current.has(client)) {
        restore();
        clients.delete(client);
      }
    }
    for (const client of current) patch(client);
    if (!clients.size && !reportedMissingClient && Date.now() - startedAt > 30000) {
      reportedMissingClient = true;
      console.error("[codexdc] Usage Lock Override is waiting for the app feature client");
    }
  }

  const state = {
    owner,
    status: () => ({
      status: failure ? "failed" : stopped ? "stopped" : clients.size && usageAtoms.size && presentationAtoms.size ? "active" : "waiting",
      clients: clients.size,
      usageAtoms: usageAtoms.size,
      presentationAtoms: presentationAtoms.size,
      sidebarAlertLayers: sidebarAlertLayers.size,
      ...(failure ? { error: failure } : {}),
    }),
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const restore of resolvers.values()) restore();
      for (const restore of clients.values()) restore();
      clients.clear();
      for (const restore of usageAtoms.values()) restore();
      usageAtoms.clear();
      for (const restore of presentationAtoms.values()) restore();
      presentationAtoms.clear();
    },
  };
  globalThis[key] = state;
  try {
    refresh();
  } catch (error) {
    state.stop();
    delete globalThis[key];
    throw error;
  }
  timer = setInterval(() => {
    try {
      refresh();
    } catch (error) {
      failure = String(error);
      state.stop();
      console.error("[codexdc] Usage Lock Override stopped:", error);
    }
  }, 1000);
  return state.status();
}

module.exports = { configureUsageLocks };
