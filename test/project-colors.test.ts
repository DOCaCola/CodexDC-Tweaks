import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { createProjectColors, automaticColor } = require("../tweaks/project-colors/index.js").__test;
const colorAttr = "data-codexdc-project-color";
const titleAttr = "data-codexdc-project-color-header";
const key = (id: string, kind = "local") => JSON.stringify([kind, id]);

function project(doc: Document, id: string, name = "Same name", kind = "local") {
  const group = doc.createElement("div");
  group.setAttribute("role", "listitem");
  group.setAttribute("data-sidebar-project-kind", kind);
  const header = doc.createElement("div");
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("data-app-action-sidebar-project-row", "");
  header.setAttribute("data-app-action-sidebar-project-id", id);
  header.setAttribute("data-app-action-sidebar-project-label", name);
  header.innerHTML = `<span data-sidebar-project-drop-zone="project-icon"><svg></svg></span><span class="select-none"></span><button class="_Button_native_1" aria-label="More" aria-haspopup="menu"><span class="_ButtonInner_native_1"></span></button>`;
  header.querySelector(".select-none")!.textContent = name;
  group.append(header);
  return { group, header };
}

function setup(stored: Record<string, unknown> = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><aside data-app-action-sidebar-scroll></aside></body></html>", { pretendToBeVisual: true });
  const { document: doc } = dom.window;
  // jsdom has no native Popover implementation; test lifecycle separately from
  // the browser integration checks for positioning, light dismiss and Escape.
  function togglePopover(node: HTMLElement, state: string) {
    const event = new dom.window.Event("beforetoggle");
    Object.defineProperty(event, "newState", { value: state });
    node.dispatchEvent(event);
    node.toggleAttribute("data-test-popover-open", state === "open");
  }
  (dom.window.HTMLElement.prototype as any).showPopover = function() { togglePopover(this, "open"); };
  (dom.window.HTMLElement.prototype as any).hidePopover = function() { togglePopover(this, "closed"); };
  // A regression that reads layout while handling sidebar mutations fails here.
  dom.window.getComputedStyle = () => { throw new Error("Unexpected style measurement"); };
  dom.window.Element.prototype.getBoundingClientRect = () => { throw new Error("Unexpected layout measurement"); };
  let section: any;
  let unregistered = false;
  let scheduled = 0;
  const raf = dom.window.requestAnimationFrame.bind(dom.window);
  dom.window.requestAnimationFrame = callback => { scheduled++; return raf(callback); };
  const api = {
    react: { getFiber: (node: any) => node.testFiber ?? null },
    storage: {
      get: (name: string, fallback: unknown) => stored[name] ?? fallback,
      set: (name: string, value: unknown) => { stored[name] = value; },
    },
    settings: {
      register: (value: any) => { section = value; return { unregister() { unregistered = true; } }; },
    },
  };
  const sidebar = doc.querySelector("aside")!;
  const first = project(doc, "/work/one");
  sidebar.append(first.group);
  const controller = createProjectColors(api, doc);
  const settle = () => new Promise(resolve => dom.window.setTimeout(resolve, 30));
  const settings = () => {
    const root = doc.createElement("section");
    doc.body.append(root);
    section.render(root);
    return root;
  };
  const selectColor = (root: Element, color: string, index = 0) => {
    const select = root.querySelectorAll("[data-codexdc-color-select]")[index] as HTMLElement;
    select.setAttribute("data-codexdc-color-value", color);
    select.dispatchEvent(new dom.window.Event("codexdc:project-color-selection"));
  };
  const cleanup = () => { controller.stop(); dom.window.close(); };
  return { dom, doc, sidebar, first, controller, stored, settle, settings, selectColor, cleanup, scheduled: () => scheduled, unregistered: () => unregistered };
}

