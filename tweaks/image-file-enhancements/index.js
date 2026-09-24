"use strict";

const IMAGE_SELECTORS = [
  "[data-testid='generated-image-preview'] img",
  "[data-testid*='image-preview'] img",
  "[data-testid*='image-attachment'] img",
  "[data-testid*='attachment-image'] img",
];
const IMAGE_SELECTOR = IMAGE_SELECTORS.join(",");
const PATH_PROP_KEYS = [
  "fullSrc",
  "downloadSrc",
  "attachmentSrc",
  "localPath",
  "filePath",
  "path",
  "src",
  "previewSrc",
];
const NESTED_PROP_KEYS = [
  "image",
  "imageRef",
  "attachment",
  "attachments",
  "content",
  "item",
];
const VERSION_PARAM = "codexpp_file_version";
const REFRESH_DELAY_MS = 100;
const POLL_INTERVAL_MS = 1500;
const MAX_STAT_CONCURRENCY = 8;

let observer = null;
let visibilityObserver = null;
let refreshInterval = null;
let refreshTimer = null;
let refreshPromise = null;
let domReadyHandler = null;
let visibilityHandler = null;
let pollRequested = false;
let stopped = true;

const pendingImages = new Set();
const dirtyPaths = new Set();
const trackedPaths = new Map();
const imagePaths = new Map();
const visibleImages = new Set();
const imageStates = new WeakMap();

function decodeLocalImageSource(source, platform = inferPlatform()) {
  if (typeof source !== "string") return null;
  const value = source.trim();
  if (!value) return null;

  if (isNativeAbsolutePath(value, platform)) return normalizeNativePath(value, platform);

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol === "app:" && url.hostname === "fs") {
    let candidate = safeDecodeUri(url.pathname);
    if (candidate.startsWith("/@fs")) candidate = candidate.slice(4);
    return normalizeUrlPath(candidate, platform);
  }

  if (url.protocol === "file:") {
    const pathname = safeDecodeUri(url.pathname);
    if (platform === "win32" && url.hostname) {
      return normalizeNativePath(`//${url.hostname}${pathname}`, platform);
    }
    return normalizeUrlPath(pathname, platform);
  }

  return null;
}

function versionImageUrl(source, version) {
  if (typeof source !== "string" || !source.trim()) return null;
  let url;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (!((url.protocol === "app:" && url.hostname === "fs") || url.protocol === "file:")) {
    return null;
  }
  url.searchParams.set(VERSION_PARAM, String(version));
  return url.toString();
}

function versionLocalImagePath(path, version, platform = inferPlatform()) {
  const normalizedPath = normalizeNativePath(path, platform);
  if (!normalizedPath) return null;

  const slashPath = platform === "win32"
    ? normalizedPath.replaceAll("\\", "/")
    : normalizedPath;
  const encodedPath = slashPath
    .split("/")
    .map((segment, index) => {
      if (platform === "win32" && index === 0 && /^[a-zA-Z]:$/.test(segment)) {
        return segment;
      }
      return encodeURIComponent(segment);
    })
    .join("/");
  const routePath = encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;
  const url = new URL(`app://fs/@fs${routePath}`);
  url.searchParams.set(VERSION_PARAM, String(version));
  return url.toString();
}

function findPathInFiber(fiber, platform = inferPlatform()) {
  const seen = new Set();
  let current = fiber;
  for (let depth = 0; current && depth < 14; depth += 1, current = current.return) {
    const path = findPathInValue(current.memoizedProps, platform, 0, seen);
    if (path) return path;
  }
  return null;
}

function findPathInValue(value, platform, depth, seen) {
  if (typeof value === "string") return decodeLocalImageSource(value, platform);
  if (!value || typeof value !== "object" || depth > 2 || seen.has(value)) return null;
  seen.add(value);

  for (const key of PATH_PROP_KEYS) {
    const path = decodeLocalImageSource(value[key], platform);
    if (path) return path;
  }

  for (const key of NESTED_PROP_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      const limit = Math.min(nested.length, 8);
      for (let index = 0; index < limit; index += 1) {
        const path = findPathInValue(nested[index], platform, depth + 1, seen);
        if (path) return path;
      }
    } else {
      const path = findPathInValue(nested, platform, depth + 1, seen);
      if (path) return path;
    }
  }

  return null;
}

function resolveDirectImagePath(image, platform) {
  const sources = new Set([
    image?.getAttribute?.("src"),
    image?.currentSrc,
    image?.src,
    image?.getAttribute?.("data-codexpp-original-src"),
  ]);
  for (const source of sources) {
    const path = decodeLocalImageSource(source, platform);
    if (path) return path;
  }
  return null;
}

function resolveImagePath(image, api, platform = inferPlatform(), fiber) {
  const directPath = resolveDirectImagePath(image, platform);
  if (directPath) return directPath;

  try {
    const ownerFiber = fiber === undefined ? api.react.getFiber(image) : fiber;
    return findPathInFiber(ownerFiber, platform);
  } catch {
    return null;
  }
}

function isChatImageInDom(image) {
  if (image.matches?.(IMAGE_SELECTOR)) return true;
  return Boolean(image.closest?.("[data-testid*='conversation'], [data-testid*='message'], main"));
}

