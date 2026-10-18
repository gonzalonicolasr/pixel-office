import { randomUUID } from "node:crypto";
import type { ChatMessage, Provider } from "../shared/types.ts";
import { resolveKey } from "./store.ts";
import type { ToolSpec } from "./tools.ts";

export { resolveKey };

export interface SSEMessage {
  event?: string;
  data: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ConvMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatChunk {
  text?: string;
  usage?: { input: number; output: number };
  toolCalls?: ToolCall[];
}

export interface ChatRequest {
  provider: Provider;
  model: string;
  system: string;
  messages: ConvMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export async function* parseSSE(
  stream: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SSEMessage | null => {
    if (data.length === 0) {
      event = undefined;
      return null;
    }
    const msg: SSEMessage = { data: data.join("\n") };
    if (event) msg.event = event;
    event = undefined;
    data = [];
    return msg;
  };

  const handleLine = (line: string): SSEMessage | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };

  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, nl);
      const sepLen = buffer[nl] === "\r" && buffer[nl + 1] === "\n" ? 2 : 1;
      if (buffer[nl] === "\r" && nl + 1 === buffer.length) break;
      buffer = buffer.slice(nl + sepLen);
      const msg = handleLine(line);
      if (msg) yield msg;
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    for (const line of buffer.split(/\r\n|\r|\n/)) {
      const msg = handleLine(line);
      if (msg) yield msg;
    }
  }
  const last = flush();
  if (last) yield last;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.body;
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function toAnthropicMessages(messages: ConvMessage[]): unknown[] {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: unknown[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseInput(c.arguments) });
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

async function* streamAnthropic(req: ChatRequest): AsyncGenerator<ChatChunk> {
  const key = resolveKey(req.provider);
  if (!key) throw new Error(`Falta la API key del provider "${req.provider.name}"`);
  const base = (req.provider.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const tools = req.tools?.length
    ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
    : {};
  const body = await post(
    `${base}/v1/messages`,
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    { model: req.model, system: req.system, messages: toAnthropicMessages(req.messages), max_tokens: req.tools?.length ? 8192 : 4096, stream: true, ...tools },
    req.signal,
  );
  let input = 0;
  let output = 0;
  const blocks = new Map<number, ToolCall>();
  for await (const msg of parseSSE(body)) {
    let payload: any;
    try {
      payload = JSON.parse(msg.data);
    } catch {
      continue;
    }
    switch (payload.type) {
      case "message_start":
        input = payload.message?.usage?.input_tokens ?? input;
        output = payload.message?.usage?.output_tokens ?? output;
        break;
      case "content_block_start":
        if (payload.content_block?.type === "tool_use") {
          blocks.set(payload.index, {
            id: payload.content_block.id || `toolu_${randomUUID()}`,
            name: payload.content_block.name ?? "",
            arguments: "",
          });
        }
        break;
      case "content_block_delta":
        if (typeof payload.delta?.text === "string") yield { text: payload.delta.text };
        else if (payload.delta?.type === "input_json_delta") {
          const block = blocks.get(payload.index);
          if (block && typeof payload.delta.partial_json === "string") block.arguments += payload.delta.partial_json;
        }
        break;
      case "message_delta":
        output = payload.usage?.output_tokens ?? output;
        break;
      case "error":
        throw new Error(`Anthropic: ${payload.error?.message ?? msg.data.slice(0, 300)}`);
    }
  }
  if (blocks.size > 0) {
    yield { toolCalls: [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ ...c, arguments: c.arguments || "{}" })) };
  }
  yield { usage: { input, output } };
}

export function toOpenAIMessages(system: string, messages: ConvMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export class OpenAIToolCallAccumulator {
  private calls: ToolCall[] = [];
  private byIndex = new Map<number, ToolCall>();
  private last: ToolCall | undefined;

  push(deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas as any[]) {
      if (!d || typeof d !== "object") continue;
      let call: ToolCall | undefined;
      if (typeof d.index === "number") call = this.byIndex.get(d.index);
      else if (d.id) call = this.calls.find((c) => c.id === d.id);
      else call = this.last;
      if (!call) {
        call = { id: "", name: "", arguments: "" };
        this.calls.push(call);
        if (typeof d.index === "number") this.byIndex.set(d.index, call);
      }
      if (typeof d.id === "string" && d.id) call.id = d.id;
      const fn = d.function;
      if (fn && typeof fn.name === "string" && fn.name && !call.name) call.name = fn.name;
      if (fn && typeof fn.arguments === "string") call.arguments += fn.arguments;
      else if (fn && fn.arguments && typeof fn.arguments === "object") call.arguments += JSON.stringify(fn.arguments);
      this.last = call;
    }
  }

  result(): ToolCall[] {
    return this.calls.filter((c) => c.name).map((c) => ({ ...c, id: c.id || `call_${randomUUID()}` }));
  }
}

