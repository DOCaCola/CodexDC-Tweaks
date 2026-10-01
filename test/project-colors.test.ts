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
  // A regression that reads layout while handling sidebar mutations fails here.
  dom.window.getComputedStyle = () => { throw new Error("Unexpected style measurement"); };
  dom.window.Element.prototype.getBoundingClientRect = () => { throw new Error("Unexpected layout measurement"); };
  let section: any;
  let unregistered = false;
  let scheduled = 0;
  const raf = dom.window.requestAnimationFrame.bind(dom.window);
  dom.window.requestAnimationFrame = callback => { scheduled++; return raf(callback); };
  const api = {
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
    const select = root.querySelectorAll("select")[index] as HTMLSelectElement;
    select.value = color;
    select.dispatchEvent(new dom.window.Event("change"));
  };
  const cleanup = () => { controller.stop(); dom.window.close(); };
  return { dom, doc, sidebar, first, controller, stored, settle, settings, selectColor, cleanup, scheduled: () => scheduled, unregistered: () => unregistered };
}

test("project colors persist by identity across equal labels, renames and remounts", async () => {
  const h = setup();
  try {
    const second = project(h.doc, "/work/two");
    h.sidebar.append(second.group);
    await h.settle();
    const root = h.settings();
    h.selectColor(root, "purple");
    assert.equal(h.first.group.getAttribute(colorAttr), "purple");
    assert.equal(second.group.getAttribute(colorAttr), automaticColor(key("/work/two")));
    h.first.header.setAttribute("data-app-action-sidebar-project-label", "Renamed");
    await h.settle();
    assert.equal(h.first.group.getAttribute(colorAttr), "purple");
    assert.equal(root.querySelector("select")!.getAttribute("aria-label"), "Color for Renamed");
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
    assert.equal(local.group.getAttribute(colorAttr), automaticColor(key("shared-id")));
  } finally { h.cleanup(); }
});

test("automatic reset, background preference and cross-window storage preserve other projects", async () => {
  const h = setup();
  try {
    await h.settle();
    const root = h.settings();
    h.stored.projectColors = { [key("/other")]: "green" };
    h.selectColor(root, "blue");
    assert.deepEqual(h.stored.projectColors, { [key("/other")]: "green", [key("/work/one")]: "blue" });
    h.selectColor(root, "auto");
    assert.deepEqual(h.stored.projectColors, { [key("/other")]: "green" });
    const checkbox = root.querySelector("input")!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new h.dom.window.Event("change"));
    assert.equal(h.first.group.hasAttribute("data-codexdc-project-tint"), false);
    assert.equal(h.stored.tintBackgrounds, false);
    h.stored.projectColors = { [key("/work/one")]: "pink" };
    h.dom.window.dispatchEvent(new h.dom.window.StorageEvent("storage", { key: "codexpp:storage:local.project-colors" }));
    assert.equal(h.first.group.getAttribute(colorAttr), "pink");
    assert.equal(root.querySelector("select")!.value, "pink");
  } finally { h.cleanup(); }
});

test("animation churn and conversation inserts schedule no color work or layout reads", async () => {
  const h = setup();
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
    const green = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Green")!;
    assert.equal(green.classList.contains("_Button_native_1"), true);
    assert.equal(green.getAttribute("data-variant"), "soft");
    green.click();
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
