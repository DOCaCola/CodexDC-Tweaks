"use strict";

/**
 * Codex serves its model catalog through the app host MessagePort. For the
 * ChatGPT-backed host the catalog carries a `versions` array that groups models
 * into rollout bundles, and the renderer turns that into `versionOptions`. The
 * picker only ever offers the models of the group the current selection belongs
 * to, and when quota runs out the app moves the selection to the Luna Reserve
 * group — after which the picker is stuck on Luna.
 *
 * Empties `versions` on every catalog that crosses the port. The renderer treats
 * a catalog without version groups as ungrouped and falls back to the flat
 * option list, so every model stays selectable regardless of quota.
 */

const { MessagePort } = require("node:worker_threads");

const MAX_SCAN_NODES = 20000;
const MAX_SCAN_DEPTH = 32;
const PATCH_FLAG = Symbol.for("codexdc.unlimited-model-selection");

function isModelCatalog(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.versions) &&
    Array.isArray(value.models) &&
    Array.isArray(value.categories)
  );
}

function childValues(value) {
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return [];
  return Object.values(value);
}

/**
 * Empties `versions` on every model catalog reachable from `payload`.
 * Returns how many catalogs were rewritten.
 */
function stripVersionGrouping(payload) {
  const seen = new WeakSet();
  const stack = [{ value: payload, depth: 0 }];
  let rewritten = 0;
  let budget = MAX_SCAN_NODES;

  while (stack.length > 0 && budget > 0) {
    const { value, depth } = stack.pop();
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    budget -= 1;

    if (isModelCatalog(value)) {
      if (value.versions.length > 0) {
        value.versions = [];
        rewritten += 1;
      }
      continue;
    }

    if (depth >= MAX_SCAN_DEPTH) continue;
    let children;
    try {
      children = childValues(value);
    } catch {
      continue;
    }
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }

  return rewritten;
}

function messagePortPrototypes() {
  const prototypes = new Set();
  if (typeof MessagePort === "function" && MessagePort.prototype) {
    prototypes.add(MessagePort.prototype);
  }
  const globalPort = globalThis.MessagePort;
  if (typeof globalPort === "function" && globalPort.prototype) {
    prototypes.add(globalPort.prototype);
  }
  return [...prototypes];
}

/**
 * Wraps `postMessage` on `prototype` so catalogs are rewritten on their way to
 * the renderer. Returns a restore function, or null when already patched.
 */
function patchPostMessage(prototype, onRewrite) {
  if (typeof prototype.postMessage !== "function") return null;
  if (prototype[PATCH_FLAG]) return null;

  const original = prototype.postMessage;
  function postMessage(value, ...rest) {
    try {
      const rewritten = stripVersionGrouping(value);
      if (rewritten > 0) onRewrite(rewritten);
    } catch (error) {
      onRewrite(0, error);
    }
    return original.call(this, value, ...rest);
  }

  Object.defineProperty(prototype, PATCH_FLAG, { value: true, configurable: true });
  prototype.postMessage = postMessage;
  return () => {
    if (prototype.postMessage === postMessage) {
      prototype.postMessage = original;
      delete prototype[PATCH_FLAG];
    }
  };
}

let restores = [];
let logged = 0;

function start(api) {
  for (const prototype of messagePortPrototypes()) {
    const restore = patchPostMessage(prototype, (rewritten, error) => {
      if (error) {
        api.log.warn("model catalog scan failed:", error);
        return;
      }
      logged += rewritten;
      if (logged <= 5) {
        api.log.info(`cleared version grouping on ${rewritten} model catalog(s)`);
      }
    });
    if (restore) restores.push(restore);
  }
  api.log.info(`Unlimited Model Selection started (${restores.length} transport(s) patched)`);
}

function stop() {
  for (const restore of [...restores].reverse()) restore();
  restores = [];
  logged = 0;
}

module.exports = {
  start,
  stop,
  __test: {
    isModelCatalog,
    stripVersionGrouping,
    patchPostMessage,
    messagePortPrototypes,
  },
};
