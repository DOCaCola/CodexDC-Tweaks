"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { configureFeatureGates } = require("./feature-gates.js");

const STATE_KEY = "__codexdcCodexLbFeatureGates__";

// Discover each feature's renderer gate from the installed webview bundles.
// Every pattern must match exactly once across the feature's bundles and all
// of them must name the same gate; otherwise the build is unsupported.
function discoverGate(assets, names, gate) {
  const sources = names
    .filter((name) => name.endsWith(".js") && gate.bundles.some((prefix) => name.startsWith(prefix)))
    .map((name) => readFileSync(join(assets, name), "utf8"));
  const ids = gate.patterns.map((pattern) => {
    const matches = sources.flatMap((source) => [...source.matchAll(pattern)]);
    return matches.length === 1 ? matches[0].groups.gate : null;
  });
  return ids.every((id) => id != null && id === ids[0]) ? ids[0] : null;
}

function discoverGates(appPath, features, log) {
  const assets = join(appPath, "webview", "assets");
  const names = readdirSync(assets);
  const gates = new Map();
  for (const feature of features) {
    const id = discoverGate(assets, names, feature.gate);
    if (id == null) log.warn("codex-lb: unsupported Codex build, cannot enable the " + feature.label + " interface");
    else gates.set(feature.capability, id);
  }
  return gates;
}

function isAppPage(url) {
  return /^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(url);
}

// Applies the enabled gate set to every app page, now and after each load.
function createGateController(host, log, queues) {
  const owner = randomUUID();
  const pages = new Map();
  let gates = [];

  function enqueue(contents) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (contents.isDestroyed() || !isAppPage(contents.getURL())) return;
      const args = JSON.stringify({ key: STATE_KEY, owner, gates });
      const result = await contents.executeJavaScript("(" + configureFeatureGates + ")(" + args + ")");
      if (result.status === "failed") log.error("codex-lb: feature gate override failed", result.error);
    }).catch((error) => {
      if (!contents.isDestroyed()) log.error("codex-lb: feature gate override failed", error);
    });
    queues.set(contents, next);
    return next;
  }

  function attach(contents) {
    if (pages.has(contents)) return;
    const ready = () => { void enqueue(contents); };
    const destroyed = () => { pages.delete(contents); };
    pages.set(contents, { ready, destroyed });
    contents.on("dom-ready", ready);
    contents.once("destroyed", destroyed);
    ready();
  }

  const created = (_event, contents) => attach(contents);
  host.app.on("web-contents-created", created);
  for (const contents of host.webContents.getAllWebContents()) attach(contents);

  return {
    update(next) {
      const sorted = [...next].sort();
      if (sorted.join() === gates.join()) return Promise.resolve();
      gates = sorted;
      return Promise.all([...pages.keys()].map(enqueue));
    },
    async stop() {
      host.app.removeListener("web-contents-created", created);
      gates = [];
      const pending = [];
      for (const [contents, { ready, destroyed }] of pages) {
        contents.removeListener("dom-ready", ready);
        contents.removeListener("destroyed", destroyed);
        pending.push(enqueue(contents));
      }
      pages.clear();
      await Promise.all(pending);
    },
  };
}

module.exports = { STATE_KEY, discoverGates, isAppPage, createGateController };
