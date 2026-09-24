import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

interface SpawnMetadata {
  model: string | null;
  reasoningEffort: string | null;
}

const require = createRequire(import.meta.url);
const subagentMetadata = require(
  "../tweaks/subagent-metadata/index.js",
) as {
  __test: {
    readSubagentFromProps(props: unknown): Record<string, unknown> | null;
    readSubagentFromFiber(fiber: unknown): Record<string, unknown> | null;
    metadataForSubagent(
      subagent: unknown,
      metadataByThreadId?: Map<string, SpawnMetadata>,
    ): {
      threadId: string;
      model: string | null;
      reasoningEffort: string | null;
    } | null;
    formatMetadataLine(metadata: SpawnMetadata): string;
    formatMetadataTitle(metadata: SpawnMetadata): string;
    indexMessagePayload(
      payload: unknown,
      metadataByThreadId?: Map<string, SpawnMetadata>,
      maxNodes?: number,
    ): {
      changed: boolean;
      visitedNodes: number;
      truncated: boolean;
    };
  };
};

test("subagent metadata reads the local panel row's semantic trailing props", () => {
  const subagent = {
    conversationId: "thread-child",
    displayName: "worker",
    spawnModel: "gpt-5.6-luna",
  };
  const props = {
    item: {
      id: "thread-child",
      trailing: {
        props: { subagent },
      },
    },
  };

  assert.equal(subagentMetadata.__test.readSubagentFromProps(props), subagent);
  assert.equal(
    subagentMetadata.__test.readSubagentFromFiber({
      memoizedProps: {},
      return: {
        memoizedProps: props,
        return: null,
        alternate: null,
      },
      alternate: null,
    }),
    subagent,
  );
});

test("subagent metadata combines row model data with tracked reasoning effort", () => {
  const tracked = new Map<string, SpawnMetadata>([
    [
      "thread-child",
      {
        model: "gpt-5.5-codex",
        reasoningEffort: "high",
      },
    ],
  ]);

  assert.deepEqual(
    subagentMetadata.__test.metadataForSubagent(
      {
        conversationId: "thread-child",
        spawnModel: "gpt-5.6-luna",
      },
      tracked,
    ),
    {
      threadId: "thread-child",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    },
  );
});

test("subagent metadata indexes nested historical and live collab tool calls", () => {
  const tracked = new Map<string, SpawnMetadata>();
  const result = subagentMetadata.__test.indexMessagePayload(
    {
      type: "app-server-response",
      result: {
        thread: {
          turns: [
            {
              items: [
                {
                  type: "collabAgentToolCall",
                  tool: "spawnAgent",
                  receiverThreadIds: ["thread-a", "thread-b"],
                  receiverThreads: [{ threadId: "thread-c" }],
                  model: "gpt-5.6-luna",
                  reasoningEffort: "xhigh",
                },
              ],
            },
          ],
        },
      },
    },
    tracked,
  );

  assert.equal(result.changed, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(tracked.get("thread-a"), {
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(tracked.get("thread-b"), tracked.get("thread-a"));
  assert.deepEqual(tracked.get("thread-c"), tracked.get("thread-a"));
});

test("subagent metadata preserves known fields when later events are partial", () => {
  const tracked = new Map<string, SpawnMetadata>([
    [
      "thread-child",
      {
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
    ],
  ]);

  subagentMetadata.__test.indexMessagePayload(
    {
      item: {
        type: "collabAgentToolCall",
        tool: "resumeAgent",
        receiverThreadIds: ["thread-child"],
        model: "gpt-5.6-terra",
      },
    },
    tracked,
  );

  assert.deepEqual(tracked.get("thread-child"), {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
  });
});

test("subagent metadata bounds cyclic message scans", () => {
  const payload: Record<string, unknown> = {
    item: {
      type: "collabAgentToolCall",
      receiverThreadIds: ["thread-child"],
      reasoning_effort: "medium",
    },
  };
  payload.self = payload;

  const tracked = new Map<string, SpawnMetadata>();
  const result = subagentMetadata.__test.indexMessagePayload(
    payload,
    tracked,
    8,
  );

  assert.equal(result.truncated, false);
  assert.deepEqual(tracked.get("thread-child"), {
    model: null,
    reasoningEffort: "medium",
  });
});

test("subagent metadata formats compact rows and explicit tooltips", () => {
  assert.equal(
    subagentMetadata.__test.formatMetadataLine({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    }),
    "gpt-5.6-luna | high",
  );
  assert.equal(
    subagentMetadata.__test.formatMetadataLine({
      model: null,
      reasoningEffort: "medium",
    }),
    "Reasoning: medium",
  );
  assert.equal(
    subagentMetadata.__test.formatMetadataTitle({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
    }),
    "Model: gpt-5.6-luna\nReasoning: high",
  );
});
