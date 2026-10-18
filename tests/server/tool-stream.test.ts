import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../shared/types.ts";
import { streamChat, toAnthropicMessages, type ChatChunk, type ConvMessage } from "../../server/providers.ts";
import { TOOL_SPECS } from "../../server/tools.ts";

function sseResponse(events: unknown[], chunkSize = 7): Response {
  const raw = events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join("");
  const bytes = new TextEncoder().encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += chunkSize) ctrl.enqueue(bytes.slice(i, i + chunkSize));
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function run(provider: Provider, messages: ConvMessage[] = [{ role: "user", content: "hola" }]) {
  const chunks: ChatChunk[] = [];
  for await (const c of streamChat({ provider, model: "m", system: "sys", messages, tools: TOOL_SPECS })) chunks.push(c);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai tool_calls stream", () => {
  it("accumulates arguments split across chunks and parallel calls by index", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sseResponse([
          { choices: [{ delta: { content: "Miro " } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "list_dir", arguments: '{"pa' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{\n  "path": ' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'th":"."}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"\n}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
          "data: [DONE]\n\n",
        ]);
      }),
    );
    const provider: Provider = { id: "o", name: "O", kind: "openai", baseUrl: "http://fake/v1", apiKey: "k" };
    const chunks = await run(provider, [
      { role: "user", content: "hola" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "list_dir", arguments: "{}" }] },
      { role: "tool", toolCallId: "c0", name: "list_dir", content: "a.txt" },
    ]);
    expect(chunks.filter((c) => c.text).map((c) => c.text).join("")).toBe("Miro ");
    const calls = chunks.find((c) => c.toolCalls)?.toolCalls;
    expect(calls).toEqual([
      { id: "call_a", name: "read_file", arguments: '{\n  "path": "README.md"\n}' },
      { id: "call_b", name: "list_dir", arguments: '{"path":"."}' },
    ]);
    expect(JSON.parse(calls![0].arguments)).toEqual({ path: "README.md" });
    expect(chunks.at(-1)?.usage).toEqual({ input: 10, output: 5 });
    expect(bodies[0].tools[0]).toMatchObject({ type: "function", function: { name: "list_dir" } });
    expect(bodies[0].messages.slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "list_dir", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: "a.txt" },
    ]);
  });
});

describe("anthropic tool_use stream", () => {
  it("collects input_json_delta into tool calls", async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sseResponse([
          { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Voy a escribir" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "a.t' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'xt", "content": "hi"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "list_dir", input: {} } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
          { type: "message_stop" },
        ]);
      }),
    );
    const provider: Provider = { id: "a", name: "A", kind: "anthropic", baseUrl: "http://fake", apiKey: "k" };
    const chunks = await run(provider);
    expect(chunks.filter((c) => c.text).map((c) => c.text).join("")).toBe("Voy a escribir");
    expect(chunks.find((c) => c.toolCalls)?.toolCalls).toEqual([
      { id: "toolu_1", name: "write_file", arguments: '{"path": "a.txt", "content": "hi"}' },
      { id: "toolu_2", name: "list_dir", arguments: "{}" },
    ]);
    expect(chunks.at(-1)?.usage).toEqual({ input: 12, output: 30 });
    expect(bodies[0].tools[0]).toMatchObject({ name: "list_dir", input_schema: { type: "object" } });
  });

  it("maps tool turns to tool_use and merged tool_result blocks", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "hola" },
      {
        role: "assistant",
        content: "miro",
        toolCalls: [
          { id: "t1", name: "read_file", arguments: '{"path":"a"}' },
          { id: "t2", name: "list_dir", arguments: "roto" },
        ],
      },
      { role: "tool", toolCallId: "t1", name: "read_file", content: "x" },
      { role: "tool", toolCallId: "t2", name: "list_dir", content: "error", isError: true },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hola" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "miro" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "list_dir", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "x" },
          { type: "tool_result", tool_use_id: "t2", content: "error", is_error: true },
        ],
      },
    ]);
  });
});
