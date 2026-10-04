import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type { Crystal, GraphNode, GraphSnapshot, Insight, MemoryProvider } from "../types.js";
import { getXmlChildren, getXmlTag } from "../prompts/xml.js";
import { logger } from "../logger.js";
import { recordAudit } from "./audit.js";
import { reinforceInsight } from "./reflect.js";

const DISTILL_SYSTEM = `You are a knowledge distillation engine for an AI coding agent's long-term memory.
You receive the highest-degree entities from the agent's knowledge graph: the concepts, files, functions,
libraries, people, decisions, patterns, and errors that recur across many sessions.

Turn that graph into compact, durable memory artifacts. Discard one-off trivia and environment-specific noise.

Output EXACTLY this XML structure, with no prose before or after it:

<insights>
  <insight confidence="0.0-1.0" title="short claim title">one-sentence durable claim</insight>
</insights>
<lessons>
  <lesson confidence="0.0-1.0" context="when this rule applies">imperative behavioral rule, stated generally</lesson>
</lessons>
<crystals>
  <crystal>
    <narrative>2-4 sentence account of a completed, reusable procedure and what it achieved</narrative>
    <keyOutcomes>
      <outcome>concrete result</outcome>
    </keyOutcomes>
    <lessons>
      <lesson>lesson implied by this procedure</lesson>
    </lessons>
  </crystal>
</crystals>

Rules:
- At most 8 insights, 8 lessons, and 4 crystals. Fewer is better than padding.
- Emit a section only when the graph gives real evidence for it; omit the section entirely otherwise.
- Insights are claims about what is true in this codebase or workflow.
- Lessons are imperative rules general enough to apply to future sessions, not restatements of one node.
- Crystals describe a reusable multi-step procedure, never a single fact.
- Confidence reflects how strongly the graph supports the claim.`;

type DistillScope = "all" | "insights" | "lessons" | "crystals";

interface DistillPayload {
  scope?: DistillScope;
  limit?: number;
  minDegree?: number;
  project?: string;
}

interface DistillCounts {
  insightsAdded: number;
  insightsReinforced: number;
  lessonsAdded: number;
  lessonsStrengthened: number;
  crystalsAdded: number;
  crystalsReinforced: number;
  nodesConsidered: number;
}

const EMPTY_COUNTS: DistillCounts = {
  insightsAdded: 0,
  insightsReinforced: 0,
  lessonsAdded: 0,
  lessonsStrengthened: 0,
  crystalsAdded: 0,
  crystalsReinforced: 0,
  nodesConsidered: 0,
};

function emptyResult(message: string): { success: true; message: string } & DistillCounts {
  return { success: true, message, ...EMPTY_COUNTS };
}

function buildDistillPrompt(nodes: GraphNode[]): string {
  const lines = nodes.map((node) => {
    const props = Object.entries(node.properties ?? {})
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 6)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    const degree = node.sourceObservationIds?.length ?? 0;
    return `- (${node.type}) ${node.name} [degree ${degree}]${props ? ` {${props}}` : ""}`;
  });
  return `Knowledge graph entities by degree:\n\n${lines.join("\n")}`;
}

function parseConfidence(raw: string | undefined, fallback = 0.5): number {
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isNaN(parsed) ? fallback : Math.max(0, Math.min(1, parsed));
}

interface ParsedDistill {
  insights: { title: string; content: string; confidence: number }[];
  lessons: { content: string; context: string; confidence: number }[];
  crystals: { narrative: string; keyOutcomes: string[]; lessons: string[] }[];
}

