import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OfficeEvent, PermissionDecision, Settings, ToolName } from "../shared/types.ts";

export const TOOL_NAMES: ToolName[] = ["list_dir", "read_file", "search", "write_file", "edit_file", "run_command"];
export const READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["list_dir", "read_file", "search"]);
export const MODEL_OUTPUT_LIMIT = 20_000;
export const EVENT_OUTPUT_LIMIT = 4_000;
export const COMMAND_TIMEOUT_MS = 120_000;
export const PERMISSION_TIMEOUT_MS = 10 * 60_000;
export const DENIED_MESSAGE = "El usuario denegó esta acción.";

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 100 * 1024;
const READ_MAX_FILE = 20 * 1024 * 1024;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILES = 20_000;
const SEARCH_MAX_FILE = 2 * 1024 * 1024;
const SEARCH_IGNORE = new Set(["node_modules", ".git", "dist"]);
const LIST_MAX_ENTRIES = 1000;

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_dir",
    description: "Lista los archivos y carpetas de un directorio. Las carpetas terminan en /.",
    parameters: schema({ path: str("Directorio, relativo al workspace o absoluto. Usá \".\" para el workspace.") }, ["path"]),
  },
  {
    name: "read_file",
    description: `Lee un archivo de texto con los números de línea. Máximo ${READ_MAX_LINES} líneas o 100 KB por llamada; usá offset y limit para archivos largos.`,
    parameters: schema(
      {
        path: str("Archivo, relativo al workspace o absoluto."),
        offset: int("Línea desde la que leer, empezando en 1."),
        limit: int(`Cantidad de líneas a leer (máximo ${READ_MAX_LINES}).`),
      },
      ["path"],
    ),
  },
  {
    name: "search",
    description: `Busca una expresión regular en los archivos de texto bajo una carpeta, recursivo (ignora node_modules, .git y dist). Devuelve hasta ${SEARCH_MAX_MATCHES} coincidencias como ruta:línea: texto.`,
    parameters: schema(
      {
        pattern: str("Expresión regular de JavaScript."),
        path: str("Carpeta o archivo donde buscar. Default: el workspace."),
      },
      ["pattern"],
    ),
  },
  {
    name: "write_file",
    description: "Crea o reemplaza un archivo con el contenido dado. Crea las carpetas que falten.",
    parameters: schema({ path: str("Archivo, relativo al workspace o absoluto."), content: str("Contenido completo del archivo.") }, [
      "path",
      "content",
    ]),
  },
  {
    name: "edit_file",
    description: "Reemplaza un fragmento exacto de un archivo. old_string tiene que aparecer exactamente una vez; incluí contexto suficiente.",
    parameters: schema(
      {
        path: str("Archivo, relativo al workspace o absoluto."),
        old_string: str("Texto exacto a reemplazar."),
        new_string: str("Texto nuevo."),
      },
      ["path", "old_string", "new_string"],
    ),
  },
  {
    name: "run_command",
    description: "Ejecuta un comando de shell (/bin/sh -c) y devuelve stdout, stderr y el código de salida. Timeout de 120 s, sin entrada interactiva.",
    parameters: schema(
      { command: str("Comando a ejecutar."), cwd: str("Carpeta donde ejecutarlo. Default: el workspace.") },
      ["command"],
    ),
  },
];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as string[]).includes(name);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolvePath(ws: string, p: string): string {
  const target = expandHome(p.trim() || ".");
  if (isAbsolute(target)) return resolve(target);
  return resolve(expandHome(ws), target);
}

export function isInside(ws: string, abs: string): boolean {
  const base = resolve(expandHome(ws));
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep);
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function targetPath(name: ToolName, args: Record<string, unknown>): string {
  if (name === "run_command") return argString(args, "cwd") ?? ".";
  return argString(args, "path") ?? ".";
}

export function needsPermission(
  name: ToolName,
  args: Record<string, unknown>,
  settings: Pick<Settings, "workspace" | "autoApprove">,
  remembered?: ReadonlySet<ToolName>,
): boolean {
  if (READ_TOOLS.has(name) && isInside(settings.workspace, resolvePath(settings.workspace, targetPath(name, args)))) return false;
  if (settings.autoApprove) return false;
  return !remembered?.has(name);
}

