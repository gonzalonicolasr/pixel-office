import { randomUUID } from "node:crypto";
import type { Agent, Assignment, ChatMessage, Office, OfficeEvent, Provider, Settings } from "../shared/types.ts";
import { streamChat, type ConvMessage, type ToolCall } from "./providers.ts";
import { defaultSettings, History } from "./store.ts";
import { Permissions, runToolCall, TOOL_SPECS } from "./tools.ts";

export const MAX_ASSIGNMENTS = 4;
export const MAX_TOOL_ITERATIONS = 25;

export interface Routing {
  note: string;
  assignments: Assignment[];
}

export interface RunOptions {
  runId?: string;
  history?: History;
  permissions?: Permissions;
  commandTimeoutMs?: number;
}

interface RunContext {
  office: Office;
  runId: string;
  history: History;
  emit: Emit;
  settings: Settings;
  permissions: Permissions;
  commandTimeoutMs?: number;
}

type Emit = (event: OfficeEvent) => void;

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function findLead(agents: Agent[]): Agent | undefined {
  return agents.find((a) => a.lead) ?? agents[0];
}

function extractJsonObject(raw: string): unknown {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

export function parseRouting(raw: string, agents: Agent[]): Routing | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as { note?: unknown; assignments?: unknown };
  if (obj.assignments !== undefined && !Array.isArray(obj.assignments)) return null;
  if (obj.assignments === undefined && typeof obj.note !== "string") return null;
  const leadId = findLead(agents)?.id;
  const assignments: Assignment[] = [];
  for (const item of (obj.assignments as unknown[] | undefined) ?? []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { agent?: unknown; agentId?: unknown; task?: unknown };
    const ref = typeof entry.agent === "string" ? entry.agent : typeof entry.agentId === "string" ? entry.agentId : "";
    const key = normalize(ref.trim());
    if (!key) continue;
    const agent = agents.find((a) => a.id === ref.trim()) ?? agents.find((a) => normalize(a.name) === key);
    if (!agent || agent.id === leadId || assignments.some((a) => a.agentId === agent.id)) continue;
    const task = typeof entry.task === "string" ? entry.task.trim() : "";
    if (!task) continue;
    assignments.push({ agentId: agent.id, task });
    if (assignments.length === MAX_ASSIGNMENTS) break;
  }
  return { note: typeof obj.note === "string" ? obj.note.trim() : "", assignments };
}

const DEMO_KEYWORDS: { text: RegExp; role: RegExp }[] = [
  { text: /\btest|bug|\bqa\b|prueba|segurid/, role: /\bqa\b|test/ },
  { text: /\bpost|linkedin|\bcopy\b|contenido|tweet/, role: /contenido|copy|post/ },
  { text: /\bapi|base de datos|server|servidor|backend|endpoint/, role: /backend/ },
  { text: /\bui\b|pantalla|\bcss\b|frontend|interfaz|boton/, role: /frontend|\bui\b/ },
  { text: /investig|busca|compar|research/, role: /research|investig/ },
];

