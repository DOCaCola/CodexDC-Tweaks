"use strict";

// Desktop features that Codex restricts to threads on the built-in `openai`
// provider. Each feature widens its restrictions to threads whose provider and
// model codex-lb confirms for that capability. Every patch of a feature targets
// one chunk of the main-process build and must match exactly once there;
// otherwise the whole feature stays unchanged. The renderer shows a feature only
// behind its Statsig gate, which the tweak turns on while codex-lb offers the
// capability. Each gate pattern must match exactly once across the renderer
// chunks that contain the gate's marker.

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
      marker: "cumberbatch",
      patterns: [
        // The "Show predictions" settings row.
        /[$\w]+=\(0,[$\w]+\.[$\w]+\)\("(?<gate>\d+)"\),[$\w]+=[$\w]+\.appServices\.cumberbatch,/g,
        // Predictions in the composer.
        /[$\w]+\([$\w]+\.[$\w]+,"(?<gate>\d+)"\)&&\(0,[$\w]+\.[$\w]+\)\([$\w]+,\(0,[$\w]+\.[$\w]+\)\(\)\.enabled\)&&null!=[$\w]+\.appServices\.cumberbatch\)/g,
        // Background predictions after each turn.
        /let ([$\w]+)=[$\w]+\.appServices\?\.cumberbatch;if\(!\(null==\1\|\|\(0,[$\w]+\.[$\w]+\)\([$\w]+\.hostId\)\)&&[$\w]+\(\)&&\(0,[$\w]+\.[$\w]+\)\([$\w]+,"(?<gate>\d+)"\)\)try\{/g,
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
        pattern: /if\(null==([$\w]+)\|\|!\1\.is_enabled\)return null;/g,
        replace: (config) => `if(null==${config}||!${config}.is_enabled&&!(${offers("composer_predictions")}))return null;`,
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
        pattern: /(?<![$\w])([$\w]+)\.collaborationMode\?\.mode==="plan"\?([$\w]+)="plan_mode":"openai"!==\1\.modelProvider\?\2="unsupported_provider":/g,
        replace: (thread, reason) =>
          `${thread}.collaborationMode?.mode==="plan"?${reason}="plan_mode":!(${thread}.modelProvider==="openai"&&${REMOTE_PREDICTIONS}!==!1||${allows(thread, "composer_predictions")})?${reason}="unsupported_provider":`,
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

module.exports = { FEATURES, patchFeature, patchSource };