async function realOrNearest(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

export async function escapesWorkspace(ws: string, p: string): Promise<boolean> {
  const base = await realOrNearest(resolve(expandHome(ws)));
  const target = await realOrNearest(resolvePath(ws, p));
  return !isInside(base, target);
}

function displayPath(ws: string, p: string): string {
  const abs = resolvePath(ws, p);
  if (!isInside(ws, abs)) return abs;
  return relative(resolve(expandHome(ws)), abs) || ".";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function summarize(name: ToolName, args: Record<string, unknown>, ws: string): string {
  const path = displayPath(ws, targetPath(name, args));
  switch (name) {
    case "list_dir":
      return `listar ${path}`;
    case "read_file":
      return `leer ${path}`;
    case "search":
      return `buscar "${clip(argString(args, "pattern") ?? "", 80)}" en ${path}`;
    case "write_file":
      return `escribir ${path} (${formatBytes(Buffer.byteLength(argString(args, "content") ?? ""))})`;
    case "edit_file":
      return `editar ${path}`;
    case "run_command": {
      const cmd = clip(argString(args, "command") ?? "", 200);
      return args.cwd !== undefined ? `${cmd}  (en ${path})` : cmd;
    }
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[salida truncada: se muestran ${max} de ${text.length} caracteres]`;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolContext {
  workspace: string;
  commandTimeoutMs?: number;
}

class ToolError extends Error {}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ToolError(`Falta el parámetro "${key}" (string).`);
  return v;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`"${key}" tiene que ser un número.`);
  return Math.floor(n);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

async function listDir(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const abs = resolvePath(ctx.workspace, argString(args, "path") ?? ".");
  const entries = await readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.slice(0, LIST_MAX_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name));
  if (lines.length === 0) return `${abs} está vacío.`;
  if (entries.length > LIST_MAX_ENTRIES) lines.push(`[se muestran ${LIST_MAX_ENTRIES} de ${entries.length} entradas]`);
  return lines.join("\n");
}

async function readTextFile(abs: string): Promise<string> {
  const info = await stat(abs);
  if (!info.isFile()) throw new ToolError(`${abs} no es un archivo.`);
  if (info.size > READ_MAX_FILE) throw new ToolError(`${abs} pesa ${formatBytes(info.size)}: es demasiado grande para leerlo.`);
  const buf = await readFile(abs);
  if (isBinary(buf)) throw new ToolError(`${abs} parece un archivo binario.`);
  return buf.toString("utf8");
}

async function readFileTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const abs = resolvePath(ctx.workspace, requireString(args, "path"));
  const text = await readTextFile(abs);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, optInt(args, "offset") ?? 1);
  const limit = Math.min(READ_MAX_LINES, Math.max(1, optInt(args, "limit") ?? READ_MAX_LINES));
  if (text === "") return "(archivo vacío)";
  if (start > lines.length) return `El archivo tiene ${lines.length} líneas; offset ${start} está fuera de rango.`;
  const out: string[] = [];
  let bytes = 0;
  let line = start;
  for (; line < start + limit && line <= lines.length; line++) {
    const row = `${String(line).padStart(6)}\t${lines[line - 1]}`;
    bytes += Buffer.byteLength(row) + 1;
    if (bytes > READ_MAX_BYTES && out.length > 0) break;
    out.push(row);
  }
  if (line <= lines.length) out.push(`[mostrando líneas ${start}-${line - 1} de ${lines.length}; usá offset=${line} para seguir]`);
  return out.join("\n");
}

async function searchTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const pattern = requireString(args, "pattern");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new ToolError(`Expresión regular inválida: ${(err as Error).message}`);
  }
  const root = resolvePath(ctx.workspace, argString(args, "path") ?? ".");
  const matches: string[] = [];
  let scanned = 0;
  let capped = false;
  const show = (file: string) => (isInside(ctx.workspace, file) ? relative(resolve(expandHome(ctx.workspace)), file) : file);

  const scanFile = async (file: string) => {
    scanned++;
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile() || info.size > SEARCH_MAX_FILE) return;
    const buf = await readFile(file).catch(() => null);
    if (!buf || isBinary(buf)) return;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push(`${show(file)}:${i + 1}: ${clip(lines[i].trim(), 300)}`);
        if (matches.length >= SEARCH_MAX_MATCHES) return;
      }
    }
  };

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (matches.length >= SEARCH_MAX_MATCHES) return;
      if (scanned >= SEARCH_MAX_FILES) {
        capped = true;
        return;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_IGNORE.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        await scanFile(full);
      }
    }
  };

  const info = await stat(root);
  if (info.isDirectory()) await walk(root);
  else await scanFile(root);
  if (matches.length === 0) return capped ? `Sin coincidencias en los primeros ${SEARCH_MAX_FILES} archivos.` : "Sin coincidencias.";
  if (matches.length >= SEARCH_MAX_MATCHES) matches.push(`[se cortó en ${SEARCH_MAX_MATCHES} coincidencias]`);
  else if (capped) matches.push(`[se revisaron sólo los primeros ${SEARCH_MAX_FILES} archivos]`);
  return matches.join("\n");
}

async function writeFileTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = requireString(args, "path");
  const content = requireString(args, "content");
  const abs = resolvePath(ctx.workspace, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return `Escribí ${displayPath(ctx.workspace, path)} (${formatBytes(Buffer.byteLength(content))}).`;
}

async function editFileTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = requireString(args, "path");
  const oldString = requireString(args, "old_string");
  const newString = requireString(args, "new_string");
  if (oldString === "") throw new ToolError("old_string no puede estar vacío.");
  const abs = resolvePath(ctx.workspace, path);
  const text = await readTextFile(abs);
  const first = text.indexOf(oldString);
  if (first === -1) throw new ToolError(`old_string no aparece en ${displayPath(ctx.workspace, path)}. Leé el archivo y copiá el texto exacto.`);
  let count = 0;
  for (let i = first; i !== -1; i = text.indexOf(oldString, i + oldString.length)) count++;
  if (count > 1) {
    throw new ToolError(`old_string aparece ${count} veces en ${displayPath(ctx.workspace, path)}. Agregá más contexto para que sea único.`);
  }
  await writeFile(abs, text.slice(0, first) + newString + text.slice(first + oldString.length), "utf8");
  return `Edité ${displayPath(ctx.workspace, path)}.`;
}

function runCommand(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const command = requireString(args, "command");
  const cwd = resolvePath(ctx.workspace, argString(args, "cwd") ?? ".");
  const timeoutMs = ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((done) => {
    let output = "";
    let total = 0;
    let timedOut = false;
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      total += s.length;
      if (output.length < MODEL_OUTPUT_LIMIT) output += s.slice(0, MODEL_OUTPUT_LIMIT - output.length);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, output: `No se pudo ejecutar el comando: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let text = output.trimEnd() || "(sin salida)";
      if (total > MODEL_OUTPUT_LIMIT) text += `\n[salida truncada: se muestran ${MODEL_OUTPUT_LIMIT} de ${total} caracteres]`;
      if (timedOut) {
        done({ ok: false, output: `${text}\n[timeout: el comando superó ${Math.round(timeoutMs / 1000)} s y se cortó]` });
        return;
      }
      done({ ok: code === 0, output: `${text}\n[exit code: ${code ?? signal}]` });
    });
  });
}