function parseDistillXml(xml: string): ParsedDistill {
  const insights: ParsedDistill["insights"] = [];
  const insightRe = /<insight\s+confidence="([^"]+)"\s+title="([^"]*)"\s*>([\s\S]*?)<\/insight>/g;
  let match: RegExpExecArray | null;
  while ((match = insightRe.exec(xml)) !== null) {
    const content = match[3].trim();
    if (!content) continue;
    insights.push({
      title: match[2].trim() || content.slice(0, 80),
      content,
      confidence: parseConfidence(match[1]),
    });
  }

  const lessons: ParsedDistill["lessons"] = [];
  const lessonRe = /<lesson\s+confidence="([^"]+)"\s+context="([^"]*)"\s*>([\s\S]*?)<\/lesson>/g;
  while ((match = lessonRe.exec(xml)) !== null) {
    const content = match[3].trim();
    if (!content) continue;
    lessons.push({
      content,
      context: match[2].trim(),
      confidence: parseConfidence(match[1]),
    });
  }

  const crystals: ParsedDistill["crystals"] = [];
  const crystalRe = /<crystal>([\s\S]*?)<\/crystal>/g;
  while ((match = crystalRe.exec(xml)) !== null) {
    const narrative = getXmlTag(match[1], "narrative");
    if (!narrative) continue;
    crystals.push({
      narrative,
      keyOutcomes: getXmlChildren(match[1], "keyOutcomes", "outcome"),
      lessons: getXmlChildren(match[1], "lessons", "lesson"),
    });
  }

  return { insights, lessons, crystals };
}

/**
 * Distills the knowledge graph into durable memory: insights, lessons, and
 * crystals. Every artifact is keyed by a fingerprint of its content, so
 * re-running distillation reinforces an existing skill instead of writing a
 * near-duplicate of it.
 */
export function registerDistillFunction(
  sdk: IIIClient,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::distill-graph-to-memory", async (data: DistillPayload) => {
    const scope: DistillScope = data?.scope ?? "all";
    const limit = Math.min(Math.max(Math.trunc(Number(data?.limit) ?? 50), 1), 500);
    const minDegree = Math.max(1, Math.trunc(Number(data?.minDegree) ?? 2));
    const project = data?.project?.trim() || undefined;

    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, "current").catch(() => null);
    if (!snap || snap.stats?.totalNodes === 0) {
      return emptyResult("No graph data available");
    }

    const candidates = (snap.topNodes ?? [])
      .filter((node) => (node.sourceObservationIds?.length ?? 0) >= minDegree)
      .slice(0, limit);
    if (candidates.length === 0) {
      return emptyResult("No high-degree nodes to distill");
    }

    const ranked = [...candidates].sort(
      (a, b) => (b.sourceObservationIds?.length ?? 0) - (a.sourceObservationIds?.length ?? 0),
    );

    let response: string;
    try {
      response = await provider.compress(DISTILL_SYSTEM, buildDistillPrompt(ranked));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Distill LLM call failed", { error: message });
      return { success: false, error: message };
    }

    const parsed = parseDistillXml(response);
    const now = new Date().toISOString();
    const counts: DistillCounts = { ...EMPTY_COUNTS, nodesConsidered: ranked.length };
    const sourceNames = ranked.slice(0, 5).map((node) => node.name);

    if (scope === "all" || scope === "insights") {
      for (const insight of parsed.insights) {
        const id = fingerprintId("ins", insight.content.toLowerCase());
        const existing = await kv.get<Insight>(KV.insights, id).catch(() => null);
        if (existing && !existing.deleted) {
          reinforceInsight(existing);
          existing.confidence = Math.max(existing.confidence, insight.confidence);
          await kv.set(KV.insights, existing.id, existing);
          counts.insightsReinforced++;
          continue;
        }
        const record: Insight = {
          id,
          title: insight.title,
          content: insight.content,
          confidence: insight.confidence,
          reinforcements: 0,
          sourceConceptCluster: sourceNames,
          sourceMemoryIds: [],
          sourceLessonIds: [],
          sourceCrystalIds: [],
          project,
          tags: [],
          createdAt: now,
          updatedAt: now,
          decayRate: 0.01,
        };
        await kv.set(KV.insights, id, record);
        counts.insightsAdded++;
      }
    }

    if (scope === "all" || scope === "lessons") {
      for (const lesson of parsed.lessons) {
        const result = await sdk.trigger({
          function_id: "mem::lesson-save",
          payload: {
            content: lesson.content,
            context: lesson.context || "graph-distillation",
            confidence: lesson.confidence,
            project,
            tags: [],
            source: "graph-distillation",
          },
        });
        if (result?.action === "strengthened") counts.lessonsStrengthened++;
        else if (result?.success) counts.lessonsAdded++;
      }
    }

    if (scope === "all" || scope === "crystals") {
      for (const crystal of parsed.crystals) {
        const id = fingerprintId("crys", crystal.narrative.toLowerCase());
        const existing = await kv
          .get<Crystal & { reinforcements?: number; deleted?: boolean }>(KV.crystals, id)
          .catch(() => null);
        if (existing && !existing.deleted) {
          await kv.set(KV.crystals, existing.id, {
            ...existing,
            reinforcements: (existing.reinforcements ?? 0) + 1,
          });
          counts.crystalsReinforced++;
        } else {
          const record: Crystal = {
            id,
            narrative: crystal.narrative,
            keyOutcomes: crystal.keyOutcomes,
            filesAffected: [],
            lessons: crystal.lessons,
            sourceActionIds: [],
            project,
            createdAt: now,
          };
          await kv.set(KV.crystals, id, record);
          counts.crystalsAdded++;
        }
        for (const lessonText of crystal.lessons) {
          await sdk
            .trigger({
              function_id: "mem::lesson-save",
              payload: {
                content: lessonText,
                context: crystal.narrative,
                confidence: 0.6,
                project,
                tags: [],
                source: "crystal",
              },
            })
            .catch(() => {});
        }
      }
    }

    logger.info("Graph distillation complete", { scope, ...counts });
    await recordAudit(kv, "distill", "mem::distill-graph-to-memory", [], { scope, ...counts });
    return { success: true, scope, project, ...counts };
  });
}