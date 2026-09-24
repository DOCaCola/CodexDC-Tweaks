"use strict";

const COMPOSER_STOP_SELECTOR = "button.size-token-button-composer";
const STOP_LABEL_RE = /^stop(?:\s+(?:generating|generation|response|responding|task))?$/i;

function normalizeLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isStopLabel(value) {
  const label = normalizeLabel(value);
  return label !== "stop all" && STOP_LABEL_RE.test(label);
}

function isComposerStopButton(button) {
  if (!button || String(button.tagName ?? "").toLowerCase() !== "button") {
    return false;
  }
  if (!button.classList?.contains("size-token-button-composer")) {
    return false;
  }
  return isStopLabel(button.getAttribute("aria-label")) ||
    isStopLabel(button.getAttribute("title"));
}

function createGuardState() {
  return {
    pending: false,
    pendingButton: null,
    sawIdle: true,
  };
}

function observeStopPhase(state, hasStopButton) {
  if (!hasStopButton) {
    state.pending = false;
    state.pendingButton = null;
    state.sawIdle = true;
    return;
  }

  if (state.sawIdle) {
    state.pending = false;
    state.pendingButton = null;
    state.sawIdle = false;
  }
}

let guardState = createGuardState();
let observer = null;
let clickHandler = null;
let domReadyHandler = null;
let log = () => {};
let lastSuppressedLogAt = 0;

function findStopButtons() {
  if (!document.body) {
    return [];
  }

  return [...document.querySelectorAll(COMPOSER_STOP_SELECTOR)]
    .filter(isComposerStopButton);
}

function clearButtonMarker(button) {
  if (!button) {
    return;
  }

  const ownsMarker = button.getAttribute("data-codexpp-interrupt-guard") === "pending";
  if (ownsMarker) {
    button.removeAttribute("data-codexpp-interrupt-guard");
  }
  if (ownsMarker && button.getAttribute("aria-busy") === "true") {
    button.removeAttribute("aria-busy");
  }
}

function clearPending() {
  clearButtonMarker(guardState.pendingButton);
  guardState.pending = false;
  guardState.pendingButton = null;
}

function markPending(button) {
  guardState.pending = true;
  guardState.pendingButton = button;
  guardState.sawIdle = false;
  button.setAttribute("data-codexpp-interrupt-guard", "pending");
  button.setAttribute("aria-busy", "true");
}

function refresh() {
  const buttons = findStopButtons();
  const pendingButton = guardState.pendingButton;

  if (
    guardState.pending &&
    (!pendingButton || !pendingButton.isConnected || !isComposerStopButton(pendingButton))
  ) {
    clearPending();
    guardState.sawIdle = true;
  }

  observeStopPhase(guardState, buttons.length > 0);
}

function onClick(event) {
  const target = event.target;
  const button =
    target && typeof target.closest === "function"
      ? target.closest(COMPOSER_STOP_SELECTOR)
      : null;

  if (!isComposerStopButton(button)) {
    return;
  }

  if (guardState.pending) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const now = Date.now();
    if (now - lastSuppressedLogAt >= 1000) {
      lastSuppressedLogAt = now;
      log("Duplicate stop click suppressed while interrupt is pending");
    }
    return;
  }

  markPending(button);
}

function start(api) {
  log = (message) => api.log.info(message);
  guardState = createGuardState();
  lastSuppressedLogAt = 0;
  clickHandler = onClick;
  document.addEventListener("click", clickHandler, true);

  observer = new MutationObserver(() => refresh());
  const begin = () => {
    domReadyHandler = null;
    if (!document.body || !observer) {
      return;
    }
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-label", "class"],
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

  api.log.info("Interrupt Stop Guard started");
}

function stop() {
  if (clickHandler) {
    document.removeEventListener("click", clickHandler, true);
    clickHandler = null;
  }
  if (domReadyHandler) {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
    domReadyHandler = null;
  }
  observer?.disconnect();
  observer = null;
  document
    .querySelectorAll("[data-codexpp-interrupt-guard='pending']")
    .forEach(clearButtonMarker);
  guardState = createGuardState();
  log = () => {};
}

module.exports = {
  start,
  stop,
  __test: {
    normalizeLabel,
    isStopLabel,
    isComposerStopButton,
    createGuardState,
    observeStopPhase,
  },
};
