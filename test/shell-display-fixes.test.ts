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
  "shell-display-fixes",
  "index.js",
)) as {
  __test: {
    stripMsysPrefix(command: unknown): unknown;
    normalizeTextNode(node: unknown): boolean;
    selectTopLevelRoots(nodes: unknown[]): unknown[];
    collectMutationRoots(mutations: unknown[]): unknown[];
    shouldYieldBatch(steps: number, elapsedMs: number): boolean;
  };
};

test("shell display strips supported MSYS bootstrap assignments", () => {
  assert.equal(
    tweak.__test.stripMsysPrefix(
      "export MSYSTEM=UCRT64 CHERE_INVOKING=1; pwd",
    ),
    "pwd",
  );
  assert.equal(
    tweak.__test.stripMsysPrefix(
      "  \n export CHERE_INVOKING=1 MSYSTEM=UCRT64;   git status",
    ),
    "git status",
  );
  assert.equal(
    tweak.__test.stripMsysPrefix("export MSYSTEM=UCRT64; uname -a"),
    "uname -a",
  );
});

test("shell display yields large or time-consuming batches", () => {
  assert.equal(tweak.__test.shouldYieldBatch(599, 10), false);
  assert.equal(tweak.__test.shouldYieldBatch(600, 0), true);
  assert.equal(tweak.__test.shouldYieldBatch(64, 4), true);
  assert.equal(tweak.__test.shouldYieldBatch(63, 10), false);
});

test("shell display preserves unrelated exports and ordinary text", () => {
  assert.equal(
    tweak.__test.stripMsysPrefix("export PATH=/tmp; pwd"),
    "export PATH=/tmp; pwd",
  );
  assert.equal(
    tweak.__test.stripMsysPrefix("echo export MSYSTEM=UCRT64; pwd"),
    "echo export MSYSTEM=UCRT64; pwd",
  );
  assert.equal(
    tweak.__test.stripMsysPrefix("export MSYSTEM=UCRT64"),
    "export MSYSTEM=UCRT64",
  );
  assert.equal(tweak.__test.stripMsysPrefix("plain output"), "plain output");
  assert.equal(tweak.__test.stripMsysPrefix(null), null);
});

test("shell display caches normalized text values and handles React rewrites", () => {
  let value = "export MSYSTEM=UCRT64 CHERE_INVOKING=1; pwd";
  let writes = 0;
  const node = {
    get nodeValue() {
      return value;
    },
    set nodeValue(next: string) {
      writes += 1;
      value = next;
    },
  };

  assert.equal(tweak.__test.normalizeTextNode(node), true);
  assert.equal(value, "pwd");
  assert.equal(writes, 1);

  assert.equal(tweak.__test.normalizeTextNode(node), false);
  assert.equal(writes, 1);

  value = "export MSYSTEM=UCRT64 CHERE_INVOKING=1; pwd";
  assert.equal(tweak.__test.normalizeTextNode(node), true);
  assert.equal(value, "pwd");
  assert.equal(writes, 2);
});

test("shell display collapses nested mutation roots", () => {
  const parent = { nodeType: 1, parentNode: null };
  const child = { nodeType: 1, parentNode: parent };
  const text = { nodeType: 3, parentNode: child };
  const sibling = { nodeType: 1, parentNode: null };

  assert.deepEqual(
    tweak.__test.selectTopLevelRoots([text, child, parent, sibling, parent]),
    [parent, sibling],
  );
  assert.deepEqual(
    tweak.__test.collectMutationRoots([
      { addedNodes: [child, text] },
      { addedNodes: [parent, sibling] },
    ]),
    [parent, sibling],
  );
});
