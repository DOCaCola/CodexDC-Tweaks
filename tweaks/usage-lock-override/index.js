"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { configureUsageLocks } = require("./usage-locks.js");

const STATE_KEY = "__codexdcUsageLockOverride__";
const QUEUE_KEY = Symbol.for("codexdc.usage-lock-override.queues");

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

function findUsageGate(source) {
  const declarations = [...source.matchAll(
    /([$\w]+)=[$\w]+\([$\w]+,\(\{get:[$\w]+\}\)=>\{/g,
  )].filter((match) => {
    const end = source.indexOf("})})))()}", match.index);
    const body = source.slice(match.index, end);
    return end !== -1 && body.length < 3000
      && /\.authMethod!==[`'"]chatgpt[`'"]/.test(body)
      && body.includes(".rate_limit?.allowed!==!1")
      && body.includes(".accountId!==")
      && body.includes(".windowMinutes===") && body.includes(".resetsAt===");
  });
  if (declarations.length !== 1) {
    throw new Error("Unsupported Codex build: expected one shared usage-block selector");
  }
  const declaration = declarations[0];
  const prefix = source.slice(0, declaration.index);
  const initializer = [...prefix.matchAll(/function ([$\w]+)\(\)\{return\(/g)].at(-1)?.[1];
  const exports = source.slice(source.lastIndexOf("export{") + 7, source.lastIndexOf("};"))
    .split(",").map((entry) => entry.split(" as "));
  function exported(name) {
    const matches = exports.filter(([local]) => local === name);
    if (matches.length !== 1) throw new Error("Unsupported Codex build: usage selector export missing");
    return matches[0][1] ?? matches[0][0];
  }
  return { selector: exported(declaration[1]), initialize: exported(initializer) };
}

function readConfiguration(appPath) {
  const assets = join(appPath, "webview", "assets");
  function bundle(prefix) {
    const files = readdirSync(assets).filter((name) => name.startsWith(prefix) && name.endsWith(".js"));
    if (files.length !== 1) throw new Error(`Unsupported Codex build: expected one ${prefix} bundle`);
    return { name: files[0], source: readFileSync(join(assets, files[0]), "utf8") };
  }
  const initial = bundle("app-initial-");
  const primary = bundle("app-primary-");
  return {
    layer: findReserveLayer(initial.source),
    usageGate: { module: `/assets/${primary.name}`, ...findUsageGate(primary.source) },
  };
}

function isAppPage(url) {
  return /^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(url);
}

function createController(host, configuration, log, queues) {
  const owner = randomUUID();
  const pages = new Map();
  let active = true;

  function enqueue(contents, enabled) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (contents.isDestroyed() || !isAppPage(contents.getURL()) || (enabled && !active)) return;
      const args = JSON.stringify({ key: STATE_KEY, owner, ...configuration, enabled });
      const result = await contents.executeJavaScript(`(${configureUsageLocks})(${args})`);
      if (enabled) log.info("Usage lock override", { window: contents.id, ...result });
    }).catch((error) => {
      if (!contents.isDestroyed()) log.error("Usage lock override failed", error);
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
  const configuration = readConfiguration(host.app.getAppPath());
  const queues = globalThis[QUEUE_KEY] ??= new WeakMap();
  controller = createController(host, configuration, api.log, queues);
}

function stop() {
  const previous = controller;
  controller = undefined;
  return previous?.stop();
}

module.exports = {
  start,
  stop,
  __test: { findReserveLayer, findUsageGate, readConfiguration, isAppPage, createController },
};
