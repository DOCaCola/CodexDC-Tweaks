"use strict";

// Serialized into the app's main JavaScript world. Keep this function
// self-contained. Turns the given Statsig feature gates on for every feature
// client of the page; an empty list restores the original gates.
function configureFeatureGates({ key, owner, gates }) {
  if (!/^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(location.href)) {
    return { status: "skipped" };
  }
  const current = globalThis[key];
  if (gates.length === 0) {
    if (current?.owner === owner) {
      current.stop();
      delete globalThis[key];
    }
    return { status: "stopped" };
  }
  if (current?.owner === owner) return current.update(gates);
  // A reloaded tweak replaces the override of its previous instance.
  current?.stop();

  const enabled = new Set(gates);
  const clients = new Map();
  let failure;
  let timer;

  function notify(client) {
    // The app's own notification path re-reads gates in mounted views and atoms.
    client.$emt({ name: "values_updated", status: client.loadingStatus, values: client.getContext().values });
  }

  function patch(client) {
    if (clients.has(client)) return;
    if (typeof client.getFeatureGate !== "function" || typeof client.$emt !== "function"
      || typeof client.getContext !== "function") {
      throw new Error("Unsupported Codex feature client");
    }
    const original = client.getFeatureGate;
    const descriptor = Object.getOwnPropertyDescriptor(client, "getFeatureGate");
    // checkGate reads through getFeatureGate, so both paths see the override.
    function getFeatureGate(name, ...args) {
      const gate = Reflect.apply(original, this, [name, ...args]);
      return enabled.has(name) && gate.value !== true ? { ...gate, value: true } : gate;
    }
    client.getFeatureGate = getFeatureGate;
    clients.set(client, () => {
      if (client.getFeatureGate === getFeatureGate) {
        if (descriptor) Object.defineProperty(client, "getFeatureGate", descriptor);
        else delete client.getFeatureGate;
      }
      notify(client);
    });
    notify(client);
  }

  function refresh() {
    const registry = globalThis.__STATSIG__;
    const present = new Set(Object.values(registry?.instances ?? {}));
    if (registry?.firstInstance) present.add(registry.firstInstance);
    // Account changes can replace the feature client without navigating.
    for (const [client, restore] of clients) {
      if (!present.has(client)) {
        restore();
        clients.delete(client);
      }
    }
    for (const client of present) patch(client);
  }

  const state = {
    owner,
    status: () => ({
      status: failure ? "failed" : clients.size ? "active" : "waiting",
      clients: clients.size,
      gates: [...enabled],
      ...(failure ? { error: failure } : {}),
    }),
    update(next) {
      enabled.clear();
      for (const gate of next) enabled.add(gate);
      for (const client of clients.keys()) notify(client);
      return state.status();
    },
    stop() {
      clearInterval(timer);
      enabled.clear();
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
    return { status: "failed", error: String(error) };
  }
  timer = setInterval(() => {
    try {
      refresh();
    } catch (error) {
      failure = String(error);
      state.stop();
      console.error("[codexdc] codex-lb feature gates stopped:", error);
    }
  }, 1000);
  return state.status();
}

module.exports = { configureFeatureGates };
