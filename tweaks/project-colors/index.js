"use strict";

const SIDEBAR = "[data-app-action-sidebar-scroll]";
const HEADER = "[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]";
const GROUP = "[data-sidebar-project-kind][role='listitem']";
const COLOR = "data-codexdc-project-color";
const TINT = "data-codexdc-project-tint";
const TITLE = "data-codexdc-project-color-header";
const THREAD = "[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-id]";
const CONVERSATION = "data-codexdc-project-conversation-color";
const PALETTE = [
  ["blue", "Blue", "var(--color-chart-blue)"],
  ["green", "Green", "var(--color-chart-green)"],
  ["yellow", "Yellow", "var(--color-chart-yellow)"],
  ["red", "Red", "var(--color-chart-red)"],
  ["pink", "Pink", "#db6aa3"],
  ["purple", "Purple", "var(--color-chart-purple)"],
  ["gray", "Gray", "var(--color-text-secondary)"],
];
const OPTIONS = [["none", "None", null], ["auto", "Auto", null], ...PALETTE];
const COLORS_KEY = "projectColors";
const TINT_KEY = "tintBackgrounds";
const isCustom = color => /^#[0-9a-f]{6}$/i.test(color);

function conversationProject(api, node, projectsById) {
  // Activity carries a full project group; Recents uses hover-card project IDs.
  // Read identities, never displayed project names or minified component names.
  let projectId = null;
  for (let fiber = api.react.getFiber(node); fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    const group = props?.projectGroup ?? props?.secondaryContent?.props?.projectGroup;
    if (group?.projectId != null && group.projectKind != null) {
      return JSON.stringify([group.projectKind, group.projectId]);
    }
    projectId ??= props?.hoverCardProjectId;
  }
  const matches = projectsById.get(projectId);
  return matches?.size === 1 ? matches.values().next().value : null;
}

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
[${CONVERSATION}] [data-thread-title] {
  color: color-mix(in srgb, var(--codexdc-project-accent) 80%, var(--color-text));
}
[${CONVERSATION}][${TINT}] {
  background: color-mix(in srgb, var(--codexdc-project-accent) 7%, transparent);
}
.codexdc-project-color-dialog {
  width: 100vw; height: 100dvh; max-width: none; max-height: none;
  margin: 0; border: 0; padding: 0; background: transparent;
  color: var(--color-text);
}
.codexdc-project-color-dialog::backdrop { background: transparent; }
.codexdc-project-color-panel { width: 400px; max-width: 92vw; max-height: 92dvh; overflow-y: auto; padding: 24px; box-sizing: border-box; }
.codexdc-project-color-heading { margin-bottom: 20px; padding-inline-end: 24px; }
.codexdc-project-color-heading h2 { margin: 0 0 8px; font-size: 20px; line-height: 28px; font-weight: 600; }
.codexdc-project-color-heading p { margin: 0; font-size: 13px; line-height: 20px; color: var(--color-text-secondary); }
.codexdc-project-color-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.codexdc-project-color-actions button { min-height: 32px; padding-inline: 12px; }
.codexdc-project-color-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; min-height: 32px; }
.codexdc-project-color-select { min-width: 110px; }
.codexdc-project-custom-trigger { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-border); border-radius: 999px; background: transparent; color: var(--color-text); padding: 6px 10px; font: inherit; cursor: pointer; }
.codexdc-project-custom-trigger[hidden] { display: none; }
.codexdc-project-custom-trigger .codexdc-project-color-swatch { margin: 0; }
.codexdc-project-color-field, .codexdc-project-color-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0; }
.codexdc-project-color-setting-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.codexdc-project-custom-popup {
  position: fixed; inset: auto; top: anchor(bottom); left: anchor(left); margin: 8px 0 0;
  position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
  padding: 16px; width: 234px; max-width: calc(100vw - 24px); box-sizing: border-box;
  border: 0.5px solid var(--color-border); border-radius: 16px;
  color: var(--color-text); background: var(--color-surface-elevated-secondary);
  box-shadow: 0 12px 32px #0004;
}
.codexdc-project-custom-popup-heading { display: block; margin-bottom: 12px; font-size: 14px; font-weight: 600; }
.codexdc-project-custom-done { display: block; margin: 12px 0 0 auto; padding: 6px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: transparent; color: var(--color-text); cursor: pointer; }
.codexdc-project-color-preview { margin-top: 20px; padding: 12px; border: 1px solid var(--color-border); border-radius: 12px; }
.codexdc-project-color-preview-caption { display: block; margin-bottom: 10px; font-size: 12px; color: var(--color-text-secondary); }
.codexdc-project-color-preview-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 10px; }
.codexdc-project-color-preview-row .select-none, .codexdc-project-color-preview-row [data-thread-title] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codexdc-project-color-preview-row svg { width: 18px; height: 18px; flex-shrink: 0; }
.codexdc-project-color-preview-activity { display: block; margin: 14px 10px 4px; font-size: 11px; color: var(--color-text-secondary); }
.codexdc-project-color-swatch {
  display: inline-block; width: 12px; height: 12px; margin-inline-end: 6px; border-radius: 50%;
}
.codexdc-project-color-settings label { display: flex; align-items: center; gap: 12px; margin: 12px 0; }
.codexdc-project-color-settings select { margin-inline-start: auto; }
.codexdc-project-custom-editor { display: flex; flex-direction: column; gap: 12px; align-items: center; }
.codexdc-project-custom-picker.react-colorful { width: 200px; height: 160px; }
.codexdc-project-custom-hex { width: 100px; padding: 6px 12px; border: 1px solid var(--color-border); border-radius: 999px; background: transparent; color: var(--color-text); }
[data-codexdc-picker-state="error"]::after { content: "Color picker unavailable. Enter a hex color."; font-size: 12px; }
`;
}

// All recoloring uses semantic sidebar attributes and CSS. In particular, native
// collapse animations (style/class/aria-expanded changes) never schedule work.
function createProjectColors(api, doc) {
  const win = doc.defaultView;
  const rows = new Map();
  const conversations = new Map();
  const dirtyConversations = new Set();
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
  let nextControlId = 0;
  const style = doc.createElement("style");
  style.id = "codexdc-project-colors-style";
  style.textContent = styleText();
  doc.head.append(style);

  function matching(node, selector) {
    if (node.nodeType !== 1) return [];
    return [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)];
  }
  function clear(row) {
    clearElement(row.group);
    row.header.removeAttribute(TITLE);
  }
  function clearElement(node) {
    node.removeAttribute(COLOR);
    node.removeAttribute(TINT);
    node.removeAttribute(CONVERSATION);
    node.style.removeProperty("--codexdc-project-accent");
  }
  function paintElement(node, key) {
    return paintSelection(node, colors[key] ?? "none", key);
  }
  function paintSelection(node, selection, key) {
    if (selection === "none") { clearElement(node); return false; }
    const color = selection === "auto" ? automaticColor(key) : selection;
    const marker = isCustom(color) ? "custom" : color;
    if (node.getAttribute(COLOR) !== marker) node.setAttribute(COLOR, marker);
    if (isCustom(color)) {
      if (node.style.getPropertyValue("--codexdc-project-accent") !== color) {
        node.style.setProperty("--codexdc-project-accent", color);
      }
    } else node.style.removeProperty("--codexdc-project-accent");
    node.toggleAttribute(TINT, tint);
    return true;
  }
  function paint(row) {
    row.header.toggleAttribute(TITLE, paintElement(row.group, row.key));
  }
  function paintConversation(node, key) {
    if (paintElement(node, key)) node.setAttribute(CONVERSATION, "");
  }
  function repaint() {
    for (const row of rows.values()) paint(row);
    const projects = projectIdentities();
    for (const [node] of conversations) {
      const key = conversationProject(api, node, projects);
      conversations.set(node, key);
      paintConversation(node, key);
    }
  }
  function projectIdentities() {
    const projects = new Map();
    // Include saved identities when a project's heading isn't mounted, such as
    // in Activity or when a project isn't visible in the sidebar.
    for (const key of new Set([...Object.keys(colors), ...[...rows.values()].map(row => row.key)])) {
      const [, id] = JSON.parse(key);
      if (!projects.has(id)) projects.set(id, new Set());
      projects.get(id).add(key);
    }
    return projects;
  }
  function flush() {
    frame = null;
    let projectsChanged = dirty.size > 0;
    for (const [header, row] of rows) {
      if (!header.isConnected || !header.matches(HEADER) || !header.closest(SIDEBAR) || !header.closest(GROUP)) {
        clear(row);
        rows.delete(header);
        projectsChanged = true;
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
    for (const [node] of conversations) {
      if (!node.isConnected || !node.matches(THREAD) || !node.closest(SIDEBAR) || node.closest(GROUP)) {
        clearElement(node);
        conversations.delete(node);
      }
    }
    // Project headers can arrive after Recents. Revisit membership when the
    // project ledger changes, including conversations previously unresolved.
    if (projectsChanged) {
      for (const node of conversations.keys()) dirtyConversations.add(node);
    }
    const projects = projectIdentities();
    for (const node of dirtyConversations) {
      if (!node.isConnected || !node.matches(THREAD) || !node.closest(SIDEBAR) || node.closest(GROUP)) continue;
      const key = conversationProject(api, node, projects);
      conversations.set(node, key);
      paintConversation(node, key);
    }
    dirtyConversations.clear();
    if (projectsChanged) renderSettings();
  }
  function schedule() {
    if (frame === null) frame = win.requestAnimationFrame(flush);
  }
  function scan(node) {
    const headers = matching(node, HEADER);
    for (const header of headers) dirty.add(header);
    const threads = matching(node, THREAD).filter(thread => !thread.closest(GROUP));
    for (const thread of threads) dirtyConversations.add(thread);
    if (headers.length || threads.length) schedule();
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
          const thread = record.target.nodeType === 1 && record.target.closest(THREAD);
          if (thread && !thread.closest(GROUP)) { dirtyConversations.add(thread); schedule(); }
          // Removing thread rows cannot affect the project ledger.
          for (const node of record.removedNodes) {
            if (matching(node, HEADER).length || matching(node, THREAD).some(thread => conversations.has(thread))) schedule();
          }
        }
      }
    });
    observer.observe(root, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: [
        "data-app-action-sidebar-project-id", "data-app-action-sidebar-project-row",
        "data-app-action-sidebar-project-label", "data-sidebar-project-kind",
        "data-app-action-sidebar-thread-id", "data-app-action-sidebar-thread-row",
      ],
    });
    sidebars.set(root, observer);
    scan(root);
  }
  function setColor(key, color, refreshSettings = true) {
    // Read at the time of the edit so other windows' selections are preserved.
    colors = { ...api.storage.get(COLORS_KEY, {}) };
    if (color === "none") delete colors[key];
    else colors[key] = color;
    api.storage.set(COLORS_KEY, colors);
    repaint();
    if (refreshSettings) renderSettings();
  }
  function customControl(value, onChange) {
    const editor = doc.createElement("div");
    editor.className = "codexdc-project-custom-editor";
    const picker = doc.createElement("div");
    picker.setAttribute("data-codexdc-custom-picker", "");
    picker.setAttribute("data-codexdc-custom-value", value);
    const hex = doc.createElement("input");
    hex.className = "codexdc-project-custom-hex";
    hex.type = "text";
    hex.value = value;
    hex.maxLength = 7;
    hex.setAttribute("aria-label", "Custom project color hex");
    hex.setAttribute("placeholder", "#RRGGBB");
    function request() {
      picker.dispatchEvent(new win.Event("codexdc:project-color-picker", { bubbles: true }));
    }
    picker.addEventListener("codexdc:project-custom-color", () => {
      const color = picker.getAttribute("data-codexdc-custom-value");
      if (!isCustom(color)) return;
      hex.value = color;
      hex.setCustomValidity("");
      onChange(color);
    });
    hex.addEventListener("input", () => {
      const color = hex.value.startsWith("#") ? hex.value : `#${hex.value}`;
      hex.setCustomValidity(isCustom(color) ? "" : "Enter a six-digit hex color.");
      if (!isCustom(color)) return;
      picker.setAttribute("data-codexdc-custom-value", color.toLowerCase());
      request();
      onChange(color.toLowerCase());
    });
    editor.append(picker, hex);
    return editor;
  }
  function colorControl(value, label, onChange) {
    let customColor = isCustom(value) ? value : "#3b82f6";
    const id = `codexdc-project-color-${++nextControlId}`;
    const element = doc.createElement("div");
    element.className = "codexdc-project-color-control";
    const select = doc.createElement("div");
    select.id = id;
    select.className = "codexdc-project-color-select";
    select.setAttribute("aria-label", label);
    select.setAttribute("data-codexdc-color-select", "");
    select.setAttribute("data-codexdc-color-value", isCustom(value) ? "custom" : value);
    select.setAttribute("data-codexdc-color-options", JSON.stringify([...OPTIONS, ["custom", "Custom…", null]]));
    const selection = () => select.getAttribute("data-codexdc-color-value");
    const trigger = doc.createElement("button");
    trigger.type = "button";
    trigger.className = "codexdc-project-custom-trigger";
    trigger.style.anchorName = `--${id}`;
    trigger.setAttribute("aria-label", "Edit custom project color");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    const swatch = doc.createElement("span");
    swatch.className = "codexdc-project-color-swatch";
    swatch.setAttribute("aria-hidden", "true");
    const hexLabel = doc.createElement("span");
    trigger.append(swatch, hexLabel);
    const popup = doc.createElement("div");
    popup.id = `${id}-popup`;
    popup.className = "codexdc-project-custom-popup";
    popup.setAttribute("popover", "auto");
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Custom project color");
    popup.style.positionAnchor = `--${id}`;
    trigger.setAttribute("aria-controls", popup.id);
    function updateCustom() {
      trigger.hidden = selection() !== "custom";
      swatch.style.background = customColor;
      hexLabel.textContent = customColor.toUpperCase();
    }
    const heading = doc.createElement("span");
    heading.className = "codexdc-project-custom-popup-heading";
    heading.textContent = "Custom color";
    const editor = customControl(customColor, color => {
      customColor = color;
      updateCustom();
      onChange(color);
    });
    const hex = editor.querySelector("input");
    const done = doc.createElement("button");
    done.type = "button";
    done.className = "codexdc-project-custom-done";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      if (!hex.reportValidity()) return;
      popup.hidePopover();
      trigger.focus();
    });
    popup.append(heading, editor, done);
    popup.addEventListener("beforetoggle", event => {
      trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    });
    function open() {
      popup.showPopover();
      editor.querySelector("[data-codexdc-custom-picker]")
        .dispatchEvent(new win.Event("codexdc:project-color-picker", { bubbles: true }));
      hex.focus();
    }
    trigger.addEventListener("click", () => {
      if (trigger.getAttribute("aria-expanded") === "true") popup.hidePopover();
      else open();
    });
    select.addEventListener("codexdc:project-color-selection", () => {
      updateCustom();
      onChange(selection() === "custom" ? customColor : selection());
      if (selection() === "custom") open();
      else if (trigger.getAttribute("aria-expanded") === "true") popup.hidePopover();
    });
    updateCustom();
    element.append(select, trigger, popup);
    win.queueMicrotask(() => {
      if (select.isConnected) select.dispatchEvent(new win.Event("codexdc:project-color-select", { bubbles: true }));
    });
    return {
      element, select,
      valid() {
        if (selection() !== "custom" || hex.checkValidity()) return true;
        open();
        hex.reportValidity();
        return false;
      },
    };
  }
  function openPicker(row) {
    if (stopped) return;
    if (dialog) dialog.remove();
    dialog = doc.createElement("dialog");
    const current = dialog;
    current.className = "codexdc-project-color-dialog";
    current.setAttribute("data-state", "open");
    current.setAttribute("aria-modal", "true");
    const overlay = doc.createElement("div");
    overlay.className = "codex-dialog-overlay fixed inset-0 z-50 bg-(--color-dialog-overlay)";
    overlay.setAttribute("aria-hidden", "true");
    overlay.addEventListener("click", () => current.close());
    const panel = doc.createElement("div");
    panel.className = "codex-dialog codexdc-project-color-panel fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 outline-none bg-surface-elevated-secondary/90 text-default ring-[0.5px] ring-border shadow-lg backdrop-blur-xl rounded-3xl max-w-[92vw] p-6";
    const heading = doc.createElement("div");
    heading.className = "codexdc-project-color-heading";
    const title = doc.createElement("h2");
    title.id = "codexdc-project-color-title";
    title.className = "heading-dialog min-w-0 font-semibold text-default";
    title.textContent = "Project color";
    const subtitle = doc.createElement("p");
    subtitle.id = "codexdc-project-color-description";
    subtitle.className = "text-base leading-normal tracking-normal text-tertiary break-words";
    subtitle.textContent = row.label;
    heading.append(title, subtitle);
    current.setAttribute("aria-labelledby", title.id);
    current.setAttribute("aria-describedby", subtitle.id);
    // Reuse the app's Button component CSS from this project's native action.
    // The module class is discovered from the live DOM, never a build hash.
    const template = row.header.querySelector("button[aria-haspopup='menu']");
    const buttonClass = [...template.classList].find(name => name.startsWith("_Button_"));
    const innerClass = template.firstElementChild.className;
    function nativeButton(label, color = "secondary", variant = "soft") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = buttonClass;
      button.dataset.size = "md";
      button.dataset.color = color;
      button.dataset.variant = variant;
      const inner = doc.createElement("span");
      inner.className = innerClass;
      inner.append(label);
      button.append(inner);
      return { button, inner };
    }
    let draft = colors[row.key] ?? "none";
    const preview = doc.createElement("div");
    preview.className = "codexdc-project-color-preview";
    preview.setAttribute("role", "group");
    preview.setAttribute("aria-label", "Color preview");
    const caption = doc.createElement("span");
    caption.className = "codexdc-project-color-preview-caption";
    caption.textContent = "Preview";
    const sampleProject = doc.createElement("div");
    const sampleHeader = doc.createElement("div");
    sampleHeader.className = "codexdc-project-color-preview-row";
    sampleHeader.setAttribute(TITLE, "");
    const icon = doc.createElement("span");
    icon.setAttribute("data-sidebar-project-drop-zone", "project-icon");
    icon.append(row.header.querySelector("[data-sidebar-project-drop-zone='project-icon'] svg").cloneNode(true));
    const sampleTitle = doc.createElement("span");
    sampleTitle.className = "select-none";
    sampleTitle.textContent = row.label;
    sampleHeader.append(icon, sampleTitle);
    sampleProject.append(sampleHeader);
    const activityLabel = doc.createElement("span");
    activityLabel.className = "codexdc-project-color-preview-activity";
    activityLabel.textContent = "Activity";
    const sampleConversation = doc.createElement("div");
    sampleConversation.className = "codexdc-project-color-preview-row";
    const conversationTitle = doc.createElement("span");
    conversationTitle.setAttribute("data-thread-title", "");
    conversationTitle.textContent = "Sample conversation";
    sampleConversation.append(conversationTitle);
    preview.append(caption, sampleProject, activityLabel, sampleConversation);
    function updatePreview() {
      paintSelection(sampleProject, draft, row.key);
      if (paintSelection(sampleConversation, draft, row.key)) sampleConversation.setAttribute(CONVERSATION, "");
    }
    const control = colorControl(draft, `Color for ${row.label}`, color => {
      draft = color;
      updatePreview();
    });
    const field = doc.createElement("div");
    field.className = "codexdc-project-color-field";
    const fieldLabel = doc.createElement("span");
    fieldLabel.textContent = "Color";
    field.append(fieldLabel, control.element);
    updatePreview();
    const apply = nativeButton("Apply", "primary").button;
    apply.addEventListener("click", () => {
      if (!control.valid()) return;
      setColor(row.key, draft);
      current.close();
    });
    const { button: cancel } = nativeButton("Cancel");
    cancel.addEventListener("click", () => current.close());
    const actions = doc.createElement("div");
    actions.className = "codexdc-project-color-actions";
    actions.append(cancel, apply);
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "no-drag cursor-interaction leading-none hover:bg-primary-ghost-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 text-text/80 rounded p-1 absolute top-4 right-4";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => current.close());
    panel.append(heading, field, preview, actions, close);
    current.append(overlay, panel);
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
    const template = menu.querySelector("[role='menuitem']:not([aria-haspopup]):not([aria-disabled='true'])");
    const button = doc.createElement("div");
    button.className = `${template.className} codexdc-project-color-menu`;
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.setAttribute("data-orientation", "vertical");
    const content = doc.createElement("div");
    content.className = template.querySelector("[data-menu-row-content]").className;
    content.setAttribute("data-menu-row-content", "true");
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("class", "shrink-0 opacity-75 group-focus:opacity-100 group-hover:opacity-100");
    icon.innerHTML = '<path d="M8 1.5a6.5 6.5 0 1 0 0 13h1a1.5 1.5 0 0 0 1.1-2.5c-.4-.5 0-1.3.7-1.3h.7a3 3 0 0 0 3-3A6.3 6.3 0 0 0 8 1.5Z" fill="none" stroke="currentColor"/><g fill="currentColor"><circle cx="4.5" cy="6" r="1"/><circle cx="7" cy="4" r="1"/><circle cx="10" cy="4.5" r="1"/><circle cx="12" cy="7" r="1"/></g>';
    const label = doc.createElement("span");
    label.className = "flex-1 min-w-0 truncate";
    label.textContent = "Project color…";
    content.append(icon, label);
    button.append(content);
    button.addEventListener("pointermove", event => {
      if (event.pointerType === "mouse") button.focus();
    });
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
      if (active === button && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        button.click();
        return;
      }
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
        repaint();
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
        const setting = doc.createElement("div");
        setting.className = "codexdc-project-color-setting-row";
        const label = doc.createElement("span");
        // Preserve the display label but distinguish equal names in settings.
        label.textContent = row.label;
        label.title = row.header.getAttribute("data-app-action-sidebar-project-id");
        const value = colors[row.key] ?? "none";
        const control = colorControl(value, `Color for ${row.label}`, color => setColor(row.key, color, false));
        setting.append(label, control.element);
        root.append(setting);
      }
    }
  }
  function syncStorage(event) {
    if (event.key !== "codexpp:storage:local.project-colors") return;
    colors = api.storage.get(COLORS_KEY, {});
    tint = api.storage.get(TINT_KEY, true);
    repaint();
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
      for (const node of conversations.keys()) clearElement(node);
      style.remove();
      for (const root of settingsRoots) {
        root.replaceChildren();
        root.classList.remove("codexdc-project-color-settings");
      }
      settingsRoots.clear();
    },
  };
}

let controller;
module.exports = {
  start(api) {
    controller = api.process === "main"
      ? require("./native-picker.js").startPickerHost(api)
      : createProjectColors(api, document);
  },
  stop() { controller?.stop(); controller = null; },
  __test: { createProjectColors, automaticColor, conversationProject },
};