function isChatFiber(fiber) {
  let current = fiber;
  for (let depth = 0; current && depth < 12; depth += 1, current = current.return) {
    const props = current.memoizedProps;
    if (!props || typeof props !== "object") continue;
    if ("conversationId" in props || "threadId" in props || "turnId" in props) return true;
  }
  return false;
}

function inspectImage(image, api, platform = inferPlatform()) {
  const directPath = resolveDirectImagePath(image, platform);
  const isDomChatImage = isChatImageInDom(image);
  if (directPath && isDomChatImage) return directPath;

  let fiber = null;
  try {
    fiber = api.react.getFiber(image);
  } catch {}

  if (!isDomChatImage && !isChatFiber(fiber)) return null;
  return directPath ?? findPathInFiber(fiber, platform);
}

function currentImageSource(image) {
  return image?.getAttribute?.("src") || image?.src || "";
}

function shouldQueueSourceMutation(image) {
  const state = imageStates.get(image);
  return !state || currentImageSource(image) !== state.renderedSource;
}

function collectImagesFromNode(node, images) {
  if (!node || node.nodeType !== 1) return;
  if (node.tagName === "IMG") {
    images.add(node);
    return;
  }
  if (node.childElementCount === 0) return;
  for (const image of node.querySelectorAll?.("img") ?? []) images.add(image);
}

function collectMutationImages(records) {
  const images = new Set();
  for (const record of records) {
    if (record.type === "attributes") {
      const image = record.target;
      if (image?.tagName === "IMG" && shouldQueueSourceMutation(image)) images.add(image);
      continue;
    }

    for (const node of record.addedNodes ?? []) collectImagesFromNode(node, images);
    for (const node of record.removedNodes ?? []) collectImagesFromNode(node, images);
  }
  return images;
}

function queueImage(image) {
  if (image) pendingImages.add(image);
}

function unlinkImage(image, unobserve = true) {
  const path = imagePaths.get(image);
  if (!path) return;

  imagePaths.delete(image);
  visibleImages.delete(image);
  const entry = trackedPaths.get(path);
  entry?.images.delete(image);
  if (entry?.images.size === 0) {
    trackedPaths.delete(path);
    dirtyPaths.delete(path);
  }
  if (unobserve) visibilityObserver?.unobserve(image);
}

function registerImage(image, path, platform) {
  const previousPath = imagePaths.get(image);
  if (previousPath !== path) {
    if (previousPath) unlinkImage(image, false);
    imagePaths.set(image, path);

    let entry = trackedPaths.get(path);
    if (!entry) {
      entry = { images: new Set(), version: null, lastError: null };
      trackedPaths.set(path, entry);
      dirtyPaths.add(path);
    }
    entry.images.add(image);

    if (visibilityObserver) {
      visibilityObserver.observe(image);
    } else {
      visibleImages.add(image);
    }
  }

  const entry = trackedPaths.get(path);
  if (entry?.version) refreshImageElement(image, path, entry.version, platform);
}

function processPendingImages(api, platform) {
  const images = [...pendingImages];
  pendingImages.clear();

  for (const image of images) {
    if (image?.isConnected === false) {
      unlinkImage(image);
      continue;
    }

    const path = inspectImage(image, api, platform);
    if (path) {
      registerImage(image, path, platform);
    } else {
      unlinkImage(image);
    }
  }
}

function pruneDisconnectedImages() {
  for (const image of imagePaths.keys()) {
    if (image?.isConnected === false) unlinkImage(image);
  }
}

function isPathVisible(entry) {
  if (!visibilityObserver) return true;
  for (const image of entry.images) {
    if (visibleImages.has(image)) return true;
  }
  return false;
}

function collectPathsToStat(includePoll) {
  const paths = new Set(dirtyPaths);
  dirtyPaths.clear();

  if (includePoll) {
    for (const [path, entry] of trackedPaths) {
      if (isPathVisible(entry)) paths.add(path);
    }
  }
  return paths;
}

async function refreshPath(api, path, platform) {
  const entry = trackedPaths.get(path);
  if (!entry || stopped) return;

  try {
    const stat = await api.codex.files.stat(path);
    if (stopped || trackedPaths.get(path) !== entry) return;
    entry.lastError = null;
    if (!stat.exists || !stat.isFile || stat.mtimeMs == null || stat.size == null) {
      entry.version = null;
      return;
    }

    const version = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
    if (entry.version === version) return;
    entry.version = version;
    for (const image of entry.images) {
      refreshImageElement(image, path, version, platform);
    }
  } catch (error) {
    if (stopped || trackedPaths.get(path) !== entry) return;
    const message = formatError(error);
    if (entry.lastError !== message) {
      entry.lastError = message;
      api.log.warn(`Failed to refresh local image ${path}: ${message}`);
    }
  }
}

async function refreshPaths(api, paths, platform) {
  const queue = [...paths];
  let nextIndex = 0;
  const workerCount = Math.min(queue.length, MAX_STAT_CONCURRENCY);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < queue.length) {
      const path = queue[nextIndex];
      nextIndex += 1;
      await refreshPath(api, path, platform);
    }
  });
  await Promise.all(workers);
}

