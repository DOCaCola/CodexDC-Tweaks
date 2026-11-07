"use strict";

const Module = require("node:module");
const { readFileSync, readdirSync, realpathSync, watch } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { parse } = require("./vendor/smol-toml.cjs");
const { FEATURES, patchFeature, patchSource } = require("./features.js");
const { discoverGates, createGateController } = require("./gates.js");
const { createUsageController, fetchUsage } = require("./usage.js");

const REGISTRY = Symbol.for("codexdc.codex-lb.capabilities");
const BUNDLE_STATE = Symbol.for("codexdc.codex-lb.bundle");
const GATE_QUEUES = Symbol.for("codexdc.codex-lb.gate-queues");
const USAGE_QUEUES = Symbol.for("codexdc.codex-lb.usage-queues");
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const CONFIG_DEBOUNCE_MS = 1_000;

function codexConfigPath(env) {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

// Every custom provider with a base URL is a candidate. Each one is probed with
// the credentials Codex itself sends to it, so only codex-lb confirms itself.
function customProviders(config, env) {
  return Object.entries(config.model_providers ?? {}).flatMap(([id, provider]) => {
    if (typeof provider.base_url !== "string") return [];
    const headers = {};
    for (const [name, value] of Object.entries(provider.http_headers ?? {})) headers[name] = String(value);
    for (const [name, variable] of Object.entries(provider.env_http_headers ?? {})) {
      if (env[variable]) headers[name] = env[variable];
    }
    const token = provider.experimental_bearer_token ?? (provider.env_key ? env[provider.env_key] : undefined);
    if (token) headers.Authorization = "Bearer " + token;
    const query = Object.fromEntries(Object.entries(provider.query_params ?? {}).map(([name, value]) => [name, String(value)]));
    return [{ id, baseUrl: provider.base_url.replace(/\/+$/, ""), query, headers }];
  });
}

// codex-lb resolves its own endpoints relative to the provider base URL, like <base_url>/models.
function providerUrl(provider, path, params = {}) {
  const url = new URL(provider.baseUrl + path);
  for (const [name, value] of Object.entries({ ...provider.query, ...params })) url.searchParams.set(name, value);
  return url.toString();
}

// The provider Codex uses for new threads: the active profile's, else the top-level one.
function defaultProviderId(config) {
  const profile = typeof config.profile === "string" ? config.profiles?.[config.profile] : undefined;
  return profile?.model_provider ?? config.model_provider ?? "openai";
}

class TransientProbeError extends Error {}

function isCapability(entry) {
  return typeof entry?.id === "string" && Array.isArray(entry.models) && entry.models.every((model) => typeof model === "string");
}

// Returns the confirmed capabilities as a map from capability to its models, or
// null when the provider is not codex-lb.
// Unreachable providers and server errors are transient and keep the last answer.
async function probeProvider(fetch, provider) {
  let response;
  try {
    response = await fetch(providerUrl(provider, "/codex-lb/capabilities"), {
      headers: provider.headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TransientProbeError(error instanceof Error ? error.message : String(error));
  }
  if (response.status >= 500) throw new TransientProbeError("HTTP " + response.status);
  if (!response.ok) return null;
  const document = await response.json().catch(() => null);
  if (
    document?.object !== "codex_lb.capabilities" ||
    document.service !== "codex-lb" ||
    !Array.isArray(document.capabilities) ||
    !document.capabilities.every(isCapability)
  ) {
    return null;
  }
  return new Map(document.capabilities.map((capability) => [capability.id, new Set(capability.models)]));
}

function describe(capabilities) {
  if (capabilities == null) return "not codex-lb";
  const entries = [...capabilities].sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([id, models]) => id + " (" + ([...models].sort().join(", ") || "no models") + ")").join(", ") || "no capabilities";
}

function createRegistry({ fetch, readConfig, env, log }) {
  let confirmed = new Map();
  let endpoints = new Map();
  let defaultProvider = "openai";
  let generation = 0;
  const listeners = new Set();

  function signature(providers) {
    return [...providers].sort(([a], [b]) => a.localeCompare(b))
      .map(([id, capabilities]) => id + " " + JSON.stringify(endpoints.get(id)) + ": " + describe(capabilities)).join("; ");
  }

  async function refresh() {
    const run = ++generation;
    let providers, configuredDefault;
    try {
      const config = parse(readConfig());
      providers = customProviders(config, env);
      configuredDefault = defaultProviderId(config);
    } catch (error) {
      log.warn("codex-lb: cannot read the Codex provider configuration", String(error));
      return;
    }
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return { id: provider.id, capabilities: await probeProvider(fetch, provider) };
      } catch (error) {
        if (!(error instanceof TransientProbeError)) throw error;
        log.warn("codex-lb: provider " + provider.id + " unreachable, keeping its last state", error.message);
        return { id: provider.id, capabilities: confirmed.get(provider.id) ?? null };
      }
    }));
    if (run !== generation) return;
    const next = new Map();
    for (const { id, capabilities } of results) {
      if (capabilities != null) next.set(id, capabilities);
      if (describe(capabilities) !== describe(confirmed.get(id))) {
        log.info("codex-lb: provider " + id + ": " + describe(capabilities));
      }
    }
    const previous = signature(confirmed) + "; default " + defaultProvider;
    endpoints = new Map(providers.filter(({ id }) => next.has(id)).map((provider) => [provider.id, provider]));
    confirmed = next;
    defaultProvider = configuredDefault;
    if (signature(confirmed) + "; default " + defaultProvider !== previous) for (const listener of listeners) listener();
  }

  return {
    has: (providerId, capability, model) => confirmed.get(providerId)?.get(capability)?.has(model) === true,
    offers: (capability) => [...confirmed.values()].some((capabilities) => (capabilities.get(capability)?.size ?? 0) > 0),
    // Confirmed providers offering the capability for some model, with the endpoint Codex uses for them.
    providers: (capability) => [...confirmed]
      .filter(([, capabilities]) => (capabilities.get(capability)?.size ?? 0) > 0)
      .map(([id]) => endpoints.get(id)),
    defaultProvider: () => defaultProvider,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
  };
}

