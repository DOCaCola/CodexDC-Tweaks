import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const testDir = dirname(fileURLToPath(import.meta.url));
const tweak = require(join(
  testDir,
  "..",
  "tweaks",
  "unlimited-model-selection",
  "index.js",
)) as {
  __test: {
    isModelCatalog(value: unknown): boolean;
    stripVersionGrouping(payload: unknown): number;
    patchPostMessage(
      prototype: object,
      onRewrite: (rewritten: number, error?: unknown) => void,
    ): (() => void) | null;
    messagePortPrototypes(): object[];
  };
};

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    models: [{ slug: "gpt-5.6-sol" }, { slug: "gpt-5.6-luna" }],
    categories: [{ default_model: "gpt-5.6-sol" }],
    versions: [
      { id: "sol", slugs: ["gpt-5.6-sol"], options: [{ slug: "gpt-5.6-sol" }] },
      { id: "luna", slugs: ["gpt-5.6-luna"], options: [{ slug: "gpt-5.6-luna" }] },
    ],
    default_model_slug: "gpt-5.6-sol",
    ...overrides,
  };
}

test("model catalogs are recognised by their catalog arrays", () => {
  assert.equal(tweak.__test.isModelCatalog(catalog()), true);
  assert.equal(tweak.__test.isModelCatalog({ versions: [], models: [] }), false);
  assert.equal(tweak.__test.isModelCatalog({ versions: [], categories: [] }), false);
  assert.equal(tweak.__test.isModelCatalog([catalog()]), false);
  assert.equal(tweak.__test.isModelCatalog(null), false);
});

test("version grouping is cleared on a catalog inside a transport payload", () => {
  const payload = {
    type: "return",
    id: 7,
    result: { data: { catalog: catalog() } },
  };

  assert.equal(tweak.__test.stripVersionGrouping(payload), 1);
  assert.deepEqual(payload.result.data.catalog.versions, []);
  assert.equal(payload.result.data.catalog.default_model_slug, "gpt-5.6-sol");
});

test("every catalog in an array payload is cleared", () => {
  const payload = { result: [catalog(), { nested: catalog() }] };

  assert.equal(tweak.__test.stripVersionGrouping(payload), 2);
  assert.deepEqual(payload.result[0].versions, []);
  assert.deepEqual(payload.result[1].nested.versions, []);
});

test("already flat catalogs and unrelated payloads are left alone", () => {
  const flat = { result: catalog({ versions: [] }) };
  const unrelated = {
    result: { data: [{ model: "gpt-5.6-luna", hidden: false }], nextCursor: null },
  };

  assert.equal(tweak.__test.stripVersionGrouping(flat), 0);
  assert.equal(tweak.__test.stripVersionGrouping(unrelated), 0);
  assert.deepEqual(unrelated, {
    result: { data: [{ model: "gpt-5.6-luna", hidden: false }], nextCursor: null },
  });
});

test("cyclic payloads terminate without losing the rewrite", () => {
  const payload: Record<string, unknown> = { result: catalog() };
  payload.self = payload;

  assert.equal(tweak.__test.stripVersionGrouping(payload), 1);
  assert.deepEqual((payload.result as { versions: unknown[] }).versions, []);
});

test("postMessage forwards the rewritten payload and its transfer list", () => {
  const sent: unknown[][] = [];
  const prototype = {
    postMessage(this: unknown, value: unknown, ...rest: unknown[]) {
      sent.push([value, ...rest]);
      return "sent";
    },
  };
  const reports: number[] = [];
  const restore = tweak.__test.patchPostMessage(prototype, (rewritten) => {
    reports.push(rewritten);
  });
  assert.ok(restore);

  const payload = { result: catalog() };
  const transfer = [{ buffer: 1 }];
  assert.equal(prototype.postMessage(payload, transfer), "sent");
  assert.equal(reports[0], 1);
  assert.deepEqual((sent[0][0] as { result: { versions: unknown[] } }).result.versions, []);
  assert.equal(sent[0][1], transfer);

  assert.equal(tweak.__test.patchPostMessage(prototype, () => {}), null);

  restore!();
  const repatched = tweak.__test.patchPostMessage(prototype, () => {});
  assert.equal(typeof repatched, "function");
  repatched!();
});

test("postMessage keeps forwarding when the catalog scan throws", () => {
  const sent: unknown[] = [];
  const prototype = {
    postMessage(value: unknown) {
      sent.push(value);
    },
  };
  const errors: unknown[] = [];
  const restore = tweak.__test.patchPostMessage(prototype, (rewritten, error) => {
    if (error) errors.push(error);
  });
  assert.ok(restore);

  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  );
  prototype.postMessage(hostile);
  assert.deepEqual(sent, [hostile]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
});

test("the node MessagePort transport is discoverable", () => {
  assert.ok(tweak.__test.messagePortPrototypes().length > 0);
});

test("a real MessagePort round trip delivers an ungrouped catalog", async () => {
  const { MessageChannel } = await import("node:worker_threads");
  const patched = tweak
    .__test.messagePortPrototypes()
    .map((prototype) => tweak.__test.patchPostMessage(prototype, () => {}))
    .filter((restore) => restore !== null);
  assert.ok(patched.length > 0);

  try {
    const { port1, port2 } = new MessageChannel();
    const received = new Promise<Record<string, unknown>>((resolve) => {
      port2.once("message", resolve);
      port2.start();
    });

    port1.postMessage({ result: catalog() });
    const payload = (await received) as { result: { versions: unknown[] } };
    assert.deepEqual(payload.result.versions, []);

    const passthrough = new Promise((resolve) => {
      port2.once("message", resolve);
    });
    port1.postMessage({ type: "ping" }, [new ArrayBuffer(8)]);
    assert.deepEqual(await passthrough, { type: "ping" });

    port1.close();
    port2.close();
  } finally {
    for (const restore of patched) restore!();
  }
});
