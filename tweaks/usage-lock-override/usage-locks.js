"use strict";

// Serialized into the app's main JavaScript world by the Owl compatibility API.
// Keep this function self-contained.
async function configureUsageLocks({ key, owner, layer, usageGate, usagePresentation, enabled }, loadModule = (url) => import(url)) {
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

  const selectors = [];
  for (const configuration of [usageGate, usagePresentation]) {
    const module = await loadModule(configuration.module);
    module[configuration.initialize]();
    const selector = module[configuration.selector];
    if (typeof selector?.resolve !== "function" || selector.scope?.__scopeBrand !== "AppScope") {
      throw new Error("Unsupported Codex usage selector");
    }
    selectors.push(selector);
  }
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

  function suppressUsageUpsell() {
    const results = new WeakMap();
    return (result) => {
      const data = result.data;
      // This field drives both the exhaustion notice and automatic reset offer.
      // Keep the actual quota, polling state, and image-specific limits intact.
      if (data?.rate_limit?.allowed !== false || data.rate_limit_upsell == null
        || data.rate_limit_upsell.banner_type === "image_generation_limit_reached"
        || data.rate_limit_upsell.model_slug != null
        || data.rate_limit_upsell.blocked_model_slug != null) return result;
      let wrapped = results.get(result);
      if (!wrapped) {
        const presentation = { ...data, rate_limit_upsell: undefined };
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

  for (const [index, selector] of selectors.entries()) {
    const originalResolve = selector.resolve;
    const atoms = index === 0 ? usageAtoms : presentationAtoms;
    const transform = index === 0 ? () => false : suppressUsageUpsell();
    function resolve(node, chain) {
      const atom = Reflect.apply(originalResolve, this, [node, chain]);
      if (!stopped) patchAtom(atom, chain.get(selector.scope.id).store, atoms, transform);
      return atom;
    }
    selector.resolve = resolve;
    resolvers.set(selector, () => {
      if (selector.resolve === resolve) selector.resolve = originalResolve;
    });
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
      layer,
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
