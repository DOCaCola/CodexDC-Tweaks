import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { FEATURES, patchSource } = require("../tweaks/codex-lb/features.js");
const { customProviders, createRegistry, installBundlePatch } = require("../tweaks/codex-lb/index.js").__test;
const { discoverGates } = require("../tweaks/codex-lb/gates.js");
const { configureFeatureGates } = require("../tweaks/codex-lb/feature-gates.js");
const { parse } = require("../tweaks/codex-lb/vendor/smol-toml.cjs");

const REGISTRY = Symbol.for("codexdc.codex-lb.capabilities");
const BUNDLE_STATE = Symbol.for("codexdc.codex-lb.bundle");
// Shape of the prediction code in the Codex desktop main bundle: the remote
// config check behind the settings row, the run gate, and the eligibility check.
const PREDICTION_CODE = [
  "class P{constructor(c){this.controller=c}async isEnabledByRemoteConfig(){return(await this.controller.getConfig())?.is_enabled===!0}}",
  "async function FRe({client:e,threadId:t,latestTurnId:n,generationTrigger:r,prompt:a,promptVersion:o,configuredReasoningEffort:c,unsupportedModels:l,useThreadSample:u=!1}){let v=await e.resumeThread(t),y=null;if(v.collaborationMode?.mode===`plan`?y=`plan_mode`:v.modelProvider===`openai`?l?.includes(v.model)&&(y=`unsupported_model`):y=`unsupported_provider`,y!=null)return y;return \"eligible\"}",
  "async function run(c,thread){if(c==null||!c.is_enabled)return null;return FRe({client:{resumeThread:async()=>thread},threadId:1,latestTurnId:2,generationTrigger:3,prompt:4,promptVersion:5,configuredReasoningEffort:6,unsupportedModels:c.unsupported_models,useThreadSample:!1})}",
].join(";");

function loadPredictionCode(source: string) {
  return new Function(source + ";return {P,run}")();
}

function logger() {
  const entries: string[] = [];
  const record = (...args: unknown[]) => entries.push(args.map(String).join(" "));
  return { entries, info: record, warn: record, error: record };
}

async function withRegistry<T>(registry: unknown, run: () => T | Promise<T>): Promise<T> {
  (globalThis as any)[REGISTRY] = registry;
  try {
    return await run();
  } finally {
    delete (globalThis as any)[REGISTRY];
  }
}

test("predictions run for models codex-lb confirms and keep OpenAI's decision for openai threads", async () => {
  const { source, applied, skipped } = patchSource(PREDICTION_CODE);
  assert.deepEqual(applied.map((feature: any) => feature.capability), ["composer_predictions"]);
  assert.deepEqual(skipped, []);
  const { run } = loadPredictionCode(source);
  const disabled = { is_enabled: false, unsupported_models: ["old"] };
  const enabled = { is_enabled: true, unsupported_models: ["old"] };
  const registry = {
    has: (provider: string, capability: string, model: string) =>
      provider === "codex-lb" && capability === "composer_predictions" && ["gpt-6.1-sol", "old"].includes(model),
    offers: (capability: string) => capability === "composer_predictions",
  };

  await withRegistry(registry, async () => {
    assert.equal(await run(disabled, { modelProvider: "codex-lb", model: "gpt-6.1-sol" }), "eligible");
    assert.equal(await run(disabled, { modelProvider: "codex-lb", model: "anthropic/claude-opus-5-5" }), "unsupported_provider");
    assert.equal(await run(disabled, { modelProvider: "other", model: "gpt-6.1-sol" }), "unsupported_provider");
    assert.equal(await run(disabled, { modelProvider: "codex-lb", model: "old" }), "unsupported_model");
    assert.equal(await run(disabled, { modelProvider: "codex-lb", collaborationMode: { mode: "plan" } }), "plan_mode");
    assert.equal(await run(disabled, { modelProvider: "openai", model: "gpt-6.1-sol" }), "unsupported_provider");
    assert.equal(await run(enabled, { modelProvider: "openai", model: "gpt-6.1-sol" }), "eligible");
    assert.equal(await run(null, { modelProvider: "codex-lb", model: "gpt-6.1-sol" }), null);
  });
  assert.equal(await run(disabled, { modelProvider: "codex-lb", model: "gpt-6.1-sol" }), null);
  assert.equal(await run(enabled, { modelProvider: "openai", model: "gpt-6.1-sol" }), "eligible");
  assert.equal(await run(enabled, { modelProvider: "codex-lb", model: "gpt-6.1-sol" }), "unsupported_provider");
});

