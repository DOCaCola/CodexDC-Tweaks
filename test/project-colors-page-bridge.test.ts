import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { installPageBridge } = require("../tweaks/project-colors/page-bridge.js");

// A page-shaped Rspack runtime: React and react-dom/client are loaded, while
// Appearance settings and the color picker arrive through a lazy import.
function fakeRuntime({ React, Client, site = true }: { React: any, Client: any, site?: boolean }) {
  const Menu = { Section: "Section", RadioGroup: "RadioGroup", RadioItem: "RadioItem" };
  const Picker = () => null;
  const chunks: unknown[] = [];
  const lazy = {
    settings: 'settingsId(e,t,a){a.d(t,{$I:()=>y,GeneralSettings:()=>x});var n=a("jsx"),eH=a("button"),J=a("menu"),e5=a("colorful");'
      + 'function x(){(0,n.jsx)(eH.vg,{"aria-label":c,className:"w-44",color:"outlineSurface",radius:"full",children:a});'
      + '(0,n.jsxs)(eH.vg,{"aria-label":j,className:"w-full",color:"outlineSurface",radius:"full",children:[a,s]});'
      + '(0,n.jsx)(J.ms.RadioItem,{value:"custom",onSelect:l});(0,n.jsx)(J.Ab,{align:"end",contentWidth:"menu",triggerButton:i})}}',
    colorful: 'colorful(e,t,r){var n=r("react");function o(){}var D=1,N={};let P=function(e){return n.createElement(D,o({},e,{colorModel:N}))};'
      + 'r.d(t,{jI:()=>P});".react-colorful__saturation-pointer"}',
  };
  const exports: Record<string, unknown> = { button: { vg: "NativeTrigger" }, menu: { ms: Menu, Ab: "NativeDropdown" }, colorful: { jI: Picker } };
  const source = (text: string) => ({ toString: () => text });
  const runtime: any = (id: string) => exports[id];
  runtime.m = {
    unrelated: source("unrelated(e,t,n){n.e(1)}"),
    loader: source(site
      ? 'loader(e,t,n){let s=l(async()=>(await Promise.all([n.e(11),n.e("settings-chunk")]).then(n.bind(n,"settingsId"))).GeneralSettings)}'
      : "loader(e,t,n){}"),
  };
  runtime.c = { react: { exports: React }, reactAlias: { exports: React }, client: { exports: Client }, other: { exports: {} } };
  runtime.e = async (chunk: unknown) => {
    chunks.push(chunk);
    runtime.m.settingsId = source(lazy.settings);
    runtime.m.colorful = source(lazy.colorful);
  };
  return { runtime, chunks, Menu, Picker };
}

function page(body: string) {
  const dom = new JSDOM('<head><script type="module" src="https://app.test/entry.js"></script></head><body>' + body + "</body>",
    { runScripts: "outside-only" });
  const install = dom.window.eval("(" + installPageBridge.toString() + ")");
  const settle = () => new Promise(resolve => dom.window.setTimeout(resolve, 0));
  return { dom, install, settle };
}