export async function executeTool(name: ToolName, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_dir":
        return { ok: true, output: await listDir(ctx, args) };
      case "read_file":
        return { ok: true, output: await readFileTool(ctx, args) };
      case "search":
        return { ok: true, output: await searchTool(ctx, args) };
      case "write_file":
        return { ok: true, output: await writeFileTool(ctx, args) };
      case "edit_file":
        return { ok: true, output: await editFileTool(ctx, args) };
      case "run_command":
        return await runCommand(ctx, args);
      default:
        return { ok: false, output: `Herramienta desconocida: ${String(name)}` };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, output: `No existe: ${e.path ?? ""}`.trim() };
    if (e.code === "ENOTDIR") return { ok: false, output: `No es un directorio: ${e.path ?? ""}`.trim() };
    if (e.code === "EISDIR") return { ok: false, output: `Es un directorio: ${e.path ?? ""}`.trim() };
    if (e.code === "EACCES" || e.code === "EPERM") return { ok: false, output: `Sin permiso: ${e.path ?? ""}`.trim() };
    return { ok: false, output: e.message || String(err) };
  }
}

interface Pending {
  done: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export class Permissions {
  private pending = new Map<string, Pending>();
  private remembered = new Map<string, Set<ToolName>>();

  constructor(readonly timeoutMs = PERMISSION_TIMEOUT_MS) {}

  rememberedFor(agentId: string): ReadonlySet<ToolName> {
    return this.remembered.get(agentId) ?? new Set();
  }

  remember(agentId: string, name: ToolName): void {
    const set = this.remembered.get(agentId) ?? new Set<ToolName>();
    set.add(name);
    this.remembered.set(agentId, set);
  }

  request(callId: string): Promise<PermissionDecision> {
    return new Promise((ok) => {
      const timer = setTimeout(() => this.resolve(callId, "deny"), this.timeoutMs);
      timer.unref();
      this.pending.set(callId, { done: ok, timer });
    });
  }

  resolve(callId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    clearTimeout(entry.timer);
    entry.done(decision);
    return true;
  }

  isPending(callId: string): boolean {
    return this.pending.has(callId);
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, "deny");
  }
}

