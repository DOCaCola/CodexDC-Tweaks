"use strict";

const CONTROL_SELECTOR = "button, a, [role='button'], [role='menuitem']";
const GET_PLUS_LABELS = new Set([
  "get plus",
  "upgrade for higher limits",
  "rejoin plus",
]);

let observer = null;
let domReadyHandler = null;
let refreshScheduled = false;
let active = false;
const hiddenControls = new Map();

function normalizeLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isGetPlusLabel(value) {
  return GET_PLUS_LABELS.has(normalizeLabel(value));
}

function isGetPlusControl(control) {
  if (!control?.matches?.(CONTROL_SELECTOR)) return false;
  return [
    control.getAttribute("aria-label"),
    control.getAttribute("title"),
    control.textContent,
  ].some(isGetPlusLabel);
}

function hideControl(control) {
  if (hiddenControls.has(control)) return;
  hiddenControls.set(control, {
    display: control.style.getPropertyValue("display"),
    priority: control.style.getPropertyPriority("display"),
  });
  control.dataset.codexppHideGetPlus = "true";
  control.style.setProperty("display", "none", "important");
}

function restoreControl(control) {
  const previous = hiddenControls.get(control);
  if (!previous) return;

  hiddenControls.delete(control);
  if (control.dataset.codexppHideGetPlus === "true") {
    delete control.dataset.codexppHideGetPlus;
    if (previous.display) {
      control.style.setProperty("display", previous.display, previous.priority);
    } else {
      control.style.removeProperty("display");
    }
  }
}

function refresh() {
  for (const control of hiddenControls.keys()) {
    if (!control.isConnected || !isGetPlusControl(control)) {
      restoreControl(control);
    }
  }

  for (const control of document.querySelectorAll(CONTROL_SELECTOR)) {
    if (isGetPlusControl(control)) hideControl(control);
  }
}

function scheduleRefresh() {
  if (!active || refreshScheduled) return;
  refreshScheduled = true;
  queueMicrotask(() => {
    refreshScheduled = false;
    if (active) refresh();
  });
}

function start(api) {
  active = true;
  observer = new MutationObserver(scheduleRefresh);

  const begin = () => {
    domReadyHandler = null;
    if (!active || !document.body || !observer) return;
    observer.observe(document.body, {
      attributeFilter: ["aria-label", "role", "title"],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    refresh();
  };

  if (document.readyState === "loading") {
    domReadyHandler = begin;
    document.addEventListener("DOMContentLoaded", domReadyHandler, { once: true });
  } else {
    begin();
  }

  api.log.info("Hide Get Plus Button started");
}

function stop() {
  active = false;
  refreshScheduled = false;
  if (domReadyHandler) {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
    domReadyHandler = null;
  }
  observer?.disconnect();
  observer = null;
  for (const control of [...hiddenControls.keys()]) restoreControl(control);
}

module.exports = {
  start,
  stop,
  __test: {
    normalizeLabel,
    isGetPlusLabel,
    isGetPlusControl,
    hideControl,
    restoreControl,
  },
};