export function demoRoute(text: string, agents: Agent[]): Routing | null {
  const lead = findLead(agents);
  const others = agents.filter((a) => a.id !== lead?.id);
  const t = normalize(text);
  const picked: Agent[] = [];
  const add = (agent: Agent | undefined) => {
    if (agent && !picked.includes(agent) && picked.length < MAX_ASSIGNMENTS) picked.push(agent);
  };
  for (const agent of others) {
    if (new RegExp(`\\b${normalize(agent.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) add(agent);
  }
  for (const kw of DEMO_KEYWORDS) {
    if (kw.text.test(t)) add(others.find((a) => kw.role.test(normalize(`${a.role} ${a.name}`))));
  }
  if (picked.length === 0) return null;
  const names = picked.map((a) => a.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
  return {
    note: `Esto lo ${picked.length === 1 ? "agarra" : "agarran"} ${list}.`,
    assignments: picked.map((a) => ({ agentId: a.id, task: `Encargate de la parte de ${a.role}: ${text}` })),
  };
}

function agentSystem(agent: Agent): string {
  return `${agent.prompt}\n\nTu nombre es ${agent.name} y tu rol en la oficina es: ${agent.role}.`;
}

function toolsSystem(agent: Agent, settings: Settings): string {
  return `${agentSystem(agent)}

Tenés acceso a la computadora del usuario mediante herramientas: listar carpetas, leer y buscar en archivos, escribir y editar archivos, y ejecutar comandos de shell.
La carpeta de trabajo (workspace) es: ${settings.workspace}
Las rutas relativas se resuelven desde ahí.
- Antes de modificar algo, mirá primero: listá, leé o buscá para entender qué hay.
- Contá brevemente qué vas a hacer y qué hiciste.
- No hagas acciones destructivas (borrar, sobrescribir trabajo ajeno, comandos irreversibles) salvo que el usuario lo pida explícitamente.
- Escribir, editar, ejecutar comandos o leer fuera del workspace puede requerir que el usuario lo apruebe; si lo deniega, no insistas y seguí con lo que puedas.`;
}

function usesTools(agent: Agent, provider: Provider): boolean {
  return agent.tools === true && provider.kind !== "demo";
}

function routingSystem(lead: Agent, agents: Agent[]): string {
  const roster = agents
    .filter((a) => a.id !== lead.id)
    .map((a) => `- id: ${a.id} | nombre: ${a.name} | rol: ${a.role}${a.tools ? " | puede usar la PC (archivos y comandos)" : ""}`)
    .join("\n");
  return `${agentSystem(lead)}

Sos quien reparte el trabajo. Tu equipo:
${roster || "(no hay nadie más en la oficina)"}

Decidí a quién le toca el pedido del usuario. Respondé SOLO con un objeto JSON, sin texto alrededor, con esta forma:
{"note":"frase corta para el usuario","assignments":[{"agent":"<id>","task":"instrucción concreta para esa persona"}]}
Usá como máximo ${MAX_ASSIGNMENTS} asignaciones. Si podés responder vos solo o es charla, devolvé "assignments": [].
Si el pedido requiere mirar, crear o cambiar archivos, o correr algo en la computadora del usuario, asignalo SOLO a alguien que "puede usar la PC". Si nadie puede, decilo en la nota y no lo asignes.`;
}

async function collect(agent: Agent, office: Office, system: string, messages: ChatMessage[]): Promise<string> {
  const provider = office.providers.find((p) => p.id === agent.providerId);
  if (!provider) throw new Error(`Provider "${agent.providerId}" no existe`);
  let text = "";
  for await (const chunk of streamChat({ provider, model: agent.model, system, messages })) {
    if (chunk.text) text += chunk.text;
  }
  return text;
}

async function runAgent(ctx: RunContext, agent: Agent, task: string, message: string, from: string | null): Promise<void> {
  const { office, runId, history, emit } = ctx;
  emit({ type: "agent_start", runId, agentId: agent.id, task, from });
  try {
    const provider = office.providers.find((p) => p.id === agent.providerId);
    if (!provider) throw new Error(`Provider "${agent.providerId}" no existe`);
    const withTools = usesTools(agent, provider);
    const system = withTools ? toolsSystem(agent, ctx.settings) : agentSystem(agent);
    const conv: ConvMessage[] = [...history.get(agent.id), { role: "user", content: message }];
    let text = "";
    let output = 0;
    let sawUsage = false;
    const say = (piece: string) => {
      text += piece;
      emit({ type: "delta", runId, agentId: agent.id, text: piece });
    };
    for (let step = 1; ; step++) {
      let stepText = "";
      let toolCalls: ToolCall[] = [];
      const tools = withTools ? TOOL_SPECS : undefined;
      for await (const chunk of streamChat({ provider, model: agent.model, system, messages: conv, tools })) {
        if (chunk.text) {
          if (!stepText && text && !text.endsWith("\n")) say("\n\n");
          stepText += chunk.text;
          say(chunk.text);
        }
        if (chunk.toolCalls) toolCalls = chunk.toolCalls;
        if (chunk.usage) {
          output += chunk.usage.output;
          sawUsage = true;
        }
      }
      if (!withTools || toolCalls.length === 0) break;
      if (step >= MAX_TOOL_ITERATIONS) {
        say(`${text && !text.endsWith("\n") ? "\n\n" : ""}(Me frené: llegué al máximo de ${MAX_TOOL_ITERATIONS} pasos con herramientas.)`);
        break;
      }
      conv.push({ role: "assistant", content: stepText, toolCalls });
      for (const call of toolCalls) {
        const result = await runToolCall(
          {
            runId,
            agentId: agent.id,
            settings: ctx.settings,
            permissions: ctx.permissions,
            emit,
            commandTimeoutMs: ctx.commandTimeoutMs,
          },
          call,
        );
        conv.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.output, isError: !result.ok });
      }
    }
    history.push(agent.id, { role: "user", content: message }, { role: "assistant", content: text });
    emit({ type: "agent_done", runId, agentId: agent.id, text, tokens: sawUsage ? output : Math.ceil(text.length / 4) });
  } catch (err) {
    emit({ type: "agent_error", runId, agentId: agent.id, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function runMessage(
  office: Office,
  text: string,
  target: string | null,
  emit: Emit,
  options: RunOptions = {},
): Promise<string> {
  const runId = options.runId ?? randomUUID();
  const history = options.history ?? new History();
  const ctx: RunContext = {
    office,
    runId,
    history,
    emit,
    settings: { ...defaultSettings(office.providers), ...office.settings },
    permissions: options.permissions ?? new Permissions(),
    commandTimeoutMs: options.commandTimeoutMs,
  };
  emit({ type: "run_start", runId, text, target });
  try {
    const direct = target ? office.agents.find((a) => a.id === target) : undefined;
    if (direct) {
      await runAgent(ctx, direct, text, text, null);
      return runId;
    }
    const lead = findLead(office.agents);
    if (!lead) return runId;
    emit({ type: "routing", runId, leadId: lead.id });
    let routing: Routing | null;
    const provider = office.providers.find((p) => p.id === lead.providerId);
    if (provider?.kind === "demo") {
      routing = demoRoute(text, office.agents);
    } else {
      try {
        const raw = await collect(lead, office, routingSystem(lead, office.agents), [
          ...history.get(lead.id),
          { role: "user", content: text },
        ]);
        routing = parseRouting(raw, office.agents);
      } catch (err) {
        emit({ type: "agent_error", runId, agentId: lead.id, error: err instanceof Error ? err.message : String(err) });
        return runId;
      }
    }
    const assignments = routing?.assignments ?? [];
    emit({ type: "route", runId, leadId: lead.id, note: assignments.length ? (routing?.note ?? "") : "", assignments });
    if (assignments.length === 0) {
      await runAgent(ctx, lead, text, text, null);
      return runId;
    }
    await Promise.all(
      assignments.map((a) => {
        const agent = office.agents.find((x) => x.id === a.agentId)!;
        const others = assignments
          .filter((o) => o.agentId !== a.agentId)
          .map((o) => `- ${office.agents.find((x) => x.id === o.agentId)?.name}: ${o.task}`)
          .join("\n");
        const brief = [
          `Tu tarea (de ${lead.name}): ${a.task}`,
          others ? `El resto del pedido lo hacen tus compañeros, no lo hagas vos:\n${others}` : "",
          `Pedido original del usuario, sólo como contexto: ${text}`,
          "Hacé únicamente tu parte y entregá el resultado directo, sin presentarte.",
        ]
          .filter(Boolean)
          .join("\n\n");
        return runAgent(ctx, agent, a.task, brief, lead.id);
      }),
    );
    return runId;
  } finally {
    emit({ type: "run_done", runId });
  }
}
