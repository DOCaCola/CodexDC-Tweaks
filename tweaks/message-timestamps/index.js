"use strict";

const STYLE_ID = "codexpp-message-timestamps-style";
const USER_BUBBLE_SELECTOR = "[data-user-message-bubble]";
const NATIVE_TIMESTAMP_CANDIDATE_SELECTOR = "span.text-xs.text-tertiary";
const USER_TIMESTAMP_SELECTOR = "[data-codexpp-message-timestamp='user']";
const NATIVE_USER_TIMESTAMP_ATTR = "data-codexpp-native-user-message-sent-time";
const ASSISTANT_TIMESTAMP_SELECTOR = "[data-assistant-message-sent-time]";
const STORAGE_KEYS = Object.freeze({
  user: "alwaysShowUserMessages",
  assistant: "alwaysShowAssistantMessages",
});
const DEFAULT_PREFERENCES = Object.freeze({
  user: true,
  assistant: true,
});

let observer = null;
let refreshTimer = null;
let domReadyHandler = null;
let settingsHandle = null;
let reactApi = null;
let preferences = { ...DEFAULT_PREFERENCES };
let timestampMatchCache = new WeakMap();
let markedTimestampElements = new Set();

function normalizePreferences(value) {
  return {
    user: value?.user !== false,
    assistant: value?.assistant !== false,
  };
}

function readPreferences(storage) {
  return normalizePreferences({
    user: storage.get(STORAGE_KEYS.user, DEFAULT_PREFERENCES.user),
    assistant: storage.get(STORAGE_KEYS.assistant, DEFAULT_PREFERENCES.assistant),
  });
}

function normalizeTimestampText(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text || null;
}

function normalizeSentAtMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sentAtMsFromProps(props) {
  if (!props || typeof props !== "object") {
    return null;
  }

  return normalizeSentAtMs(props.sentAtMs)
    ?? normalizeSentAtMs(props.children?.props?.sentAtMs);
}

function readSentAtMs(fiber) {
  const pending = [fiber];
  const visited = new Set();

  for (let index = 0; index < pending.length && visited.size < 48; index += 1) {
    const current = pending[index];
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const sentAtMs = sentAtMsFromProps(current.memoizedProps);
    if (sentAtMs != null) {
      return sentAtMs;
    }

    pending.push(current.return, current.alternate);
  }
  return null;
}

function findDirectChildContaining(root, descendant) {
  let current = descendant;
  while (current?.parentElement && current.parentElement !== root) {
    current = current.parentElement;
  }
  return current?.parentElement === root ? current : null;
}

function collectBranchElements(root, descendant) {
  const elements = [];
  let current = descendant;
  while (current && current !== root) {
    elements.push(current);
    current = current.parentElement;
  }
  return current === root ? elements : [];
}

function findUserTimestampSource(bubble, getFiber) {
  if (typeof getFiber !== "function") {
    return null;
  }

  const seenCandidates = new Set();
  let current = bubble?.parentElement ?? null;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    const contentBranch = findDirectChildContaining(current, bubble);
    if (!contentBranch) {
      continue;
    }

    const candidates = current.querySelectorAll?.(NATIVE_TIMESTAMP_CANDIDATE_SELECTOR) ?? [];
    for (const candidate of candidates) {
      if (seenCandidates.has(candidate)) {
        continue;
      }
      seenCandidates.add(candidate);
      if (!normalizeTimestampText(candidate.textContent) || bubble.contains?.(candidate)) {
        continue;
      }

      let sentAtMs = null;
      try {
        sentAtMs = readSentAtMs(getFiber(candidate));
      } catch {
        continue;
      }
      if (sentAtMs == null) {
        continue;
      }

      const actionBranch = findDirectChildContaining(current, candidate);
      const revealElements = collectBranchElements(current, candidate);
      if (
        !actionBranch
        || contentBranch === actionBranch
        || revealElements.length === 0
      ) {
        continue;
      }

      return {
        root: current,
        source: candidate,
        actionBranch,
        revealElements,
        sentAtMs,
      };
    }
  }

  return null;
}

function isTimestampMatchValid(bubble, match) {
  return Boolean(
    match?.source?.isConnected
      && match.root?.contains?.(bubble)
      && match.root.contains(match.source),
  );
}

function resolveUserTimestampMatch(bubble) {
  const cached = timestampMatchCache.get(bubble);
  if (isTimestampMatchValid(bubble, cached)) {
    return cached;
  }

  const match = findUserTimestampSource(
    bubble,
    (element) => reactApi?.getFiber(element) ?? null,
  );
  if (match) {
    timestampMatchCache.set(bubble, match);
  } else {
    timestampMatchCache.delete(bubble);
  }
  return match;
}

