import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Agent, Appearance, Layout, Look, OfficeEvent, PermissionDecision, Provider, ProviderKind, Rect, Settings } from "../shared/types.ts";
import { generateLookImage, LOOK_FILE_RE, LOOK_MIME, lookFileFromSrc, lookFileName } from "./looks.ts";
import { runMessage } from "./orchestrator.ts";
import { defaultSettings, publicOffice, Store } from "./store.ts";
import { Permissions, resolvePath } from "./tools.ts";

const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const PROVIDER_KINDS: ProviderKind[] = ["anthropic", "openai", "demo"];
const DECISIONS: PermissionDecision[] = ["allow", "always", "deny"];
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_APPEARANCE: Appearance = {
  skin: "#f1c27d",
  hair: "#3b2a1a",
  hairStyle: "short",
  shirt: "#5b7bd5",
  pants: "#2d3436",
  accessory: "none",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string | null;
  allowedOrigins?: string[];
  commandTimeoutMs?: number;
  permissionTimeoutMs?: number;
}

export interface RunningServer {
  server: Server;
  store: Store;
  url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Body demasiado grande (máx 1MB)");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Se esperaba un objeto JSON");
  return value as Record<string, unknown>;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `"${key}" tiene que ser un string`);
  return v;
}

type AgentPatch = Omit<Partial<Agent>, "look"> & { look?: Look | null };

function validLook(value: unknown): Look | null {
  if (value === null) return null;
  const body = asObject(value);
  if (typeof body.src !== "string" || !body.src) throw new HttpError(400, '"look.src" tiene que ser un string');
  if (body.description !== undefined && typeof body.description !== "string") {
    throw new HttpError(400, '"look.description" tiene que ser un string');
  }
  if (body.createdAt !== undefined && typeof body.createdAt !== "number") throw new HttpError(400, '"look.createdAt" tiene que ser un número');
  return { src: body.src, description: (body.description as string | undefined) ?? "", createdAt: (body.createdAt as number | undefined) ?? Date.now() };
}

function agentPatch(body: Record<string, unknown>): AgentPatch {
  const patch: AgentPatch = {};
  for (const key of ["name", "role", "prompt", "providerId", "model"] as const) {
    const v = optString(body, key);
    if (v !== undefined) patch[key] = v;
  }
  if (body.seat !== undefined) {
    if (typeof body.seat !== "number" || !Number.isInteger(body.seat) || body.seat < 0) {
      throw new HttpError(400, '"seat" tiene que ser un entero >= 0');
    }
    patch.seat = body.seat;
  }
  if (body.lead !== undefined) {
    if (typeof body.lead !== "boolean") throw new HttpError(400, '"lead" tiene que ser boolean');
    patch.lead = body.lead;
  }
  if (body.tools !== undefined) {
    if (typeof body.tools !== "boolean") throw new HttpError(400, '"tools" tiene que ser boolean');
    patch.tools = body.tools;
  }
  if (body.look !== undefined) patch.look = validLook(body.look);
  if (body.appearance !== undefined) patch.appearance = asObject(body.appearance) as unknown as Appearance;
  return patch;
}

function providerPatch(body: Record<string, unknown>): Partial<Provider> {
  const patch: Partial<Provider> = {};
  for (const key of ["name", "baseUrl", "apiKey", "apiKeyEnv"] as const) {
    const v = optString(body, key);
    if (v !== undefined) patch[key] = v;
  }
  const kind = optString(body, "kind");
  if (kind !== undefined) {
    if (!PROVIDER_KINDS.includes(kind as ProviderKind)) throw new HttpError(400, `"kind" inválido: ${kind}`);
    patch.kind = kind as ProviderKind;
  }
  return patch;
}

function validLayout(value: unknown): Layout {
  const body = asObject(value);
  const isPoint = (p: unknown) =>
    !!p && typeof p === "object" && typeof (p as Layout["entry"]).x === "number" && typeof (p as Layout["entry"]).y === "number";
  if (
    typeof body.background !== "string" ||
    typeof body.width !== "number" ||
    typeof body.height !== "number" ||
    !isPoint(body.entry) ||
    !Array.isArray(body.seats) ||
    !body.seats.every(isPoint) ||
    (body.lights !== undefined && !(Array.isArray(body.lights) && body.lights.every(isPoint))) ||
    (body.spots !== undefined && !(Array.isArray(body.spots) && body.spots.every(isPoint))) ||
    (body.board !== undefined &&
      !(isPoint(body.board) && typeof (body.board as Rect).w === "number" && typeof (body.board as Rect).h === "number"))
  ) {
    throw new HttpError(400, "Layout inválido");
  }
  return body as unknown as Layout;
}

