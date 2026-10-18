import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeEvent, PublicOffice } from "../../shared/types.ts";
import { startServer, type RunningServer } from "../../server/index.ts";
import { parseSSE } from "../../server/providers.ts";

let dir: string;
let app: RunningServer;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pixel-office-"));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.DATA_DIR = dir;
  app = await startServer({ port: 0, staticDir: null });
});

afterAll(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("server", () => {
  it("serves the default office without api keys", async () => {
    const { status, json } = await api("GET", "/api/office");
    const office = json as PublicOffice;
    expect(status).toBe(200);
    expect(office.agents).toHaveLength(6);
    expect(office.agents.filter((a) => a.lead).map((a) => a.id)).toEqual(["mate"]);
    expect(office.providers.find((p) => p.id === "demo")?.hasKey).toBe(false);
    expect(office.providers.every((p) => !("apiKey" in p))).toBe(true);
    const saved = JSON.parse(await readFile(join(dir, "office.json"), "utf8"));
    expect(saved.agents).toHaveLength(6);
  });

  it("creates an agent and moves the lead", async () => {
    const created = await api("POST", "/api/agents", { name: "Tita", role: "Diseño" });
    expect(created.status).toBe(201);
    expect(created.json.providerId).toBe("demo");
    expect(created.json.seat).toBe(6);
    const updated = await api("PUT", `/api/agents/${created.json.id}`, { lead: true, appearance: { shirt: "#000000" } });
    expect(updated.status).toBe(200);
    expect(updated.json.appearance.shirt).toBe("#000000");
    expect(updated.json.appearance.skin).toBeTruthy();
    const { json } = await api("GET", "/api/office");
    expect((json as PublicOffice).agents.filter((a) => a.lead).map((a) => a.id)).toEqual([created.json.id]);
    const back = await api("PUT", "/api/agents/mate", { lead: true });
    expect(back.status).toBe(200);
    expect((await api("DELETE", `/api/agents/${created.json.id}`)).status).toBe(200);
  });

  it("protects providers in use and keeps api keys on update", async () => {
    expect((await api("DELETE", "/api/providers/demo")).status).toBe(409);
    const p = await api("POST", "/api/providers", { name: "Local LM", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "sk-x" });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ id: "local-lm", hasKey: true });
    expect(p.json.apiKey).toBeUndefined();
    const u = await api("PUT", "/api/providers/local-lm", { name: "Local", apiKey: "" });
    expect(u.json).toMatchObject({ name: "Local", hasKey: true });
    expect((await api("DELETE", "/api/providers/local-lm")).status).toBe(200);
  });

  it("rejects bad input", async () => {
    expect((await api("POST", "/api/message", { text: "" })).status).toBe(400);
    expect((await api("POST", "/api/message", { text: "hola", target: "nadie" })).status).toBe(400);
    expect((await api("PUT", "/api/layout", { seats: "x" })).status).toBe(400);
    expect((await api("GET", "/api/nope")).status).toBe(404);
  });

  it("runs a demo message end to end over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${app.url}/api/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events: OfficeEvent[] = [];
    let runId: string | undefined;
    const done = (async () => {
      for await (const msg of parseSSE(res.body!)) {
        const ev = JSON.parse(msg.data) as OfficeEvent;
        events.push(ev);
        if (ev.type === "office" && !runId) {
          const posted = await api("POST", "/api/message", { text: "Encontré un bug en el login, ¿lo podés testear?" });
          expect(posted.status).toBe(202);
          runId = posted.json.runId;
        }
        if (ev.type === "run_done" && ev.runId === runId) break;
      }
    })();
    await done;
    ctrl.abort();
    const run = events.filter((e) => e.type !== "office");
    const types = run.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types).toContain("routing");
    const route = run.find((e) => e.type === "route");
    expect(route && route.type === "route" && route.assignments.map((a) => a.agentId)).toEqual(["reva"]);
    const start = run.find((e) => e.type === "agent_start");
    expect(start).toMatchObject({ agentId: "reva", from: "mate" });
    expect(types.filter((t) => t === "delta").length).toBeGreaterThan(1);
    const agentDone = run.find((e) => e.type === "agent_done");
    expect(agentDone && agentDone.type === "agent_done" && agentDone.text).toContain("Listo, me pongo con eso");
    expect(types[types.length - 1]).toBe("run_done");
  }, 20_000);
});