function activityThread(doc: Document, id: string, projectId: string | null, kind = "local") {
  const node = doc.createElement("div");
  node.setAttribute("data-app-action-sidebar-thread-row", "");
  node.setAttribute("data-app-action-sidebar-thread-id", id);
  node.innerHTML = '<span data-thread-title>Conversation</span><span>Running</span>';
  (node as any).testFiber = {
    memoizedProps: { secondaryContent: { props: {
      projectGroup: projectId == null ? null : { projectId, projectKind: kind },
    } } },
    return: null,
  };
  return node;
}

test("Activity conversations use project identities without needing mounted project headers", async () => {
  const h = setup({ projectColors: { [key("/work/one")]: "blue", [key("same", "remote")]: "pink" } });
  try {
    const local = activityThread(h.doc, "local:one", "/work/one");
    const remote = activityThread(h.doc, "local:two", "same", "remote");
    const collision = activityThread(h.doc, "local:three", "same");
    const projectless = activityThread(h.doc, "local:four", null);
    h.first.group.remove();
    h.sidebar.append(local, remote, collision, projectless);
    await h.settle();
    assert.equal(local.getAttribute(colorAttr), "blue");
    assert.equal(remote.getAttribute(colorAttr), "pink");
    assert.equal(collision.hasAttribute(colorAttr), false);
    assert.equal(projectless.hasAttribute(colorAttr), false);
    // A virtualized/reused row changes project while retaining the same node.
    (local as any).testFiber.memoizedProps.secondaryContent.props.projectGroup = { projectId: "same", projectKind: "remote" };
    local.setAttribute("data-app-action-sidebar-thread-id", "local:new");
    await h.settle();
    assert.equal(local.getAttribute(colorAttr), "pink");
    (local as any).testFiber.memoizedProps.secondaryContent.props.projectGroup = null;
    local.querySelector("[data-thread-title]")!.textContent = "Moved out of project";
    await h.settle();
    assert.equal(local.hasAttribute(colorAttr), false);
    h.controller.stop();
    assert.equal(remote.hasAttribute(colorAttr), false);
    assert.equal(remote.hasAttribute("data-codexdc-project-conversation-color"), false);
  } finally { h.dom.window.close(); }
});

test("custom hex colors persist, synchronize and remove their CSS when switching to a preset or None", async () => {
  const h = setup({ projectColors: { [key("/work/one")]: "#1256ab" } });
  try {
    const thread = activityThread(h.doc, "local:one", "/work/one");
    h.sidebar.append(thread);
    await h.settle();
    assert.equal(h.first.group.getAttribute(colorAttr), "custom");
    assert.equal(h.first.group.style.getPropertyValue("--codexdc-project-accent"), "#1256ab");
    assert.equal(thread.style.getPropertyValue("--codexdc-project-accent"), "#1256ab");
    const root = h.settings();
    assert.equal(root.querySelector("[data-codexdc-color-select]")!.getAttribute("data-codexdc-color-value"), "custom");
    const hex = root.querySelector(".codexdc-project-custom-hex") as HTMLInputElement;
    const picker = root.querySelector("[data-codexdc-custom-picker]")!;
    hex.value = "#AA3311";
    hex.dispatchEvent(new h.dom.window.Event("input"));
    assert.equal((h.stored.projectColors as any)[key("/work/one")], "#aa3311");
    assert.equal(root.querySelector("[data-codexdc-custom-picker]"), picker, "Dragging must keep the picker mounted");
    hex.value = "invalid";
    hex.dispatchEvent(new h.dom.window.Event("input"));
    assert.equal(hex.checkValidity(), false);
    assert.equal((h.stored.projectColors as any)[key("/work/one")], "#aa3311");
    picker.setAttribute("data-codexdc-custom-value", "#123456");
    picker.dispatchEvent(new h.dom.window.Event("codexdc:project-custom-color"));
    assert.equal(hex.value, "#123456");
    assert.equal(hex.checkValidity(), true);
    assert.equal(thread.style.getPropertyValue("--codexdc-project-accent"), "#123456");
    h.stored.projectColors = { [key("/work/one")]: "#abcdef" };
    h.dom.window.dispatchEvent(new h.dom.window.StorageEvent("storage", { key: "codexpp:storage:local.project-colors" }));
    assert.equal(thread.style.getPropertyValue("--codexdc-project-accent"), "#abcdef");
    h.selectColor(root, "green");
    assert.equal(thread.getAttribute(colorAttr), "green");
    assert.equal(thread.style.getPropertyValue("--codexdc-project-accent"), "");
    h.selectColor(root, "none");
    assert.equal(thread.hasAttribute(colorAttr), false);
    assert.equal(h.first.group.style.getPropertyValue("--codexdc-project-accent"), "");
    h.selectColor(root, "custom");
    h.controller.stop();
    assert.equal(root.childElementCount, 0);
    assert.equal(root.classList.contains("codexdc-project-color-settings"), false);
  } finally { h.cleanup(); }
});