// The main process is split into chunks whose names change with every build.
// Each feature belongs to the one chunk in which all of its patches match.
function locateFeatures(buildDir, features) {
  // Node names compiled modules by their real path.
  const directory = realpathSync(buildDir);
  const sources = readdirSync(directory)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ path: join(directory, name), source: readFileSync(join(directory, name), "utf8") }));
  const targets = new Map();
  const unsupported = [];
  for (const feature of features) {
    const chunks = sources.filter(({ source }) => patchFeature(source, feature) != null);
    if (chunks.length !== 1) {
      unsupported.push(feature);
      continue;
    }
    targets.set(chunks[0].path, [...(targets.get(chunks[0].path) ?? []), feature]);
  }
  return { targets, unsupported };
}

function unsupportedBuild(log, feature) {
  log.warn("codex-lb: unsupported Codex build, " + feature.label + " stay limited to the OpenAI provider");
}

// Each chunk is compiled once per process. The hook patches a feature's chunk
// as it loads, which can happen any time after startup, and reports newly
// applied features through onApplied. The patched checks consult the registry,
// so stopping the tweak restores the original behaviour without reloading code.
function installBundlePatch(log, buildDir, onApplied, cache = require.cache) {
  const state = (globalThis[BUNDLE_STATE] ??= { applied: [] });
  const pending = FEATURES.filter((feature) => !state.applied.includes(feature.capability));
  if (pending.length === 0) return () => {};
  const { targets, unsupported } = locateFeatures(buildDir, pending);
  for (const feature of unsupported) unsupportedBuild(log, feature);
  const loaded = [...targets].filter(([path]) => path in cache);
  for (const [path] of loaded) targets.delete(path);
  if (loaded.length > 0) {
    log.warn("codex-lb: restart Codex to enable " + loaded.flatMap(([, features]) => features).map((feature) => feature.label).join(", "));
  }
  if (targets.size === 0) return () => {};
  const compile = Module.prototype._compile;
  function patchedCompile(content, filename) {
    const features = targets.get(filename);
    if (features == null) return compile.call(this, content, filename);
    targets.delete(filename);
    if (targets.size === 0) Module.prototype._compile = compile;
    const result = patchSource(content, features);
    state.applied.push(...result.applied.map((feature) => feature.capability));
    for (const feature of result.applied) log.info("codex-lb: " + feature.label + " available for confirmed providers");
    for (const feature of result.skipped) unsupportedBuild(log, feature);
    const exports = compile.call(this, result.source, filename);
    if (result.applied.length > 0) onApplied();
    return exports;
  }
  Module.prototype._compile = patchedCompile;
  return () => {
    if (Module.prototype._compile === patchedCompile) Module.prototype._compile = compile;
  };
}

