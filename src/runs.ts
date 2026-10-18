import type { OfficeEvent, ToolName } from "../shared/types.ts";

export type Step =
  | { kind: "text"; text: string }
  | { kind: "tool"; callId: string; name: ToolName; summary: string; state: "running" | "asking" | "ok" | "error" | "denied"; output?: string };

export interface RunEntry {
  agentId: string;
  task: string;
  from: string | null;
  steps: Step[];
  status: "working" | "done" | "error";
  tokens: number;
}

export interface Run {
  id: string;
  text: string;
  target: string | null;
  note: string | null;
  routing: boolean;
  entries: RunEntry[];
  done: boolean;
}

export function entryText(e: RunEntry): string {
  return e.steps
    .filter((s): s is Extract<Step, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("");
}

function appendText(steps: Step[], text: string): Step[] {
  const last = steps[steps.length - 1];
  if (last?.kind === "text") return [...steps.slice(0, -1), { ...last, text: last.text + text }];
  return [...steps, { kind: "text", text }];
}

function updateTool(steps: Step[], callId: string, patch: Partial<Extract<Step, { kind: "tool" }>>): Step[] {
  return steps.map((s) => (s.kind === "tool" && s.callId === callId ? { ...s, ...patch } : s));
}

function ensureEntry(entries: RunEntry[], agentId: string): RunEntry[] {
  if (entries.some((e) => e.agentId === agentId)) return entries;
  return [...entries, { agentId, task: "", from: null, steps: [], status: "working", tokens: 0 }];
}

export function reduceRuns(runs: Run[], ev: OfficeEvent): Run[] {
  if (ev.type === "run_start")
    return [...runs.slice(-49), { id: ev.runId, text: ev.text, target: ev.target, note: null, routing: false, entries: [], done: false }];
  if (!("runId" in ev)) return runs;
  return runs.map((r) => {
    if (r.id !== ev.runId) return r;
    const patchEntry = (agentId: string, fn: (e: RunEntry) => RunEntry): Run => ({
      ...r,
      entries: ensureEntry(r.entries, agentId).map((e) => (e.agentId === agentId ? fn(e) : e)),
    });
    switch (ev.type) {
      case "routing":
        return { ...r, routing: true };
      case "route":
        return { ...r, routing: false, note: ev.note || null };
      case "agent_start":
        return {
          ...r,
          entries: [...r.entries.filter((e) => e.agentId !== ev.agentId), { agentId: ev.agentId, task: ev.task, from: ev.from, steps: [], status: "working", tokens: 0 }],
        };
      case "delta":
        return patchEntry(ev.agentId, (e) => ({ ...e, steps: appendText(e.steps, ev.text) }));
      case "tool_call":
        return patchEntry(ev.agentId, (e) => ({
          ...e,
          steps: e.steps.some((s) => s.kind === "tool" && s.callId === ev.callId)
            ? e.steps
            : [...e.steps, { kind: "tool", callId: ev.callId, name: ev.name, summary: ev.summary, state: "running" }],
        }));
      case "permission_request":
        return patchEntry(ev.agentId, (e) => ({
          ...e,
          steps: e.steps.some((s) => s.kind === "tool" && s.callId === ev.callId)
            ? updateTool(e.steps, ev.callId, { state: "asking" })
            : [...e.steps, { kind: "tool", callId: ev.callId, name: ev.name, summary: ev.summary, state: "asking" }],
        }));
      case "permission_resolved":
        return patchEntry(ev.agentId, (e) => ({ ...e, steps: updateTool(e.steps, ev.callId, { state: ev.decision === "deny" ? "denied" : "running" }) }));
      case "tool_result":
        return patchEntry(ev.agentId, (e) => ({
          ...e,
          steps: e.steps.map((s) =>
            s.kind === "tool" && s.callId === ev.callId ? { ...s, state: s.state === "denied" ? "denied" : ev.ok ? "ok" : "error", output: ev.output } : s,
          ),
        }));
      case "agent_done":
        return patchEntry(ev.agentId, (e) => ({
          ...e,
          status: "done",
          tokens: ev.tokens,
          steps: entryText(e) || !ev.text ? e.steps : appendText(e.steps, ev.text),
        }));
      case "agent_error":
        return patchEntry(ev.agentId, (e) => ({ ...e, status: "error", steps: appendText(e.steps, `\n⚠ ${ev.error}`) }));
      case "run_done":
        return { ...r, done: true, routing: false, entries: r.entries.map((e) => (e.status === "working" ? { ...e, status: "done" } : e)) };
      default:
        return r;
    }
  });
}
