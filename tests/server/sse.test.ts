import { describe, expect, it } from "vitest";
import { parseSSE, type SSEMessage } from "../../server/providers.ts";

async function collect(chunks: string[]): Promise<SSEMessage[]> {
  const enc = new TextEncoder();
  async function* gen() {
    for (const c of chunks) yield enc.encode(c);
  }
  const out: SSEMessage[] = [];
  for await (const m of parseSSE(gen())) out.push(m);
  return out;
}

describe("parseSSE", () => {
  it("reassembles events split across chunks", async () => {
    const msgs = await collect(['event: content_block_delta\nda', 'ta: {"a":', "1}\n", "\ndata: second\n\n"]);
    expect(msgs).toEqual([
      { event: "content_block_delta", data: '{"a":1}' },
      { data: "second" },
    ]);
  });

  it("handles CRLF split between chunks, comments and multi-line data", async () => {
    const msgs = await collect([": ping\r", "\n\r\ndata: a\r", "\ndata: b\r\n\r\n", "data: tail"]);
    expect(msgs).toEqual([{ data: "a\nb" }, { data: "tail" }]);
  });

  it("splits a multibyte character across chunks", async () => {
    const bytes = new TextEncoder().encode("data: ñandú\n\n");
    async function* gen() {
      yield bytes.slice(0, 8);
      yield bytes.slice(8);
    }
    const out: SSEMessage[] = [];
    for await (const m of parseSSE(gen())) out.push(m);
    expect(out).toEqual([{ data: "ñandú" }]);
  });
});
