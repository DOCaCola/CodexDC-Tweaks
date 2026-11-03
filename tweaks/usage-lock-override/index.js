"use strict";

const { randomUUID } = require("node:crypto");
const { configureUsageLocks } = require("./usage-locks.js");
const { findUsageModules } = require("./usage-modules.js");

const STATE_KEY = "__codexdcUsageLockOverride__";
const QUEUE_KEY = Symbol.for("codexdc.usage-lock-override.queues");

function isAppPage(url) {
  return /^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(url);
}

// Codex loads its usage modules lazily from thousands of Rspack chunks. Each
// page discovers them in its live module runtime instead of scanning the app.
function createController(host, log, queues) {
  const owner = randomUUID();
  const pages = new Map();
  let active = true;

  function enqueue(contents, enabled) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (contents.isDestroyed() || !isAppPage(contents.getURL()) || (enabled && !active)) return;
      const args = JSON.stringify({ key: STATE_KEY, owner, enabled });
      const result = await contents.executeJavaScript(`(${configureUsageLocks})(${args}, ${findUsageModules})`);
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
  const queues = globalThis[QUEUE_KEY] ??= new WeakMap();
  controller = createController(host, api.log, queues);
}

function stop() {
  const previous = controller;
  controller = undefined;
  return previous?.stop();
}

module.exports = {
  start,
  stop,
  __test: { isAppPage, createController },
};