test("native picker bridge loads Appearance modules once, sends edits and unmounts removed or disabled controls", async () => {
  const { dom, install, settle } = page("<div data-codexdc-custom-picker data-codexdc-custom-value='#123456'></div>");
  const win = dom.window;
  let mounts = 0;
  let unmounts = 0;
  let rendered: any;
  let changed = 0;
  const { runtime, chunks, Picker } = fakeRuntime({
    React: { createElement: (type: any, props: any) => ({ type, props }), useState() {}, version: "19.2.7" },
    Client: { createRoot() {
      mounts++;
      return { render(value: any) { rendered = value; }, unmount() { unmounts++; } };
    } },
  });
  const loads: string[] = [];
  try {
    await install(true, async (url: string) => { loads.push(url); return { __webpack_require__: runtime }; });
    const picker = win.document.querySelector("[data-codexdc-custom-picker]")!;
    picker.addEventListener("codexdc:project-custom-color", () => { changed++; });
    const request = async () => {
      picker.dispatchEvent(new win.Event("codexdc:project-color-picker", { bubbles: true }));
      await settle();
    };
    await request();
    await request();
    assert.deepEqual(chunks, [11, "settings-chunk"]);
    assert.deepEqual(loads, ["https://app.test/entry.js"]);
    assert.equal(picker.getAttribute("data-codexdc-picker-state"), "ready");
    assert.equal(mounts, 1);
    assert.equal(rendered.type, Picker);
    assert.equal(rendered.props.color, "#123456");
    rendered.props.onChange("#AA33BB");
    assert.equal(changed, 1);
    assert.equal(picker.getAttribute("data-codexdc-custom-value"), "#aa33bb");
    picker.remove();
    await settle();
    assert.equal(unmounts, 1);
    win.document.body.append(picker);
    await request();
    assert.equal(mounts, 2);
    await install(false);
    assert.equal(unmounts, 2);
    await request();
    assert.equal(mounts, 2);
  } finally { dom.window.close(); }
});

test("native picker bridge reports an unsupported build without a lazy Appearance import", async () => {
  const { dom, install, settle } = page("<div data-codexdc-custom-picker></div>");
  const { runtime } = fakeRuntime({
    React: { createElement() {}, useState() {}, version: "19.2.7" }, Client: { createRoot() {} }, site: false,
  });
  const error = dom.window.console.error;
  dom.window.console.error = () => {};
  try {
    await install(true, async () => ({ __webpack_require__: runtime }));
    const picker = dom.window.document.querySelector("div")!;
    picker.dispatchEvent(new dom.window.Event("codexdc:project-color-picker", { bubbles: true }));
    await settle();
    await settle();
    assert.equal(picker.getAttribute("data-codexdc-picker-state"), "error");
  } finally { dom.window.console.error = error; dom.window.close(); }
});

test("native picker bridge does not mount after an async load is disabled", async () => {
  const { dom, install, settle } = page("<div data-codexdc-custom-picker></div>");
  let finish: any;
  const pending = new Promise(resolve => { finish = resolve; });
  let mounts = 0;
  const { runtime } = fakeRuntime({
    React: { createElement() {}, useState() {}, version: "19.2.7" }, Client: { createRoot() { mounts++; } },
  });
  try {
    await install(true, () => pending);
    const picker = dom.window.document.querySelector("div")!;
    picker.dispatchEvent(new dom.window.Event("codexdc:project-color-picker", { bubbles: true }));
    await install(false);
    finish({ __webpack_require__: runtime });
    await settle();
    await settle();
    assert.equal(mounts, 0);
    assert.equal(picker.hasAttribute("data-codexdc-picker-state"), false);
  } finally { dom.window.close(); }
});

test("native dropdown bridge sends selections, preserves its root and uses the dialog portal", async () => {
  const { dom, install, settle } = page('<dialog><div data-codexdc-color-select data-codexdc-color-value="none" aria-label="Project color"></div></dialog>');
  const node = dom.window.document.querySelector("[data-codexdc-color-select]")!;
  node.setAttribute("data-codexdc-color-options", JSON.stringify([["none", "None", null], ["custom", "Custom…", null]]));
  let mounts = 0;
  let unmounts = 0;
  let tree: any;
  let selections = 0;
  const { runtime } = fakeRuntime({
    React: {
      createElement(type: any, props: any, ...children: any[]) {
        if (typeof type === "function") return type(props);
        return { type, props, children };
      },
      useState: (value: any) => [value, () => {}],
      useEffect: (callback: any) => callback(),
      version: "19.2.7",
    },
    Client: { createRoot() {
      mounts++;
      return { render(value: any) { tree = value; }, unmount() { unmounts++; } };
    } },
  });
  try {
    await install(true, async () => ({ __webpack_require__: runtime }));
    node.addEventListener("codexdc:project-color-selection", () => { selections++; });
    async function request() {
      node.dispatchEvent(new dom.window.Event("codexdc:project-color-select", { bubbles: true }));
      await settle();
    }
    await request();
    assert.equal(tree.type, "NativeDropdown");
    assert.equal(tree.props.triggerButton.type, "NativeTrigger");
    assert.equal(tree.props.triggerButton.props.radius, "full");
    assert.equal(tree.props.portalContainer, node.closest("dialog"));
    const custom = tree.children[0].children[0].children[0][1];
    assert.equal(custom.type, "RadioItem");
    custom.props.onSelect();
    assert.equal(node.getAttribute("data-codexdc-color-value"), "custom");
    assert.equal(selections, 0, "Dispatch after the native menu restores focus");
    await settle();
    assert.equal(selections, 1);
    await request();
    assert.equal(mounts, 1);
    assert.equal(tree.children[0].children[0].props.value, "custom");
    await install(false);
    assert.equal(unmounts, 1);
  } finally { dom.window.close(); }
});