test("Custom in settings creates a picker and preserves Activity tint and Auto preferences", async () => {
  const h = setup();
  try {
    const thread = activityThread(h.doc, "local:one", "/work/one");
    h.sidebar.append(thread);
    await h.settle();
    const root = h.settings();
    h.selectColor(root, "custom");
    assert.equal(root.querySelectorAll("[data-codexdc-custom-picker]").length, 1);
    const trigger = root.querySelector(".codexdc-project-custom-trigger")!;
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const popup = root.querySelector("[popover]")!;
    assert.equal(popup.getAttribute("role"), "dialog");
    thread.querySelector("[data-thread-title]")!.textContent = "Still running";
    await h.settle();
    assert.equal(root.querySelector("[popover]"), popup, "Activity changes must preserve the open color popup");
    assert.equal(thread.getAttribute(colorAttr), "custom");
    const checkbox = root.querySelector("input[type=checkbox]")! as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new h.dom.window.Event("change"));
    assert.equal(thread.hasAttribute("data-codexdc-project-tint"), false);
    h.selectColor(root, "auto");
    assert.equal(thread.getAttribute(colorAttr), automaticColor(key("/work/one")));
    assert.equal(thread.style.getPropertyValue("--codexdc-project-accent"), "");
    thread.remove();
    await h.settle();
    assert.equal(thread.hasAttribute(colorAttr), false);
  } finally { h.cleanup(); }
});

test("project colors persist by identity across equal labels, renames and remounts", async () => {
  const h = setup();
  try {
    const second = project(h.doc, "/work/two");
    h.sidebar.append(second.group);
    await h.settle();
    const root = h.settings();
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.equal(h.first.group.hasAttribute("data-codexdc-project-tint"), false);
    assert.equal(h.first.header.hasAttribute(titleAttr), false);
    assert.equal(root.querySelector("[data-codexdc-color-select]")!.getAttribute("data-codexdc-color-value"), "none");
    h.selectColor(root, "purple");
    assert.equal(h.first.group.getAttribute(colorAttr), "purple");
    assert.equal(second.group.hasAttribute(colorAttr), false);
    h.first.header.setAttribute("data-app-action-sidebar-project-label", "Renamed");
    await h.settle();
    assert.equal(h.first.group.getAttribute(colorAttr), "purple");
    assert.equal(root.querySelector("[data-codexdc-color-select]")!.getAttribute("aria-label"), "Color for Renamed");
    h.first.group.remove();
    const remounted = project(h.doc, "/work/one", "Renamed");
    h.sidebar.append(remounted.group);
    await h.settle();
    assert.equal(remounted.group.getAttribute(colorAttr), "purple");
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.deepEqual(h.stored.projectColors, { [key("/work/one")]: "purple" });
    const local = project(h.doc, "shared-id", "Shared", "local");
    const remote = project(h.doc, "shared-id", "Shared", "remote");
    h.sidebar.append(local.group, remote.group);
    await h.settle();
    h.selectColor(root, "red", 3);
    assert.equal(remote.group.getAttribute(colorAttr), "red");
    assert.equal(local.group.hasAttribute(colorAttr), false);
  } finally { h.cleanup(); }
});

