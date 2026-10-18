import { useEffect, useRef, useState } from "react";
import type { Agent, Layout, OfficeEvent, PermissionDecision, Provider, PublicOffice, Settings } from "../shared/types.ts";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  office: () => call<PublicOffice>("GET", "/api/office"),
  createAgent: (a: Partial<Agent>) => call<Agent>("POST", "/api/agents", a),
  updateAgent: (id: string, a: Partial<Agent>) => call<Agent>("PUT", `/api/agents/${id}`, a),
  deleteAgent: (id: string) => call<unknown>("DELETE", `/api/agents/${id}`),
  createProvider: (p: Partial<Provider>) => call<unknown>("POST", "/api/providers", p),
  updateProvider: (id: string, p: Partial<Provider>) => call<unknown>("PUT", `/api/providers/${id}`, p),
  deleteProvider: (id: string) => call<unknown>("DELETE", `/api/providers/${id}`),
  saveLayout: (l: Layout) => call<unknown>("PUT", "/api/layout", l),
  send: (text: string, target: string | null) => call<{ runId: string }>("POST", "/api/message", { text, target }),
  reset: (agentId?: string) => call<unknown>("POST", "/api/reset", { agentId }),
  permission: (callId: string, decision: PermissionDecision) => call<unknown>("POST", "/api/permission", { callId, decision }),
  saveSettings: (s: Partial<Settings>) => call<unknown>("PUT", "/api/settings", s),
  drawLook: (id: string, description: string) => call<unknown>("POST", `/api/agents/${id}/look`, { description }),
  deleteLook: (id: string) => call<unknown>("DELETE", `/api/agents/${id}/look`),
};

export function useOfficeStream(onEvent: (ev: OfficeEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        handler.current(JSON.parse(m.data) as OfficeEvent);
      } catch {
        return;
      }
    };
    return () => es.close();
  }, []);
  return connected;
}
