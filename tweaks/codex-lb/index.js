"use strict";

const Module = require("node:module");
const { readFileSync, watch } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { parse } = require("./vendor/smol-toml.cjs");
const { FEATURES, patchSource } = require("./features.js");

const REGISTRY = Symbol.for("codexdc.codex-lb.capabilities");
const BUNDLE_STATE = Symbol.for("codexdc.codex-lb.bundle");
const MAIN_BUNDLE = /[\\/]\.vite[\\/]build[\\/]main-[^\\/]+\.js$/;
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
    const url = new URL(provider.base_url.replace(/\/+$/, "") + "/codex-lb/capabilities");
    for (const [name, value] of Object.entries(provider.query_params ?? {})) url.searchParams.set(name, String(value));
    return [{ id, url: url.toString(), headers }];
  });
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
    response = await fetch(provider.url, { headers: provider.headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
  let generation = 0;

  async function refresh() {
    const run = ++generation;
    let providers;
    try {
      providers = customProviders(parse(readConfig()), env);
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
    confirmed = next;
  }

  return {
    has: (providerId, capability, model) => confirmed.get(providerId)?.get(capability)?.has(model) === true,
    refresh,
  };
}

// The desktop main bundle is compiled once per process. The hook patches it as
// it loads; the patched checks consult the registry, so stopping the tweak
// restores the original behaviour without reloading code.
function installBundlePatch(log, cache = require.cache) {
  const state = (globalThis[BUNDLE_STATE] ??= { compiled: false, applied: [] });
  if (state.compiled || Object.keys(cache).some((path) => MAIN_BUNDLE.test(path))) {
    const missing = FEATURES.filter((feature) => !state.applied.includes(feature.capability));
    if (missing.length > 0) {
      log.warn("codex-lb: restart Codex to enable " + missing.map((feature) => feature.label).join(", "));
    }
    return () => {};
  }
  const compile = Module.prototype._compile;
  function patchedCompile(content, filename) {
    if (!MAIN_BUNDLE.test(filename)) return compile.call(this, content, filename);
    Module.prototype._compile = compile;
    state.compiled = true;
    const result = patchSource(content);
    state.applied = result.applied.map((feature) => feature.capability);
    for (const feature of result.applied) log.info("codex-lb: " + feature.label + " available for confirmed providers");
    for (const feature of result.skipped) {
      log.warn("codex-lb: unsupported Codex build, " + feature.label + " stay limited to the OpenAI provider");
    }
    return compile.call(this, result.source, filename);
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
  const uninstallBundlePatch = installBundlePatch(api.log);
  const registry = createRegistry({
    fetch: (url, init) => host.net.fetch(url, init),
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
    watcher.close();
    clearTimeout(debounce);
    clearInterval(interval);
    if (globalThis[REGISTRY] === registry) delete globalThis[REGISTRY];
  };
}

function stop() {
  const previous = active;
  active = undefined;
  previous?.();
}

module.exports = {
  start,
  stop,
  __test: { codexConfigPath, customProviders, probeProvider, createRegistry, installBundlePatch, MAIN_BUNDLE },
};
