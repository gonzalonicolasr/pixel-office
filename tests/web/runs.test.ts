import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../shared/types.ts";
import { findSegments, isKeyColor } from "../../src/office/characters.ts";
import { paintChibi } from "../../src/office/sprites-chibi.ts";
import { entryText, reduceRuns, type Run } from "../../src/runs.ts";

const play = (events: OfficeEvent[]) => events.reduce<Run[]>((r, e) => reduceRuns(r, e), []);

describe("reduceRuns", () => {
  it("interleaves text and tool steps with permission states", () => {
    const runs = play([
      { type: "run_start", runId: "r", text: "creá hola.txt", target: "coda" },
      { type: "agent_start", runId: "r", agentId: "coda", task: "creá hola.txt", from: null },
      { type: "delta", runId: "r", agentId: "coda", text: "Voy " },
      { type: "delta", runId: "r", agentId: "coda", text: "a crearlo." },
      { type: "tool_call", runId: "r", agentId: "coda", callId: "c1", name: "write_file", args: { path: "hola.txt" }, summary: "escribir hola.txt" },
      { type: "permission_request", runId: "r", agentId: "coda", callId: "c1", name: "write_file", args: { path: "hola.txt" }, summary: "escribir hola.txt" },
    ]);
    const steps = runs[0].entries[0].steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ kind: "text", text: "Voy a crearlo." });
    expect(steps[1]).toMatchObject({ kind: "tool", callId: "c1", state: "asking" });

    const after = [
      { type: "permission_resolved", runId: "r", agentId: "coda", callId: "c1", decision: "allow" },
      { type: "tool_result", runId: "r", agentId: "coda", callId: "c1", ok: true, output: "ok" },
      { type: "delta", runId: "r", agentId: "coda", text: "Listo." },
      { type: "agent_done", runId: "r", agentId: "coda", text: "Voy a crearlo.Listo.", tokens: 12 },
      { type: "run_done", runId: "r" },
    ] as OfficeEvent[];
    const done = after.reduce((r, e) => reduceRuns(r, e), runs);
    const e = done[0].entries[0];
    expect(e.status).toBe("done");
    expect(e.steps[1]).toMatchObject({ state: "ok", output: "ok" });
    expect(entryText(e)).toBe("Voy a crearlo.Listo.");
  });

  it("keeps a denied tool as denied even after its result", () => {
    const runs = play([
      { type: "run_start", runId: "r", text: "x", target: null },
      { type: "tool_call", runId: "r", agentId: "a", callId: "c", name: "run_command", args: { command: "rm -rf /" }, summary: "rm -rf /" },
      { type: "permission_resolved", runId: "r", agentId: "a", callId: "c", decision: "deny" },
      { type: "tool_result", runId: "r", agentId: "a", callId: "c", ok: false, output: "denegado" },
    ]);
    expect(runs[0].entries[0].steps[0]).toMatchObject({ state: "denied" });
  });

  it("uses agent_done text when nothing streamed and ignores events without runId", () => {
    const runs = play([
      { type: "run_start", runId: "r", text: "x", target: null },
      { type: "agent_start", runId: "r", agentId: "a", task: "x", from: null },
      { type: "look_progress", agentId: "a", status: "drawing" },
      { type: "agent_done", runId: "r", agentId: "a", text: "hola", tokens: 1 },
    ]);
    expect(entryText(runs[0].entries[0])).toBe("hola");
  });
});

describe("AI sheet slicing", () => {
  it("detects magenta and transparent as key color", () => {
    expect(isKeyColor(255, 0, 255, 255)).toBe(true);
    expect(isKeyColor(240, 30, 230, 255)).toBe(true);
    expect(isKeyColor(200, 40, 40, 255)).toBe(false);
    expect(isKeyColor(30, 120, 60, 255)).toBe(false);
    expect(isKeyColor(10, 10, 10, 0)).toBe(true);
  });

  it("finds three figures, merging small gaps and ignoring specks", () => {
    const counts = new Array(300).fill(0);
    for (let x = 20; x < 80; x++) counts[x] = 50;
    for (let x = 84; x < 90; x++) counts[x] = 30;
    for (let x = 120; x < 180; x++) counts[x] = 50;
    for (let x = 200; x < 202; x++) counts[x] = 1;
    for (let x = 220; x < 280; x++) counts[x] = 50;
    expect(findSegments(counts)).toEqual([
      [20, 89],
      [120, 179],
      [220, 279],
    ]);
  });

  it("falls back to equal columns when it can't find three figures", () => {
    const counts = new Array(90).fill(0);
    for (let x = 0; x < 90; x++) counts[x] = 10;
    expect(findSegments(counts)).toEqual([
      [0, 29],
      [30, 59],
      [60, 89],
    ]);
  });
});

describe("chibi painter", () => {
  const look = { skin: "#f1c7a5", hair: "#a33b2b", hairStyle: "long" as const, shirt: "#4f9d69", pants: "#3a3550", accessory: "glasses" as const };
  it("paints every pose inside the grid with an outline", () => {
    for (const pose of [
      { kind: "stand", dir: "down", step: 0 },
      { kind: "stand", dir: "left", step: 1 },
      { kind: "stand", dir: "right", step: 3 },
      { kind: "stand", dir: "up", step: 2 },
      { kind: "sit", typing: 1 },
    ] as const) {
      const px = paintChibi(look, pose);
      const filled = px.flat().filter(Boolean).length;
      expect(filled).toBeGreaterThan(150);
    }
  });

  it("mirrors the side view", () => {
    const l = paintChibi(look, { kind: "stand", dir: "left", step: 0 });
    const r = paintChibi(look, { kind: "stand", dir: "right", step: 0 });
    expect(r.map((row) => [...row].reverse())).toEqual(l);
  });
});
