import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const timestamps = require(
  "../tweaks/message-timestamps/index.js",
) as {
  __test: {
    normalizePreferences(value: unknown): {
      user: boolean;
      assistant: boolean;
    };
    readPreferences(storage: {
      get(key: string, fallback: boolean): unknown;
    }): {
      user: boolean;
      assistant: boolean;
    };
    normalizeTimestampText(value: unknown): string | null;
    normalizeSentAtMs(value: unknown): number | null;
    readSentAtMs(fiber: unknown): number | null;
    findDirectChildContaining(root: unknown, descendant: unknown): unknown;
    collectBranchElements(root: unknown, descendant: unknown): unknown[];
    findUserTimestampSource(
      bubble: unknown,
      getFiber: (element: unknown) => unknown,
    ): {
      root: unknown;
      source: unknown;
      actionBranch: unknown;
      revealElements: unknown[];
      sentAtMs: number;
    } | null;
    isTimestampMatchValid(bubble: unknown, match: unknown): boolean;
    applyTimestampMarkers(elements: Set<{
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
    }>): void;
    buildStyleText(preferences: { user: boolean; assistant: boolean }): string;
  };
};

test("message timestamp preferences default on and remain independent", () => {
  const stored = new Map<string, unknown>([
    ["alwaysShowUserMessages", false],
  ]);
  const preferences = timestamps.__test.readPreferences({
    get(key, fallback) {
      return stored.has(key) ? stored.get(key) : fallback;
    },
  });

  assert.deepEqual(preferences, {
    user: false,
    assistant: true,
  });
  assert.match(
    timestamps.__test.buildStyleText({ user: true, assistant: true }),
    /data-assistant-message-sent-time/,
  );
  assert.doesNotMatch(
    timestamps.__test.buildStyleText({ user: true, assistant: false }),
    /data-assistant-message-sent-time/,
  );
  assert.match(
    timestamps.__test.buildStyleText({ user: true, assistant: false }),
    /data-codexpp-native-user-message-sent-time/,
  );
});

test("message timestamp helpers read semantic sentAtMs props", () => {
  assert.equal(
    timestamps.__test.normalizeTimestampText("  Friday   10:19 PM  "),
    "Friday 10:19 PM",
  );
  assert.equal(timestamps.__test.normalizeTimestampText("   "), null);
  assert.equal(timestamps.__test.normalizeSentAtMs("1785600000000"), 1785600000000);
  assert.equal(timestamps.__test.normalizeSentAtMs(0), null);

  const owner = {
    memoizedProps: { sentAtMs: 1785600000000 },
    return: null,
    alternate: null,
  };
  const host = {
    memoizedProps: {},
    return: owner,
    alternate: null,
  };
  assert.equal(timestamps.__test.readSentAtMs(host), 1785600000000);

  const alternateOnly = {
    memoizedProps: {},
    return: null,
    alternate: {
      memoizedProps: { sentAtMs: 1785600000123 },
      return: null,
      alternate: null,
    },
  };
  assert.equal(timestamps.__test.readSentAtMs(alternateOnly), 1785600000123);
});

test("message timestamp helpers find and reveal the native user timestamp branch", () => {
  const root = fakeElement();
  const contentBranch = fakeElement({ parentElement: root });
  const bubble = fakeElement({ parentElement: contentBranch });
  const actionBranch = fakeElement({ parentElement: root });
  const nativeContainer = fakeElement({ parentElement: actionBranch });
  const source = fakeElement({
    parentElement: nativeContainer,
    textContent: "10:19 PM",
  });
  const sentAtMs = 1785600000000;
  const sourceFiber = {
    memoizedProps: {},
    return: {
      memoizedProps: { sentAtMs },
      return: null,
      alternate: null,
    },
    alternate: null,
  };

  contentBranch.querySelectorAll = () => [];
  root.querySelectorAll = () => [source];

  assert.equal(
    timestamps.__test.findDirectChildContaining(root, source),
    actionBranch,
  );
  assert.deepEqual(
    timestamps.__test.collectBranchElements(root, source),
    [source, nativeContainer, actionBranch],
  );
  assert.deepEqual(
    timestamps.__test.findUserTimestampSource(
      bubble,
      (element) => element === source ? sourceFiber : null,
    ),
    {
      root,
      source,
      actionBranch,
      revealElements: [source, nativeContainer, actionBranch],
      sentAtMs,
    },
  );
});

test("message timestamp markers only write changed elements", () => {
  const first = markerElement();
  const second = markerElement();

  timestamps.__test.applyTimestampMarkers(new Set([first]));
  timestamps.__test.applyTimestampMarkers(new Set([first]));
  assert.equal(first.setCalls, 1);
  assert.equal(first.removeCalls, 0);

  timestamps.__test.applyTimestampMarkers(new Set([second]));
  assert.equal(first.removeCalls, 1);
  assert.equal(second.setCalls, 1);

  timestamps.__test.applyTimestampMarkers(new Set());
});

test("message timestamp cache entries require connected elements in the same root", () => {
  const bubble = {};
  const source = { isConnected: true };
  const root = {
    contains(value: unknown) {
      return value === bubble || value === source;
    },
  };

  assert.equal(
    timestamps.__test.isTimestampMatchValid(bubble, { root, source }),
    true,
  );
  source.isConnected = false;
  assert.equal(
    timestamps.__test.isTimestampMatchValid(bubble, { root, source }),
    false,
  );
});

interface MarkerElement {
  setCalls: number;
  removeCalls: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function markerElement(): MarkerElement {
  return {
    setCalls: 0,
    removeCalls: 0,
    setAttribute() {
      this.setCalls += 1;
    },
    removeAttribute() {
      this.removeCalls += 1;
    },
  };
}

interface FakeElement {
  parentElement: FakeElement | null;
  textContent: string;
  contains(value: unknown): boolean;
  querySelectorAll(selector?: string): FakeElement[];
}

interface FakeElementOptions {
  parentElement?: FakeElement | null;
  textContent?: string;
}

function fakeElement(options: FakeElementOptions = {}): FakeElement {
  return {
    parentElement: options.parentElement ?? null,
    textContent: options.textContent ?? "",
    contains() {
      return false;
    },
    querySelectorAll() {
      return [];
    },
  };
}
