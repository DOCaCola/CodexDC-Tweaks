"use strict";

const BADGE_SELECTOR = "[data-codexpp-collapsed-command-count]";
const ACTIVITY_BUTTON_SELECTOR = [
  "button.group\\/activity-header[aria-expanded]",
  ".group\\/activity-header > button[aria-expanded]",
].join(",");
const STORAGE_KEY = "displayMode";
const DISPLAY_MODES = Object.freeze({
  active: "active",
  all: "all",
  off: "off",
});
const DEFAULT_DISPLAY_MODE = DISPLAY_MODES.active;

let displayMode = DEFAULT_DISPLAY_MODE;
let observer = null;
let refreshTimer = null;
let domReadyHandler = null;
let settingsHandle = null;
let reactApi = null;
let renderedBadges = new Set();

function normalizeDisplayMode(value) {
  return Object.values(DISPLAY_MODES).includes(value)
    ? value
    : DEFAULT_DISPLAY_MODE;
}
function readCommandGroupModelFromChain(fiber) {
  const pending = [fiber, fiber?.alternate];
  const visited = new Set();

  for (let index = 0; index < pending.length && visited.size < 64; index += 1) {
    const current = pending[index];
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const props = current.memoizedProps;
    if (props && typeof props === "object" && "canExpand" in props) {
      const summaryProps = props.summary?.props;
      const stateKind = summaryProps?.state?.kind;
      const summaryParts = summaryProps?.summary?.completedHeader?.summaryParts;
      if (
        ["active", "thinking", "summary"].includes(stateKind)
        && Array.isArray(summaryParts)
      ) {
        const commandPart = summaryParts.find((part) => part?.kind === "commands");
        const count = Number(commandPart?.count ?? 0);
        return {
          count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
          isActive: stateKind !== "summary",
          stateKind,
        };
      }
    }

    pending.push(current.return, current.alternate);
  }

  return null;
}

function readCommandGroupModel(fiber) {
  return readCommandGroupModelFromChain(fiber);
}

function shouldShowCount(mode, model, collapsed) {
  if (!collapsed || !model || model.count < 1 || mode === DISPLAY_MODES.off) {
    return false;
  }
  return mode === DISPLAY_MODES.all || model.isActive;
}

function collectVisibleCommandGroups(buttons, mode, getModel) {
  if (mode === DISPLAY_MODES.off) {
    return [];
  }

  const orderedButtons = mode === DISPLAY_MODES.active
    ? [...buttons].reverse()
    : buttons;
  const visibleGroups = [];

  for (const button of orderedButtons) {
    if (button.getAttribute("aria-expanded") !== "false") {
      continue;
    }

    const model = getModel(button);
    if (!model) {
      continue;
    }
    if (mode === DISPLAY_MODES.active) {
      if (model.isActive && model.count > 0) {
        visibleGroups.push({ button, model });
      }
      break;
    }

    if (model.count > 0) {
      visibleGroups.push({ button, model });
    }
  }

  return visibleGroups;
}

function formatCommandCountLabel(count) {
  return `${count} ${count === 1 ? "command" : "commands"}`;
}

function findHeaderContainer(button) {
  const parent = button.parentElement;
  return parent?.classList?.contains("group/activity-header") ? parent : button;
}

function findDirectBadge(container) {
  return [...(container?.children ?? [])]
    .find((child) => child.matches?.(BADGE_SELECTOR)) ?? null;
}

function createBadge() {
  const badge = document.createElement("span");
  badge.setAttribute("data-codexpp-collapsed-command-count", "");
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.justifyContent = "center";
  badge.style.flex = "0 0 auto";
  badge.style.minWidth = "1.25rem";
  badge.style.height = "1.125rem";
  badge.style.padding = "0 0.3rem";
  badge.style.marginInlineStart = "0.25rem";
  badge.style.border = "1px solid var(--color-token-border)";
  badge.style.borderRadius = "9999px";
  badge.style.color = "var(--color-token-text-tertiary)";
  badge.style.fontSize = "0.6875rem";
  badge.style.fontVariantNumeric = "tabular-nums";
  badge.style.lineHeight = "1";
  badge.style.pointerEvents = "none";
  return badge;
}

function syncBadge(button, model) {
  const container = findHeaderContainer(button);
  let badge = findDirectBadge(container);
  if (!badge) {
    badge = createBadge();
    const disclosure = container.lastElementChild;
    container.insertBefore(
      badge,
      disclosure && disclosure !== button ? disclosure : null,
    );
  }

  const label = formatCommandCountLabel(model.count);
  if (badge.textContent !== String(model.count)) {
    badge.textContent = String(model.count);
  }
  badge.setAttribute("aria-label", label);
  badge.title = label;
  badge.dataset.codexppCommandGroupState = model.stateKind;
  return badge;
}