test("the predictions setting is offered while codex-lb offers predictions", async () => {
  const { P } = loadPredictionCode(patchSource(PREDICTION_CODE).source);
  const remote = (is_enabled: boolean) => new P({ getConfig: async () => ({ is_enabled }) });
  assert.equal(await remote(false).isEnabledByRemoteConfig(), false);
  assert.equal(await remote(true).isEnabledByRemoteConfig(), true);
  await withRegistry({ offers: () => true }, async () => {
    assert.equal(await remote(false).isEnabledByRemoteConfig(), true);
  });
  await withRegistry({ offers: () => false }, async () => {
    assert.equal(await remote(false).isEnabledByRemoteConfig(), false);
  });
});

test("features stay unchanged unless their check matches exactly once", () => {
  assert.equal(patchSource("function D(){}").skipped.length, 1);
  const duplicated = PREDICTION_CODE + ";" + PREDICTION_CODE.replace("async function FRe", "async function GRe");
  const result = patchSource(duplicated);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.source, duplicated);
  const partial = PREDICTION_CODE.replace("isEnabledByRemoteConfig", "isEnabled");
  assert.equal(patchSource(partial).source, partial);
});

test("custom providers are probed with the credentials Codex sends", () => {
  const config = parse([
    "[model_providers.codex-lb]",
    'base_url = "https://lb.example/backend-api/codex/"',
    'experimental_bearer_token = "secret"',
    'http_headers = { "X-Static" = "1" }',
    'env_http_headers = { "X-Env" = "LB_HEADER" }',
    'query_params = { "api-version" = "1" }',
    "[model_providers.keyed]",
    'base_url = "https://other.example/v1"',
    'env_key = "OTHER_KEY"',
    "[model_providers.nameonly]",
    'name = "No URL"',
  ].join("\n"));
  const providers = customProviders(config, { LB_HEADER: "env", OTHER_KEY: "other" });
  assert.deepEqual(providers, [
    {
      id: "codex-lb",
      url: "https://lb.example/backend-api/codex/codex-lb/capabilities?api-version=1",
      headers: { "X-Static": "1", "X-Env": "env", Authorization: "Bearer secret" },
    },
    { id: "keyed", url: "https://other.example/v1/codex-lb/capabilities", headers: { Authorization: "Bearer other" } },
  ]);
  assert.deepEqual(customProviders({}, {}), []);
});

function response(status: number, body?: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not json");
      return body;
    },
  };
}

test("only providers that identify as codex-lb gain capabilities, per model", async () => {
  const document = {
    object: "codex_lb.capabilities",
    service: "codex-lb",
    capabilities: [{ id: "composer_predictions", models: ["gpt-6.1-sol", "gpt-6-astra"] }],
  };
  const answers = new Map<string, () => unknown>([
    ["https://lb.example/v1/codex-lb/capabilities", () => response(200, document)],
    ["https://other.example/v1/codex-lb/capabilities", () => response(404)],
  ]);
  const log = logger();
  const registry = createRegistry({
    fetch: async (url: string) => answers.get(url)!(),
    readConfig: () => [
      "[model_providers.codex-lb]",
      'base_url = "https://lb.example/v1"',
      "[model_providers.other]",
      'base_url = "https://other.example/v1"',
    ].join("\n"),
    env: {},
    log,
  });

  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6.1-sol"), true);
  assert.equal(registry.has("codex-lb", "composer_predictions", "anthropic/claude-opus-5-5"), false);
  assert.equal(registry.has("codex-lb", "unknown", "gpt-6.1-sol"), false);
  assert.equal(registry.has("other", "composer_predictions", "gpt-6.1-sol"), false);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => response(503));
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6.1-sol"), true);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => {
    throw new TypeError("fetch failed");
  });
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6.1-sol"), true);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () =>
    response(200, { ...document, capabilities: [{ id: "composer_predictions", models: ["gpt-6-astra"] }] }),
  );
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6.1-sol"), false);
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6-astra"), true);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () =>
    response(200, { ...document, capabilities: ["composer_predictions"] }),
  );
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6-astra"), false);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => response(200, { object: "list", data: [] }));
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions", "gpt-6-astra"), false);
  assert.ok(log.entries.some((entry) => entry.includes("provider codex-lb: composer_predictions (gpt-6-astra, gpt-6.1-sol)")));
  assert.ok(log.entries.some((entry) => entry.includes("provider codex-lb: not codex-lb")));
});