test("explicit Auto, None, background preference and cross-window storage preserve other projects", async () => {
  const h = setup();
  try {
    await h.settle();
    const root = h.settings();
    h.stored.projectColors = { [key("/other")]: "green" };
    h.selectColor(root, "blue");
    assert.deepEqual(h.stored.projectColors, { [key("/other")]: "green", [key("/work/one")]: "blue" });
    h.selectColor(root, "auto");
    assert.deepEqual(h.stored.projectColors, { [key("/other")]: "green", [key("/work/one")]: "auto" });
    assert.equal(h.first.group.getAttribute(colorAttr), automaticColor(key("/work/one")));
    h.selectColor(root, "none");
    assert.deepEqual(h.stored.projectColors, { [key("/other")]: "green" });
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.equal(h.first.group.hasAttribute("data-codexdc-project-tint"), false);
    assert.equal(h.first.header.hasAttribute(titleAttr), false);
    h.selectColor(root, "auto");
    const checkbox = root.querySelector("input")!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new h.dom.window.Event("change"));
    assert.equal(h.first.group.hasAttribute("data-codexdc-project-tint"), false);
    assert.equal(h.stored.tintBackgrounds, false);
    h.stored.projectColors = { [key("/work/one")]: "pink" };
    h.dom.window.dispatchEvent(new h.dom.window.StorageEvent("storage", { key: "codexpp:storage:local.project-colors" }));
    assert.equal(h.first.group.getAttribute(colorAttr), "pink");
    assert.equal(root.querySelector("[data-codexdc-color-select]")!.getAttribute("data-codexdc-color-value"), "pink");
  } finally { h.cleanup(); }
});

test("animation churn and conversation inserts schedule no color work or layout reads", async () => {
  const h = setup({ projectColors: { [key("/work/one")]: "auto" } });
  try {
    await h.settle();
    const initial = h.scheduled();
    for (let i = 0; i < 100; i++) {
      h.first.group.style.height = `${i}px`;
      h.first.header.className = `animation-${i}`;
      h.first.header.setAttribute("aria-expanded", String(i % 2 === 0));
      h.first.header.setAttribute("data-app-action-sidebar-project-collapsed", String(i % 2 === 0));
      const thread = h.doc.createElement("div");
      thread.setAttribute("data-app-action-sidebar-thread-row", "");
      h.first.group.append(thread);
    }
    await h.settle();
    assert.equal(h.scheduled(), initial);
    assert.equal(h.first.header.hasAttribute(titleAttr), true);
  } finally { h.cleanup(); }
});

test("sidebar replacement, changing identity and stop clean up all owned DOM", async () => {
  const h = setup({ projectColors: { [key("/work/one")]: "red", [key("/new")]: "yellow" } });
  try {
    await h.settle();
    h.first.header.setAttribute("data-app-action-sidebar-project-id", "/new");
    await h.settle();
    assert.equal(h.first.group.getAttribute(colorAttr), "yellow");
    h.sidebar.remove();
    const root = h.doc.createElement("aside");
    root.setAttribute("data-app-action-sidebar-scroll", "");
    const next = project(h.doc, "/work/one");
    root.append(next.group);
    h.doc.body.append(root);
    await h.settle();
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.equal(next.group.getAttribute(colorAttr), "red");
    h.controller.stop();
    assert.equal(h.unregistered(), true);
    assert.equal(next.group.hasAttribute(colorAttr), false);
    assert.equal(next.header.hasAttribute(titleAttr), false);
    assert.equal(h.doc.querySelector("#codexdc-project-colors-style"), null);
    const later = project(h.doc, "/later");
    root.append(later.group);
    await h.settle();
    assert.equal(later.group.hasAttribute(colorAttr), false);
  } finally { h.dom.window.close(); }
});

