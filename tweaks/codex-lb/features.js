"use strict";

// Desktop features that Codex restricts to threads on the built-in `openai`
// provider. Each feature widens its restrictions to threads whose provider and
// model codex-lb confirms for that capability. Every patch of a feature targets
// the installed main bundle and must match exactly once; otherwise the whole
// feature stays unchanged. The renderer shows a feature only behind its
// Statsig gate, which the tweak turns on while codex-lb offers the capability.

const REGISTRY_EXPRESSION = 'globalThis[Symbol.for("codexdc.codex-lb.capabilities")]';
// Whether OpenAI's remote prediction config enables predictions for the
// signed-in account. Threads on the built-in provider keep that decision.
const REMOTE_PREDICTIONS = "$codexLbRemotePredictions";

function allows(threadExpression, capability) {
  return `${REGISTRY_EXPRESSION}?.has(${threadExpression}.modelProvider,${JSON.stringify(capability)},${threadExpression}.model)===!0`;
}

function offers(capability) {
  return `${REGISTRY_EXPRESSION}?.offers(${JSON.stringify(capability)})===!0`;
}

const FEATURES = [
  {
    capability: "composer_predictions",
    label: "Composer predictions",
    gate: {
      bundles: ["general-settings-", "app-initial-", "app-primary-", "app-shared-", "initialize-app-host-services-"],
      patterns: [
        // The "Show predictions" settings row.
        /[$\w]+=[$\w]+\(`(?<gate>\d+)`\),[$\w]+=[$\w]+\.cumberbatch,/g,
        // Predictions in the composer.
        /[$\w]+\([$\w]+,`(?<gate>\d+)`\)&&[$\w]+\([$\w]+,[$\w]+\(\)\.enabled\)&&[$\w]+\.cumberbatch!=null/g,
        // Background predictions after each turn.
        /let ([$\w]+)=[$\w]+\?\.cumberbatch;if\(\1!=null&&![$\w]+\([$\w]+\.hostId\)&&[$\w]+\(\)&&[$\w]+\([$\w]+,`(?<gate>\d+)`\)\)try\{/g,
      ],
    },
    patches: [
      {
        // The settings page shows "Show predictions" only when the remote
        // config enables predictions; a codex-lb provider offering them does too.
        pattern: /async isEnabledByRemoteConfig\(\)\{return\(await this\.controller\.getConfig\(\)\)\?\.is_enabled===!0\}/g,
        replace: () =>
          `async isEnabledByRemoteConfig(){return(await this.controller.getConfig())?.is_enabled===!0||${offers("composer_predictions")}}`,
      },
      {
        // A prediction run stops when the remote config disables predictions,
        // unless a codex-lb provider offers them. Eligibility below then admits
        // only threads on codex-lb models.
        pattern: /if\(([$\w]+)==null\|\|!\1\.is_enabled\)return null;/g,
        replace: (config) => `if(${config}==null||!${config}.is_enabled&&!(${offers("composer_predictions")}))return null;`,
      },
      {
        pattern: /unsupportedModels:([$\w]+)\.unsupported_models,/g,
        replace: (config) =>
          `unsupportedModels:${config}.unsupported_models,codexLbRemotePredictions:${config}.is_enabled===!0,`,
      },
      {
        pattern: /(\{client:[$\w]+,threadId:[$\w]+,latestTurnId:[$\w]+,generationTrigger:[$\w]+,prompt:[$\w]+,promptVersion:[$\w]+,configuredReasoningEffort:[$\w]+,unsupportedModels:[$\w]+,)/g,
        replace: (parameters) => `${parameters}codexLbRemotePredictions:${REMOTE_PREDICTIONS},`,
      },
      {
        // Eligibility rejects plan mode, then any provider other than `openai`
        // as unsupported_provider before a prediction fork is started.
        pattern: /(?<![$\w])([$\w]+)\.collaborationMode\?\.mode===`plan`\?([$\w]+)=`plan_mode`:\1\.modelProvider===`openai`\?/g,
        replace: (thread, reason) =>
          `${thread}.collaborationMode?.mode===\`plan\`?${reason}=\`plan_mode\`:(${thread}.modelProvider===\`openai\`&&${REMOTE_PREDICTIONS}!==!1||${allows(thread, "composer_predictions")})?`,
      },
    ],
  },
];

function patchFeature(source, feature) {
  let patched = source;
  for (const { pattern, replace } of feature.patches) {
    const matches = [...patched.matchAll(pattern)];
    if (matches.length !== 1) return null;
    const [match] = matches;
    patched = patched.slice(0, match.index) + replace(...match.slice(1)) + patched.slice(match.index + match[0].length);
  }
  return patched;
}

function patchSource(source, features = FEATURES) {
  let patched = source;
  const applied = [];
  const skipped = [];
  for (const feature of features) {
    const result = patchFeature(patched, feature);
    if (result == null) {
      skipped.push(feature);
      continue;
    }
    patched = result;
    applied.push(feature);
  }
  return { source: patched, applied, skipped };
}

module.exports = { FEATURES, patchSource };