function hostAllowed(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

function originGuard(extra: string[]) {
  const origins = new Set<string>();
  const hosts = new Set<string>();
  for (const raw of extra.map((e) => e.trim()).filter(Boolean)) {
    try {
      const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
      if (raw.includes("://")) origins.add(u.origin);
      hosts.add(u.host.toLowerCase());
      hosts.add(u.hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  return (req: IncomingMessage): string | null => {
    const host = req.headers.host;
    if (!host) return "Falta el header Host";
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return "Host inválido";
    }
    if (!hostAllowed(hostname) && !hosts.has(host.toLowerCase()) && !hosts.has(hostname.toLowerCase())) return `Host no permitido: ${host}`;
    const origin = req.headers.origin;
    if (origin === undefined) return null;
    try {
      const u = new URL(origin);
      if ((u.protocol === "http:" || u.protocol === "https:") && hostAllowed(u.hostname)) return null;
      if (origins.has(u.origin)) return null;
    } catch {
      return `Origin no permitido: ${origin}`;
    }
    return `Origin no permitido: ${origin}`;
  };
}

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? "data");
  const staticDir =
    options.staticDir !== undefined ? options.staticDir : process.env.NODE_ENV === "production" ? join(ROOT, "dist") : null;
  const store = await Store.open(dataDir);
  const looksDir = join(dataDir, "looks");
  const clients = new Set<ServerResponse>();
  const permissions = new Permissions(options.permissionTimeoutMs);
  const drawing = new Set<string>();
  const guard = originGuard(options.allowedOrigins ?? (process.env.OFFICE_ALLOWED_ORIGINS ?? "").split(","));
  const settings = (): Settings => {
    store.office.settings = { ...defaultSettings(store.office.providers), ...store.office.settings };
    return store.office.settings;
  };
  const removeLookFile = async (src: string | undefined) => {
    const file = lookFileFromSrc(src);
    if (file) await unlink(join(looksDir, file)).catch(() => {});
  };

  const send = (res: ServerResponse, event: OfficeEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const broadcast = (event: OfficeEvent) => {
    for (const res of clients) send(res, event);
  };
  const officeChanged = async () => {
    await store.save();
    broadcast({ type: "office", office: publicOffice(store.office) });
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    if (!staticDir) return false;
    const base = resolve(staticDir);
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    } catch {
      throw new HttpError(400, "Ruta inválida");
    }
    let file = resolve(base, rel);
    if (file !== base && !file.startsWith(base + sep)) throw new HttpError(403, "Prohibido");
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile) {
      if (extname(rel)) return false;
      file = join(base, "index.html");
    }
    const data = await readFile(file).catch(() => null);
    if (!data) return false;
    res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
    res.end(data);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "Ruta inválida");
    }
    const office = store.office;

    if (parts[0] !== "api") {
      if ((method === "GET" || method === "HEAD") && (await serveStatic(url.pathname, res))) return;
      throw new HttpError(404, "No encontrado");
    }
    const denied = guard(req);
    if (denied) throw new HttpError(403, denied);
    const [, resource, id, sub] = parts;
    const route = `${method} ${resource ?? ""}${id !== undefined ? "/:id" : ""}${sub !== undefined ? `/${sub}` : ""}`;
    if (parts.length > 4) throw new HttpError(404, "No encontrado");

    switch (route) {
      case "GET office":
        return sendJson(res, 200, publicOffice(office));

      case "GET events": {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": connected\n\n");
        send(res, { type: "office", office: publicOffice(office) });
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      case "POST agents": {
        const patch = agentPatch(asObject(await readJson(req)));
        const lead = office.agents.find((a) => a.lead) ?? office.agents[0];
        const providerId = patch.providerId ?? lead?.providerId ?? office.providers[0]?.id;
        if (!providerId || !office.providers.some((p) => p.id === providerId)) {
          throw new HttpError(400, `Provider "${providerId}" no existe`);
        }
        const used = new Set(office.agents.map((a) => a.seat));
        let seat = 0;
        while (used.has(seat)) seat++;
        const agent: Agent = {
          id: `a-${randomUUID().slice(0, 8)}`,
          name: patch.name ?? "Persona nueva",
          role: patch.role ?? "Generalista",
          prompt: patch.prompt ?? "",
          providerId,
          model: patch.model ?? (patch.providerId ? "" : lead?.model ?? "demo"),
          appearance: { ...DEFAULT_APPEARANCE, ...patch.appearance },
          seat: patch.seat ?? seat,
          tools: patch.tools ?? false,
        };
        if (patch.look) agent.look = patch.look;
        if (patch.lead || office.agents.length === 0) {
          for (const a of office.agents) delete a.lead;
          agent.lead = true;
        }
        office.agents.push(agent);
        await officeChanged();
        return sendJson(res, 201, agent);
      }

      case "PUT agents/:id": {
        const agent = office.agents.find((a) => a.id === id);
        if (!agent) throw new HttpError(404, "Agente no encontrado");
        const patch = agentPatch(asObject(await readJson(req)));
        if (patch.providerId !== undefined && !office.providers.some((p) => p.id === patch.providerId)) {
          throw new HttpError(400, `Provider "${patch.providerId}" no existe`);
        }
        if (patch.lead === false && agent.lead) throw new HttpError(409, "Tiene que haber un líder: marcá a otra persona como líder");
        const { appearance, lead, look, ...rest } = patch;
        Object.assign(agent, rest);
        if (appearance) agent.appearance = { ...agent.appearance, ...appearance };
        if (look !== undefined) {
          const previous = agent.look?.src;
          if (look) agent.look = look;
          else delete agent.look;
          if (previous && previous !== look?.src) await removeLookFile(previous);
        }
        if (lead) {
          for (const a of office.agents) delete a.lead;
          agent.lead = true;
        }
        await officeChanged();
        return sendJson(res, 200, agent);
      }

      case "DELETE agents/:id": {
        const index = office.agents.findIndex((a) => a.id === id);
        if (index === -1) throw new HttpError(404, "Agente no encontrado");
        if (office.agents.length === 1) throw new HttpError(409, "No se puede borrar al último líder");
        const [removed] = office.agents.splice(index, 1);
        if (removed.lead) office.agents[0].lead = true;
        store.history.reset(removed.id);
        await officeChanged();
        await removeLookFile(removed.look?.src);
        return sendJson(res, 200, { ok: true });
      }

      case "POST providers": {
        const body = asObject(await readJson(req));
        const patch = providerPatch(body);
        if (!patch.kind) throw new HttpError(400, '"kind" es obligatorio');
        const requested = optString(body, "id");
        const pid = slugify(requested ?? patch.name ?? "") || `p-${randomUUID().slice(0, 8)}`;
        if (office.providers.some((p) => p.id === pid)) throw new HttpError(409, `Ya existe un provider "${pid}"`);
        const provider: Provider = { name: patch.name ?? pid, ...patch, id: pid, kind: patch.kind };
        if (!provider.apiKey) delete provider.apiKey;
        office.providers.push(provider);
        await officeChanged();
        return sendJson(res, 201, publicOffice({ ...office, providers: [provider] }).providers[0]);
      }

      case "PUT providers/:id": {
        const provider = office.providers.find((p) => p.id === id);
        if (!provider) throw new HttpError(404, "Provider no encontrado");
        const patch = providerPatch(asObject(await readJson(req)));
        if (!patch.apiKey) delete patch.apiKey;
        Object.assign(provider, patch);
        await officeChanged();
        return sendJson(res, 200, publicOffice({ ...office, providers: [provider] }).providers[0]);
      }

      case "DELETE providers/:id": {
        const index = office.providers.findIndex((p) => p.id === id);
        if (index === -1) throw new HttpError(404, "Provider no encontrado");
        const users = office.agents.filter((a) => a.providerId === id);
        if (users.length > 0) {
          throw new HttpError(409, `Lo usa${users.length > 1 ? "n" : ""}: ${users.map((a) => a.name).join(", ")}`);
        }
        office.providers.splice(index, 1);
        await officeChanged();
        return sendJson(res, 200, { ok: true });
      }

      case "PUT layout": {
        office.layout = validLayout(await readJson(req));
        await officeChanged();
        return sendJson(res, 200, office.layout);
      }

      case "POST message": {
        const body = asObject(await readJson(req));
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, '"text" es obligatorio');
        const target = body.target ?? null;
        if (target !== null && typeof target !== "string") throw new HttpError(400, '"target" tiene que ser string o null');
        if (target && !office.agents.some((a) => a.id === target)) throw new HttpError(400, `Agente "${target}" no existe`);
        const runId = randomUUID();
        sendJson(res, 202, { runId });
        settings();
        runMessage(structuredClone(office), text, target || null, broadcast, {
          runId,
          history: store.history,
          permissions,
          commandTimeoutMs: options.commandTimeoutMs,
        }).catch((err) => {
          console.error("[run]", runId, err);
        });
        return;
      }

      case "PUT settings": {
        const body = asObject(await readJson(req));
        const current = settings();
        const next: Settings = { ...current };
        const workspace = optString(body, "workspace");
        if (workspace !== undefined) {
          const abs = resolvePath(current.workspace, workspace);
          const isDir = await stat(abs).then((s) => s.isDirectory()).catch(() => false);
          if (!isDir) throw new HttpError(400, `La carpeta de trabajo no existe o no es un directorio: ${abs}`);
          next.workspace = abs;
        }
        if (body.autoApprove !== undefined) {
          if (typeof body.autoApprove !== "boolean") throw new HttpError(400, '"autoApprove" tiene que ser boolean');
          next.autoApprove = body.autoApprove;
        }
        const imageProviderId = optString(body, "imageProviderId");
        if (imageProviderId !== undefined) {
          if (imageProviderId && !office.providers.some((p) => p.id === imageProviderId)) {
            throw new HttpError(400, `Provider "${imageProviderId}" no existe`);
          }
          next.imageProviderId = imageProviderId;
        }
        const imageModel = optString(body, "imageModel");
        if (imageModel !== undefined) next.imageModel = imageModel.trim();
        office.settings = next;
        await officeChanged();
        return sendJson(res, 200, next);
      }

      case "POST permission": {
        const body = asObject(await readJson(req));
        const callId = optString(body, "callId");
        const decision = optString(body, "decision");
        if (!callId) throw new HttpError(400, '"callId" es obligatorio');
        if (!decision || !DECISIONS.includes(decision as PermissionDecision)) {
          throw new HttpError(400, '"decision" tiene que ser allow, always o deny');
        }
        if (!permissions.resolve(callId, decision as PermissionDecision)) throw new HttpError(404, "No hay un pedido de permiso pendiente con ese callId");
        return sendJson(res, 200, { ok: true });
      }

      case "POST agents/:id/look": {
        const agent = office.agents.find((a) => a.id === id);
        if (!agent) throw new HttpError(404, "Agente no encontrado");
        const body = asObject(await readJson(req));
        const description = typeof body.description === "string" ? body.description.trim() : "";
        if (!description) throw new HttpError(400, '"description" es obligatorio');
        if (description.length > 1000) throw new HttpError(400, '"description" es demasiado larga (máx 1000 caracteres)');
        const { imageProviderId, imageModel } = settings();
        if (!imageProviderId) throw new HttpError(400, "Elegí un provider de imágenes en la configuración antes de generar un look");
        const provider = office.providers.find((p) => p.id === imageProviderId);
        if (!provider) throw new HttpError(400, `El provider de imágenes "${imageProviderId}" no existe`);
        if (provider.kind !== "openai") throw new HttpError(400, "El provider de imágenes tiene que ser OpenAI-compatible");
        if (!imageModel) throw new HttpError(400, "Elegí un modelo de imágenes en la configuración antes de generar un look");
        if (drawing.has(agent.id)) throw new HttpError(409, "Ya se está dibujando un look para esta persona");
        drawing.add(agent.id);
        const agentId = agent.id;
        sendJson(res, 202, { ok: true });
        broadcast({ type: "look_progress", agentId, status: "drawing" });
        (async () => {
          const image = await generateLookImage(provider, imageModel, description);
          await mkdir(looksDir, { recursive: true });
          const file = lookFileName(agentId, image.ext);
          await writeFile(join(looksDir, file), image.data);
          const current = store.office.agents.find((a) => a.id === agentId);
          if (!current) {
            await unlink(join(looksDir, file)).catch(() => {});
            throw new Error("La persona ya no está en la oficina");
          }
          const previous = current.look?.src;
          current.look = { src: `/api/looks/${file}`, description, createdAt: Date.now() };
          await officeChanged();
          if (previous && previous !== current.look.src) await removeLookFile(previous);
          broadcast({ type: "look_progress", agentId, status: "done" });
        })()
          .catch((err) => {
            broadcast({ type: "look_progress", agentId, status: "error", error: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => drawing.delete(agentId));
        return;
      }

      case "DELETE agents/:id/look": {
        const agent = office.agents.find((a) => a.id === id);
        if (!agent) throw new HttpError(404, "Agente no encontrado");
        const previous = agent.look?.src;
        delete agent.look;
        await officeChanged();
        await removeLookFile(previous);
        return sendJson(res, 200, { ok: true });
      }

      case "GET looks/:id": {
        if (!id || !LOOK_FILE_RE.test(id)) throw new HttpError(404, "No encontrado");
        const data = await readFile(join(looksDir, id)).catch(() => null);
        if (!data) throw new HttpError(404, "No encontrado");
        res.writeHead(200, {
          "content-type": LOOK_MIME[extname(id).slice(1)] ?? "application/octet-stream",
          "content-length": data.length,
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(data);
        return;
      }

      case "POST reset": {
        const body = asObject(await readJson(req));
        const agentId = optString(body, "agentId");
        store.history.reset(agentId || undefined);
        return sendJson(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "No encontrado");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      ok();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    store,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${actualPort}`,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(heartbeat);
        permissions.denyAll();
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  startServer()
    .then(({ url, store }) => {
      console.log(`Pixel Office API en ${url} (datos: ${store.file})`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
