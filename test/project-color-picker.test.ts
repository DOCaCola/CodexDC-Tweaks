import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const { discoverPicker, discoverDropdown, installPicker } = require("../tweaks/project-colors/native-picker.js");

test("Appearance dropdown discovery resolves the actual trigger and radio-menu exports", () => {
  const bundles = [
    {
      name: "general-settings-new.js",
      source: 'import{TriggerExport as B}from"./app-initial-new.js";'
        + 'import{MenuExport as M,DropdownExport as D}from"./app-shared-new.js";'
        + 'const id="settings.general.appearance.chromeTheme.accent";'
        + '(0,jsx.jsxs)(B,{"aria-label":label,color:`outlineSurface`});'
        + '(0,jsx.jsx)(M.RadioItem,{value:`custom`});'
        + '(0,jsx.jsx)(D,{align:`end`,contentWidth:`menu`,triggerButton:button});',
    },
    {
      name: "app-initial-new.js",
      source: 'function trigger(e){let t=(0,cache.c)(3);return e;}'
        + 'var cache;function initTrigger(){return(initTrigger=lazy((()=>{cache=runtime();})))()}'
        + 'export{trigger as TriggerExport,initTrigger as TriggerInitExport};',
    },
    {
      name: "app-shared-new.js",
      source: 'function dropdown(e){return e;}'
        + 'function initMenu(){return(initMenu=lazy((()=>{Menu={focusMenuItem:focus};})))()}'
        + 'export{Menu as MenuExport,dropdown as DropdownExport,initMenu as MenuInitExport};',
    },
    { name: "general-settings-unrelated.js", source: "unrelated settings" },
  ];
  assert.deepEqual(discoverDropdown(bundles), {
    initial: "/assets/app-initial-new.js", trigger: "TriggerExport", triggerInitialize: "TriggerInitExport",
    menu: "MenuExport", dropdown: "DropdownExport", menuInitialize: "MenuInitExport",
  });
  assert.throws(() => discoverDropdown([...bundles, bundles[0]]), /Unsupported Appearance dropdown modules/);
  assert.throws(() => discoverDropdown(bundles.map(bundle => bundle.name.startsWith("general-settings-new")
    ? { ...bundle, source: bundle.source.replace("color:`outlineSurface`", "color:`other`") } : bundle)),
    /Unsupported Appearance dropdown interface/);
});

test("settings picker discovery follows exports across changed bundle hashes and minified names", () => {
  const bundles = [
    {
      name: "dist-newhash.js",
      source: 'import{ReactExport as R}from"./app-shared-newhash.js";'
        + 'function init(){return(init=l((()=>{react=wrap(R(),1),'
        + 'component=function(e){return react.createElement(base,merge({},e,{colorModel:model}))};'
        + 'style=".react-colorful__saturation-pointer";})))()}'
        + 'export{init as initializeExport,component as componentExport};',
    },
    {
      name: "app-shared-newhash.js",
      source: "clientModule=c((e=>{e.createRoot=function(){};})),"
        + "client=c(((e,t)=>{function check(){hook.checkDCE(check)}check(),t.exports=clientModule()}));"
        + "export{client as ClientExport};",
    },
  ];
  assert.deepEqual(discoverPicker(bundles), {
    picker: "/assets/dist-newhash.js", shared: "/assets/app-shared-newhash.js",
    initialize: "initializeExport", component: "componentExport", react: "ReactExport", client: "ClientExport",
  });
  assert.throws(() => discoverPicker([...bundles, bundles[0]]), /Unsupported Codex color picker modules/);
  assert.throws(() => discoverPicker([{ ...bundles[0], source: bundles[0].source.replace("component as componentExport", "other as componentExport") }, bundles[1]]),
    /Unsupported Codex color picker export/);
});

