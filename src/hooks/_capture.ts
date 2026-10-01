import { spawn } from "node:child_process";
import { deriveEventId } from "../capture/event-id.js";
import {
  appendSpool,
  drainInProgress,
  drainSpool,
  spoolHasRecords,
  type SendOutcome,
  type SpoolRecord,
} from "../capture/spool.js";

export const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const DRAIN_CHILD_ENV = "AGENTMEMORY_CAPTURE_DRAIN_CHILD";
const DRAIN_MAX_RECORDS = 500;
const DRAIN_DEADLINE_MS = 20_000;
const DRAIN_REQUEST_TIMEOUT_MS = 5000;

export type CaptureOutcome = "delivered" | "duplicate" | "rejected" | "spooled" | "dropped";

export interface ObserveBody {
  hookType: string;
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: unknown;
  eventId?: string;
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

export function withEventId(body: ObserveBody, host: Record<string, unknown>, content?: unknown): ObserveBody {
  return {
    ...body,
    eventId: deriveEventId(body.hookType, body.sessionId, host, content ?? body.data),
  };
}

function classify(status: number): SendOutcome {
  if (status >= 200 && status < 300) return status === 200 ? "duplicate" : "delivered";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<SendOutcome> {
  const res = await fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.arrayBuffer().catch(() => undefined);
  return classify(res.status);
}

function startDrainChild(): void {
  if (process.env[DRAIN_CHILD_ENV] === "1") return;
  if (!process.argv[1] || drainInProgress(REST_URL)) return;
  try {
    const child = spawn(process.execPath, [process.argv[1]], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [DRAIN_CHILD_ENV]: "1" },
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function captureObservation(body: ObserveBody, timeoutMs: number): Promise<CaptureOutcome> {
  const eventId = body.eventId ?? deriveEventId(body.hookType, body.sessionId, null, body.data);
  const payload = { ...body, eventId } as unknown as Record<string, unknown>;
  let reason: string;
  try {
    const outcome = await post(payload, timeoutMs);
    if (outcome !== "retry") {
      if (spoolHasRecords(REST_URL)) startDrainChild();
      return outcome;
    }
    reason = "server-error";
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable";
  }
  return appendSpool(REST_URL, eventId, payload, reason).spooled ? "spooled" : "dropped";
}

export function isDrainChild(): boolean {
  return process.env[DRAIN_CHILD_ENV] === "1";
}

export async function runDrainChild(): Promise<void> {
  await drainSpool(
    REST_URL,
    (record: SpoolRecord) => post({ ...record.body, eventId: record.eventId }, DRAIN_REQUEST_TIMEOUT_MS),
    { maxRecords: DRAIN_MAX_RECORDS, deadlineMs: DRAIN_DEADLINE_MS },
  ).catch(() => undefined);
}
