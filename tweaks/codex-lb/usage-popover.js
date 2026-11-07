"use strict";

// Serialized into the main app page's JavaScript world. Keep this function
// self-contained. Replaces the navigation rail's usage menu with a popover that
// shows the codex-lb pools of the given state; a null state restores the menu.
// The page reports user intent through next(): "open", "refresh", "visible"
// and { type: "dashboard", url }.
function configureUsagePopover({ key, owner, state }) {
  if (!/^app:\/\/-\/index\.html(?:[?#]|$)/.test(location.href) || new URLSearchParams(location.search).has("initialRoute")) {
    return { status: "skipped" };
  }
  const current = globalThis[key];
  if (state == null) {
    if (current?.owner === owner) {
      current.stop();
      delete globalThis[key];
    }
    return { status: "stopped" };
  }
  if (current?.owner === owner) return current.update(state);
  // A reloaded tweak replaces the popover of its previous instance.
  current?.stop();

  const RING = "data-codexlb-usage-ring";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_NAMES = { five_hour: "5-hour", weekly: "Weekly", monthly: "Monthly" };
  const STYLE = [
    "button[" + RING + "]{position:relative}",
    "button[" + RING + "]>:not(.codexlb-ring){visibility:hidden}",
    ".codexlb-ring{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}",
    ".codexlb-ring circle{fill:none;stroke-width:2.4}",
    ".codexlb-ring .track{stroke:var(--color-border)}",
    ".codexlb-ring .fill{stroke:var(--color-text-secondary);stroke-linecap:round}",
    ".codexlb-ring[data-tone=warning] .fill{stroke:var(--color-text-warning)}",
    ".codexlb-ring[data-tone=danger] .fill{stroke:var(--color-text-danger)}",
    ".codexlb-pop{position:fixed;z-index:2147483000;width:340px;max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:12px;display:flex;flex-direction:column;gap:12px;border-radius:14px;background:var(--color-surface);color:var(--color-text);box-shadow:var(--elevation-prominent);font:13px/1.4 var(--font-sans)}",
    ".codexlb-pop[hidden]{display:none}",
    ".codexlb-pop:focus{outline:none}",
    ".codexlb-pop button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:default}",
    ".codexlb-head{display:flex;align-items:center;gap:8px}",
    ".codexlb-title{flex:1;font-weight:500}",
    ".codexlb-muted{color:var(--color-text-secondary)}",
    ".codexlb-small{font-size:12px}",
    ".codexlb-num{font-variant-numeric:tabular-nums}",
    ".codexlb-warning{color:var(--color-text-warning)}",
    ".codexlb-danger{color:var(--color-text-danger)}",
    ".codexlb-icon{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:var(--color-text-secondary)}",
    ".codexlb-icon:hover,.codexlb-link:hover{background:var(--color-background-primary-ghost-hover);color:var(--color-text)}",
    ".codexlb-icon[data-busy] svg{animation:codexlb-spin 1s linear infinite}",
    "@keyframes codexlb-spin{to{transform:rotate(360deg)}}",
    ".codexlb-chat{border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--color-background-primary-ghost-hover)}",
    ".codexlb-chat-top{display:flex;align-items:baseline;gap:8px}",
    ".codexlb-chat-pool{flex:1;font-weight:500}",
    ".codexlb-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;color:var(--color-text-success)}",
    ".codexlb-status::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}",
    ".codexlb-status.codexlb-warning{color:var(--color-text-warning)}",
    ".codexlb-status.codexlb-danger{color:var(--color-text-danger)}",
    ".codexlb-status.codexlb-muted{color:var(--color-text-secondary)}",
    ".codexlb-win{display:grid;grid-template-columns:56px 1fr 44px;align-items:center;gap:4px 10px}",
    ".codexlb-note{grid-column:2/4;font-size:12px;color:var(--color-text-secondary);margin-top:-2px}",
    ".codexlb-bar{height:6px;border-radius:3px;background:var(--color-border);overflow:hidden;position:relative}",
    ".codexlb-bar>span{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--color-text-secondary)}",
    ".codexlb-bar>.codexlb-relief{opacity:.3}",
    ".codexlb-bar[data-tone=warning]>span{background:var(--color-text-warning)}",
    ".codexlb-bar[data-tone=danger]>span{background:var(--color-text-danger)}",
    ".codexlb-val{text-align:right;font-variant-numeric:tabular-nums}",
    ".codexlb-section{display:flex;flex-direction:column;gap:2px}",
    ".codexlb-section-title{font-size:11px;font-weight:500;letter-spacing:.03em;text-transform:uppercase;color:var(--color-text-secondary);padding:0 4px 4px}",
    ".codexlb-pool{display:grid;grid-template-columns:minmax(0,1fr) 72px 50px;align-items:center;gap:2px 10px;padding:6px 4px;border-radius:8px}",
    ".codexlb-pool-sub{grid-column:1/4;font-size:12px;color:var(--color-text-secondary)}",
    ".codexlb-events{list-style:none;margin:0;padding:0 4px;display:flex;flex-direction:column;gap:6px}",
    ".codexlb-events li{display:grid;grid-template-columns:46px 8px 1fr;align-items:center;gap:8px}",
    ".codexlb-events time{font-variant-numeric:tabular-nums;color:var(--color-text-secondary)}",
    ".codexlb-dot{width:8px;height:8px;border-radius:50%;background:var(--color-text-success)}",
    ".codexlb-dot.codexlb-warning{background:var(--color-text-warning)}",
    ".codexlb-foot{display:flex;align-items:center;gap:8px;border-top:1px solid var(--color-border);padding-top:10px}",
    ".codexlb-foot-text{flex:1;min-width:0;font-size:12px;color:var(--color-text-secondary)}",
    ".codexlb-link{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:4px 6px!important;border-radius:6px;white-space:nowrap}",
    ".codexlb-empty{color:var(--color-text-secondary);padding:4px}",
  ].join("\n");
  const REFRESH_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/></svg>';
  const EXTERNAL_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

  let usage = state;
  let button = null;
  let ring = null;
  let rendered = "";
  let waiting = null;
  const signals = [];
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  const popover = document.createElement("div");
  popover.className = "codexlb-pop";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "codex-lb usage");
  // Like the stock menu, the open popover holds focus, so Escape reaches it
  // instead of shortcuts of the previously focused composer.
  popover.tabIndex = -1;
  popover.hidden = true;
  document.body.append(popover);

  function emit(signal) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(signal);
    } else if (!signals.some((queued) => JSON.stringify(queued) === JSON.stringify(signal))) {
      signals.push(signal);
    }
  }

  function escape(value) {
    return String(value).replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";");
  }

  function fiberOf(node) {
    const name = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
    return name ? node[name] : null;
  }

  function props(fiber) {
    return fiber.memoizedProps != null && typeof fiber.memoizedProps === "object" ? fiber.memoizedProps : {};
  }

  // The rail's usage trigger is the menu button rendered for the usage menu.
  function findButton() {
    if (button?.isConnected) return button;
    for (const candidate of document.querySelectorAll('button[aria-haspopup="menu"]')) {
      for (let fiber = fiberOf(candidate), depth = 0; fiber && depth < 40; fiber = fiber.return, depth++) {
        const found = props(fiber);
        if ("menu" in found && "usage" in found && "actions" in found && "source" in found) return candidate;
      }
    }
    return null;
  }

  // The composer's selected model, and the provider of its thread. A composer
  // without a thread starts one on the configured default provider.
  function chatContext() {
    const target = [...document.querySelectorAll('[data-composer-navigation-target="reasoning"]')]
      .find((element) => element.getClientRects().length > 0);
    if (target == null) return null;
    let model = null;
    for (let fiber = fiberOf(target), depth = 0; fiber && depth < 400; fiber = fiber.return, depth++) {
      const found = props(fiber);
      if (model == null && typeof found.model === "string" && "modelOptions" in found) model = found.model;
      if (model == null) continue;
      for (let hook = fiber.memoizedState; hook != null && typeof hook === "object" && "memoizedState" in hook; hook = hook.next) {
        const value = hook.memoizedState;
        if (value != null && typeof value === "object" && typeof value.threadId === "string" && typeof value.modelProvider === "string") {
          return { model, provider: value.modelProvider };
        }
      }
    }
    return model == null ? null : { model, provider: usage.defaultProvider };
  }

  function chatPool(context) {
    if (context == null) return null;
    const provider = usage.providers.find((entry) => entry.id === context.provider);
    const pool = provider?.snapshot?.pools.find((entry) => entry.models.includes(context.model));
    return pool == null ? null : { provider: provider.id, pool };
  }

  // The window that limits the pool first.
  function binding(pool) {
    return pool.windows.reduce((lowest, window) => (lowest == null || window.left_percent < lowest.left_percent ? window : lowest), null);
  }

  function creditsLeft(credits) {
    return credits.total_usd > 0 ? Math.max(0, (credits.total_usd - credits.used_usd) / credits.total_usd) * 100 : 0;
  }

  function leftPercent(pool) {
    const window = binding(pool);
    if (window != null) return window.left_percent;
    return pool.credits != null ? creditsLeft(pool.credits) : null;
  }

  function tone(pool) {
    const left = leftPercent(pool);
    if (left == null) return "";
    if (left <= 0) return "danger";
    return left < 20 || pool.windows.some((window) => window.exhausts_at != null) ? "warning" : "";
  }

  function time(iso) {
    const date = new Date(iso);
    return date.getTime() - Date.now() < DAY_MS && date.getDate() === new Date().getDate() ? clock.format(date) : weekday.format(date);
  }

  function percent(value) {
    return Math.round(value) + "%";
  }

  // Relief that leaves the window partly used; a full refill reads as a refill.
  function partialRelief(window) {
    return window.relief != null && window.relief.left_percent > window.left_percent && window.relief.left_percent < 100 ? window.relief : null;
  }

  function windowNote(window) {
    if (window.exhausts_at != null) {
      return "Empty around " + time(window.exhausts_at) + " at the current pace" + (window.resets_at ? " · refills " + time(window.resets_at) : "");
    }
    const relief = partialRelief(window);
    if (relief != null) return "Back to " + percent(relief.left_percent) + " at " + time(relief.at);
    return window.resets_at != null ? "Refills " + time(window.resets_at) : "Unused";
  }

  function accountsNote(accounts) {
    if (accounts.total === 1) return accounts.ready === 1 ? "Account ready" : "Account limited";
    return accounts.ready + " of " + accounts.total + " accounts ready";
  }

  function meter(left, toneName, relief) {
    const ghost = relief != null ? '<span class="codexlb-relief" style="width:' + relief + '%"></span>' : "";
    return '<span class="codexlb-bar" data-tone="' + toneName + '">' + ghost + '<span style="width:' + Math.max(0, Math.min(100, left)) + '%"></span></span>';
  }

  function stale(pool) {
    return pool.stale && pool.updated_at ? " · reading from " + time(pool.updated_at) : "";
  }

  function chatCard(pool) {
    const toneName = tone(pool);
    const status = toneName === "danger" ? "Exhausted" : toneName === "warning" ? "Running low" : pool.stale ? "Stale" : "Healthy";
    const statusClass = toneName ? "codexlb-" + toneName : pool.stale ? "codexlb-muted" : "";
    const rows = pool.windows.map((window) => {
      const windowTone = window.left_percent <= 0 ? "danger" : window.left_percent < 20 || window.exhausts_at ? "warning" : "";
      return '<div class="codexlb-win"><span class="codexlb-muted">' + escape(WINDOW_NAMES[window.id]) + "</span>"
        + meter(window.left_percent, windowTone, partialRelief(window)?.left_percent)
        + '<span class="codexlb-val' + (windowTone ? " codexlb-" + windowTone : "") + '">' + percent(window.left_percent) + "</span>"
        + '<span class="codexlb-note' + (window.exhausts_at ? " codexlb-warning" : "") + '">' + escape(windowNote(window)) + "</span></div>";
    });
    if (pool.credits != null) {
      const left = creditsLeft(pool.credits);
      rows.push('<div class="codexlb-win"><span class="codexlb-muted">Credits</span>' + meter(left, left < 20 ? "warning" : "")
        + '<span class="codexlb-val">' + escape(money.format(pool.credits.total_usd - pool.credits.used_usd)) + "</span>"
        + '<span class="codexlb-note">' + escape(money.format(pool.credits.used_usd) + " of " + money.format(pool.credits.total_usd) + " spent") + "</span></div>");
    }
    if (rows.length === 0) rows.push('<div class="codexlb-muted codexlb-small">No quota reported</div>');
    return '<div class="codexlb-chat"><div class="codexlb-chat-top"><span class="codexlb-chat-pool">' + escape(pool.label)
      + ' <span class="codexlb-muted codexlb-small">· this chat</span></span><span class="codexlb-status ' + statusClass + '">' + status + "</span></div>"
      + rows.join("") + '<div class="codexlb-muted codexlb-small">' + escape(accountsNote(pool.accounts) + stale(pool)) + "</div></div>";
  }

  function poolLine(pool) {
    const window = binding(pool);
    const toneName = tone(pool);
    let value, sub, left;
    if (window != null) {
      left = window.left_percent;
      value = percent(left);
      sub = [WINDOW_NAMES[window.id], accountsNote(pool.accounts), windowNote(window)].join(" · ");
    } else if (pool.credits != null) {
      left = creditsLeft(pool.credits);
      value = money.format(pool.credits.total_usd - pool.credits.used_usd);
      sub = "Credits · " + money.format(pool.credits.used_usd) + " of " + money.format(pool.credits.total_usd) + " spent";
    } else {
      sub = accountsNote(pool.accounts) + " · no quota reported";
    }
    return '<div class="codexlb-pool"><span>' + escape(pool.label) + "</span>"
      + (left == null ? "<span></span><span></span>" : meter(left, toneName, window && partialRelief(window)?.left_percent)
        + '<span class="codexlb-val' + (toneName ? " codexlb-" + toneName : "") + '">' + escape(value) + "</span>")
      + '<span class="codexlb-pool-sub">' + escape(sub + stale(pool)) + "</span></div>";
  }

  // Refills of windows that have used at least a fifth, relief and run-out
  // warnings within the next day.
  function events(pools) {
    const now = Date.now();
    const found = [];
    for (const pool of pools) {
      for (const window of pool.windows) {
        const name = pool.label + " " + WINDOW_NAMES[window.id].toLowerCase();
        if (window.exhausts_at != null) found.push({ at: window.exhausts_at, text: name + " may run out", warning: true, approximate: true });
        if (window.left_percent >= 80) continue;
        const relief = partialRelief(window);
        if (relief != null) {
          found.push({ at: relief.at, text: name + " back to " + percent(relief.left_percent) });
        } else if (window.resets_at != null) {
          found.push({ at: window.resets_at, text: name + " refills" });
        }
      }
    }
    return found
      .filter((event) => new Date(event.at).getTime() > now && new Date(event.at).getTime() - now < DAY_MS)
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .slice(0, 5);
  }

  function render(context) {
    const chat = chatPool(context);
    const providers = usage.providers;
    const fetched = providers.map((entry) => entry.fetchedAt).filter((at) => at != null).sort().at(0);
    const failed = providers.filter((entry) => entry.error != null);
    const header = failed.length > 0
      ? '<span class="codexlb-small codexlb-warning" title="' + escape(failed.map((entry) => entry.id + ": " + entry.error).join("\n")) + '">Update failed</span>'
      : fetched != null ? '<span class="codexlb-muted codexlb-small codexlb-num">Updated ' + escape(clock.format(new Date(fetched))) + "</span>" : "";
    let body = chat == null ? "" : chatCard(chat.pool);
    for (const entry of providers) {
      const pools = entry.snapshot?.pools.filter((pool) => pool !== chat?.pool) ?? [];
      const title = "Pools" + (providers.length > 1 ? " · " + entry.id : "");
      const lines = entry.snapshot == null
        ? '<div class="codexlb-empty">' + escape(entry.error ?? "Loading…") + "</div>"
        : pools.length > 0 ? pools.map(poolLine).join("") : chat == null ? '<div class="codexlb-empty">No pools</div>' : "";
      if (lines) body += '<div class="codexlb-section"><div class="codexlb-section-title">' + escape(title) + "</div>" + lines + "</div>";
    }
    const upcoming = events(providers.flatMap((entry) => entry.snapshot?.pools ?? []));
    if (upcoming.length > 0) {
      body += '<div class="codexlb-section"><div class="codexlb-section-title">Coming up</div><ul class="codexlb-events">'
        + upcoming.map((event) => "<li><time>" + (event.approximate ? "~" : "") + escape(time(event.at)) + '</time><span class="codexlb-dot'
          + (event.warning ? " codexlb-warning" : "") + '"></span><span>' + escape(event.text) + "</span></li>").join("") + "</ul></div>";
    }
    const today = providers.map((entry) => entry.snapshot?.today).filter((entry) => entry != null);
    const footText = today.length > 0
      ? "Today " + today.reduce((sum, entry) => sum + entry.requests, 0).toLocaleString() + " requests · "
        + money.format(today.reduce((sum, entry) => sum + entry.cost_usd, 0)) + " est."
      : "";
    const links = providers.map((entry) => '<button type="button" class="codexlb-link" data-dashboard="' + escape(entry.dashboard) + '">'
      + EXTERNAL_ICON + "Dashboard" + (providers.length > 1 ? " · " + escape(entry.id) : "") + "</button>").join("");
    return '<div class="codexlb-head"><span class="codexlb-title">codex-lb</span>' + header
      + '<button type="button" class="codexlb-icon" data-refresh aria-label="Refresh usage" title="Refresh"' + (usage.refreshing ? " data-busy" : "") + ">"
      + REFRESH_ICON + "</button></div>" + body
      + '<div class="codexlb-foot"><span class="codexlb-foot-text codexlb-num" title="Since midnight, for this API key · cost estimated at API prices">'
      + escape(footText) + "</span>" + links + "</div>";
  }

  function place() {
    const rect = button.getBoundingClientRect();
    const height = popover.offsetHeight;
    popover.style.left = Math.min(rect.right + 8, innerWidth - popover.offsetWidth - 8) + "px";
    popover.style.top = Math.max(8, Math.min(rect.bottom - height, innerHeight - height - 8)) + "px";
  }

  function updateRing(found, context) {
    const chat = chatPool(context);
    const left = chat == null ? null : leftPercent(chat.pool);
    if (left == null) {
      if (button != null) {
        button.removeAttribute(RING);
        ring?.remove();
      }
      return;
    }
    if (ring == null) {
      ring = document.createElement("span");
      ring.className = "codexlb-ring";
      ring.setAttribute("aria-hidden", "true");
      ring.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><circle class="track" cx="12" cy="12" r="9"/><circle class="fill" cx="12" cy="12" r="9" transform="rotate(-90 12 12)"/></svg>';
    }
    const length = 2 * Math.PI * 9;
    const arc = (Math.max(0, Math.min(100, left)) / 100) * length;
    ring.querySelector(".fill").setAttribute("stroke-dasharray", arc.toFixed(2) + " " + length.toFixed(2));
    ring.dataset.tone = tone(chat.pool);
    found.setAttribute(RING, "");
    if (ring.parentNode !== found) found.append(ring);
  }

  function sync() {
    const found = findButton();
    if (found !== button) {
      if (button != null) {
        button.removeAttribute(RING);
        ring?.remove();
      }
      button = found;
      if (button == null) close();
    }
    const context = chatContext();
    if (button != null) updateRing(button, context);
    if (!popover.hidden) {
      const html = render(context);
      if (html !== rendered) {
        rendered = html;
        popover.innerHTML = html;
      }
      place();
    }
  }

  function open() {
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    rendered = "";
    sync();
    popover.focus({ preventScroll: true });
    emit("open");
  }

  function close() {
    if (popover.hidden) return;
    popover.hidden = true;
    button?.setAttribute("aria-expanded", "false");
  }

  function onTrigger(event) {
    if (button == null || !button.contains(event.target)) return false;
    event.stopImmediatePropagation();
    return true;
  }

  // The stock menu opens on pointerdown and on Enter, Space or ArrowDown.
  // Enter and Space keep their default action so the button's click toggles.
  const listeners = {
    pointerdown(event) {
      if (onTrigger(event)) {
        event.preventDefault();
      } else if (!popover.hidden && !popover.contains(event.target)) {
        close();
      }
    },
    mousedown(event) {
      if (onTrigger(event)) event.preventDefault();
    },
    keydown(event) {
      if (event.key === "Escape" && !popover.hidden) {
        event.stopImmediatePropagation();
        close();
        button?.focus();
        return;
      }
      if (onTrigger(event) && event.key === "ArrowDown") event.preventDefault();
    },
    click(event) {
      if (!onTrigger(event)) return;
      event.preventDefault();
      if (popover.hidden) open();
      else close();
    },
    focus(event) {
      if (event.target === window) emit("visible");
    },
    resize() {
      if (!popover.hidden) place();
    },
  };
  for (const [type, listener] of Object.entries(listeners)) addEventListener(type, listener, true);
  const visibility = () => {
    if (document.visibilityState === "visible") emit("visible");
  };
  document.addEventListener("visibilitychange", visibility);
  popover.addEventListener("click", (event) => {
    const target = event.target.closest("[data-refresh],[data-dashboard]");
    if (target == null) return;
    if (target.hasAttribute("data-refresh")) emit("refresh");
    else emit({ type: "dashboard", url: target.dataset.dashboard });
  });

  const timer = setInterval(sync, 1000);
  const controller = {
    owner,
    status: () => ({ status: "active", button: button != null }),
    update(next) {
      usage = next;
      sync();
      return controller.status();
    },
    next() {
      return signals.length > 0 ? Promise.resolve(signals.shift()) : new Promise((resolve) => { waiting = resolve; });
    },
    stop() {
      clearInterval(timer);
      for (const [type, listener] of Object.entries(listeners)) removeEventListener(type, listener, true);
      document.removeEventListener("visibilitychange", visibility);
      if (button != null) {
        button.removeAttribute(RING);
        button.setAttribute("aria-expanded", "false");
      }
      ring?.remove();
      popover.remove();
      style.remove();
      waiting?.(null);
      waiting = null;
    },
  };
  globalThis[key] = controller;
  sync();
  if (document.visibilityState === "visible") emit("visible");
  return controller.status();
}

module.exports = { configureUsagePopover };
