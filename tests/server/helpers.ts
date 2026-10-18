import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { OfficeEvent } from "../../shared/types.ts";
import { parseSSE } from "../../server/providers.ts";

export interface FakeServer {
  url: string;
  bodies: any[];
  close(): Promise<void>;
}

export type FakeHandler = (body: any, req: IncomingMessage, res: ServerResponse, n: number) => void;

export async function fakeServer(handler: FakeHandler): Promise<FakeServer> {
  const bodies: any[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : {};
    bodies.push({ path: req.url, ...body });
    handler(body, req, res, bodies.length);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

export function writeSSE(res: ServerResponse, events: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`);
  res.end();
}

export class EventLog {
  readonly events: OfficeEvent[] = [];
  private ctrl = new AbortController();
  private waiters: { pred: (e: OfficeEvent) => boolean; ok: (e: OfficeEvent) => void }[] = [];
  ready: Promise<void>;

  constructor(baseUrl: string) {
    this.ready = (async () => {
      const res = await fetch(`${baseUrl}/api/events`, { signal: this.ctrl.signal });
      let first = true;
      let resolveFirst!: () => void;
      const firstOffice = new Promise<void>((r) => (resolveFirst = r));
      (async () => {
        try {
          for await (const msg of parseSSE(res.body!)) {
            const ev = JSON.parse(msg.data) as OfficeEvent;
            this.events.push(ev);
            if (first) {
              first = false;
              resolveFirst();
            }
            for (const w of [...this.waiters]) {
              if (w.pred(ev)) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                w.ok(ev);
              }
            }
          }
        } catch {
          return;
        }
      })();
      await firstOffice;
    })();
  }

  waitFor<T extends OfficeEvent["type"]>(
    type: T,
    pred: (e: Extract<OfficeEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Extract<OfficeEvent, { type: T }>> {
    const match = (e: OfficeEvent) => e.type === type && pred(e as Extract<OfficeEvent, { type: T }>);
    const found = this.events.find(match);
    if (found) return Promise.resolve(found as Extract<OfficeEvent, { type: T }>);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`timeout esperando ${type}`)), timeoutMs);
      this.waiters.push({
        pred: match,
        ok: (e) => {
          clearTimeout(timer);
          ok(e as Extract<OfficeEvent, { type: T }>);
        },
      });
    });
  }

  close() {
    this.ctrl.abort();
  }
}

export function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end();
  });
}