test("project menu opens an accessible color dialog and native menu closes through Escape", async () => {
  const h = setup();
  try {
    // jsdom does not implement the browser's top-layer dialog methods.
    h.dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    h.dom.window.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new h.dom.window.Event("close"));
    };
    await h.settle();
    h.first.header.dispatchEvent(new h.dom.window.MouseEvent("contextmenu", { bubbles: true }));
    const menu = h.doc.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    menu.innerHTML = '<div class="native-menu-row cursor-interaction" role="menuitem"><div class="native-menu-content" data-menu-row-content>Rename</div></div>';
    let escaped = false;
    menu.addEventListener("keydown", event => { escaped = event.key === "Escape"; });
    h.doc.body.append(menu);
    await h.settle();
    const item = menu.querySelector(".codexdc-project-color-menu")! as HTMLElement;
    assert.equal(item.getAttribute("role"), "menuitem");
    assert.equal(item.classList.contains("native-menu-row"), true);
    assert.equal(item.querySelector("[data-menu-row-content]")!.className, "native-menu-content");
    item.click();
    await h.settle();
    assert.equal(escaped, true);
    const dialog = h.doc.querySelector("dialog")!;
    assert.equal(dialog.getAttribute("aria-labelledby"), "codexdc-project-color-title");
    assert.equal(dialog.getAttribute("aria-describedby"), "codexdc-project-color-description");
    assert.equal(dialog.querySelectorAll(".codex-dialog-overlay").length, 1);
    assert.equal(dialog.querySelectorAll(".codex-dialog").length, 1);
    assert.equal(dialog.querySelector("[data-codexdc-color-select]")!.getAttribute("data-codexdc-color-value"), "none");
    const preview = dialog.querySelector(".codexdc-project-color-preview")!;
    assert.equal(preview.getAttribute("aria-label"), "Color preview");
    h.selectColor(dialog, "green");
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.equal(preview.querySelectorAll(`[${colorAttr}="green"]`).length, 2);
    const apply = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Apply")!;
    assert.equal(apply.classList.contains("_Button_native_1"), true);
    assert.equal(apply.getAttribute("data-variant"), "soft");
    apply.click();
    assert.equal(h.first.group.getAttribute(colorAttr), "green");
    assert.equal(h.doc.querySelector("dialog"), null);
    h.controller.stop();
    assert.equal(menu.querySelector(".codexdc-project-color-menu"), null);
  } finally { h.dom.window.close(); }
});

test("overflow menu pointerdown is captured before mount and joins the native keyboard loop", async () => {
  const h = setup();
  try {
    await h.settle();
    h.first.header.querySelector("button")!.dispatchEvent(new h.dom.window.Event("pointerdown", { bubbles: true }));
    const menu = h.doc.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    menu.innerHTML = '<button role="menuitem"><div data-menu-row-content>Rename</div></button><button role="menuitem"><div data-menu-row-content>Archive</div></button>';
    h.doc.body.append(menu);
    await h.settle();
    const native = menu.querySelectorAll("button");
    const custom = menu.querySelector(".codexdc-project-color-menu")! as HTMLElement;
    (native[1] as HTMLButtonElement).focus();
    native[1].dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.equal(h.doc.activeElement, custom);
    custom.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.equal(h.doc.activeElement, native[0]);
    native[0].dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    assert.equal(h.doc.activeElement, custom);
    custom.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    assert.equal(h.doc.activeElement, native[1]);
    h.first.header.removeAttribute("data-app-action-sidebar-project-row");
    await h.settle();
    assert.equal(h.first.group.hasAttribute(colorAttr), false);
    assert.equal(h.first.header.hasAttribute(titleAttr), false);
  } finally { h.cleanup(); }
});

