"use strict";

const SIDEBAR = "[data-app-action-sidebar-scroll]";
const HEADER = "[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]";
const GROUP = "[data-sidebar-project-kind][role='listitem']";
const COLOR = "data-codexdc-project-color";
const TINT = "data-codexdc-project-tint";
const TITLE = "data-codexdc-project-color-header";
const PALETTE = [
  ["blue", "Blue", "var(--color-chart-blue)"],
  ["green", "Green", "var(--color-chart-green)"],
  ["yellow", "Yellow", "var(--color-chart-yellow)"],
  ["red", "Red", "var(--color-chart-red)"],
  ["pink", "Pink", "#db6aa3"],
  ["purple", "Purple", "var(--color-chart-purple)"],
  ["gray", "Gray", "var(--color-text-secondary)"],
];
const COLORS_KEY = "projectColors";
const TINT_KEY = "tintBackgrounds";

function automaticColor(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return PALETTE[(hash >>> 0) % 6][0];
}

function styleText() {
  return `
${PALETTE.map(([id, , value]) => `[${COLOR}="${id}"] { --codexdc-project-accent: ${value}; }`).join("\n")}
[${COLOR}][${TINT}] {
  background: color-mix(in srgb, var(--codexdc-project-accent) 7%, transparent);
  border-radius: 8px;
}
[${COLOR}] [${TITLE}] .select-none,
[${COLOR}] [${TITLE}] [data-sidebar-project-drop-zone="project-icon"] svg {
  color: color-mix(in srgb, var(--codexdc-project-accent) 80%, var(--color-text));
}
.codexdc-project-color-menu {
  display: flex; width: 100%; padding: 6px 8px; border: 0; border-radius: 4px;
  background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
}
.codexdc-project-color-menu:hover, .codexdc-project-color-menu:focus-visible {
  background: var(--color-background-panel);
}
.codexdc-project-color-dialog {
  color: var(--color-text); background: var(--color-surface);
  border: 1px solid var(--color-border); border-radius: 12px; padding: 20px;
  max-width: 380px;
}
.codexdc-project-color-dialog::backdrop { background: rgb(0 0 0 / 35%); }
.codexdc-project-color-dialog h2 { margin: 0 0 16px; font-size: 16px; }
.codexdc-project-color-options { display: flex; flex-wrap: wrap; gap: 8px; }
.codexdc-project-color-options button, .codexdc-project-color-dialog > button {
  color: inherit; background: transparent; border: 1px solid var(--color-border);
  border-radius: 6px; padding: 8px 12px; cursor: pointer;
}
.codexdc-project-color-dialog > button { margin-top: 16px; }
.codexdc-project-color-options button[aria-pressed="true"] { outline: 2px solid var(--color-text); }
.codexdc-project-color-swatch {
  display: inline-block; width: 12px; height: 12px; margin-inline-end: 6px; border-radius: 50%;
}
.codexdc-project-color-settings label { display: flex; align-items: center; gap: 12px; margin: 12px 0; }
.codexdc-project-color-settings select { margin-inline-start: auto; }
`;
}

