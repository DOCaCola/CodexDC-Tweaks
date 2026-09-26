"use strict";

// Serialized into the app's main JavaScript world by the Owl compatibility API.
// Keep this function self-contained.
async function configureUsageLocks({ key, owner, layer, usageGate, enabled }, loadModule = (url) => import(url)) {
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

  const module = await loadModule(usageGate.module);
  module[usageGate.initialize]();
  const selector = module[usageGate.selector];
  if (typeof selector?.resolve !== "function" || selector.scope?.__scopeBrand !== "AppScope") {
    throw new Error("Unsupported Codex usage selector");
  }
  const originalResolve = selector.resolve;
  const usageAtoms = new Map();
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

  function patchUsageAtom(atom, store) {
    if (usageAtoms.has(atom)) return;
    if (typeof atom.read !== "function" || "init" in atom || "write" in atom) {
      throw new Error("Unsupported Codex usage-block atom");
    }
    const originalRead = atom.read;
    // Initialize cached dependencies before replacing the read function.
    store.get(atom);
    let active = true;
    function read(...args) {
      const blocked = Reflect.apply(originalRead, this, args);
      return active ? false : blocked;
    }
    atom.read = read;
    usageAtoms.set(atom, () => {
      active = false;
      if (atom.read === read) atom.read = originalRead;
      publish(atom, store);
    });
    publish(atom, store);
  }

  function resolve(node, chain) {
    const atom = Reflect.apply(originalResolve, this, [node, chain]);
    if (!stopped) patchUsageAtom(atom, chain.get(selector.scope.id).store);
    return atom;
  }
  selector.resolve = resolve;

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
        const node = chain.get(selector.scope.id);
        if (node) {
          selector.resolve(node, chain);
          return;
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
    const wrappedLayers = new WeakMap();
    let enabled = true;
    function getLayer(name, ...args) {
      const value = Reflect.apply(original, this, [name, ...args]);
      if (!enabled || name !== layer) return value;
      let wrapped = wrappedLayers.get(value);
      if (!wrapped) {
        wrapped = {
          ...value,
          get(parameter, ...args) {
            if (enabled && parameter === "reserve_enabled") return false;
            return Reflect.apply(value.get, value, [parameter, ...args]);
          },
        };
        wrappedLayers.set(value, wrapped);
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
    console.info("[codexdc] Forced Luna Reserve selection disabled");
  }

  function refresh() {
    if (stopped) return;
    if (!usageAtoms.size) refreshUsageScopes();
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
      status: failure ? "failed" : stopped ? "stopped" : clients.size && usageAtoms.size ? "active" : "waiting",
      clients: clients.size,
      usageAtoms: usageAtoms.size,
      layer,
      ...(failure ? { error: failure } : {}),
    }),
    stop() {
      stopped = true;
      clearInterval(timer);
      if (selector.resolve === resolve) selector.resolve = originalResolve;
      for (const restore of clients.values()) restore();
      clients.clear();
      for (const restore of usageAtoms.values()) restore();
      usageAtoms.clear();
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
