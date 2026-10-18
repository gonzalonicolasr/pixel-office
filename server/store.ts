import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, ChatMessage, Layout, Office, Provider, PublicOffice, PublicProvider, Settings } from "../shared/types.ts";

export const HISTORY_LIMIT = 20;

export const DEFAULT_LAYOUT: Layout = {
  background: "/office/office-bg.png",
  width: 1672,
  height: 940,
  entry: { x: 838, y: 915 },
  seats: [
    { x: 440, y: 432 },
    { x: 844, y: 432 },
    { x: 1249, y: 432 },
    { x: 397, y: 690 },
    { x: 844, y: 690 },
    { x: 1288, y: 690 },
  ],
  lights: [
    { x: 300, y: 52 },
    { x: 512, y: 90 },
    { x: 845, y: 55 },
    { x: 1190, y: 90 },
    { x: 1360, y: 52 },
  ],
  board: { x: 690, y: 80, w: 335, h: 135 },
  spots: [
    { x: 857, y: 265 },
    { x: 1440, y: 330 },
    { x: 230, y: 560 },
    { x: 1180, y: 820 },
  ],
};

export function defaultProviders(): Provider[] {
  return [
    { id: "demo", name: "Demo (sin API key)", kind: "demo" },
    { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
    {
      id: "openai",
      name: "OpenAI-compatible",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
  ];
}

export function defaultSettings(providers: Provider[]): Settings {
  const image = providers.find((p) => p.kind === "openai" && resolveKey(p));
  return {
    workspace: process.env.OFFICE_WORKSPACE || homedir(),
    autoApprove: false,
    imageProviderId: image?.id ?? "",
    imageModel: "",
  };
}

export function migrateOffice(office: Office): boolean {
  const defaults = defaultSettings(office.providers ?? []);
  const current = office.settings as Partial<Settings> | undefined;
  const next: Settings = {
    workspace: typeof current?.workspace === "string" && current.workspace ? current.workspace : defaults.workspace,
    autoApprove: typeof current?.autoApprove === "boolean" ? current.autoApprove : defaults.autoApprove,
    imageProviderId: typeof current?.imageProviderId === "string" ? current.imageProviderId : defaults.imageProviderId,
    imageModel: typeof current?.imageModel === "string" ? current.imageModel : defaults.imageModel,
  };
  let changed = JSON.stringify(current) !== JSON.stringify(next);
  office.settings = next;
  for (const agent of office.agents ?? []) {
    if (typeof agent.tools !== "boolean") {
      agent.tools = false;
      changed = true;
    }
  }
  return changed;
}

export function defaultOffice(): Office {
  const useAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const providerId = useAnthropic ? "anthropic" : "demo";
  const model = useAnthropic ? "claude-sonnet-5-5" : "demo";
  const base = { providerId, model };
  const agents: Agent[] = [
    {
      id: "mate",
      name: "Mate",
      role: "Líder / Orquesta el equipo",
      prompt:
        "Sos Mate, el líder de la oficina. Entendés qué pide el usuario, lo repartís entre las personas que mejor encajan y cuando es algo simple lo contestás vos. Hablás claro, en rioplatense y sin vueltas.",
      ...base,
      appearance: { skin: "#f1c27d", hair: "#3b2a1a", hairStyle: "short", shirt: "#2e7d5b", pants: "#2b2b3a", accessory: "none" },
      seat: 0,
      lead: true,
    },
    {
      id: "coda",
      name: "Coda",
      role: "Frontend (UI/UX y código web)",
      prompt:
        "Sos Coda, dev frontend. Te ocupás de interfaces, UX, HTML, CSS y React. Proponés soluciones concretas, con código cuando hace falta, y cuidás la accesibilidad.",
      ...base,
      appearance: { skin: "#e0ac69", hair: "#1a1a1a", hairStyle: "curly", shirt: "#4f6bed", pants: "#30343f", accessory: "glasses" },
      seat: 1,
    },
    {
      id: "bruno",
      name: "Bruno",
      role: "Backend (APIs, datos e infraestructura)",
      prompt:
        "Sos Bruno, dev backend. Diseñás APIs, modelos de datos e infraestructura. Pensás en errores, performance y seguridad, y respondés con pasos claros.",
      ...base,
      appearance: { skin: "#c68642", hair: "#2a1b10", hairStyle: "cap", shirt: "#d35400", pants: "#3a3a3a", accessory: "headphones" },
      seat: 2,
    },
    {
      id: "reva",
      name: "Reva",
      role: "QA (testing y seguridad)",
      prompt:
        "Sos Reva, QA. Buscás bugs, armás casos de prueba y revisás riesgos de seguridad. Sos detallista y priorizás lo que más puede romper.",
      ...base,
      appearance: { skin: "#ffdbac", hair: "#a0522d", hairStyle: "bun", shirt: "#8e44ad", pants: "#2c3e50", accessory: "glasses" },
      seat: 3,
    },
    {
      id: "indu",
      name: "Indu",
      role: "Research (investiga y resume)",
      prompt:
        "Sos Indu, research. Investigás, comparás opciones y resumís lo importante en pocas líneas, separando lo que sabés de lo que suponés.",
      ...base,
      appearance: { skin: "#8d5524", hair: "#0f0f0f", hairStyle: "long", shirt: "#16a085", pants: "#34495e", accessory: "none" },
      seat: 4,
    },
    {
      id: "olivia",
      name: "Olivia",
      role: "Contenido (posts, copy y LinkedIn)",
      prompt:
        "Sos Olivia, de contenido. Escribís posts, copy y textos para LinkedIn con voz cercana, un buen gancho al principio y un cierre que se recuerde.",
      ...base,
      appearance: { skin: "#f5d0b0", hair: "#e8b04b", hairStyle: "long", shirt: "#e84393", pants: "#2d3436", accessory: "headphones" },
      seat: 5,
    },
  ];
  const providers = defaultProviders();
  return {
    name: "Pixel Office",
    agents,
    providers,
    layout: structuredClone(DEFAULT_LAYOUT),
    settings: defaultSettings(providers),
  };
}

export function resolveKey(provider: Provider): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  if (provider.apiKeyEnv) return process.env[provider.apiKeyEnv] || undefined;
  return undefined;
}

export function publicProvider(provider: Provider): PublicProvider {
  const rest: Provider = { ...provider };
  delete rest.apiKey;
  return { ...rest, hasKey: Boolean(resolveKey(provider)) };
}

export function publicOffice(office: Office): PublicOffice {
  return { ...structuredClone(office), providers: office.providers.map(publicProvider) };
}

export class History {
  private map = new Map<string, ChatMessage[]>();

  get(agentId: string): ChatMessage[] {
    return [...(this.map.get(agentId) ?? [])];
  }

  push(agentId: string, ...messages: ChatMessage[]): void {
    const list = [...(this.map.get(agentId) ?? []), ...messages];
    this.map.set(agentId, list.slice(-HISTORY_LIMIT));
  }

  reset(agentId?: string): void {
    if (agentId) this.map.delete(agentId);
    else this.map.clear();
  }
}

export class Store {
  readonly history = new History();
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string,
    public office: Office,
  ) {}

  static async open(dataDir: string): Promise<Store> {
    await mkdir(dataDir, { recursive: true });
    const file = join(dataDir, "office.json");
    let office: Office;
    try {
      office = JSON.parse(await readFile(file, "utf8")) as Office;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      office = defaultOffice();
      migrateOffice(office);
      const store = new Store(file, office);
      await store.save();
      return store;
    }
    const store = new Store(file, office);
    if (migrateOffice(office)) await store.save();
    return store;
  }

  save(): Promise<void> {
    const data = JSON.stringify(this.office, null, 2) + "\n";
    const next = this.writing.then(async () => {
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