test("native picker bridge mounts once, sends edits and unmounts removed or disabled controls", async () => {
  const dom = new JSDOM("<body><div data-codexdc-custom-picker data-codexdc-custom-value='#123456'></div></body>",
    { runScripts: "outside-only" });
  const win = dom.window;
  const configuration = { picker: "picker", shared: "shared", initialize: "init", component: "Picker", react: "React", client: "Client" };
  let mounts = 0;
  let unmounts = 0;
  let rendered: any;
  let changed = 0;
  const modules = {
    picker: { init() {}, Picker() {} },
    shared: {
      React: () => ({ createElement: (type: any, props: any) => ({ type, props }) }),
      Client: () => ({ createRoot() {
        mounts++;
        return { render(value: any) { rendered = value; }, unmount() { unmounts++; } };
      } }),
    },
  };
  const install = win.eval(`(${installPicker.toString()})`);
  try {
    await install(configuration, true, async (url: keyof typeof modules) => modules[url]);
    const picker = win.document.querySelector("[data-codexdc-custom-picker]")!;
    picker.addEventListener("codexdc:project-custom-color", () => { changed++; });
    const request = async () => {
      picker.dispatchEvent(new win.Event("codexdc:project-color-picker", { bubbles: true }));
      await new Promise(resolve => win.setTimeout(resolve, 0));
    };
    await request();
    await request();
    assert.equal(mounts, 1);
    assert.equal(rendered.type, modules.picker.Picker);
    assert.equal(rendered.props.color, "#123456");
    rendered.props.onChange("#AA33BB");
    assert.equal(changed, 1);
    assert.equal(picker.getAttribute("data-codexdc-custom-value"), "#aa33bb");
    picker.remove();
    await new Promise(resolve => win.setTimeout(resolve, 0));
    assert.equal(unmounts, 1);
    win.document.body.append(picker);
    await request();
    assert.equal(mounts, 2);
    await install(configuration, false);
    assert.equal(unmounts, 2);
    await request();
    assert.equal(mounts, 2);
  } finally { dom.window.close(); }
});

test("native picker bridge does not mount after an async load is disabled", async () => {
  const dom = new JSDOM("<body><div data-codexdc-custom-picker></div></body>", { runScripts: "outside-only" });
  const install = dom.window.eval(`(${installPicker.toString()})`);
  let finish: any;
  const pending = new Promise(resolve => { finish = resolve; });
  try {
    await install({ picker: "picker", shared: "shared" }, true, () => pending);
    const picker = dom.window.document.querySelector("div")!;
    picker.dispatchEvent(new dom.window.Event("codexdc:project-color-picker", { bubbles: true }));
    await install({}, false);
    finish({});
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(picker.hasAttribute("data-codexdc-picker-state"), false);
  } finally { dom.window.close(); }
});

test("native dropdown bridge sends selections, preserves its root and uses the dialog portal", async () => {
  const dom = new JSDOM('<body><dialog><div data-codexdc-color-select data-codexdc-color-value="none" aria-label="Project color"></div></dialog></body>',
    { runScripts: "outside-only" });
  const node = dom.window.document.querySelector("[data-codexdc-color-select]")!;
  node.setAttribute("data-codexdc-color-options", JSON.stringify([["none", "None", null], ["custom", "Custom…", null]]));
  let mounts = 0;
  let unmounts = 0;
  let tree: any;
  let selections = 0;
  const Menu = { Section: "Section", RadioGroup: "RadioGroup", RadioItem: "RadioItem" };
  const modules = {
    initial: { init() {}, Trigger: "NativeTrigger" },
    shared: {
      initMenu() {}, Menu, Dropdown: "NativeDropdown",
      React: () => ({
        createElement(type: any, props: any, ...children: any[]) {
          if (typeof type === "function") return type(props);
          return { type, props, children };
        },
        useState: (value: any) => [value, () => {}],
        useEffect: (callback: any) => callback(),
      }),
      Client: () => ({ createRoot() {
        mounts++;
        return { render(value: any) { tree = value; }, unmount() { unmounts++; } };
      } }),
    },
  };
  const configuration = {
    shared: "shared", react: "React", client: "Client",
    dropdown: { initial: "initial", triggerInitialize: "init", trigger: "Trigger",
      menuInitialize: "initMenu", menu: "Menu", dropdown: "Dropdown" },
  };
  const install = dom.window.eval(`(${installPicker.toString()})`);
  try {
    await install(configuration, true, async (url: keyof typeof modules) => modules[url]);
    node.addEventListener("codexdc:project-color-selection", () => { selections++; });
    async function request() {
      node.dispatchEvent(new dom.window.Event("codexdc:project-color-select", { bubbles: true }));
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    }
    await request();
    assert.equal(tree.type, "NativeDropdown");
    assert.equal(tree.props.triggerButton.type, "NativeTrigger");
    assert.equal(tree.props.triggerButton.props.radius, "full");
    assert.equal(tree.props.portalContainer, node.closest("dialog"));
    const custom = tree.children[0].children[0].children[0][1];
    custom.props.onSelect();
    assert.equal(node.getAttribute("data-codexdc-color-value"), "custom");
    assert.equal(selections, 0, "Dispatch after the native menu restores focus");
    await new Promise(resolve => dom.window.setTimeout(resolve, 0));
    assert.equal(selections, 1);
    await request();
    assert.equal(mounts, 1);
    assert.equal(tree.children[0].children[0].props.value, "custom");
    await install({}, false);
    assert.equal(unmounts, 1);
  } finally { dom.window.close(); }
});
