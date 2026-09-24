import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

interface CommandGroupModel {
  count: number;
  isActive: boolean;
  stateKind: "active" | "thinking" | "summary";
}

interface ActivityButton {
  model: CommandGroupModel;
  getAttribute(name: string): string | null;
}

const require = createRequire(import.meta.url);
const commandCounts = require(
  "../tweaks/collapsed-command-counts/index.js",
) as {
  __test: {
    normalizeDisplayMode(value: unknown): "active" | "all" | "off";
    readCommandGroupModel(fiber: unknown): {
      count: number;
      isActive: boolean;
      stateKind: "active" | "thinking" | "summary";
    } | null;
    shouldShowCount(
      mode: "active" | "all" | "off",
      model: { count: number; isActive: boolean },
      collapsed: boolean,
    ): boolean;
    collectVisibleCommandGroups(
      buttons: ActivityButton[],
      mode: "active" | "all" | "off",
      getModel: (button: ActivityButton) => CommandGroupModel | null,
    ): Array<{ button: ActivityButton; model: CommandGroupModel }>;
    formatCommandCountLabel(count: number): string;
    findHeaderContainer(button: unknown): unknown;
  };
};

test("collapsed command count display defaults to active sections", () => {
  assert.equal(commandCounts.__test.normalizeDisplayMode(undefined), "active");
  assert.equal(commandCounts.__test.normalizeDisplayMode("all"), "all");
  assert.equal(commandCounts.__test.normalizeDisplayMode("off"), "off");
  assert.equal(commandCounts.__test.normalizeDisplayMode("invalid"), "active");
});

test("collapsed command count reads the semantic command summary from owner fibers", () => {
  const groupFiber = {
    memoizedProps: {
      canExpand: true,
      summary: {
        props: {
          state: { kind: "active" },
          summary: {
            completedHeader: {
              summaryParts: [
                { kind: "exploration" },
                { kind: "commands", count: 7 },
              ],
            },
          },
        },
      },
    },
    return: null,
    alternate: null,
  };
  const hostFiber = {
    memoizedProps: { "aria-expanded": false },
    return: groupFiber,
    alternate: null,
  };

  assert.deepEqual(commandCounts.__test.readCommandGroupModel(hostFiber), {
    count: 7,
    isActive: true,
    stateKind: "active",
  });
});

test("collapsed command count follows an alternate owner chain", () => {
  const alternateGroup = fiberWithSummary(
    "active",
    [{ kind: "commands", count: 9 }],
  );
  const hostFiber = {
    memoizedProps: { "aria-expanded": false },
    return: null,
    alternate: {
      memoizedProps: { "aria-expanded": false },
      return: alternateGroup,
      alternate: null,
    },
  };

  assert.deepEqual(commandCounts.__test.readCommandGroupModel(hostFiber), {
    count: 9,
    isActive: true,
    stateKind: "active",
  });
});

test("collapsed command count distinguishes completed groups and missing command parts", () => {
  const completed = commandCounts.__test.readCommandGroupModel(
    fiberWithSummary("summary", [{ kind: "commands", count: 3 }]),
  );
  const noCommands = commandCounts.__test.readCommandGroupModel(
    fiberWithSummary("thinking", [{ kind: "exploration" }]),
  );

  assert.deepEqual(completed, {
    count: 3,
    isActive: false,
    stateKind: "summary",
  });
  assert.deepEqual(noCommands, {
    count: 0,
    isActive: true,
    stateKind: "thinking",
  });
});

