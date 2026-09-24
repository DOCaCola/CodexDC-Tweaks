"use strict";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const MAX_WORK_STEPS_PER_BATCH = 600;
const MAX_BATCH_MS = 4;

let observer = null;
let domReadyHandler = null;
let continuationTimer = null;
let flushScheduled = false;
let stopped = true;

const pendingRoots = new Set();
const workQueue = [];
const normalizedValues = new WeakMap();

function stripMsysPrefix(command) {
  if (typeof command !== "string") return command;

  const exportIndex = command.indexOf("export ");
  if (exportIndex === -1) return command;

  const trimmed = exportIndex === 0 ? command : command.trimStart();
  if (!trimmed.startsWith("export ")) return command;

  const separatorIndex = trimmed.indexOf(";");
  if (separatorIndex === -1) return command;

  const prefix = trimmed.slice(7, separatorIndex).trim();
  if (!prefix) return command;

  for (const assignment of prefix.split(/\s+/)) {
    if (!assignment.startsWith("MSYSTEM=") && !assignment.startsWith("CHERE_INVOKING=")) {
      return command;
    }
  }

  return trimmed.slice(separatorIndex + 1).trimStart();
}

function normalizeTextNode(node) {
  if (!node || typeof node.nodeValue !== "string") return false;
  if (node.parentElement?.closest("input, textarea, [contenteditable]:not([contenteditable='false']), script, style")) return false;

  const value = node.nodeValue;
  if (normalizedValues.get(node) === value) return false;

  const normalized = stripMsysPrefix(value);
  normalizedValues.set(node, normalized);
  if (normalized === value) return false;

  node.nodeValue = normalized;
  return true;
}

function selectTopLevelRoots(nodes) {
  const roots = [...new Set(nodes)].filter((node) => (
    node?.nodeType === TEXT_NODE || node?.nodeType === ELEMENT_NODE
  ));
  if (roots.length < 2) return roots;

  const rootSet = new Set(roots);
  return roots.filter((root) => {
    let parent = root.parentNode;
    while (parent) {
      if (rootSet.has(parent)) return false;
      parent = parent.parentNode;
    }
    return true;
  });
}

function collectMutationRoots(mutations) {
  const roots = [];
  for (const mutation of mutations) {
    if (mutation.type === "characterData") roots.push(mutation.target);
    for (const node of mutation.addedNodes ?? []) roots.push(node);
  }
  return selectTopLevelRoots(roots);
}

function createWorkItem(root) {
  if (root.nodeType === TEXT_NODE) {
    return { root, textNode: root, walker: null };
  }
  if (root.nodeType !== ELEMENT_NODE) return null;

  return {
    root,
    textNode: null,
    walker: document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
  };
}

function appendPendingWork() {
  const roots = selectTopLevelRoots(pendingRoots);
  pendingRoots.clear();

  for (const root of roots) {
    if (root.isConnected === false) continue;
    const item = createWorkItem(root);
    if (item) workQueue.push(item);
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function shouldYieldBatch(steps, elapsedMs) {
  return steps >= MAX_WORK_STEPS_PER_BATCH
    || (steps % 64 === 0 && elapsedMs >= MAX_BATCH_MS);
}
function hasBatchBudgetExpired(steps, startedAt) {
  if (steps >= MAX_WORK_STEPS_PER_BATCH) return true;
  if (steps % 64 !== 0) return false;
  return shouldYieldBatch(steps, now() - startedAt);
}

function processWorkBatch() {
  appendPendingWork();
  const startedAt = now();
  let steps = 0;

  while (workQueue.length > 0) {
    const item = workQueue[workQueue.length - 1];
    steps += 1;

    if (item.root.isConnected === false) {
      workQueue.pop();
    } else if (item.textNode) {
      normalizeTextNode(item.textNode);
      workQueue.pop();
    } else {
      const textNode = item.walker.nextNode();
      if (textNode) {
        normalizeTextNode(textNode);
      } else {
        workQueue.pop();
      }
    }

    if (
      hasBatchBudgetExpired(steps, startedAt)
      && (workQueue.length > 0 || pendingRoots.size > 0)
    ) {
      scheduleFlush(true);
      return;
    }
  }

  if (pendingRoots.size > 0) scheduleFlush();
}

function scheduleFlush(useTimer = false) {
  if (stopped || flushScheduled) return;
  flushScheduled = true;

  const run = () => {
    continuationTimer = null;
    flushScheduled = false;
    if (!stopped) processWorkBatch();
  };

  if (useTimer) {
    continuationTimer = setTimeout(run, 0);
  } else {
    queueMicrotask(run);
  }
}

function queueRoots(roots) {
  if (stopped || roots.length === 0) return;
  for (const root of roots) pendingRoots.add(root);
  scheduleFlush();
}

function beginObserving() {
  domReadyHandler = null;
  if (stopped || !document.body) return;

  observer = new MutationObserver((mutations) => {
    queueRoots(collectMutationRoots(mutations));
  });
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  queueRoots([document.body]);
}

function start(api) {
  if (!stopped) stop();
  stopped = false;

  if (document.readyState === "loading") {
    domReadyHandler = beginObserving;
    document.addEventListener("DOMContentLoaded", beginObserving, { once: true });
  } else {
    beginObserving();
  }

  api.log.info("Shell Display Fixes started");
}

function stop() {
  stopped = true;
  observer?.disconnect();
  observer = null;

  if (domReadyHandler && typeof document !== "undefined") {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
  }
  domReadyHandler = null;

  if (continuationTimer != null) clearTimeout(continuationTimer);
  continuationTimer = null;
  flushScheduled = false;
  pendingRoots.clear();
  workQueue.length = 0;
}

module.exports = {
  start,
  stop,
  __test: {
    stripMsysPrefix,
    normalizeTextNode,
    selectTopLevelRoots,
    collectMutationRoots,
    shouldYieldBatch,
  },
};