async function* streamOpenAI(req: ChatRequest): AsyncGenerator<ChatChunk> {
  const key = resolveKey(req.provider);
  const base = (req.provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const tools = req.tools?.length
    ? {
        tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }
    : {};
  const body = await post(
    `${base}/chat/completions`,
    headers,
    {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...tools,
    },
    req.signal,
  );
  let usage: ChatChunk["usage"];
  const acc = new OpenAIToolCallAccumulator();
  for await (const msg of parseSSE(body)) {
    if (msg.data === "[DONE]") break;
    let payload: any;
    try {
      payload = JSON.parse(msg.data);
    } catch {
      continue;
    }
    if (payload.error) throw new Error(`OpenAI: ${payload.error.message ?? msg.data.slice(0, 300)}`);
    const delta = payload.choices?.[0]?.delta;
    const text = delta?.content;
    if (typeof text === "string" && text) yield { text };
    if (delta?.tool_calls) acc.push(delta.tool_calls);
    if (payload.usage) {
      usage = { input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 };
    }
  }
  const toolCalls = acc.result();
  if (toolCalls.length) yield { toolCalls };
  if (usage) yield { usage };
}

const DEMO_ROLES: { match: RegExp; bullets: string[] }[] = [
  {
    match: /frontend|\bui\b|ux/,
    bullets: ["Armo la estructura de la pantalla y sus componentes", "Defino estilos y estados (hover, foco, vacío)", "Reviso que se vea bien en mobile y sea accesible"],
  },
  {
    match: /backend|api|infra/,
    bullets: ["Defino los endpoints y el contrato de datos", "Modelo las tablas y validaciones", "Cubro errores, límites y logs"],
  },
  {
    match: /\bqa\b|testing|segur/,
    bullets: ["Armo los casos de prueba felices y de borde", "Intento romperlo con datos raros", "Te paso la lista de riesgos priorizada"],
  },
  {
    match: /research|investig/,
    bullets: ["Junto las fuentes más confiables", "Comparo las opciones con pros y contras", "Te dejo un resumen corto con mi recomendación"],
  },
  {
    match: /contenido|copy|post|linkedin/,
    bullets: ["Escribo un gancho que frene el scroll", "Cuento la historia en pocas líneas", "Cierro con una frase para recordar y un CTA suave"],
  },
  {
    match: /lider|orquest/,
    bullets: ["Te respondo yo directamente", "Si hace falta, sumo a alguien del equipo", "Avisame si querés que lo profundicemos"],
  },
];

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function demoReply(system: string, messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const ask = last.split("\n\nPedido original:")[0].replace(/\s+/g, " ").trim();
  const summary = ask.length > 140 ? `${ask.slice(0, 137)}...` : ask || "lo que me pediste";
  const sys = normalize(system);
  const role = DEMO_ROLES.find((r) => r.match.test(sys));
  const bullets = role?.bullets ?? ["Entiendo bien qué se necesita", "Hago una primera versión", "Te la paso para que la revises"];
  return `Listo, me pongo con eso: ${summary}\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n\n(Respuesta de demo: configurá un provider con API key para respuestas reales.)`;
}

async function* streamDemo(req: ChatRequest): AsyncGenerator<ChatChunk> {
  const plain = req.messages.filter((m): m is ChatMessage => m.role !== "tool");
  const text = demoReply(req.system, plain);
  const parts = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < parts.length; i += 2) {
    if (req.signal?.aborted) throw new Error("Cancelado");
    await new Promise((r) => setTimeout(r, 40));
    yield { text: parts.slice(i, i + 2).join("") };
  }
  const input = Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4);
  yield { usage: { input, output: Math.ceil(text.length / 4) } };
}

export function streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
  switch (req.provider.kind) {
    case "anthropic":
      return streamAnthropic(req);
    case "openai":
      return streamOpenAI(req);
    case "demo":
      return streamDemo(req);
    default:
      throw new Error(`Provider desconocido: ${String((req.provider as Provider).kind)}`);
  }
}