// All recoloring uses semantic sidebar attributes and CSS. In particular, native
// collapse animations (style/class/aria-expanded changes) never schedule work.
function createProjectColors(api, doc) {
  const win = doc.defaultView;
  const rows = new Map();
  const sidebars = new Map();
  const dirty = new Set();
  const menus = new Map();
  const settingsRoots = new Set();
  let colors = api.storage.get(COLORS_KEY, {});
  let tint = api.storage.get(TINT_KEY, true);
  let frame = null;
  let pendingMenu = null;
  let menuTimer = null;
  let dialog = null;
  let stopped = false;
  const style = doc.createElement("style");
  style.id = "codexdc-project-colors-style";
  style.textContent = styleText();
  doc.head.append(style);

  function matching(node, selector) {
    if (node.nodeType !== 1) return [];
    return [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)];
  }
  function clear(row) {
    row.group.removeAttribute(COLOR);
    row.group.removeAttribute(TINT);
    row.header.removeAttribute(TITLE);
  }
  function paint(row) {
    const color = colors[row.key] || automaticColor(row.key);
    if (row.group.getAttribute(COLOR) !== color) row.group.setAttribute(COLOR, color);
    row.group.toggleAttribute(TINT, tint);
    row.header.setAttribute(TITLE, "");
  }
  function flush() {
    frame = null;
    for (const [header, row] of rows) {
      if (!header.isConnected || !header.matches(HEADER) || !header.closest(SIDEBAR) || !header.closest(GROUP)) {
        clear(row);
        rows.delete(header);
      }
    }
    for (const header of dirty) {
      if (!header.isConnected || !header.matches(HEADER) || !header.closest(SIDEBAR)) continue;
      const group = header.closest(GROUP);
      if (!group) continue; // Header can mount before its containing project.
      const key = JSON.stringify([
        group.getAttribute("data-sidebar-project-kind"),
        header.getAttribute("data-app-action-sidebar-project-id"),
      ]);
      const previous = rows.get(header);
      if (previous && previous.group !== group) clear(previous);
      const row = {
        header, group, key,
        label: header.getAttribute("data-app-action-sidebar-project-label") || header.textContent.trim(),
      };
      rows.set(header, row);
      paint(row);
    }
    dirty.clear();
    renderSettings();
  }
  function schedule() {
    if (frame === null) frame = win.requestAnimationFrame(flush);
  }
  function scan(node) {
    const headers = matching(node, HEADER);
    for (const header of headers) dirty.add(header);
    if (headers.length) schedule();
  }
  function attachSidebar(root) {
    if (sidebars.has(root)) return;
    const observer = new win.MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (rows.has(record.target)) {
            dirty.add(record.target);
            schedule();
          } else scan(record.target);
        } else {
          for (const node of record.addedNodes) scan(node);
          // Removing thread rows cannot affect the project ledger.
          for (const node of record.removedNodes) {
            if (matching(node, HEADER).length) schedule();
          }
        }
      }
    });
    observer.observe(root, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-project-id", "data-app-action-sidebar-project-row",
        "data-app-action-sidebar-project-label", "data-sidebar-project-kind",
      ],
    });
    sidebars.set(root, observer);
    scan(root);
  }
  function setColor(key, color) {
    // Read at the time of the edit so other windows' selections are preserved.
    colors = { ...api.storage.get(COLORS_KEY, {}) };
    if (color === "auto") delete colors[key];
    else colors[key] = color;
    api.storage.set(COLORS_KEY, colors);
    for (const row of rows.values()) paint(row);
    renderSettings();
  }
  function openPicker(row) {
    if (stopped) return;
    if (dialog) dialog.remove();
    dialog = doc.createElement("dialog");
    const current = dialog;
    current.className = "codexdc-project-color-dialog";
    const title = doc.createElement("h2");
    title.id = "codexdc-project-color-title";
    title.textContent = `Color for ${row.label}`;
    current.setAttribute("aria-labelledby", title.id);
    const options = doc.createElement("div");
    options.className = "codexdc-project-color-options";
    for (const [id, label, value] of [["auto", "Auto", null], ...PALETTE]) {
      const button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("aria-pressed", String((colors[row.key] || "auto") === id));
      if (value) {
        const swatch = doc.createElement("span");
        swatch.className = "codexdc-project-color-swatch";
        swatch.style.background = value;
        swatch.setAttribute("aria-hidden", "true");
        button.append(swatch);
      }
      button.append(label);
      button.addEventListener("click", () => {
        setColor(row.key, id);
        current.close();
      });
      options.append(button);
    }
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.type = "button";
    cancel.addEventListener("click", () => current.close());
    current.append(title, options, cancel);
    current.addEventListener("close", () => {
      current.remove();
      if (dialog === current) dialog = null;
      if (row.header.isConnected) row.header.focus();
    }, { once: true });
    doc.body.append(current);
    current.showModal();
  }
  function attachMenu(menu) {
    if (!pendingMenu || !pendingMenu.header.isConnected || menu.querySelector(".codexdc-project-color-menu")) return;
    const row = pendingMenu;
    pendingMenu = null;
    win.clearTimeout(menuTimer);
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "codexdc-project-color-menu";
    button.setAttribute("role", "menuitem");
    button.textContent = "Project color…";
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      menu.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // Let the native menu restore focus before the modal takes focus.
      win.queueMicrotask(() => openPicker(row));
    });
    menu.append(button);
    // Radix's registered item collection cannot include an externally inserted
    // item. Join its keyboard loop explicitly, without replacing native actions.
    const onKey = event => {
      const native = [...menu.querySelectorAll("[role='menuitem']")]
        .filter(item => item !== button && item.getAttribute("aria-disabled") !== "true");
      const active = doc.activeElement;
      let next;
      if (event.key === "End") next = button;
      else if (event.key === "ArrowDown" && active === native.at(-1)) next = button;
      else if (event.key === "ArrowUp" && active === native[0]) next = button;
      else if (active === button && event.key === "ArrowUp") next = native.at(-1);
      else if (active === button && (event.key === "ArrowDown" || event.key === "Home")) next = native[0];
      if (next) {
        event.preventDefault();
        event.stopPropagation();
        next.focus();
      }
    };
    menu.addEventListener("keydown", onKey, true);
    menus.set(button, () => menu.removeEventListener("keydown", onKey, true));
  }
  function rememberProject(event) {
    const header = event.target.closest(HEADER);
    if (!header || (event.type !== "contextmenu" && !event.target.closest("button[aria-haspopup='menu']"))) return;
    pendingMenu = rows.get(header) || null;
    win.clearTimeout(menuTimer);
    menuTimer = win.setTimeout(() => { pendingMenu = null; }, 1500);
    win.queueMicrotask(() => {
      if (pendingMenu) {
        for (const menu of doc.querySelectorAll("[role='menu'][data-state='open']")) attachMenu(menu);
      }
    });
  }
  const bodyObserver = new win.MutationObserver(records => {
    for (const [root, observer] of sidebars) {
      if (!root.isConnected) {
        observer.disconnect();
        sidebars.delete(root);
        schedule();
      }
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        for (const root of matching(node, SIDEBAR)) attachSidebar(root);
        if (pendingMenu) {
          for (const menu of matching(node, "[role='menu'][data-state='open']")) attachMenu(menu);
        }
      }
    }
    for (const [button, cleanup] of menus) {
      if (!button.isConnected) { cleanup(); menus.delete(button); }
    }
  });
  bodyObserver.observe(doc.body, { subtree: true, childList: true });
  for (const root of doc.querySelectorAll(SIDEBAR)) attachSidebar(root);
  doc.addEventListener("contextmenu", rememberProject, true);
  doc.addEventListener("click", rememberProject, true);
  doc.addEventListener("pointerdown", rememberProject, true);

  function renderSettings() {
    for (const root of settingsRoots) {
      if (!root.isConnected) {
        settingsRoots.delete(root);
        continue;
      }
      root.replaceChildren();
      root.classList.add("codexdc-project-color-settings");
      const tintLabel = doc.createElement("label");
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = tint;
      checkbox.addEventListener("change", () => {
        tint = checkbox.checked;
        api.storage.set(TINT_KEY, tint);
        for (const row of rows.values()) paint(row);
      });
      tintLabel.append(checkbox, "Tint project backgrounds");
      root.append(tintLabel);
      const projects = new Map([...rows.values()].map(row => [row.key, row]));
      if (!projects.size) {
        const empty = doc.createElement("p");
        empty.textContent = "Open the sidebar to choose project colors.";
        root.append(empty);
      }
      for (const row of projects.values()) {
        const label = doc.createElement("label");
        // Preserve the display label but distinguish equal names in settings.
        label.textContent = row.label;
        label.title = row.header.getAttribute("data-app-action-sidebar-project-id");
        const select = doc.createElement("select");
        select.setAttribute("aria-label", `Color for ${row.label}`);
        for (const [id, name] of [["auto", "Auto"], ...PALETTE]) {
          const option = doc.createElement("option");
          option.value = id;
          option.textContent = name;
          select.append(option);
        }
        select.value = colors[row.key] || "auto";
        select.addEventListener("change", () => setColor(row.key, select.value));
        label.append(select);
        root.append(label);
      }
    }
  }
  function syncStorage(event) {
    if (event.key !== "codexpp:storage:local.project-colors") return;
    colors = api.storage.get(COLORS_KEY, {});
    tint = api.storage.get(TINT_KEY, true);
    for (const row of rows.values()) paint(row);
    renderSettings();
  }
  win.addEventListener("storage", syncStorage);
  const unregister = api.settings.register({
    id: "project-colors", title: "Project Colors",
    render(root) {
      settingsRoots.add(root);
      renderSettings();
      return () => settingsRoots.delete(root);
    },
  });
  return {
    stop() {
      stopped = true;
      bodyObserver.disconnect();
      for (const observer of sidebars.values()) observer.disconnect();
      if (frame !== null) win.cancelAnimationFrame(frame);
      win.clearTimeout(menuTimer);
      pendingMenu = null;
      doc.removeEventListener("contextmenu", rememberProject, true);
      doc.removeEventListener("click", rememberProject, true);
      doc.removeEventListener("pointerdown", rememberProject, true);
      win.removeEventListener("storage", syncStorage);
      unregister.unregister();
      dialog?.remove();
      for (const [button, cleanup] of menus) { cleanup(); button.remove(); }
      for (const row of rows.values()) clear(row);
      style.remove();
      settingsRoots.clear();
    },
  };
}

let controller;
module.exports = {
  start(api) { controller = createProjectColors(api, document); },
  stop() { controller?.stop(); controller = null; },
  __test: { createProjectColors, automaticColor },
};
