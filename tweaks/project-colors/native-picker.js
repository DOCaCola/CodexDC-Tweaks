"use strict";

// Serialized by the host into the app page's main world. Keep self-contained.
// Codex lazy-loads its Appearance settings from Rspack chunks. On first use the
// page loads them through its own module runtime and reuses their accent
// dropdown and HexColorPicker components. Modules are found by semantic source
// and export shape, never by build hashes or module IDs.
async function installPicker(enabled, loadModule = url => import(url)) {
  const key = "__codexdcProjectColorPicker__";
  globalThis[key]?.stop();
  delete globalThis[key];
  if (!enabled) return;
  const roots = new Map();
  let active = true;
  let components;

  // Rspack defines exports as n.d(exports,{name:()=>local},{name:local}).
  function exportsOf(source) {
    const names = new Map();
    for (const match of source.matchAll(/\.d\([$\w]+,\{([^{}]*)\}(?:,\{([^{}]*)\})?\)/g)) {
      for (const entry of [match[1], match[2] ?? ""].join(",").split(",")) {
        const parsed = /^([$\w]+):(?:\(\)=>)?([$\w]+)$/.exec(entry);
        if (parsed) names.set(parsed[2], parsed[1]);
      }
    }
    return names;
  }

  async function loadComponents() {
    // Each app page loads one Rspack runtime entry. Importing the page's own,
    // already evaluated module scripts returns those instances without side effects.
    const runtimes = [];
    for (const script of document.querySelectorAll("script[type=module][src]")) {
      const module = await loadModule(script.src);
      if (typeof module.__webpack_require__ === "function") runtimes.push(module.__webpack_require__);
    }
    if (runtimes.length !== 1) throw new Error("Unsupported Codex module runtime");
    const runtime = runtimes[0];
    function loaded(test, kind) {
      const found = new Set(Object.values(runtime.c).map(module => module.exports).filter(test));
      if (found.size !== 1) throw new Error("Unsupported Codex " + kind + " module");
      return found.values().next().value;
    }
    const React = loaded(exports => typeof exports?.createElement === "function"
      && typeof exports.useState === "function" && typeof exports.version === "string", "React");
    const client = loaded(exports => typeof exports?.createRoot === "function", "React DOM client");

    // Replay the app's own lazy import of the Appearance settings page.
    const site = /\(await (Promise\.all\(\[[^\]]*\]\)|[$\w]+\.e\([^()]*\))\.then\([$\w]+\.bind\([$\w]+,"([^"]+)"\)\)\)\.GeneralSettings\b/g;
    const sites = new Map();
    for (const factory of Object.values(runtime.m)) {
      const source = String(factory);
      if (!source.includes(".GeneralSettings")) continue;
      for (const match of source.matchAll(site)) {
        sites.set(match[2], [...match[1].matchAll(/\.e\(([^()]+)\)/g)].map(chunk => JSON.parse(chunk[1])));
      }
    }
    if (sites.size !== 1) throw new Error("Unsupported Codex Appearance settings import");
    const [[settingsId, chunks]] = sites;
    await Promise.all(chunks.map(chunk => runtime.e(chunk)));
    const settings = String(runtime.m[settingsId]);
    const requireName = /^[^(]*\(\s*[$\w]+\s*,\s*[$\w]+\s*,\s*([$\w]+)\s*\)/.exec(settings)?.[1];
    if (!requireName) throw new Error("Unsupported Codex Appearance settings module");
    const imports = new Map([...settings.matchAll(new RegExp("([$\\w]+)=" + requireName.replace(/\$/g, "\\$") + "\\(\"([^\"]+)\"\\)", "g"))]
      .map(match => [match[1], match[2]]));
    function member(pattern, kind) {
      const match = pattern.exec(settings);
      const id = match && imports.get(match[1]);
      const value = id && runtime(id)[match[2]];
      if (!value) throw new Error("Unsupported Appearance " + kind);
      return value;
    }
    const Trigger = member(/\(0,[$\w]+\.jsxs\)\(([$\w]+)\.([$\w]+),\{"aria-label":[^{}]*?color:"outlineSurface"/, "dropdown trigger");
    const Menu = member(/\(0,[$\w]+\.jsx\)\(([$\w]+)\.([$\w]+)\.RadioItem,\{value:"custom"/, "dropdown menu");
    const Dropdown = member(/\(0,[$\w]+\.jsx\)\(([$\w]+)\.([$\w]+),\{align:"end",contentWidth:"menu",triggerButton:/, "dropdown");
    const pickers = [...new Set(imports.values())].filter(id => {
      const source = String(runtime.m[id]);
      return source.includes(".react-colorful__saturation-pointer") && source.includes("colorModel:");
    });
    if (pickers.length !== 1) throw new Error("Unsupported Codex color picker module");
    const pickerSource = String(runtime.m[pickers[0]]);
    const pickerLocal = /([$\w]+)=function\(e\)\{return [$\w]+\.createElement\([^;]*?colorModel:/.exec(pickerSource)?.[1];
    const pickerExport = exportsOf(pickerSource).get(pickerLocal);
    const Picker = pickerExport && runtime(pickers[0])[pickerExport];
    if (!Picker) throw new Error("Unsupported Codex color picker interface");
    return { React, client, Trigger, Menu, Dropdown, Picker };
  }

  function mount(node, element) {
    // Preserve each root across requests and external updates.
    let root = roots.get(node);
    if (!root) {
      root = components.client.createRoot(node);
      roots.set(node, root);
    }
    root.render(element);
    node.setAttribute("data-codexdc-picker-state", "ready");
  }

  function ColorSelect({ node, value }) {
    const { React, Trigger, Menu, Dropdown } = components;
    const [selection, setSelection] = React.useState(value);
    React.useEffect(() => { setSelection(value); }, [value]);
    const options = JSON.parse(node.getAttribute("data-codexdc-color-options"));
    const chosen = options.find(option => option[0] === selection);
    const swatch = color => color && React.createElement("span", {
      className: "size-3 shrink-0 rounded-full border border-default",
      style: { backgroundColor: color }, "aria-hidden": true,
    });
    const trigger = React.createElement(Trigger, {
      "aria-label": node.getAttribute("aria-label"), color: "outlineSurface", radius: "full", size: "menuRow",
      className: "w-full max-w-36 max-sm:max-w-none",
    }, swatch(chosen?.[2]), chosen?.[1]);
    return React.createElement(Dropdown, {
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

  const observer = new MutationObserver(() => {
    for (const [node, root] of roots) {
      if (!node.isConnected) { root.unmount(); roots.delete(node); }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const onRequest = async event => {
    const node = event.target;
    if (!(node instanceof Element) || !node.matches("[data-codexdc-custom-picker], [data-codexdc-color-select]")) return;
    try {
      components ??= loadComponents();
      components = await components;
      if (!active || !node.isConnected) return;
      const { React, Picker } = components;
      if (node.matches("[data-codexdc-color-select]")) {
        mount(node, React.createElement(ColorSelect, { node, value: node.getAttribute("data-codexdc-color-value") }));
        return;
      }
      mount(node, React.createElement(Picker, {
        color: node.getAttribute("data-codexdc-custom-value"),
        className: "codexdc-project-custom-picker",
        onChange(color) {
          node.setAttribute("data-codexdc-custom-value", color.toLowerCase());
          node.dispatchEvent(new Event("codexdc:project-custom-color", { bubbles: true }));
        },
      }));
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
      for (const root of roots.values()) root.unmount();
      roots.clear();
    },
  };
}

function startPickerHost(api) {
  const { app, webContents } = require("electron");
  const pages = new Map();
  const queues = globalThis[Symbol.for("codexdc.project-colors.picker-queues")] ??= new Map();
  let active = true;
  function configure(contents, enabled) {
    const previous = queues.get(contents) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (contents.isDestroyed() || (enabled && !active)
        || !/^app:\/\/-\/(?:index|detached-window)\.html(?:[?#]|$)/.test(contents.getURL())) return;
      return contents.executeJavaScript("(" + installPicker + ")(" + enabled + ")");
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

module.exports = { startPickerHost, installPicker };
