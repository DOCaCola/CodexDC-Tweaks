"use strict";

// Serialized into the app page together with configureUsageLocks. Keep this
// function self-contained. It receives [moduleId, factorySource] pairs from the
// page's Rspack runtime and reports the modules and exports to hook.
function findUsageModules(modules) {
  const quote = "[\x60'\"]";
  const call = "(?:\\(0,[$\\w.]+\\)|[$\\w.]+)";
  const declaration = new RegExp("([$\\w]+)=" + call + "\\([$\\w.]+,\\(\\{get:[$\\w]+\\}\\)=>\\{", "g");
  const gateAuth = new RegExp(quote + "chatgpt" + quote + "!==[$\\w]+\\.authMethod|\\.authMethod!==" + quote + "chatgpt" + quote);
  const sidebarAlert = new RegExp("[$\\w]+=\\{personal:" + quote + "(\\d+)" + quote + ",workspace_owner:" + quote + "(\\d+)" + quote
    + ",workspace_member:" + quote + "(\\d+)" + quote + "\\},[$\\w]+=\\{enabled:!1,showWithCredits:!1,exposureThresholdPercent:", "g");

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

  function gateDeclarations(source) {
    const declarations = [...source.matchAll(declaration)];
    const exportCall = source.search(/\.d\([$\w]+,\{/);
    return declarations.filter((match, index) => {
      const next = declarations[index + 1]?.index ?? source.length;
      const end = exportCall > match.index ? Math.min(next, exportCall) : next;
      const body = source.slice(match.index, end);
      return body.length < 3000 && gateAuth.test(body)
        && body.includes(".rate_limit?.allowed!==!1") && body.includes(".accountId!==")
        && body.includes(".windowMinutes===") && body.includes(".resetsAt===");
    }).map((match) => match[1]);
  }

  // The automatic usage presentation shares a query-options factory with the
  // separately refreshed Usage settings page. Follow only its automatic binding.
  function presentationDeclarations(source) {
    const factories = [...source.matchAll(new RegExp("function ([$\\w]+)\\(([$\\w]+)\\)\\{let [$\\w]+=(?:\\2===" + quote
      + "usage-settings" + quote + "|" + quote + "usage-settings" + quote + "===\\2);return\\(\\{get:[$\\w]+,scope:[$\\w]+,queryClient:[$\\w]+\\}\\)=>\\{", "g"))]
      .filter((match) => {
        const end = source.indexOf("refetchIntervalInBackground:", match.index);
        const body = source.slice(match.index, end);
        return end !== -1 && body.length < 7000 && new RegExp(quote + "base_interval_ms" + quote).test(body)
          && new RegExp(quote + "usage_scaling_multiplier" + quote).test(body) && body.includes(".rate_limit?.allowed===!1");
      }).map((match) => match[1]);
    const names = new Set(factories);
    return [...source.matchAll(new RegExp("([$\\w]+)=" + call + "\\([$\\w.]+,([$\\w]+)\\(" + quote + "automatic" + quote + "\\)(?:,[$\\w.]+)?\\)", "g"))]
      .filter((match) => names.has(match[2])).map((match) => match[1]);
  }

  function exported(id, source, locals, kind) {
    if (!locals.length) return [];
    const names = exportsOf(source);
    return locals.map((local) => {
      const name = names.get(local);
      if (name === undefined) throw new Error("Unsupported Codex build: " + kind + " export missing");
      return { id, name };
    });
  }

  const result = { gates: [], presentations: [], sidebarAlertLayers: [] };
  for (const [id, source] of modules) {
    if (source.includes(".windowMinutes===")) {
      result.gates.push(...exported(id, source, gateDeclarations(source), "shared usage-block selector"));
    }
    if (source.includes("usage-settings")) {
      result.presentations.push(...exported(id, source, presentationDeclarations(source), "shared usage presentation query"));
    }
    if (source.includes("workspace_owner:")) {
      for (const match of source.matchAll(sidebarAlert)) result.sidebarAlertLayers.push({ id, layers: match.slice(1) });
    }
  }
  return result;
}

module.exports = { findUsageModules };