function applyTimestampMarkers(nextElements) {
  for (const element of markedTimestampElements) {
    if (!nextElements.has(element)) {
      element.removeAttribute(NATIVE_USER_TIMESTAMP_ATTR);
    }
  }
  for (const element of nextElements) {
    if (!markedTimestampElements.has(element)) {
      element.setAttribute(NATIVE_USER_TIMESTAMP_ATTR, "");
    }
  }
  markedTimestampElements = nextElements;
}

function clearUserTimestamps() {
  document.querySelectorAll(USER_TIMESTAMP_SELECTOR).forEach((element) => element.remove());
  for (const element of markedTimestampElements) {
    element.removeAttribute(NATIVE_USER_TIMESTAMP_ATTR);
  }
  document.querySelectorAll(`[${NATIVE_USER_TIMESTAMP_ATTR}]`).forEach((element) => {
    element.removeAttribute(NATIVE_USER_TIMESTAMP_ATTR);
  });
  markedTimestampElements = new Set();
  timestampMatchCache = new WeakMap();
}

function refresh() {
  if (!document.body) {
    return;
  }

  if (!preferences.user || !reactApi) {
    applyTimestampMarkers(new Set());
    return;
  }

  const nextElements = new Set();
  for (const bubble of document.querySelectorAll(USER_BUBBLE_SELECTOR)) {
    const match = resolveUserTimestampMatch(bubble);
    for (const element of match?.revealElements ?? []) {
      nextElements.add(element);
    }
  }
  applyTimestampMarkers(nextElements);
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

function buildStyleText(currentPreferences) {
  const assistantRule = currentPreferences.assistant
    ? `
    ${ASSISTANT_TIMESTAMP_SELECTOR} {
      opacity: 1 !important;
    }
`
    : "";
  const userRule = currentPreferences.user
    ? `
    [${NATIVE_USER_TIMESTAMP_ATTR}] {
      opacity: 1 !important;
    }
`
    : "";

  return `${assistantRule}${userRule}`;
}

function installStyle() {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildStyleText(preferences);
}

function applyPreferences(nextPreferences) {
  preferences = normalizePreferences(nextPreferences);
  installStyle();
  if (!preferences.user) {
    clearUserTimestamps();
    return;
  }
  refresh();
}

function renderSettings(root, api) {
  root.innerHTML = "";

  const layout = document.createElement("div");
  layout.className = "flex flex-col gap-3";

  const heading = document.createElement("div");
  heading.className = "flex flex-col gap-0.5";
  const title = document.createElement("div");
  title.className = "text-sm font-medium text-token-text-primary";
  title.textContent = "Always show timestamps";
  const description = document.createElement("div");
  description.className = "text-sm text-token-text-secondary";
  description.textContent = "Disabled message types keep Codex's default hover-only timestamp.";
  heading.append(title, description);
  layout.appendChild(heading);

  const listeners = [];
  const options = [
    {
      key: "user",
      label: "Sent messages",
      description: "Show the send time below your prompts.",
    },
    {
      key: "assistant",
      label: "Agent responses",
      description: "Show the start time below final assistant output.",
    },
  ];

  for (const option of options) {
    const row = document.createElement("label");
    row.className = "flex cursor-pointer items-start justify-between gap-4";

    const text = document.createElement("span");
    text.className = "flex min-w-0 flex-col";
    const label = document.createElement("span");
    label.className = "text-sm text-token-text-primary";
    label.textContent = option.label;
    const detail = document.createElement("span");
    detail.className = "text-xs text-token-text-secondary";
    detail.textContent = option.description;
    text.append(label, detail);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = preferences[option.key];
    input.setAttribute("aria-label", option.label);
    input.style.width = "16px";
    input.style.height = "16px";
    input.style.marginTop = "2px";
    input.style.accentColor = "var(--color-token-text-primary)";

    const onChange = () => {
      const nextPreferences = {
        ...preferences,
        [option.key]: input.checked,
      };
      api.storage.set(STORAGE_KEYS[option.key], input.checked);
      applyPreferences(nextPreferences);
    };
    input.addEventListener("change", onChange);
    listeners.push(() => input.removeEventListener("change", onChange));

    row.append(text, input);
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
  reactApi = api.react ?? null;
  preferences = readPreferences(api.storage);
  settingsHandle = api.settings?.register({
    id: "visibility",
    title: "Message timestamps",
    render(root) {
      return renderSettings(root, api);
    },
  }) ?? null;

  const begin = () => {
    domReadyHandler = null;
    if (!document.body) {
      return;
    }

    installStyle();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
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

  api.log.info("Message Timestamps started");
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

  document.getElementById(STYLE_ID)?.remove();
  clearUserTimestamps();
  preferences = { ...DEFAULT_PREFERENCES };
}

module.exports = {
  start,
  stop,
  __test: {
    normalizePreferences,
    readPreferences,
    normalizeTimestampText,
    normalizeSentAtMs,
    readSentAtMs,
    findDirectChildContaining,
    collectBranchElements,
    isTimestampMatchValid,
    applyTimestampMarkers,
    findUserTimestampSource,
    buildStyleText,
  },
};
