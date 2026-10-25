"use strict";

// Desktop features that Codex restricts to threads on the built-in `openai`
// provider. Each entry widens one restriction to providers that codex-lb
// confirms it serves for that capability. Patterns target the installed main
// bundle and must match exactly once; otherwise the feature stays unchanged.

const REGISTRY_EXPRESSION = 'globalThis[Symbol.for("codexdc.codex-lb.capabilities")]';

function allows(providerExpression, capability) {
  return `${REGISTRY_EXPRESSION}?.has(${providerExpression},${JSON.stringify(capability)})===!0`;
}

const FEATURES = [
  {
    capability: "composer_predictions",
    label: "Composer predictions",
    // Prediction eligibility rejects plan mode, then any provider other than
    // `openai` as unsupported_provider before a prediction fork is started.
    pattern: /(?<![$\w])([$\w]+)\.collaborationMode\?\.mode===`plan`\?([$\w]+)=`plan_mode`:\1\.modelProvider===`openai`\?/g,
    replace: (thread, reason) =>
      `${thread}.collaborationMode?.mode===\`plan\`?${reason}=\`plan_mode\`:(${thread}.modelProvider===\`openai\`||${allows(`${thread}.modelProvider`, "composer_predictions")})?`,
  },
];

function patchSource(source, features = FEATURES) {
  let patched = source;
  const applied = [];
  const skipped = [];
  for (const feature of features) {
    const matches = [...patched.matchAll(feature.pattern)];
    if (matches.length !== 1) {
      skipped.push(feature);
      continue;
    }
    const [match] = matches;
    patched = patched.slice(0, match.index) + feature.replace(...match.slice(1)) + patched.slice(match.index + match[0].length);
    applied.push(feature);
  }
  return { source: patched, applied, skipped };
}

module.exports = { FEATURES, patchSource };
