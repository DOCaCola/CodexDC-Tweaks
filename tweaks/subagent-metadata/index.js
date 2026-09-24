"use strict";

const ROW_SELECTOR = "button[type=\"button\"][class*=\"text-start\"]";
const LABEL_SELECTOR = "[data-codexpp-subagent-metadata]";
const MAX_MESSAGE_NODES = 100000;

let observer = null;
let refreshTimer = null;
let messageScanTimer = null;
let domReadyHandler = null;
let messageHandler = null;
let reactApi = null;
let pendingMessages = [];
let renderedLabels = new Set();
let spawnMetadata = new Map();

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readSubagentFromProps(props) {
  if (!props || typeof props !== "object") {
    return null;
  }

  const directCandidates = [
    props.subagent,
    props.backgroundAgent,
    props.row,
    props.item?.subagent,
    props.item?.trailing?.props?.subagent,
    props.item?.trailing?.props?.backgroundAgent,
  ];

  for (const candidate of directCandidates) {
    if (
      candidate
      && typeof candidate === "object"
      && normalizeText(candidate.conversationId ?? candidate.threadId) != null
    ) {
      return candidate;
    }
  }

  return null;
}

function readSubagentFromFiber(fiber) {
  const pending = [fiber, fiber?.alternate];
  const visited = new Set();

  for (let index = 0; index < pending.length && visited.size < 64; index += 1) {
    const current = pending[index];
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const subagent = readSubagentFromProps(current.memoizedProps);
    if (subagent) {
      return subagent;
    }

    pending.push(current.return, current.alternate);
  }

  return null;
}

function metadataForSubagent(subagent, metadataByThreadId = spawnMetadata) {
  if (!subagent || typeof subagent !== "object") {
    return null;
  }

  const threadId = normalizeText(subagent.conversationId ?? subagent.threadId);
  if (!threadId) {
    return null;
  }

  const tracked = metadataByThreadId.get(threadId);
  const model = normalizeText(
    subagent.spawnModel
      ?? subagent.model
      ?? tracked?.model,
  );
  const reasoningEffort = normalizeText(
    subagent.spawnReasoningEffort
      ?? subagent.reasoningEffort
      ?? tracked?.reasoningEffort,
  );

  if (!model && !reasoningEffort) {
    return null;
  }

  return { threadId, model, reasoningEffort };
}

function formatMetadataLine(metadata) {
  if (metadata.model && metadata.reasoningEffort) {
    return `${metadata.model} | ${metadata.reasoningEffort}`;
  }
  if (metadata.model) {
    return metadata.model;
  }
  return `Reasoning: ${metadata.reasoningEffort}`;
}

function formatMetadataTitle(metadata) {
  return [
    metadata.model ? `Model: ${metadata.model}` : null,
    metadata.reasoningEffort
      ? `Reasoning: ${metadata.reasoningEffort}`
      : null,
  ].filter(Boolean).join("\n");
}

function receiverThreadIds(item) {
  const ids = new Set();

  if (Array.isArray(item.receiverThreadIds)) {
    for (const value of item.receiverThreadIds) {
      const id = normalizeText(value);
      if (id) {
        ids.add(id);
      }
    }
  }

  if (Array.isArray(item.receiverThreads)) {
    for (const receiver of item.receiverThreads) {
      const id = normalizeText(receiver?.threadId ?? receiver?.id);
      if (id) {
        ids.add(id);
      }
    }
  }

  return ids;
}

function indexCollabAgentToolCall(item, metadataByThreadId) {
  if (
    !item
    || typeof item !== "object"
    || item.type !== "collabAgentToolCall"
  ) {
    return false;
  }

  const model = normalizeText(item.model);
  const reasoningEffort = normalizeText(
    item.reasoningEffort ?? item.reasoning_effort,
  );
  if (!model && !reasoningEffort) {
    return false;
  }

  let changed = false;
  for (const threadId of receiverThreadIds(item)) {
    const previous = metadataByThreadId.get(threadId);
    const next = {
      model: model ?? previous?.model ?? null,
      reasoningEffort:
        reasoningEffort ?? previous?.reasoningEffort ?? null,
    };

    if (
      previous?.model !== next.model
      || previous?.reasoningEffort !== next.reasoningEffort
    ) {
      metadataByThreadId.set(threadId, next);
      changed = true;
    }
  }

  return changed;
}

