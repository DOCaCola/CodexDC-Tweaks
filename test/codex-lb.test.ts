import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
// Shape of the prediction code in a Codex desktop main-process chunk: the remote
// config check behind the settings row, the run gate, and the eligibility check.
const PREDICTION_CODE = [
  "class P{constructor(c){this.controller=c}async isEnabledByRemoteConfig(){return(await this.controller.getConfig())?.is_enabled===!0}}",
  "async function FRe({client:e,threadId:t,latestTurnId:r,generationTrigger:n,prompt:i,promptVersion:s,configuredReasoningEffort:a,unsupportedModels:o,interruptOnCancel:l=!1}){let f=await e.resumeThread(t),b=null;if(f.collaborationMode?.mode===\"plan\"?b=\"plan_mode\":\"openai\"!==f.modelProvider?b=\"unsupported_provider\":o?.includes(f.model)&&(b=\"unsupported_model\"),null!=b)return b;return \"eligible\"}",
  "async function run(o,thread){if(null==o||!o.is_enabled)return null;return FRe({client:{resumeThread:async()=>thread},threadId:1,latestTurnId:2,generationTrigger:3,prompt:4,promptVersion:5,configuredReasoningEffort:6,unsupportedModels:o.unsupported_models,interruptOnCancel:!1})}",
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

test("each feature gate is discovered from the renderer chunks and kept for the current build", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-lb-gates-"));
  const assets = join(root, "webview", "assets");
  const settings = "let h=e.enabled,f=(0,G.Zj)(\"4290031608\"),m=Y.appServices.cumberbatch,b=(0,g.Ul)(Z.o8);";
  const composer = "h=(0,o.un)(c.u,({get:e})=>e(m.JW,\"4290031608\")&&(0,u.CN)(e,(0,l.W)().enabled)&&null!=s.appServices.cumberbatch),f=1;";
  const background = "async function zN(e,t,n,a){let s=H.appServices?.cumberbatch;if(!(null==s||(0,i.ZJQ)(n.hostId))&&a()&&(0,ej.ie)(e,\"4290031608\"))try{}finally{}}";
  const write = (files: Record<string, string>) => {
    rmSync(assets, { recursive: true, force: true });
    mkdirSync(join(assets, "async"), { recursive: true });
    for (const [name, source] of Object.entries(files)) writeFileSync(join(assets, name), source);
  };
  const store = new Map<string, unknown>();
  const storage = {
    get: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
    set: (key: string, value: unknown) => store.set(key, value),
  };
  const discover = (build: string, log = logger()) => discoverGates({ appPath: root, build, features: FEATURES, storage, log });
  try {
    const log = logger();
    write({
      "async/553834.a.js": settings,
      "async/16389.b.js": composer,
      "async/39017.c.js": "let unrelated=1;",
      "182735.d.js": background,
    });
    assert.deepEqual([...await discover("1", log)], [["composer_predictions", "4290031608"]]);
    assert.deepEqual(log.entries, []);

    // The same build reuses the stored gates without reading the chunks again.
    rmSync(assets, { recursive: true, force: true });
    assert.deepEqual([...await discover("1")], [["composer_predictions", "4290031608"]]);

    // A new build replaces the stored gates.
    const changed = logger();
    write({
      "async/553834.a.js": settings,
      "async/16389.b.js": composer.replace("4290031608", "1"),
      "182735.d.js": background,
    });
    assert.deepEqual([...await discover("2", changed)], []);
    assert.deepEqual(changed.entries, ["codex-lb: unsupported Codex build, cannot enable the Composer predictions interface"]);
    assert.deepEqual([...store.keys()], ["gates"]);

    write({
      "async/553834.a.js": settings + settings,
      "async/16389.b.js": composer,
      "182735.d.js": background,
    });
    assert.deepEqual([...await discover("3")], []);
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

test("the main-process chunk with a feature's code is patched once while it loads", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-lb-"));
  const original = (Module.prototype as any)._compile;
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    const build = join(root, ".vite", "build");
    mkdirSync(build, { recursive: true });
    const chunk = join(build, "early-bootstrap-747-a.js");
    const other = join(build, "early-bootstrap-12-b.js");
    writeFileSync(chunk, PREDICTION_CODE + ";module.exports=run;");
    writeFileSync(other, "module.exports=1;");

    const log = logger();
    installBundlePatch(log, build, {});
    assert.equal(require(other), 1);
    assert.notEqual((Module.prototype as any)._compile, original);
    const patched = require(chunk);
    assert.equal((Module.prototype as any)._compile, original);

    const registry = { has: () => true, offers: () => true };
    const config = { is_enabled: false, unsupported_models: [] };
    await withRegistry(registry, async () => {
      assert.equal(await patched(config, { modelProvider: "codex-lb" }), "eligible");
    });
    assert.ok(log.entries.some((entry) => entry.includes("Composer predictions available")));

    const restarted = logger();
    installBundlePatch(restarted, build, {});
    assert.equal((Module.prototype as any)._compile, original);
    assert.deepEqual(restarted.entries, []);
  } finally {
    (Module.prototype as any)._compile = original;
    delete (globalThis as any)[BUNDLE_STATE];
    rmSync(root, { recursive: true, force: true });
  }
});

test("a feature whose code is not in exactly one chunk stays unchanged", () => {
  const build = mkdtempSync(join(tmpdir(), "codex-lb-"));
  const original = (Module.prototype as any)._compile;
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    writeFileSync(join(build, "early-bootstrap-1-a.js"), PREDICTION_CODE);
    writeFileSync(join(build, "early-bootstrap-2-b.js"), PREDICTION_CODE);
    const log = logger();
    installBundlePatch(log, build, {});
    assert.equal((Module.prototype as any)._compile, original);
    assert.deepEqual(log.entries, ["codex-lb: unsupported Codex build, Composer predictions stay limited to the OpenAI provider"]);
  } finally {
    delete (globalThis as any)[BUNDLE_STATE];
    rmSync(build, { recursive: true, force: true });
  }
});

test("enabling after the chunk loaded asks for a restart", () => {
  const build = realpathSync(mkdtempSync(join(tmpdir(), "codex-lb-")));
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    const chunk = join(build, "early-bootstrap-747-a.js");
    writeFileSync(chunk, PREDICTION_CODE);
    const log = logger();
    const original = (Module.prototype as any)._compile;
    installBundlePatch(log, build, { [chunk]: {} });
    assert.equal((Module.prototype as any)._compile, original);
    assert.deepEqual(log.entries, ["codex-lb: restart Codex to enable Composer predictions"]);
  } finally {
    delete (globalThis as any)[BUNDLE_STATE];
    rmSync(build, { recursive: true, force: true });
  }
});
