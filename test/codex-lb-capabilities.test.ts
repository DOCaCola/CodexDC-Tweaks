import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { patchSource } = require("../tweaks/codex-lb-capabilities/features.js");
const { customProviders, createRegistry, installBundlePatch } = require("../tweaks/codex-lb-capabilities/index.js").__test;
const { parse } = require("../tweaks/codex-lb-capabilities/vendor/smol-toml.cjs");

const REGISTRY = Symbol.for("codexdc.codex-lb.capabilities");
const BUNDLE_STATE = Symbol.for("codexdc.codex-lb.bundle");
// Shape of the prediction eligibility check in the Codex desktop main bundle.
const PREDICTION_CHECK =
  'function D(g,l){let _=null;if(g.collaborationMode?.mode===`plan`?_=`plan_mode`:g.modelProvider===`openai`?l?.includes(g.model)&&(_=`unsupported_model`):_=`unsupported_provider`,_!=null)return _;return "eligible"}';

function logger() {
  const entries: string[] = [];
  const record = (...args: unknown[]) => entries.push(args.map(String).join(" "));
  return { entries, info: record, warn: record, error: record };
}

function withRegistry<T>(registry: unknown, run: () => T): T {
  (globalThis as any)[REGISTRY] = registry;
  try {
    return run();
  } finally {
    delete (globalThis as any)[REGISTRY];
  }
}

test("prediction eligibility admits providers confirmed by codex-lb", () => {
  const { source, applied, skipped } = patchSource(PREDICTION_CHECK);
  assert.deepEqual(applied.map((feature: any) => feature.capability), ["composer_predictions"]);
  assert.deepEqual(skipped, []);
  const check = new Function(source + ";return D")();
  const registry = { has: (provider: string, capability: string) => provider === "codex-lb" && capability === "composer_predictions" };

  withRegistry(registry, () => {
    assert.equal(check({ modelProvider: "codex-lb", model: "gpt-6.1-sol" }, []), "eligible");
    assert.equal(check({ modelProvider: "other", model: "gpt-6.1-sol" }, []), "unsupported_provider");
    assert.equal(check({ modelProvider: "codex-lb", model: "old" }, ["old"]), "unsupported_model");
    assert.equal(check({ modelProvider: "codex-lb", collaborationMode: { mode: "plan" } }, []), "plan_mode");
  });
  assert.equal(check({ modelProvider: "openai", model: "gpt-6.1-sol" }, []), "eligible");
  assert.equal(check({ modelProvider: "codex-lb", model: "gpt-6.1-sol" }, []), "unsupported_provider");
});

test("features stay unchanged unless their check matches exactly once", () => {
  assert.equal(patchSource("function D(){}").skipped.length, 1);
  const duplicated = PREDICTION_CHECK + PREDICTION_CHECK.replace("function D", "function E");
  const result = patchSource(duplicated);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.source, duplicated);
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

test("only providers that identify as codex-lb gain capabilities", async () => {
  const document = { object: "codex_lb.capabilities", service: "codex-lb", capabilities: ["composer_predictions"] };
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
  assert.equal(registry.has("codex-lb", "composer_predictions"), true);
  assert.equal(registry.has("codex-lb", "unknown"), false);
  assert.equal(registry.has("other", "composer_predictions"), false);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => response(503));
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions"), true);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => {
    throw new TypeError("fetch failed");
  });
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions"), true);

  answers.set("https://lb.example/v1/codex-lb/capabilities", () => response(200, { object: "list", data: [] }));
  await registry.refresh();
  assert.equal(registry.has("codex-lb", "composer_predictions"), false);
  assert.ok(log.entries.some((entry) => entry.includes("provider codex-lb: composer_predictions")));
  assert.ok(log.entries.some((entry) => entry.includes("provider codex-lb: not codex-lb")));
});

test("the desktop main bundle is patched once while it loads", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-lb-capabilities-"));
  const original = (Module.prototype as any)._compile;
  delete (globalThis as any)[BUNDLE_STATE];
  try {
    mkdirSync(join(root, ".vite", "build"), { recursive: true });
    const bundle = join(root, ".vite", "build", "main-Test.js");
    const other = join(root, ".vite", "build", "src-Test.js");
    writeFileSync(bundle, PREDICTION_CHECK + ";module.exports=D;");
    writeFileSync(other, PREDICTION_CHECK + ";module.exports=D;");

    const log = logger();
    installBundlePatch(log, {});
    const untouched = require(other);
    const patched = require(bundle);
    assert.equal((Module.prototype as any)._compile, original);

    const registry = { has: () => true };
    withRegistry(registry, () => {
      assert.equal(patched({ modelProvider: "codex-lb" }, []), "eligible");
      assert.equal(untouched({ modelProvider: "codex-lb" }, []), "unsupported_provider");
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