function indexMessagePayload(
  payload,
  metadataByThreadId = spawnMetadata,
  maxNodes = MAX_MESSAGE_NODES,
) {
  const pending = [payload];
  const visited = new Set();
  let changed = false;
  let visitedNodes = 0;

  while (pending.length > 0 && visitedNodes < maxNodes) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);
    visitedNodes += 1;

    if (indexCollabAgentToolCall(current, metadataByThreadId)) {
      changed = true;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]);
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }

  return { changed, visitedNodes, truncated: pending.length > 0 };
}

function findContentContainer(button) {
  return [...(button?.children ?? [])].find((child) =>
    child?.tagName === "SPAN"
    && child.classList?.contains("min-w-0")
    && child.classList?.contains("flex-1")
  ) ?? null;
}

function findDirectLabel(container) {
  return [...(container?.children ?? [])].find((child) =>
    child.matches?.(LABEL_SELECTOR)
  ) ?? null;
}

function createLabel() {
  const label = document.createElement("span");
  label.setAttribute("data-codexpp-subagent-metadata", "");
  label.className =
    "block truncate text-xs leading-4 text-token-text-tertiary";
  label.style.pointerEvents = "none";
  return label;
}

function syncLabel(button, metadata) {
  const container = findContentContainer(button);
  if (!container) {
    return null;
  }

  let label = findDirectLabel(container);
  if (!label) {
    label = createLabel();
    const preview = container.children[1] ?? null;
    container.insertBefore(label, preview);
  }

  const text = formatMetadataLine(metadata);
  if (label.textContent !== text) {
    label.textContent = text;
  }
  label.title = formatMetadataTitle(metadata);
  label.dataset.codexppSubagentThreadId = metadata.threadId;
  return label;
}

function clearLabels() {
  for (const label of renderedLabels) {
    label.remove();
  }
  renderedLabels = new Set();
  document.querySelectorAll(LABEL_SELECTOR).forEach((label) => label.remove());
}

function refresh() {
  if (!document.body || !reactApi) {
    return;
  }

  const nextLabels = new Set();
  const buttons = document.querySelectorAll(ROW_SELECTOR);

  for (const button of buttons) {
    const subagent = readSubagentFromFiber(reactApi.getFiber(button));
    const metadata = metadataForSubagent(subagent);
    if (!metadata) {
      continue;
    }

    const label = syncLabel(button, metadata);
    if (label) {
      nextLabels.add(label);
    }
  }

  for (const label of renderedLabels) {
    if (!nextLabels.has(label)) {
      label.remove();
    }
  }
  renderedLabels = nextLabels;
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

function flushMessageScans() {
  messageScanTimer = null;
  const messages = pendingMessages;
  pendingMessages = [];
  let changed = false;

  for (const message of messages) {
    if (indexMessagePayload(message).changed) {
      changed = true;
    }
  }

  if (changed) {
    scheduleRefresh();
  }
}

function queueMessageScan(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  pendingMessages.push(payload);
  if (messageScanTimer == null) {
    messageScanTimer = setTimeout(flushMessageScans, 0);
  }
}

function start(api) {
  if (!api.react) {
    throw new Error("Subagent Model Details requires the Codex++ React API");
  }

  reactApi = api.react;
  messageHandler = (event) => {
    queueMessageScan(event.data);
  };
  window.addEventListener("message", messageHandler);

  const begin = () => {
    domReadyHandler = null;
    if (!document.body) {
      return;
    }

    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    refresh();
  };

  if (document.readyState === "loading") {
    domReadyHandler = begin;
    document.addEventListener("DOMContentLoaded", domReadyHandler, {
      once: true,
    });
  } else {
    begin();
  }

  api.log.info("Subagent Model Details started");
}

function stop() {
  observer?.disconnect();
  observer = null;
  reactApi = null;

  if (refreshTimer != null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (messageScanTimer != null) {
    clearTimeout(messageScanTimer);
    messageScanTimer = null;
  }
  if (domReadyHandler) {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
    domReadyHandler = null;
  }
  if (messageHandler) {
    window.removeEventListener("message", messageHandler);
    messageHandler = null;
  }

  pendingMessages = [];
  spawnMetadata = new Map();
  clearLabels();
}

module.exports = {
  start,
  stop,
  __test: {
    normalizeText,
    readSubagentFromProps,
    readSubagentFromFiber,
    metadataForSubagent,
    formatMetadataLine,
    formatMetadataTitle,
    receiverThreadIds,
    indexCollabAgentToolCall,
    indexMessagePayload,
    findContentContainer,
  },
};
