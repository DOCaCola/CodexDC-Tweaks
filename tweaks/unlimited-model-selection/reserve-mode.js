"use strict";

// Serialized into the app's main JavaScript world by the Owl compatibility API.
// Keep this function self-contained.
function configureReserveMode({ key, owner, layer, enabled }) {
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

  const clients = new Map();
  let stopped = false;
  let failure;
  let timer;
  let reportedMissingClient = false;
  const startedAt = Date.now();

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
    console.info("[codexdc] Forced Luna Reserve model selection disabled");
  }

  function refresh() {
    if (stopped) return;
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
      console.error("[codexdc] Model-selection tweak is waiting for the app feature client");
    }
  }

  const state = {
    owner,
    status: () => ({
      status: failure ? "failed" : stopped ? "stopped" : clients.size ? "active" : "waiting",
      clients: clients.size,
      layer,
      ...(failure ? { error: failure } : {}),
    }),
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const restore of clients.values()) restore();
      clients.clear();
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
      console.error("[codexdc] Model-selection tweak stopped:", error);
    }
  }, 1000);
  return state.status();
}

module.exports = { configureReserveMode };