// Fiber chains as React builds them above sidebar rows: Activity rows carry
// their project group; Recents and pinned rows reach the sidebar provider's
// home container map above their entry, beyond isolated-world snapshots.
test("page bridge answers thread projects from Activity groups and the sidebar's home containers", async () => {
  const { dom, install } = page("");
  const doc = dom.window.document;
  function row(id: string, fiber: any) {
    const node = doc.createElement("div");
    node.setAttribute("data-app-action-sidebar-thread-row", "");
    node.setAttribute("data-app-action-sidebar-thread-id", id);
    (node as any)["__reactFiber$test"] = fiber;
    doc.body.append(node);
    return node;
  }
  const homes = new dom.window.Map([
    ["pinned-id", "project:dokiq"], ["remote-id", "project:ssh"], ["chat-id", "chats"],
  ]);
  const provider = { memoizedProps: { homeContainerIdByThreadId: homes }, return: null };
  const below = (entry: any) => {
    let fiber: any = { memoizedProps: { homeContainerIdByThreadId: homes }, return: null };
    for (let depth = 0; depth < 80; depth++) fiber = { memoizedProps: { depth }, return: fiber };
    return { memoizedProps: {}, return: { memoizedProps: { entry }, return: fiber } };
  };
  const ask = (node: Element) => {
    node.dispatchEvent(new dom.window.Event("codexdc:project-color-thread"));
    return JSON.parse(node.getAttribute("data-codexdc-project-thread")!);
  };
  try {
    let announced = 0;
    doc.addEventListener("codexdc:project-colors-bridge", () => { announced++; });
    await install(true, async () => { throw new Error("Thread lookups load no modules"); });
    assert.equal(announced, 1);
    const activity = row("local:a", { memoizedProps: { secondaryContent: { props: { projectGroup: { projectId: "p", projectKind: "remote" } } } }, return: provider });
    const pinned = row("local:pinned", below({ kind: "local", key: "local:pinned", conversationId: "pinned-id" }));
    const remote = row("remote:r", below({ kind: "remote", key: "remote:r", task: { id: "remote-id" } }));
    const chat = row("local:chat", below({ kind: "local", key: "local:chat", conversationId: "chat-id" }));
    const pending = row("local:pending", below({ kind: "local", key: "local:pending", conversationId: null }));
    assert.deepEqual(ask(activity), ["remote", "p"]);
    assert.deepEqual(ask(pinned), [null, "dokiq"]);
    assert.deepEqual(ask(remote), [null, "ssh"]);
    assert.equal(ask(chat), null);
    assert.equal(ask(pending), null);
    await install(false);
    pinned.removeAttribute("data-codexdc-project-thread");
    pinned.dispatchEvent(new dom.window.Event("codexdc:project-color-thread"));
    assert.equal(pinned.hasAttribute("data-codexdc-project-thread"), false);
  } finally { dom.window.close(); }
});