test("the registry reports offered capabilities and notifies on changes", async () => {
  let models = ["gpt-6.1-sol"];
  const registry = createRegistry({
    fetch: async () => response(200, {
      object: "codex_lb.capabilities",
      service: "codex-lb",
      capabilities: [{ id: "composer_predictions", models }],
    }),
    readConfig: () => '[model_providers.codex-lb]\nbase_url = "https://lb.example/v1"',
    env: {},
    log: logger(),
  });
  let notified = 0;
  const unsubscribe = registry.subscribe(() => notified++);
  assert.equal(registry.offers("composer_predictions"), false);

  await registry.refresh();
  assert.equal(registry.offers("composer_predictions"), true);
  assert.equal(registry.offers("unknown"), false);
  assert.equal(notified, 1);

  await registry.refresh();
  assert.equal(notified, 1);

  models = [];
  await registry.refresh();
  assert.equal(registry.offers("composer_predictions"), false);
  assert.equal(notified, 2);

  unsubscribe();
  models = ["gpt-6-astra"];
  await registry.refresh();
  assert.equal(notified, 2);
});

test("each feature gate is discovered from the installed renderer bundles", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-lb-gates-"));
  const assets = join(root, "webview", "assets");
  const settings = "let s=Et(`4290031608`),c=he.cumberbatch,l=L(Xn);";
  const composer = "E3s=W(V,({get:e})=>e(e_,`4290031608`)&&Cr(e,N().enabled)&&mi.cumberbatch!=null);";
  const background = "async function zN(e,t,n,r){let i=H?.cumberbatch;if(i!=null&&!R(n.hostId)&&r()&&Kl(e,`4290031608`))try{}finally{}}";
  const write = (files: Record<string, string>) => {
    rmSync(assets, { recursive: true, force: true });
    mkdirSync(assets, { recursive: true });
    for (const [name, source] of Object.entries(files)) writeFileSync(join(assets, name), source);
  };
  try {
    const log = logger();
    write({
      "general-settings-a.js": settings,
      "general-settings-b.js": "",
      "app-initial-a.js": composer,
      "initialize-app-host-services-a.js": background,
      "unrelated-a.js": settings,
    });
    assert.deepEqual([...discoverGates(root, FEATURES, log)], [["composer_predictions", "4290031608"]]);
    assert.deepEqual(log.entries, []);

    write({
      "general-settings-a.js": settings,
      "app-initial-a.js": composer.replace("4290031608", "1"),
      "initialize-app-host-services-a.js": background,
    });
    assert.deepEqual([...discoverGates(root, FEATURES, log)], []);
    assert.deepEqual(log.entries, ["codex-lb: unsupported Codex build, cannot enable the Composer predictions interface"]);

    write({
      "general-settings-a.js": settings + settings,
      "app-initial-a.js": composer,
      "initialize-app-host-services-a.js": background,
    });
    assert.deepEqual([...discoverGates(root, FEATURES, logger())], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function featureClientPage() {
  const events: unknown[] = [];
  class Client {
    loadingStatus = "Ready";
    values = { gates: {} };
    getFeatureGate(name: string) {
      return { name, value: name === "on", details: { reason: "Network:Recognized" } };
    }
    checkGate(name: string) {
      return this.getFeatureGate(name).value;
    }
    getContext() {
      return { values: this.values };
    }
    $emt(event: unknown) {
      events.push(event);
    }
  }
  const client = new Client();
  const timers: Array<() => void> = [];
  const context = createContext({
    location: { href: "app://-/index.html" },
    __STATSIG__: { instances: { key: client }, firstInstance: client },
    setInterval: (callback: () => void) => timers.push(callback),
    clearInterval: () => {},
    console,
  });
  const configure = (args: object) =>
    JSON.parse(JSON.stringify(
      runInContext("(" + configureFeatureGates + ")(" + JSON.stringify({ key: "__gates", ...args }) + ")", context),
    ));
  return { client, Client, context, events, timers, configure };
}

test("feature gates are turned on in the page and restored when disabled", () => {
  const page = featureClientPage();
  const { client, events } = page;
  assert.deepEqual(page.configure({ owner: "a", gates: ["4290031608"] }), { status: "active", clients: 1, gates: ["4290031608"] });
  assert.equal(client.checkGate("4290031608"), true);
  assert.equal(client.getFeatureGate("4290031608").details.reason, "Network:Recognized");
  assert.equal(client.checkGate("other"), false);
  assert.equal(events.length, 1);

  page.configure({ owner: "a", gates: ["other"] });
  assert.equal(client.checkGate("4290031608"), false);
  assert.equal(client.checkGate("other"), true);
  assert.equal(events.length, 2);

  // A replaced feature client is patched and the old one restored.
  const replacement = new page.Client();
  runInContext("__STATSIG__", page.context).instances = { key: replacement };
  runInContext("__STATSIG__", page.context).firstInstance = replacement;
  page.timers[0]();
  assert.equal(replacement.checkGate("other"), true);
  assert.equal(Object.hasOwn(client, "getFeatureGate"), false);

  assert.deepEqual(page.configure({ owner: "a", gates: [] }), { status: "stopped" });
  assert.equal(Object.hasOwn(replacement, "getFeatureGate"), false);
  assert.equal(replacement.checkGate("other"), false);
  assert.equal(runInContext("globalThis.__gates", page.context), undefined);
});

test("a new tweak instance replaces the previous page override", () => {
  const page = featureClientPage();
  page.configure({ owner: "a", gates: ["x"] });
  page.configure({ owner: "b", gates: ["y"] });
  assert.equal(page.client.checkGate("x"), false);
  assert.equal(page.client.checkGate("y"), true);
  assert.equal(runInContext("globalThis.__gates.owner", page.context), "b");
  page.configure({ owner: "a", gates: [] });
  assert.equal(page.client.checkGate("y"), true);
  page.configure({ owner: "b", gates: [] });
  assert.equal(page.client.checkGate("y"), false);
});

test("the desktop main bundle is patched once while it loads", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-lb-"));
  const original = (Module.prototype as any)._compile;
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    mkdirSync(join(root, ".vite", "build"), { recursive: true });
    const bundle = join(root, ".vite", "build", "main-Test.js");
    const other = join(root, ".vite", "build", "src-Test.js");
    writeFileSync(bundle, PREDICTION_CODE + ";module.exports=run;");
    writeFileSync(other, PREDICTION_CODE + ";module.exports=run;");

    const log = logger();
    installBundlePatch(log, {});
    const untouched = require(other);
    const patched = require(bundle);
    assert.equal((Module.prototype as any)._compile, original);

    const registry = { has: () => true, offers: () => true };
    const config = { is_enabled: false, unsupported_models: [] };
    await withRegistry(registry, async () => {
      assert.equal(await patched(config, { modelProvider: "codex-lb" }), "eligible");
      assert.equal(await untouched(config, { modelProvider: "codex-lb" }), null);
    });
    assert.ok(log.entries.some((entry) => entry.includes("Composer predictions available")));

    const restarted = logger();
    installBundlePatch(restarted, {});
    assert.equal((Module.prototype as any)._compile, original);
    assert.deepEqual(restarted.entries, []);
  } finally {
    (Module.prototype as any)._compile = original;
    delete (globalThis as any)[BUNDLE_STATE];
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabling after the bundle loaded asks for a restart", () => {
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    const log = logger();
    const original = (Module.prototype as any)._compile;
    installBundlePatch(log, { "/App/.vite/build/main-Loaded.js": {} });
    assert.equal((Module.prototype as any)._compile, original);
    assert.deepEqual(log.entries, ["codex-lb: restart Codex to enable Composer predictions"]);
  } finally {
    delete (globalThis as any)[BUNDLE_STATE];
  }
});
