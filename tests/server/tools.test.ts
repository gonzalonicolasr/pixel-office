import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeEvent, Settings } from "../../shared/types.ts";
import {
  DENIED_MESSAGE,
  executeTool,
  needsPermission,
  Permissions,
  resolvePath,
  runToolCall,
  summarize,
  type ToolContext,
} from "../../server/tools.ts";

describe("resolvePath", () => {
  it("resolves relative paths against the workspace", () => {
    expect(resolvePath("/work/ws", "src/a.ts")).toBe("/work/ws/src/a.ts");
    expect(resolvePath("/work/ws", "./x/../b.txt")).toBe("/work/ws/b.txt");
    expect(resolvePath("/work/ws", "")).toBe("/work/ws");
  });

  it("accepts absolute paths and ~", () => {
    expect(resolvePath("/work/ws", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolvePath("/work/ws", "~")).toBe(homedir());
    expect(resolvePath("/work/ws", "~/notes.md")).toBe(join(homedir(), "notes.md"));
    expect(resolvePath("~/proj", "a")).toBe(join(homedir(), "proj", "a"));
  });
});

describe("needsPermission", () => {
  const settings: Settings = { workspace: "/work/ws", autoApprove: false };

  it("auto-approves reads inside the workspace", () => {
    expect(needsPermission("read_file", { path: "src/a.ts" }, settings)).toBe(false);
    expect(needsPermission("list_dir", {}, settings)).toBe(false);
    expect(needsPermission("search", { pattern: "x" }, settings)).toBe(false);
  });

  it("asks for reads outside the workspace", () => {
    expect(needsPermission("read_file", { path: "/etc/passwd" }, settings)).toBe(true);
    expect(needsPermission("list_dir", { path: "../other" }, settings)).toBe(true);
    expect(needsPermission("search", { pattern: "x", path: "/work/wsx" }, settings)).toBe(true);
  });

  it("always asks for writes and commands, even inside the workspace", () => {
    expect(needsPermission("write_file", { path: "a.txt", content: "" }, settings)).toBe(true);
    expect(needsPermission("edit_file", { path: "a.txt" }, settings)).toBe(true);
    expect(needsPermission("run_command", { command: "ls" }, settings)).toBe(true);
  });

  it("skips asking with autoApprove or a remembered tool", () => {
    expect(needsPermission("run_command", { command: "ls" }, { ...settings, autoApprove: true })).toBe(false);
    expect(needsPermission("read_file", { path: "/etc/passwd" }, { ...settings, autoApprove: true })).toBe(false);
    expect(needsPermission("write_file", { path: "a" }, settings, new Set(["write_file"]))).toBe(false);
    expect(needsPermission("run_command", { command: "ls" }, settings, new Set(["write_file"]))).toBe(true);
  });
});

describe("summarize", () => {
  it("builds short labels", () => {
    expect(summarize("run_command", { command: "npm test" }, "/w")).toBe("npm test");
    expect(summarize("write_file", { path: "src/x.ts", content: "a".repeat(1229) }, "/w")).toBe("escribir src/x.ts (1.2 KB)");
    expect(summarize("edit_file", { path: "/w/src/x.ts" }, "/w")).toBe("editar src/x.ts");
    expect(summarize("read_file", { path: "README.md" }, "/w")).toBe("leer README.md");
  });
});

describe("executeTool", () => {
  let ws: string;
  let ctx: ToolContext;

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), "pixel-tools-"));
    ctx = { workspace: ws, commandTimeoutMs: 5000 };
  });

  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("writes, reads and edits a file", async () => {
    const w = await executeTool("write_file", { path: "src/deep/a.txt", content: "uno\ndos\ntres\ndos\n" }, ctx);
    expect(w.ok).toBe(true);
    expect(await readFile(join(ws, "src/deep/a.txt"), "utf8")).toBe("uno\ndos\ntres\ndos\n");

    const r = await executeTool("read_file", { path: "src/deep/a.txt" }, ctx);
    expect(r).toEqual({ ok: true, output: "     1\tuno\n     2\tdos\n     3\ttres\n     4\tdos" });
    const slice = await executeTool("read_file", { path: "src/deep/a.txt", offset: 2, limit: 2 }, ctx);
    expect(slice.output).toContain("     2\tdos\n     3\ttres");
    expect(slice.output).toContain("offset=4");

    const none = await executeTool("edit_file", { path: "src/deep/a.txt", old_string: "cuatro", new_string: "x" }, ctx);
    expect(none.ok).toBe(false);
    expect(none.output).toContain("no aparece");
    const twice = await executeTool("edit_file", { path: "src/deep/a.txt", old_string: "dos", new_string: "2" }, ctx);
    expect(twice.ok).toBe(false);
    expect(twice.output).toContain("aparece 2 veces");
    const once = await executeTool("edit_file", { path: "src/deep/a.txt", old_string: "tres", new_string: "$& 3" }, ctx);
    expect(once.ok).toBe(true);
    expect(await readFile(join(ws, "src/deep/a.txt"), "utf8")).toBe("uno\ndos\n$& 3\ndos\n");
  });

  it("lists and searches", async () => {
    await executeTool("write_file", { path: "node_modules/pkg/i.js", content: "aguja" }, ctx);
    await executeTool("write_file", { path: "b.md", content: "nada\nuna aguja acá\n" }, ctx);
    const list = await executeTool("list_dir", { path: "." }, ctx);
    expect(list.output.split("\n")).toEqual(["b.md", "node_modules/", "src/"]);
    const found = await executeTool("search", { pattern: "agu+ja" }, ctx);
    expect(found).toEqual({ ok: true, output: "b.md:2: una aguja acá" });
    const bad = await executeTool("search", { pattern: "(" }, ctx);
    expect(bad.ok).toBe(false);
    const missing = await executeTool("read_file", { path: "nope.txt" }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("No existe");
  });

  it("runs commands with exit codes and timeouts", async () => {
    const hola = await executeTool("run_command", { command: "echo hola" }, ctx);
    expect(hola).toEqual({ ok: true, output: "hola\n[exit code: 0]" });
    const pwd = await executeTool("run_command", { command: "pwd", cwd: "src" }, ctx);
    expect(pwd.output).toContain(join(ws, "src"));
    const fail = await executeTool("run_command", { command: "echo mal >&2; exit 3" }, ctx);
    expect(fail).toEqual({ ok: false, output: "mal\n[exit code: 3]" });
    const started = Date.now();
    const slow = await executeTool("run_command", { command: "sleep 5 & sleep 5; echo nunca" }, { ...ctx, commandTimeoutMs: 300 });
    expect(slow.ok).toBe(false);
    expect(slow.output).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("asks before reading through a symlink that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pixel-outside-"));
    try {
      await symlink(outside, join(ws, "escape"));
      const events: OfficeEvent[] = [];
      const permissions = new Permissions();
      const pending = runToolCall(
        { runId: "r", agentId: "a", settings: { workspace: ws, autoApprove: false }, permissions, emit: (e) => events.push(e) },
        { name: "list_dir", arguments: '{"path":"escape"}' },
      );
      await new Promise((r) => setTimeout(r, 50));
      const request = events.find((e) => e.type === "permission_request");
      expect(request).toBeTruthy();
      permissions.resolve((request as { callId: string }).callId, "deny");
      expect(await pending).toEqual({ ok: false, output: DENIED_MESSAGE });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("Permissions", () => {
  it("denies on timeout and remembers per agent", async () => {
    const p = new Permissions(20);
    expect(await p.request("x")).toBe("deny");
    expect(p.resolve("x", "allow")).toBe(false);
    p.remember("a", "run_command");
    expect(p.rememberedFor("a").has("run_command")).toBe(true);
    expect(p.rememberedFor("b").has("run_command")).toBe(false);
  });
});
