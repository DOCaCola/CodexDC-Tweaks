"use strict";

// Reuse the installed Appearance settings' HexColorPicker in the page world.
// Discover module/export names from semantic source, never a build hash.
function exported(source, local) {
  const entries = source.slice(source.lastIndexOf("export{") + 7, source.lastIndexOf("};"))
    .split(",").map(entry => entry.trim().split(" as "));
  const matches = entries.filter(([name]) => name === local);
  if (matches.length !== 1) throw new Error(`Unsupported Codex color picker export: ${local}`);
  return matches[0][1] || matches[0][0];
}

function discoverPicker(bundles) {
  const picker = bundles.filter(bundle => bundle.source.includes(".react-colorful__saturation-pointer")
    && bundle.source.includes("colorModel:"));
  const shared = bundles.filter(bundle => bundle.name.startsWith("app-shared-"));
  if (picker.length !== 1 || shared.length !== 1) throw new Error("Unsupported Codex color picker modules");
  const { source } = picker[0];
  const reactImport = source.match(/import\{([^}]+)\}from["']\.\/(app-shared-[^"']+\.js)["']/);
  const reactLocal = source.match(/[$\w]+=[$\w]+\(([$\w]+)\(\),1\)/);
  const reactExport = reactImport?.[1].split(",").map(entry => entry.trim().split(" as "))
    .find(([, name]) => name === reactLocal?.[1])?.[0];
  const initialize = source.match(/function ([$\w]+)\(\)\{return\(\1=[$\w]+\(\(\(\)=>/)?.[1];
  const component = source.match(/([$\w]+)=function\(e\)\{return [^;]+colorModel:/)?.[1];
  const rootAt = shared[0].source.indexOf(".createRoot=function");
  const rootModule = [...shared[0].source.slice(0, rootAt).matchAll(/([$\w]+)=[$\w]+\(\([$\w]+=>/g)].at(-1)?.[1];
  const client = rootModule && shared[0].source.match(
    new RegExp("([$\\w]+)=[$\\w]+\\(\\(\\([^;]{0,800}?\\.exports=" + rootModule + "\\(\\)\\}\\)\\)"),
  )?.[1];
  if (!reactExport || !initialize || !component || !client) throw new Error("Unsupported Codex color picker interface");
  return {
    picker: `/assets/${picker[0].name}`,
    shared: `/assets/${shared[0].name}`,
    initialize: exported(source, initialize),
    component: exported(source, component),
    react: reactExport,
    client: exported(shared[0].source, client),
  };
}

function discoverDropdown(bundles) {
  const settings = bundles.filter(bundle => bundle.name.startsWith("general-settings-")
    && bundle.source.includes("settings.general.appearance.chromeTheme.accent"));
  const shared = bundles.find(bundle => bundle.name.startsWith("app-shared-"));
  const initial = bundles.find(bundle => bundle.name.startsWith("app-initial-"));
  if (settings.length !== 1 || !shared || !initial) throw new Error("Unsupported Appearance dropdown modules");
  const source = settings[0].source;
  const trigger = source.match(/\(0,[$\w]+\.jsxs\)\(([$\w]+),\{"aria-label":[^}]+color:`outlineSurface`/)?.[1];
  const menu = source.match(/\(0,[$\w]+\.jsx\)\(([$\w]+)\.RadioItem,\{value:`custom`/)?.[1];
  const dropdown = source.match(/\(0,[$\w]+\.jsx\)\(([$\w]+),\{align:`end`,contentWidth:`menu`,triggerButton:/)?.[1];
  function imported(local, bundle) {
    const imports = [...source.matchAll(/import\{([^}]+)\}from["']\.\/([^"']+)["']/g)];
    return imports.filter(match => match[2] === bundle.name)
      .flatMap(match => match[1].split(",").map(entry => entry.trim().split(" as ")))
      .find(([, alias]) => alias === local)?.[0];
  }
  function localName(bundle, name) {
    return bundle.source.slice(bundle.source.lastIndexOf("export{") + 7, bundle.source.lastIndexOf("};"))
      .split(",").map(entry => entry.trim().split(" as ")).find(([local, alias]) => (alias || local) === name)?.[0];
  }
  const triggerExport = imported(trigger, initial);
  const menuExport = imported(menu, shared);
  const dropdownExport = imported(dropdown, shared);
  const menuLocal = localName(shared, menuExport);
  const menuAt = shared.source.indexOf(`${menuLocal}={focusMenuItem:`);
  const menuInitialize = [...shared.source.slice(0, menuAt).matchAll(/function ([$\w]+)\(\)\{return\(\1=/g)].at(-1)?.[1];
  const triggerLocal = localName(initial, triggerExport);
  const triggerAt = initial.source.indexOf(`function ${triggerLocal}(`);
  const cache = initial.source.slice(triggerAt).match(/let [$\w]+=\(0,([$\w]+)\.c\)/)?.[1];
  const initializerAt = initial.source.indexOf(`var ${cache}`, triggerAt);
  const triggerInitialize = initial.source.slice(initializerAt).match(/function ([$\w]+)\(\)\{return\(\1=/)?.[1];
  if (!triggerExport || !menuExport || !dropdownExport || !menuInitialize || !triggerInitialize) {
    throw new Error("Unsupported Appearance dropdown interface");
  }
  return {
    initial: `/assets/${initial.name}`, trigger: triggerExport,
    triggerInitialize: exported(initial.source, triggerInitialize),
    menu: menuExport, dropdown: dropdownExport,
    menuInitialize: exported(shared.source, menuInitialize),
  };
}

// Serialized by the host into the main JavaScript world. Keep self-contained.
async function installPicker(configuration, enabled, loadModule = url => import(url)) {
  const key = "__codexdcProjectColorPicker__";
  const existing = globalThis[key];
  existing?.stop();
  delete globalThis[key];
  if (!enabled) return;
  const roots = new Map();
  let active = true;
  let modules;
  let dropdownModules;
  const observer = new MutationObserver(() => {
    for (const [node, { root }] of roots) {
      if (!node.isConnected) { root.unmount(); roots.delete(node); }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const onRequest = async event => {
    const node = event.target;
    if (!(node instanceof Element) || !node.matches("[data-codexdc-custom-picker], [data-codexdc-color-select]")) return;
    try {
      if (node.matches("[data-codexdc-color-select]")) {
        dropdownModules ??= Promise.all([loadModule(configuration.dropdown.initial), loadModule(configuration.shared)]);
        const [initial, shared] = await dropdownModules;
        if (!active || !node.isConnected) return;
        const config = configuration.dropdown;
        initial[config.triggerInitialize]();
        shared[config.menuInitialize]();
        const React = shared[configuration.react]();
        const client = shared[configuration.client]();
        const Menu = shared[config.menu];
        function Dropdown({ value }) {
          const [selection, setSelection] = React.useState(value);
          React.useEffect(() => { setSelection(value); }, [value]);
          const options = JSON.parse(node.getAttribute("data-codexdc-color-options"));
          const chosen = options.find(option => option[0] === selection);
          const swatch = color => color && React.createElement("span", {
            className: "size-3 shrink-0 rounded-full border border-default",
            style: { backgroundColor: color }, "aria-hidden": true,
          });
          const trigger = React.createElement(initial[config.trigger], {
            "aria-label": node.getAttribute("aria-label"), color: "outlineSurface", radius: "full", size: "menuRow",
            className: "w-full max-w-36 max-sm:max-w-none",
          }, swatch(chosen?.[2]), chosen?.[1]);
          return React.createElement(shared[config.dropdown], {
            align: "end", contentWidth: "menu", triggerButton: trigger,
            portalContainer: node.closest("dialog") ?? document.body,
          }, React.createElement(Menu.Section, null,
            React.createElement(Menu.RadioGroup, { value: selection }, options.map(([id, label, color]) =>
              React.createElement(Menu.RadioItem, {
                key: id, value: id,
                onSelect() {
                  setSelection(id);
                  node.setAttribute("data-codexdc-color-value", id);
                  // Let the native menu finish closing and restoring focus
                  // before the renderer opens the custom-color popover.
                  setTimeout(() => {
                    if (active && node.isConnected) node.dispatchEvent(new Event("codexdc:project-color-selection", { bubbles: true }));
                  }, 0);
                },
              }, React.createElement("span", { className: "flex items-center gap-2" }, swatch(color), label)),
            )),
          ));
        }
        // Preserve the component identity across requests and external updates.
        let entry = roots.get(node);
        if (!entry) {
          entry = { root: client.createRoot(node), component: Dropdown };
          roots.set(node, entry);
        }
        entry.root.render(React.createElement(entry.component, { value: node.getAttribute("data-codexdc-color-value") }));
        node.setAttribute("data-codexdc-picker-state", "ready");
        return;
      }
      modules ??= Promise.all([loadModule(configuration.picker), loadModule(configuration.shared)]);
      const [picker, shared] = await modules;
      if (!active || !node.isConnected) return;
      picker[configuration.initialize]();
      const React = shared[configuration.react]();
      const client = shared[configuration.client]();
      let entry = roots.get(node);
      if (!entry) { entry = { root: client.createRoot(node) }; roots.set(node, entry); }
      const root = entry.root;
      root.render(React.createElement(picker[configuration.component], {
        color: node.getAttribute("data-codexdc-custom-value"),
        className: "codexdc-project-custom-picker",
        onChange(color) {
          node.setAttribute("data-codexdc-custom-value", color.toLowerCase());
          node.dispatchEvent(new Event("codexdc:project-custom-color", { bubbles: true }));
        },
      }));
      node.setAttribute("data-codexdc-picker-state", "ready");
    } catch (error) {
      console.error("[project-colors] Settings color picker failed", error);
      node.setAttribute("data-codexdc-picker-state", "error");
    }
  };
  document.addEventListener("codexdc:project-color-picker", onRequest);
  document.addEventListener("codexdc:project-color-select", onRequest);
  globalThis[key] = {
    stop() {
      active = false;
      observer.disconnect();
      document.removeEventListener("codexdc:project-color-picker", onRequest);
      document.removeEventListener("codexdc:project-color-select", onRequest);
      for (const { root } of roots.values()) root.unmount();
      roots.clear();
    },
  };
}

function startPickerHost(api) {
  const { readFileSync, readdirSync } = require("node:fs");
  const { join } = require("node:path");
  const { app, webContents } = require("electron");
  const assets = join(app.getAppPath(), "webview", "assets");
  const bundles = readdirSync(assets).filter(name => name.endsWith(".js")
    && (name.startsWith("dist-") || name.startsWith("app-shared-")
      || name.startsWith("app-initial-") || name.startsWith("general-settings-")))
    .map(name => ({ name, source: readFileSync(join(assets, name), "utf8") }));
  const configuration = { ...discoverPicker(bundles), dropdown: discoverDropdown(bundles) };
  const pages = new Map();
  const queues = globalThis[Symbol.for("codexdc.project-colors.picker-queues")] ??= new Map();
  let active = true;
  function configure(contents, enabled) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (contents.isDestroyed() || (enabled && !active)
        || !/^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(contents.getURL())) return;
      return contents.executeJavaScript(`(${installPicker})(${JSON.stringify(configuration)},${enabled})`);
    })
      .catch(error => api.log.error("Settings color picker bridge failed", error));
    queues.set(contents, next);
    return next;
  }
  function attach(contents) {
    if (pages.has(contents)) return;
    const ready = () => { if (active) void configure(contents, true); };
    pages.set(contents, ready);
    contents.on("dom-ready", ready);
    contents.once("destroyed", () => { pages.delete(contents); queues.delete(contents); });
    ready();
  }
  const created = (_event, contents) => attach(contents);
  app.on("web-contents-created", created);
  for (const contents of webContents.getAllWebContents()) attach(contents);
  return {
    stop() {
      active = false;
      app.removeListener("web-contents-created", created);
      for (const [contents, ready] of pages) {
        contents.removeListener("dom-ready", ready);
        void configure(contents, false);
      }
      pages.clear();
    },
  };
}

module.exports = { startPickerHost, discoverPicker, discoverDropdown, installPicker };
