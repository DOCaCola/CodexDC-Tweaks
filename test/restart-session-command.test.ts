import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const tweak = require(
  join(
    process.cwd(),
    "tweaks",
    "restart-session-command",
    "index.js",
  ),
) as {
  start(api: unknown): Promise<void> | void;
  stop(): void;
};

test("restart session command registers and restarts the local backend", async () => {
  let registeredCommand: {
    name: string;
    title: string;
    description?: string;
    execute(): Promise<void>;
  } | null = null;
  let unregistered = false;
  let restarted = false;
  let notificationWasAfterRestart = false;
  const restartCalls: unknown[] = [];
  const appended: FakeElement[] = [];
  let notificationTimer: (() => void) | null = null;
  const surface = fakeElement();
  surface.getBoundingClientRect = () => ({
    left: 100,
    top: 20,
    width: 800,
  });
  surface.appendChild = (child: FakeElement) => {
    notificationWasAfterRestart = restarted;
    appended.push(child);
    return child;
  };
  const activeElement = fakeElement();
  activeElement.closest = () => surface;
  const fakeDocument = {
    activeElement,
    body: surface,
    createElement: () => fakeElement(),
    querySelector: () => surface,
    querySelectorAll: () => [],
  };
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.setTimeout = ((callback: () => void) => {
    notificationTimer = callback;
    return 1;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {
    notificationTimer = null;
  }) as typeof clearTimeout;

  try {
    tweak.start({
      composer: {
        slashCommands: {
          register(command: NonNullable<typeof registeredCommand>) {
            registeredCommand = command;
            return {
              unregister() {
                unregistered = true;
              },
            };
          },
        },
      },
      codex: {
        runtime: {
          async restartAppServer(options: unknown) {
            restartCalls.push(options);
            restarted = true;
          },
        },
      },
      log: {
        info() {},
      },
    });

    assert.ok(registeredCommand);
    assert.equal(registeredCommand.name, "restart-session");
    assert.equal(registeredCommand.title, "Restart Codex backend");
    assert.match(registeredCommand.description ?? "", /all local chats/);

    await registeredCommand.execute();

    assert.deepEqual(restartCalls, [{
      hostId: "local",
      killCodexProcess: true,
    }]);
    assert.equal(notificationWasAfterRestart, true);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].dataset.codexppRestartSessionNotification, "true");
    assert.equal(appended[0].attributes.role, "status");
    assert.equal(appended[0].attributes["aria-live"], "polite");
    assert.match(appended[0].textContent, /all local chats/);
    assert.equal(appended[0].classList.removed.has("opacity-0"), true);

    notificationTimer?.();
    assert.equal(appended[0].removed, true);

    tweak.stop();
    assert.equal(unregistered, true);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
    if (originalRequestAnimationFrame === undefined) {
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    } else {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

interface FakeElement {
  attributes: Record<string, string>;
  classList: {
    removed: Set<string>;
    remove(...names: string[]): void;
  };
  className: string;
  dataset: Record<string, string>;
  removed: boolean;
  style: Record<string, string>;
  textContent: string;
  appendChild(child: FakeElement): FakeElement;
  closest(selector: string): FakeElement | null;
  getBoundingClientRect(): { left: number; top: number; width: number };
  remove(): void;
  setAttribute(name: string, value: string): void;
}

function fakeElement(): FakeElement {
  return {
    attributes: {},
    classList: {
      removed: new Set(),
      remove(...names: string[]) {
        for (const name of names) this.removed.add(name);
      },
    },
    className: "",
    dataset: {},
    removed: false,
    style: {},
    textContent: "",
    appendChild(child) {
      return child;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0 };
    },
    remove() {
      this.removed = true;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
}
