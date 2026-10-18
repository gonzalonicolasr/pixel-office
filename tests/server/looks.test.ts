import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type RunningServer } from "../../server/index.ts";
import { EventLog, fakeServer, rawRequest, type FakeServer } from "./helpers.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dataDir: string;
let app: RunningServer;
let fake: FakeServer;
let mode: "chat" | "images" = "chat";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pixel-looks-"));
  fake = await fakeServer((_body, req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.endsWith("/chat/completions")) {
      const message =
        mode === "chat"
          ? { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }] }
          : { role: "assistant", content: "no puedo dibujar" };
      res.end(JSON.stringify({ choices: [{ message }] }));
    } else {
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
    }
  });
  app = await startServer({ port: 0, staticDir: null, dataDir });
  const provider = await api("POST", "/api/providers", { name: "Img", kind: "openai", baseUrl: `${fake.url}/v1`, apiKey: "k" });
  expect(provider.status).toBe(201);
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("looks", () => {
  it("requires an image provider and model before starting", async () => {
    expect((await api("POST", "/api/agents/reva/look", { description: "una QA con rulos" })).status).toBe(400);
    await api("PUT", "/api/settings", { imageProviderId: "img", imageModel: "" });
    expect((await api("POST", "/api/agents/reva/look", { description: "una QA con rulos" })).status).toBe(400);
    expect((await api("POST", "/api/agents/nadie/look", { description: "x" })).status).toBe(404);
  });

  it("draws a look, serves it and replaces the previous file", async () => {
    await api("PUT", "/api/settings", { imageProviderId: "img", imageModel: "pixel-model" });
    expect((await api("POST", "/api/agents/reva/look", { description: "" })).status).toBe(400);
    const log = new EventLog(app.url);
    await log.ready;
    try {
      const started = await api("POST", "/api/agents/reva/look", { description: "una QA con rulos y anteojos" });
      expect(started).toEqual({ status: 202, json: { ok: true } });
      await log.waitFor("look_progress", (e) => e.agentId === "reva" && e.status === "drawing");
      await log.waitFor("look_progress", (e) => e.agentId === "reva" && e.status === "done");
      const prompt = fake.bodies.find((b) => b.path === "/v1/chat/completions");
      expect(prompt.model).toBe("pixel-model");
      expect(prompt.messages[0].content).toContain("Character: una QA con rulos y anteojos.");
      const office = await api("GET", "/api/office");
      const look = office.json.agents.find((a: any) => a.id === "reva").look;
      expect(look).toMatchObject({ description: "una QA con rulos y anteojos" });
      expect(look.src).toMatch(/^\/api\/looks\/reva-\d+\.png$/);
      const served = await fetch(`${app.url}${look.src}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("cache-control")).toContain("max-age=31536000");
      expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

      mode = "images";
      await api("POST", "/api/agents/reva/look", { description: "otra versión" });
      await log.waitFor("look_progress", (e) => e.agentId === "reva" && e.status === "done" && log.events.filter((x) => x.type === "look_progress" && x.status === "done").length === 2);
      const files = await readdir(join(dataDir, "looks"));
      expect(files).toHaveLength(1);
      expect(fake.bodies.some((b) => b.path === "/v1/images/generations" && b.size === "1536x1024")).toBe(true);
      await expect(access(join(dataDir, "looks", look.src.split("/").pop()))).rejects.toThrow();

      expect((await api("DELETE", "/api/agents/reva/look")).status).toBe(200);
      expect(await readdir(join(dataDir, "looks"))).toHaveLength(0);
      const after = await api("GET", "/api/office");
      expect(after.json.agents.find((a: any) => a.id === "reva").look).toBeUndefined();
    } finally {
      log.close();
    }
  });

  it("rejects traversal and bad file names", async () => {
    for (const path of ["/api/looks/..%2Foffice.json", "/api/looks/..%2F..%2Fetc%2Fpasswd", "/api/looks/Reva.png", "/api/looks/x.svg", "/api/looks/%E0%A4%A"]) {
      const res = await rawRequest(`${app.url}${path}`, {});
      expect([400, 404]).toContain(res.status);
    }
    expect((await rawRequest(`${app.url}/api/looks/nada-1.png`, {})).status).toBe(404);
  });
});