test("collapsed command count visibility respects mode and disclosure state", () => {
  const active = { count: 4, isActive: true };
  const completed = { count: 4, isActive: false };

  assert.equal(commandCounts.__test.shouldShowCount("active", active, true), true);
  assert.equal(commandCounts.__test.shouldShowCount("active", completed, true), false);
  assert.equal(commandCounts.__test.shouldShowCount("all", completed, true), true);
  assert.equal(commandCounts.__test.shouldShowCount("all", active, false), false);
  assert.equal(commandCounts.__test.shouldShowCount("off", active, true), false);
  assert.equal(
    commandCounts.__test.shouldShowCount("active", { count: 0, isActive: true }, true),
    false,
  );
});
test("collapsed command count active mode stops at the newest active group", () => {
  const completed = activityButton("false", {
    count: 8,
    isActive: false,
    stateKind: "summary",
  });
  const expanded = activityButton("true", {
    count: 5,
    isActive: true,
    stateKind: "active",
  });
  const current = activityButton("false", {
    count: 3,
    isActive: true,
    stateKind: "active",
  });
  const calls: ActivityButton[] = [];

  const visible = commandCounts.__test.collectVisibleCommandGroups(
    [completed, expanded, current],
    "active",
    (button) => {
      calls.push(button);
      return button.model;
    },
  );

  assert.deepEqual(calls, [current]);
  assert.deepEqual(visible, [{ button: current, model: current.model }]);
});

test("collapsed command count active mode stops at the newest completed group", () => {
  const olderActive = activityButton("false", {
    count: 6,
    isActive: true,
    stateKind: "active",
  });
  const newestCompleted = activityButton("false", {
    count: 4,
    isActive: false,
    stateKind: "summary",
  });
  const calls: ActivityButton[] = [];

  const visible = commandCounts.__test.collectVisibleCommandGroups(
    [olderActive, newestCompleted],
    "active",
    (button) => {
      calls.push(button);
      return button.model;
    },
  );

  assert.deepEqual(calls, [newestCompleted]);
  assert.deepEqual(visible, []);
});

test("collapsed command count all mode skips expanded groups before model lookup", () => {
  const first = activityButton("false", {
    count: 2,
    isActive: false,
    stateKind: "summary",
  });
  const expanded = activityButton("true", {
    count: 9,
    isActive: true,
    stateKind: "active",
  });
  const second = activityButton("false", {
    count: 4,
    isActive: true,
    stateKind: "thinking",
  });
  const calls: ActivityButton[] = [];

  const visible = commandCounts.__test.collectVisibleCommandGroups(
    [first, expanded, second],
    "all",
    (button) => {
      calls.push(button);
      return button.model;
    },
  );

  assert.deepEqual(calls, [first, second]);
  assert.deepEqual(visible, [
    { button: first, model: first.model },
    { button: second, model: second.model },
  ]);
});

test("collapsed command count formats accessible labels", () => {
  assert.equal(commandCounts.__test.formatCommandCountLabel(1), "1 command");
  assert.equal(commandCounts.__test.formatCommandCountLabel(6), "6 commands");
});

test("collapsed command count selects the visible activity header container", () => {
  const iconHeader = {
    classList: { contains: (value: string) => value === "group/activity-header" },
  };
  const overlayButton = { parentElement: iconHeader };
  const inlineButton = {
    parentElement: {
      classList: { contains: () => false },
    },
  };

  assert.equal(commandCounts.__test.findHeaderContainer(overlayButton), iconHeader);
  assert.equal(commandCounts.__test.findHeaderContainer(inlineButton), inlineButton);
});

function activityButton(
  expanded: "true" | "false",
  model: CommandGroupModel,
): ActivityButton {
  return {
    model,
    getAttribute(name: string) {
      return name === "aria-expanded" ? expanded : null;
    },
  };
}

function fiberWithSummary(
  stateKind: "active" | "thinking" | "summary",
  summaryParts: Array<{ kind: string; count?: number }>,
): unknown {
  return {
    memoizedProps: {},
    alternate: null,
    return: {
      memoizedProps: {
        canExpand: true,
        summary: {
          props: {
            state: { kind: stateKind },
            summary: {
              completedHeader: { summaryParts },
            },
          },
        },
      },
      alternate: null,
      return: null,
    },
  };
}
