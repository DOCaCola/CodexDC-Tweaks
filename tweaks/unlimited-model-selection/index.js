"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { configureReserveMode } = require("./reserve-mode.js");

const STATE_KEY = "__codexdcUnlimitedModelSelection__";
const QUEUE_KEY = Symbol.for("codexdc.unlimited-model-selection.queues");

// Discover the feature layer from the installed renderer, not a minified name
// or a catalog response. Refuse an unsupported build rather than report success.
function findReserveLayer(source) {
  const matches = [...source.matchAll(
    /[$\w]+\([$ \w]+,[`'"]([^`'"]+)[`'"],\{disableExposureLog:!0\}\)\.get\([`'"]reserve_enabled[`'"],!1\)/g,
  )];
  const layers = new Set(matches.map((match) => match[1]));
  if (layers.size !== 1) {
    throw new Error("Unsupported Codex build: expected one reserve_enabled feature layer");
  }
  return [...layers][0];
}

function readReserveLayer(appPath) {
  const assets = join(appPath, "webview", "assets");
  const files = readdirSync(assets).filter((name) => /^app-initial-.*\.js$/.test(name));
  if (files.length !== 1) {
    throw new Error("Unsupported Codex build: expected one app-initial renderer bundle");
  }
  return findReserveLayer(readFileSync(join(assets, files[0]), "utf8"));
}

function isAppPage(url) {
  return /^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(url);
}

function createController(host, layer, log, queues) {
  const owner = randomUUID();
  const pages = new Map();
  let active = true;

  function enqueue(contents, enabled) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (contents.isDestroyed() || !isAppPage(contents.getURL()) || (enabled && !active)) return;
      const args = JSON.stringify({ key: STATE_KEY, owner, layer, enabled });
      const result = await contents.executeJavaScript(`(${configureReserveMode})(${args})`);
      if (enabled) log.info("Reserve model-selection override", { window: contents.id, ...result });
    }).catch((error) => {
      if (!contents.isDestroyed()) log.error("Reserve model-selection override failed", error);
    });
    queues.set(contents, next);
    return next;
  }

  function attach(contents) {
    if (pages.has(contents)) return;
    const ready = () => { void enqueue(contents, true); };
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
    async stop() {
      active = false;
      host.app.removeListener("web-contents-created", created);
      const pending = [];
      for (const [contents, { ready, destroyed }] of pages) {
        contents.removeListener("dom-ready", ready);
        contents.removeListener("destroyed", destroyed);
        pending.push(enqueue(contents, false));
      }
      pages.clear();
      await Promise.all(pending);
    },
  };
}

let controller;

function start(api) {
  // Owl is a custom Chromium host. Its Node compatibility API keeps this
  // module name; no stock Electron process or worker-thread port is assumed.
  const host = require("electron");
  const layer = readReserveLayer(host.app.getAppPath());
  const queues = globalThis[QUEUE_KEY] ??= new WeakMap();
  controller = createController(host, layer, api.log, queues);
}

function stop() {
  const previous = controller;
  controller = undefined;
  return previous?.stop();
}

module.exports = {
  start,
  stop,
  __test: { findReserveLayer, readReserveLayer, isAppPage, createController },
};