function clearBadges() {
  for (const badge of renderedBadges) {
    badge.remove();
  }
  renderedBadges = new Set();
  document.querySelectorAll(BADGE_SELECTOR).forEach((badge) => badge.remove());
}

function refresh() {
  if (!document.body || !reactApi) {
    return;
  }

  const buttons = [...document.querySelectorAll(ACTIVITY_BUTTON_SELECTOR)];
  const visibleGroups = collectVisibleCommandGroups(
    buttons,
    displayMode,
    (button) => readCommandGroupModel(reactApi.getFiber(button)),
  );
  const nextBadges = new Set();

  for (const { button, model } of visibleGroups) {
    nextBadges.add(syncBadge(button, model));
  }

  for (const badge of renderedBadges) {
    if (!nextBadges.has(badge)) {
      badge.remove();
    }
  }
  renderedBadges = nextBadges;
}

function scheduleRefresh() {
  if (refreshTimer != null) {
    return;
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 50);
}

function applyDisplayMode(value) {
  displayMode = normalizeDisplayMode(value);
  if (displayMode === DISPLAY_MODES.off) {
    clearBadges();
    return;
  }
  refresh();
}

function renderSettings(root, api) {
  root.innerHTML = "";

  const layout = document.createElement("div");
  layout.className = "flex flex-col gap-3";

  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "Choose which collapsed agent activity sections show command counts.";
  layout.appendChild(description);

  const listeners = [];
  const options = [
    {
      value: DISPLAY_MODES.active,
      label: "Active section only",
      description: "Show the count only while the current agent activity section is running.",
    },
    {
      value: DISPLAY_MODES.all,
      label: "All collapsed sections",
      description: "Keep command counts visible on completed collapsed sections too.",
    },
    {
      value: DISPLAY_MODES.off,
      label: "Disabled",
      description: "Do not add command count badges.",
    },
  ];

  for (const option of options) {
    const row = document.createElement("label");
    row.className = "flex cursor-pointer items-start gap-3";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "codexpp-collapsed-command-count-display";
    input.value = option.value;
    input.checked = displayMode === option.value;
    input.style.width = "16px";
    input.style.height = "16px";
    input.style.marginTop = "2px";
    input.style.accentColor = "var(--color-token-text-primary)";

    const text = document.createElement("span");
    text.className = "flex min-w-0 flex-col";
    const label = document.createElement("span");
    label.className = "text-sm text-token-text-primary";
    label.textContent = option.label;
    const detail = document.createElement("span");
    detail.className = "text-xs text-token-text-secondary";
    detail.textContent = option.description;
    text.append(label, detail);

    const onChange = () => {
      if (!input.checked) {
        return;
      }
      api.storage.set(STORAGE_KEY, option.value);
      applyDisplayMode(option.value);
    };
    input.addEventListener("change", onChange);
    listeners.push(() => input.removeEventListener("change", onChange));

    row.append(input, text);
    layout.appendChild(row);
  }

  root.appendChild(layout);
  return () => {
    for (const removeListener of listeners) {
      removeListener();
    }
  };
}

function start(api) {
  if (!api.react) {
    throw new Error("Collapsed Command Counts requires the Codex++ React API");
  }

  reactApi = api.react;
  displayMode = normalizeDisplayMode(
    api.storage.get(STORAGE_KEY, DEFAULT_DISPLAY_MODE),
  );
  settingsHandle = api.settings?.register({
    id: "visibility",
    title: "Collapsed command counts",
    render(root) {
      return renderSettings(root, api);
    },
  }) ?? null;

  const begin = () => {
    domReadyHandler = null;
    if (!document.body) {
      return;
    }

    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
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

  api.log.info("Collapsed Command Counts started");
}

function stop() {
  settingsHandle?.unregister();
  settingsHandle = null;
  observer?.disconnect();
  observer = null;
  reactApi = null;

  if (refreshTimer != null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (domReadyHandler) {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
    domReadyHandler = null;
  }

  clearBadges();
  displayMode = DEFAULT_DISPLAY_MODE;
}

module.exports = {
  start,
  stop,
  __test: {
    normalizeDisplayMode,
    readCommandGroupModel,
    shouldShowCount,
    collectVisibleCommandGroups,
    formatCommandCountLabel,
    findHeaderContainer,
  },
};
