import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const tweak = require("../tweaks/hide-get-plus-button/index.js") as {
  __test: {
    normalizeLabel(value: unknown): string;
    isGetPlusLabel(value: unknown): boolean;
    isGetPlusControl(control: unknown): boolean;
    hideControl(control: FakeControl): void;
    restoreControl(control: FakeControl): void;
  };
};

test("hide Get Plus recognizes only the profile upgrade labels", () => {
  assert.equal(tweak.__test.normalizeLabel("  Upgrade   for higher limits "), "upgrade for higher limits");
  assert.equal(tweak.__test.isGetPlusLabel("Get Plus"), true);
  assert.equal(tweak.__test.isGetPlusLabel("Upgrade for higher limits"), true);
  assert.equal(tweak.__test.isGetPlusLabel("Rejoin Plus"), true);
  assert.equal(tweak.__test.isGetPlusLabel("Upgrade to Plus"), false);
  assert.equal(tweak.__test.isGetPlusLabel("Try Plus"), false);

  assert.equal(tweak.__test.isGetPlusControl(fakeControl({ textContent: "Get Plus" })), true);
  assert.equal(
    tweak.__test.isGetPlusControl(fakeControl({ ariaLabel: "Upgrade for higher limits" })),
    true,
  );
  assert.equal(
    tweak.__test.isGetPlusControl(fakeControl({ textContent: "Upgrade to Plus" })),
    false,
  );
  assert.equal(
    tweak.__test.isGetPlusControl(fakeControl({ matches: false, textContent: "Get Plus" })),
    false,
  );
});

test("hide Get Plus restores the control's previous inline display", () => {
  const control = fakeControl({
    display: "inline-flex",
    displayPriority: "",
    textContent: "Get Plus",
  });

  tweak.__test.hideControl(control);
  assert.equal(control.dataset.codexppHideGetPlus, "true");
  assert.equal(control.style.getPropertyValue("display"), "none");
  assert.equal(control.style.getPropertyPriority("display"), "important");

  tweak.__test.restoreControl(control);
  assert.equal(control.dataset.codexppHideGetPlus, undefined);
  assert.equal(control.style.getPropertyValue("display"), "inline-flex");
  assert.equal(control.style.getPropertyPriority("display"), "");
});

interface FakeControl {
  dataset: Record<string, string>;
  isConnected: boolean;
  style: {
    getPropertyPriority(name: string): string;
    getPropertyValue(name: string): string;
    removeProperty(name: string): string;
    setProperty(name: string, value: string, priority?: string): void;
  };
  textContent: string;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
}

function fakeControl(options: {
  ariaLabel?: string;
  display?: string;
  displayPriority?: string;
  matches?: boolean;
  textContent?: string;
  title?: string;
}): FakeControl {
  const properties = new Map<string, { value: string; priority: string }>();
  if (options.display) {
    properties.set("display", {
      value: options.display,
      priority: options.displayPriority ?? "",
    });
  }

  return {
    dataset: {},
    isConnected: true,
    style: {
      getPropertyPriority(name) {
        return properties.get(name)?.priority ?? "";
      },
      getPropertyValue(name) {
        return properties.get(name)?.value ?? "";
      },
      removeProperty(name) {
        const previous = properties.get(name)?.value ?? "";
        properties.delete(name);
        return previous;
      },
      setProperty(name, value, priority = "") {
        properties.set(name, { value, priority });
      },
    },
    textContent: options.textContent ?? "",
    getAttribute(name) {
      if (name === "aria-label") return options.ariaLabel ?? null;
      if (name === "title") return options.title ?? null;
      return null;
    },
    matches() {
      return options.matches !== false;
    },
  };
}