test("project menu dropdown previews custom drafts in a popup and Cancel preserves the selection", async () => {
  const h = setup();
  try {
    await h.settle();
    (h.dom.window.HTMLDialogElement.prototype as any).showModal = function() { this.open = true; };
    (h.dom.window.HTMLDialogElement.prototype as any).close = function() {
      this.open = false;
      this.dispatchEvent(new h.dom.window.Event("close"));
    };
    async function open() {
      h.first.header.dispatchEvent(new h.dom.window.MouseEvent("contextmenu", { bubbles: true }));
      const menu = h.doc.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("data-state", "open");
      menu.innerHTML = '<button role="menuitem"><div data-menu-row-content>Rename</div></button>';
      h.doc.body.append(menu);
      await h.settle();
      (menu.querySelector(".codexdc-project-color-menu") as HTMLElement).click();
      await h.settle();
      const dialog = h.doc.querySelector("dialog")!;
      h.selectColor(dialog, "custom");
      return dialog;
    }
    const dialog = await open();
    const hex = dialog.querySelector(".codexdc-project-custom-hex") as HTMLInputElement;
    const popup = dialog.querySelector(".codexdc-project-custom-popup")!;
    const trigger = dialog.querySelector(".codexdc-project-custom-trigger")!;
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(popup.getAttribute("popover"), "auto");
    hex.value = "#7654AB";
    hex.dispatchEvent(new h.dom.window.Event("input"));
    assert.equal(h.first.group.hasAttribute(colorAttr), false, "Drafts should not save before Apply");
    const preview = dialog.querySelector(".codexdc-project-color-preview")!;
    for (const sample of preview.querySelectorAll(`[${colorAttr}]`)) {
      assert.equal(sample.getAttribute(colorAttr), "custom");
      assert.equal((sample as HTMLElement).style.getPropertyValue("--codexdc-project-accent"), "#7654ab");
    }
    ([...popup.querySelectorAll("button")].find(button => button.textContent === "Done")!).click();
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(h.doc.querySelector("dialog"), dialog);
    ([...dialog.querySelectorAll("button")].find(button => button.textContent === "Apply")!).click();
    assert.equal((h.stored.projectColors as any)[key("/work/one")], "#7654ab");
    assert.equal(h.doc.querySelector("dialog"), null);
    const reopened = await open();
    assert.equal((reopened.querySelector(".codexdc-project-custom-hex") as HTMLInputElement).value, "#7654ab");
    h.selectColor(reopened, "red");
    ([...reopened.querySelectorAll("button")].find(button => button.textContent === "Cancel")!).click();
    assert.equal((h.stored.projectColors as any)[key("/work/one")], "#7654ab");
  } finally { h.cleanup(); }
});

test("dialog preview shares Auto and tint styling, resets None, and blocks invalid custom input", async () => {
  const h = setup({ tintBackgrounds: false });
  try {
    h.dom.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
    h.dom.window.HTMLDialogElement.prototype.close = function() { this.dispatchEvent(new h.dom.window.Event("close")); };
    await h.settle();
    h.first.header.dispatchEvent(new h.dom.window.MouseEvent("contextmenu", { bubbles: true }));
    const menu = h.doc.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    menu.innerHTML = '<button role="menuitem"><div data-menu-row-content>Rename</div></button>';
    h.doc.body.append(menu);
    await h.settle();
    (menu.querySelector(".codexdc-project-color-menu") as HTMLElement).click();
    await h.settle();
    const dialog = h.doc.querySelector("dialog")!;
    const preview = dialog.querySelector(".codexdc-project-color-preview")!;
    h.selectColor(dialog, "auto");
    assert.equal(preview.querySelectorAll(`[${colorAttr}="${automaticColor(key("/work/one"))}"]`).length, 2);
    assert.equal(preview.querySelector("[data-codexdc-project-tint]"), null);
    h.selectColor(dialog, "none");
    assert.equal(preview.querySelector(`[${colorAttr}]`), null);
    h.selectColor(dialog, "custom");
    const hex = dialog.querySelector(".codexdc-project-custom-hex")! as HTMLInputElement;
    hex.value = "#bad";
    hex.dispatchEvent(new h.dom.window.Event("input"));
    ([...dialog.querySelectorAll("button")].find(button => button.textContent === "Apply")!).click();
    assert.equal(h.doc.querySelector("dialog"), dialog);
    assert.equal(h.stored.projectColors, undefined);
    assert.equal(dialog.querySelector(".codexdc-project-custom-trigger")!.getAttribute("aria-expanded"), "true");
    h.controller.stop();
    assert.equal(h.doc.querySelector(".codexdc-project-custom-popup"), null);
  } finally { h.dom.window.close(); }
});