async function flushRefresh(api) {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const platform = inferPlatform();
    do {
      const includePoll = pollRequested;
      pollRequested = false;
      processPendingImages(api, platform);
      pruneDisconnectedImages();
      const paths = collectPathsToStat(includePoll);
      await refreshPaths(api, paths, platform);
    } while (!stopped && (pendingImages.size > 0 || dirtyPaths.size > 0 || pollRequested));
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function scheduleRefresh(api, { delay = REFRESH_DELAY_MS, poll = false } = {}) {
  if (stopped) return;
  if (poll) pollRequested = true;
  if (refreshTimer != null) return;

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void flushRefresh(api);
  }, delay);
}

function refreshImageElement(image, path, version, platform = inferPlatform()) {
  const source = currentImageSource(image);
  const previousState = imageStates.get(image);
  const sourceWasSetByTweak = previousState?.path === path
    && source === previousState.renderedSource;
  const originalSource = sourceWasSetByTweak ? previousState.originalSource : source;
  const nextSource = versionImageUrl(originalSource, version)
    ?? versionLocalImagePath(path, version, platform);
  if (!nextSource) return;
  if (previousState?.version === version && source === nextSource) return;

  imageStates.set(image, {
    path,
    version,
    originalSource,
    renderedSource: nextSource,
  });
  image.removeAttribute?.("data-codexpp-original-src");
  image.setAttribute("data-codexpp-local-image-path", path);
  image.setAttribute("data-codexpp-file-version", version);
  image.setAttribute("src", nextSource);
}

function startRenderer(api) {
  stopped = false;
  const begin = () => {
    domReadyHandler = null;
    if (!document.documentElement || stopped) return;

    if (typeof IntersectionObserver === "function") {
      visibilityObserver = new IntersectionObserver((entries) => {
        let newlyVisible = false;
        for (const entry of entries) {
          const image = entry.target;
          if (!imagePaths.has(image)) continue;
          if (entry.isIntersecting) {
            if (!visibleImages.has(image)) {
              visibleImages.add(image);
              const path = imagePaths.get(image);
              if (path) dirtyPaths.add(path);
              newlyVisible = true;
            }
          } else {
            visibleImages.delete(image);
          }
        }
        if (newlyVisible) scheduleRefresh(api);
      }, { rootMargin: "800px 0px" });
    }

    observer = new MutationObserver((records) => {
      const images = collectMutationImages(records);
      if (images.size === 0) return;
      for (const image of images) queueImage(image);
      scheduleRefresh(api);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["src"],
      childList: true,
      subtree: true,
    });

    visibilityHandler = () => {
      if (document.visibilityState !== "hidden") {
        scheduleRefresh(api, { delay: 0, poll: true });
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    for (const image of document.querySelectorAll("img")) queueImage(image);
    scheduleRefresh(api, { delay: 0 });
    refreshInterval = setInterval(() => {
      if (document.visibilityState !== "hidden") {
        scheduleRefresh(api, { delay: 0, poll: true });
      }
    }, POLL_INTERVAL_MS);
  };

  if (document.readyState === "loading") {
    domReadyHandler = begin;
    document.addEventListener("DOMContentLoaded", begin, { once: true });
  } else {
    begin();
  }
}

function start(api) {
  startRenderer(api);
  api.log.info("Image Preview Refresh started");
}

function stop() {
  stopped = true;
  observer?.disconnect();
  observer = null;
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  if (refreshInterval != null) clearInterval(refreshInterval);
  refreshInterval = null;
  if (refreshTimer != null) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (domReadyHandler && typeof document !== "undefined") {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
  }
  domReadyHandler = null;
  if (visibilityHandler && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }
  visibilityHandler = null;
  pollRequested = false;
  pendingImages.clear();
  dirtyPaths.clear();
  trackedPaths.clear();
  imagePaths.clear();
  visibleImages.clear();
}

function inferPlatform() {
  if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) return "win32";
  if (typeof process !== "undefined" && process.platform) return process.platform;
  return "linux";
}

function isNativeAbsolutePath(value, platform) {
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]/.test(value);
  return value.startsWith("/");
}

function normalizeUrlPath(value, platform) {
  let candidate = value;
  if (platform === "win32" && /^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
  if (!isNativeAbsolutePath(candidate, platform)) return null;
  return normalizeNativePath(candidate, platform);
}

function normalizeNativePath(value, platform) {
  if (platform !== "win32") return value.replace(/\/{2,}/g, "/");
  const windowsPath = value.replaceAll("/", "\\");
  return windowsPath.startsWith("\\\\")
    ? `\\\\${windowsPath.slice(2).replace(/\\{2,}/g, "\\")}`
    : windowsPath.replace(/\\{2,}/g, "\\");
}

function safeDecodeUri(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  start,
  stop,
  __test: {
    decodeLocalImageSource,
    versionImageUrl,
    versionLocalImagePath,
    findPathInFiber,
    resolveImagePath,
    inspectImage,
    collectMutationImages,
    refreshImageElement,
  },
};
