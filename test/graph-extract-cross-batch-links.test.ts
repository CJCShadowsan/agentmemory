import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, isGraphExtractionEnabled: () => true };
});

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, GraphEdge, GraphNode } from "../src/types.js";

function clone<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      clone((store.get(scope)?.get(key) as T) ?? null),
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      const stored = clone(data);
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, stored);
      return clone(stored);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? clone(Array.from(m.values()) as T[]) : [];
    },
  };
}

function obs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: `obs ${id}`,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 0.5,
  };
}

/** Registers mem::graph-extract with a provider that replays canned LLM output. */
function harness(replies: string[]) {
  const kv = mockKV();
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string, fn: (data: unknown) => Promise<unknown>) =>
      handlers.set(id, fn),
    registerTrigger: () => {},
    trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => {
      const fn = handlers.get(function_id);
      if (!fn) throw new Error(`no handler for ${function_id}`);
      return fn(payload);
    },
  } as never;
  let call = 0;
  const provider = {
    name: "fake",
    compress: async () => replies[Math.min(call++, replies.length - 1)],
    summarize: async () => "",
  };
  registerGraphFunction(sdk, kv as never, provider as never);
  const extract = (observations: CompressedObservation[]) =>
    handlers.get("mem::graph-extract")!({ observations }) as Promise<{
      success: boolean;
      edgesAdded: number;
      nodesAdded: number;
    }>;
  return { kv, extract };
}

describe("graph extraction relationship retention", () => {
  beforeEach(() => vi.clearAllMocks());

  it("links a new entity to one an earlier batch already extracted", async () => {
    const { extract, kv } = harness([
      // Batch 1 introduces "authentication" with no relationships.
      `<entities><entity type="concept" name="authentication" /></entities>`,
      // Batch 2 introduces "jwt" and relates it to the already-known entity.
      `<entities>
         <entity type="concept" name="jwt" />
         <relationship type="uses" source="jwt" target="authentication" weight="0.8" />
       </entities>`,
    ]);

    await extract([obs("o1")]);
    const second = await extract([obs("o2")]);

    const edges = await kv.list<GraphEdge>(KV.graphEdges);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("uses");

    const nodes = await kv.list<GraphNode>(KV.graphNodes);
    const byName = new Map(nodes.map((n) => [n.name, n.id]));
    expect(edges[0].sourceNodeId).toBe(byName.get("jwt"));
    expect(edges[0].targetNodeId).toBe(byName.get("authentication"));
    expect(second.edgesAdded).toBe(1);
  });

  it("does not invent an edge when the referenced entity was never extracted", async () => {
    const { extract, kv } = harness([
      `<entities>
         <entity type="concept" name="jwt" />
         <relationship type="uses" source="jwt" target="never-extracted" weight="0.8" />
       </entities>`,
    ]);

    await extract([obs("o1")]);
    expect(await kv.list<GraphEdge>(KV.graphEdges)).toHaveLength(0);
  });
});
