import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../../server/index.ts";
import { DENIED_MESSAGE } from "../../server/tools.ts";
import { EventLog, fakeServer, rawRequest, writeSSE, type FakeServer } from "./helpers.ts";

let dataDir: string;
let ws: string;
let app: RunningServer;
let fake: FakeServer;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pixel-int-data-"));
  ws = await mkdtemp(join(tmpdir(), "pixel-int-ws-"));
  fake = await fakeServer((body, _req, res) => {
    const last = body.messages[body.messages.length - 1];
    if (last.role === "tool") {
      writeSSE(res, [{ choices: [{ delta: { content: "Listo, " } }] }, { choices: [{ delta: { content: "ya está." } }] }, "data: [DONE]\n\n"]);
      return;
    }
    const file = last.content.includes("denegame") ? "denied.txt" : "hola.txt";
    writeSSE(res, [
      { choices: [{ delta: { content: "Lo escribo." } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: '{\n  "path": ' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${file}", "content": "hola mundo"\n}` } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      "data: [DONE]\n\n",
    ]);
  });
  app = await startServer({ port: 0, staticDir: null, dataDir, allowedOrigins: [] });
  expect((await api("PUT", "/api/settings", { workspace: ws })).status).toBe(200);
  const provider = await api("POST", "/api/providers", { name: "Fake", kind: "openai", baseUrl: `${fake.url}/v1`, apiKey: "k" });
  expect(provider.status).toBe(201);
  const agent = await api("PUT", "/api/agents/coda", { providerId: provider.json.id, model: "fake-model", tools: true });
  expect(agent.status).toBe(200);
  expect(agent.json.tools).toBe(true);
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});

describe("tool calling over the API", () => {
  it("asks permission, writes the file after allow and finishes", async () => {
    const log = new EventLog(app.url);
    await log.ready;
    try {
      const posted = await api("POST", "/api/message", { text: "escribí hola.txt", target: "coda" });
      expect(posted.status).toBe(202);
      const runId = posted.json.runId;
      const call = await log.waitFor("tool_call", (e) => e.runId === runId);
      expect(call).toMatchObject({ agentId: "coda", name: "write_file", args: { path: "hola.txt", content: "hola mundo" } });
      expect(call.summary).toBe("escribir hola.txt (10 B)");
      const request = await log.waitFor("permission_request", (e) => e.runId === runId);
      expect(request.callId).toBe(call.callId);
      await expect(access(join(ws, "hola.txt"))).rejects.toThrow();
      expect((await api("POST", "/api/permission", { callId: request.callId, decision: "allow" })).status).toBe(200);
      expect((await api("POST", "/api/permission", { callId: request.callId, decision: "allow" })).status).toBe(404);
      await log.waitFor("permission_resolved", (e) => e.callId === request.callId && e.decision === "allow");
      const result = await log.waitFor("tool_result", (e) => e.callId === call.callId);
      expect(result.ok).toBe(true);
      const done = await log.waitFor("agent_done", (e) => e.runId === runId);
      expect(done.text).toBe("Lo escribo.\n\nListo, ya está.");
      expect(await readFile(join(ws, "hola.txt"), "utf8")).toBe("hola mundo");
      const second = fake.bodies.at(-1);
      expect(second.messages.at(-2).tool_calls[0]).toMatchObject({ id: "call_1", function: { name: "write_file" } });
      expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
      expect(second.messages.at(-1).content).toContain("hola.txt");
      expect(second.messages[0].content).toContain(ws);
    } finally {
      log.close();
    }
  });

  it("does not write on deny and tells the model", async () => {
    const log = new EventLog(app.url);
    await log.ready;
    try {
      const posted = await api("POST", "/api/message", { text: "denegame esto", target: "coda" });
      const runId = posted.json.runId;
      const request = await log.waitFor("permission_request", (e) => e.runId === runId);
      expect((await api("POST", "/api/permission", { callId: request.callId, decision: "deny" })).status).toBe(200);
      const result = await log.waitFor("tool_result", (e) => e.callId === request.callId);
      expect(result).toMatchObject({ ok: false, output: DENIED_MESSAGE });
      await log.waitFor("agent_done", (e) => e.runId === runId);
      await expect(access(join(ws, "denied.txt"))).rejects.toThrow();
      const toolMsg = fake.bodies.at(-1).messages.at(-1);
      expect(toolMsg).toMatchObject({ role: "tool", content: DENIED_MESSAGE });
    } finally {
      log.close();
    }
  });

  it("remembers 'always' for that agent and tool", async () => {
    const log = new EventLog(app.url);
    await log.ready;
    try {
      const first = await api("POST", "/api/message", { text: "escribí hola.txt otra vez", target: "coda" });
      const request = await log.waitFor("permission_request", (e) => e.runId === first.json.runId);
      await api("POST", "/api/permission", { callId: request.callId, decision: "always" });
      await log.waitFor("agent_done", (e) => e.runId === first.json.runId);
      const second = await api("POST", "/api/message", { text: "y de nuevo", target: "coda" });
      await log.waitFor("agent_done", (e) => e.runId === second.json.runId);
      expect(log.events.some((e) => e.type === "permission_request" && e.runId === second.json.runId)).toBe(false);
      expect(log.events.some((e) => e.type === "tool_result" && e.runId === second.json.runId && e.ok)).toBe(true);
    } finally {
      log.close();
    }
  });

  it("validates permission and settings payloads", async () => {
    expect((await api("POST", "/api/permission", { callId: "nada", decision: "allow" })).status).toBe(404);
    expect((await api("POST", "/api/permission", { callId: "nada", decision: "quizas" })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { workspace: join(ws, "no-existe") })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { workspace: join(ws, "hola.txt") })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { autoApprove: "si" })).status).toBe(400);
    const ok = await api("PUT", "/api/settings", { autoApprove: false, imageModel: "img" });
    expect(ok.json).toMatchObject({ workspace: ws, autoApprove: false, imageModel: "img" });
    const office = await api("GET", "/api/office");
    expect(office.json.settings.workspace).toBe(ws);
    expect(office.json.agents.find((a: any) => a.id === "mate").tools).toBe(false);
  });
});

describe("origin and host checks", () => {
  it("rejects foreign origins and hosts", async () => {
    const evil = await rawRequest(`${app.url}/api/office`, { headers: { origin: "https://evil.com" } });
    expect(evil.status).toBe(403);
    const nullOrigin = await rawRequest(`${app.url}/api/office`, { headers: { origin: "null" } });
    expect(nullOrigin.status).toBe(403);
    const rebinding = await rawRequest(`${app.url}/api/office`, { headers: { host: "evil.com:8787" } });
    expect(rebinding.status).toBe(403);
    const local = await rawRequest(`${app.url}/api/office`, { headers: { origin: "http://localhost:5173" } });
    expect(local.status).toBe(200);
    const loopback = await rawRequest(`${app.url}/api/office`, { headers: { origin: "http://127.0.0.1:8787", host: "localhost:8787" } });
    expect(loopback.status).toBe(200);
  });

  it("allows configured origins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pixel-origin-"));
    const other = await startServer({ port: 0, staticDir: null, dataDir: dir, allowedOrigins: ["https://office.example.com"] });
    try {
      const ok = await rawRequest(`${other.url}/api/office`, {
        headers: { origin: "https://office.example.com", host: "office.example.com" },
      });
      expect(ok.status).toBe(200);
      const bad = await rawRequest(`${other.url}/api/office`, { headers: { origin: "https://evil.com" } });
      expect(bad.status).toBe(403);
    } finally {
      await other.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
