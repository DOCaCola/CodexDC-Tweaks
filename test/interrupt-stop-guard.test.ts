import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const guard = require("../tweaks/interrupt-stop-guard/index.js") as {
  __test: {
    normalizeLabel(value: unknown): string;
    isStopLabel(value: unknown): boolean;
    isComposerStopButton(button: unknown): boolean;
    createGuardState(): {
      pending: boolean;
      pendingButton: unknown;
      sawIdle: boolean;
    };
    observeStopPhase(
      state: { pending: boolean; pendingButton: unknown; sawIdle: boolean },
      hasStopButton: boolean,
    ): void;
  };
};

test("interrupt stop guard recognizes only the composer stop control", () => {
  assert.equal(guard.__test.normalizeLabel("  Stop   generating "), "stop generating");
  assert.equal(guard.__test.isStopLabel("Stop"), true);
  assert.equal(guard.__test.isStopLabel("Stop all"), false);
  assert.equal(guard.__test.isStopLabel("Send"), false);

  assert.equal(
    guard.__test.isComposerStopButton(fakeButton("Stop", "size-token-button-composer")),
    true,
  );
  assert.equal(
    guard.__test.isComposerStopButton(fakeButton(null, "size-token-button-composer", "Stop")),
    true,
  );
  assert.equal(
    guard.__test.isComposerStopButton(fakeButton("Stop all", "size-token-button-composer")),
    false,
  );
  assert.equal(
    guard.__test.isComposerStopButton(fakeButton("Stop", "size-4")),
    false,
  );
});

test("interrupt stop guard resets after the visible stop phase ends", () => {
  const state = guard.__test.createGuardState();
  state.pending = true;
  state.pendingButton = {};
  state.sawIdle = false;

  guard.__test.observeStopPhase(state, false);
  assert.equal(state.pending, false);
  assert.equal(state.pendingButton, null);
  assert.equal(state.sawIdle, true);

  guard.__test.observeStopPhase(state, true);
  assert.equal(state.pending, false);
  assert.equal(state.pendingButton, null);
  assert.equal(state.sawIdle, false);
});

function fakeButton(label: string | null, className: string, title: string | null = null): object {
  return {
    tagName: "BUTTON",
    classList: {
      contains(value: string) {
        return value === className;
      },
    },
    getAttribute(name: string) {
      if (name === "aria-label") {
        return label;
      }
      return name === "title" ? title : null;
    },
  };
}
