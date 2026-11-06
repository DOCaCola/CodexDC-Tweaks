"use strict";

const { readFile, readdir } = require("node:fs/promises");
const { join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { configureFeatureGates } = require("./feature-gates.js");

const STATE_KEY = "__codexdcCodexLbFeatureGates__";
const CACHE_KEY = "gates";
const READ_CONCURRENCY = 16;

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  }));
  return nested.flat();
}

// Every pattern must match exactly once across the sources and all of them must
// name the same gate; otherwise the build is unsupported.
function gateIn(sources, patterns) {
  const ids = patterns.map((pattern) => {
    const matches = sources.flatMap((source) => [...source.matchAll(pattern)]);
    return matches.length === 1 ? matches[0].groups.gate : null;
  });
  return ids.every((id) => id != null && id === ids[0]) ? ids[0] : null;
}

// The renderer is split into thousands of chunks whose names change with every
// build, so only chunks containing a gate's marker are matched.
async function scanGates(assets, features) {
  const markers = [...new Set(features.map((feature) => feature.gate.marker))];
  const sources = new Map(markers.map((marker) => [marker, []]));
  const files = await javascriptFiles(assets);
  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    await Promise.all(files.slice(index, index + READ_CONCURRENCY).map(async (file) => {
      const content = await readFile(file);
      const found = markers.filter((marker) => content.includes(marker));
      if (found.length === 0) return;
      const source = content.toString("utf8");
      for (const marker of found) sources.get(marker).push(source);
    }));
  }
  return Object.fromEntries(features.map((feature) => [feature.capability, gateIn(sources.get(feature.gate.marker), feature.gate.patterns)]));
}

// Discovers each feature's renderer gate from the installed webview chunks.
// Reading every chunk takes a while, so storage keeps the result for the
// running Codex build and gate patterns only; any change replaces it.
async function discoverGates({ appPath, build, features, storage, log }) {
  const key = createHash("sha256")
    .update(JSON.stringify([build, features.map((feature) => [feature.capability, feature.gate.marker, feature.gate.patterns.map(String)])]))
    .digest("hex");
  let found = storage.get(CACHE_KEY, null);
  if (found?.key !== key) {
    found = { key, gates: await scanGates(join(appPath, "webview", "assets"), features) };
    storage.set(CACHE_KEY, found);
  }
  const gates = new Map();
  for (const feature of features) {
    const id = found.gates[feature.capability];
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