export interface ToolRunContext {
  runId: string;
  agentId: string;
  settings: Settings;
  permissions: Permissions;
  emit: (event: OfficeEvent) => void;
  commandTimeoutMs?: number;
}

export interface RawToolCall {
  name: string;
  arguments: string;
}

export function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function runToolCall(ctx: ToolRunContext, call: RawToolCall): Promise<ToolResult> {
  const callId = randomUUID();
  const base = { runId: ctx.runId, agentId: ctx.agentId, callId };
  const finish = (result: ToolResult): ToolResult => {
    ctx.emit({ type: "tool_result", ...base, ok: result.ok, output: truncate(result.output, EVENT_OUTPUT_LIMIT) });
    return { ok: result.ok, output: truncate(result.output, MODEL_OUTPUT_LIMIT) };
  };
  const args = parseToolArgs(call.arguments);
  if (!isToolName(call.name)) {
    return { ok: false, output: `Herramienta desconocida: ${call.name}. Las disponibles son: ${TOOL_NAMES.join(", ")}.` };
  }
  const name = call.name;
  if (!args) {
    ctx.emit({ type: "tool_call", ...base, name, args: {}, summary: `${name} (argumentos inválidos)` });
    return finish({ ok: false, output: `Los argumentos de ${name} no son un objeto JSON válido: ${clip(call.arguments, 200)}` });
  }
  const summary = summarize(name, args, ctx.settings.workspace);
  ctx.emit({ type: "tool_call", ...base, name, args, summary });
  let ask = needsPermission(name, args, ctx.settings, ctx.permissions.rememberedFor(ctx.agentId));
  if (!ask && READ_TOOLS.has(name) && !ctx.settings.autoApprove && !ctx.permissions.rememberedFor(ctx.agentId).has(name)) {
    ask = await escapesWorkspace(ctx.settings.workspace, targetPath(name, args));
  }
  if (ask) {
    ctx.emit({ type: "permission_request", ...base, name, args, summary });
    const decision = await ctx.permissions.request(callId);
    ctx.emit({ type: "permission_resolved", ...base, decision });
    if (decision === "deny") return finish({ ok: false, output: DENIED_MESSAGE });
    if (decision === "always") ctx.permissions.remember(ctx.agentId, name);
  }
  return finish(await executeTool(name, args, { workspace: ctx.settings.workspace, commandTimeoutMs: ctx.commandTimeoutMs }));
}