let active;

function start(api) {
  // Owl keeps Electron's module name for its Node compatibility API.
  const host = require("electron");
  const env = process.env;
  const configPath = codexConfigPath(env);
  const appPath = host.app.getAppPath();
  const fetch = (url, init) => host.net.fetch(url, init);
  const registry = createRegistry({
    fetch,
    readConfig: () => {
      try {
        return readFileSync(configPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
      }
    },
    env,
    log: api.log,
  });
  globalThis[REGISTRY] = registry;

  // A feature's interface appears only when its main-bundle patch is in effect
  // and a confirmed codex-lb provider offers it.
  let gates = new Map();
  const gateController = createGateController(host, api.log, (globalThis[GATE_QUEUES] ??= new WeakMap()));
  const updateGates = () => {
    const applied = globalThis[BUNDLE_STATE]?.applied ?? [];
    const enabled = [...gates].filter(([capability]) => applied.includes(capability) && registry.offers(capability));
    void gateController.update(enabled.map(([, gate]) => gate));
  };
  // The usage popover replaces the rail's usage menu while a provider offers usage.
  const usage = createUsageController({
    host,
    log: api.log,
    queues: (globalThis[USAGE_QUEUES] ??= new WeakMap()),
    load: (provider, since) => fetchUsage(fetch, providerUrl, provider, since),
  });
  const updateUsage = () => {
    void usage.update(registry.providers("usage"), registry.defaultProvider());
  };
  const unsubscribe = registry.subscribe(() => {
    updateGates();
    updateUsage();
  });
  const uninstallBundlePatch = installBundlePatch(api.log, join(appPath, ".vite", "build"), updateGates);
  discoverGates({ appPath, build: host.app.getVersion(), features: FEATURES, storage: api.storage, log: api.log })
    .then((found) => {
      gates = found;
      updateGates();
    })
    .catch((error) => api.log.error("codex-lb: feature gate discovery failed", error));

  const refresh = () => {
    registry.refresh().catch((error) => api.log.error("codex-lb: capability refresh failed", error));
  };
  let debounce;
  const watcher = watch(dirname(configPath), (_event, name) => {
    if (name !== basename(configPath)) return;
    clearTimeout(debounce);
    debounce = setTimeout(refresh, CONFIG_DEBOUNCE_MS);
  });
  const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
  host.app.whenReady().then(refresh);

  active = () => {
    uninstallBundlePatch();
    unsubscribe();
    const stopped = Promise.all([gateController.stop(), usage.stop()]);
    watcher.close();
    clearTimeout(debounce);
    clearInterval(interval);
    if (globalThis[REGISTRY] === registry) delete globalThis[REGISTRY];
    return stopped;
  };
}

function stop() {
  const previous = active;
  active = undefined;
  return previous?.();
}

module.exports = {
  start,
  stop,
  __test: { codexConfigPath, customProviders, providerUrl, defaultProviderId, probeProvider, createRegistry, installBundlePatch },
};
