"use strict";

const THREAD_SURFACE_SELECTOR = "[data-app-shell-focus-area='main'], main";
const NOTIFICATION_DURATION_MS = 3000;

let registration = null;
let notification = null;
let notificationTimer = null;

function start(api) {
  if (!api.composer?.slashCommands || !api.codex?.runtime) {
    throw new Error("Restart Session Command requires composer and Codex runtime APIs");
  }

  registration = api.composer.slashCommands.register({
    name: "restart-session",
    title: "Restart Codex backend",
    description: "Restarts the local Codex CLI for all local chats",
    async execute() {
      api.log.info("Restarting the local Codex backend");
      await api.codex.runtime.restartAppServer({
        hostId: "local",
        killCodexProcess: true,
      });
      showRestartNotification();
    },
  });

  api.log.info("Restart Session Command started");
}

function stop() {
  registration?.unregister();
  registration = null;
  clearRestartNotification();
}

function showRestartNotification() {
  clearRestartNotification();

  const surface = activeThreadSurface();
  const toast = document.createElement("div");
  toast.dataset.codexppRestartSessionNotification = "true";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.className =
    "pointer-events-none fixed z-[9999] max-w-[min(28rem,calc(100vw-2rem))] " +
    "translate-y-2 rounded-xl border border-token-border/50 " +
    "bg-token-main-surface-primary px-3 py-2 text-center text-sm font-medium " +
    "text-token-foreground opacity-0 shadow-lg transition-all duration-200";
  toast.textContent = "Codex backend restarted for all local chats.";

  const bounds = surface.getBoundingClientRect();
  toast.style.left = `${bounds.left + bounds.width / 2}px`;
  toast.style.top = `${Math.max(bounds.top + 16, 16)}px`;
  toast.style.transform = "translateX(-50%)";

  surface.appendChild(toast);
  notification = toast;

  requestAnimationFrame(() => {
    if (notification !== toast) return;
    toast.classList.remove("translate-y-2", "opacity-0");
  });

  notificationTimer = setTimeout(clearRestartNotification, NOTIFICATION_DURATION_MS);
}

function activeThreadSurface() {
  const activeSurface = document.activeElement?.closest?.(THREAD_SURFACE_SELECTOR);
  if (activeSurface) return activeSurface;

  for (const editor of document.querySelectorAll("[contenteditable='true']")) {
    if (!editor.isConnected || editor.getClientRects().length === 0) continue;
    const surface = editor.closest(THREAD_SURFACE_SELECTOR);
    if (surface) return surface;
  }

  return document.querySelector(THREAD_SURFACE_SELECTOR) ?? document.body;
}

function clearRestartNotification() {
  if (notificationTimer !== null) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
  }
  notification?.remove();
  notification = null;
}

module.exports = {
  start,
  stop,
};
