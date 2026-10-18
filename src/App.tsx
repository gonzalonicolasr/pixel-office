import { useCallback, useMemo, useState } from "react";
import type { OfficeEvent, PublicOffice } from "../shared/types.ts";
import { api, useOfficeStream } from "./api.ts";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { type PendingPermission, PermissionModal } from "./components/PermissionModal.tsx";
import { ProvidersEditor } from "./components/ProvidersEditor.tsx";
import { TeamEditor } from "./components/TeamEditor.tsx";
import { OfficeEngine } from "./office/engine.ts";
import { OfficeCanvas } from "./office/OfficeCanvas.tsx";
import { type Run, reduceRuns } from "./runs.ts";

type Tab = "office" | "team" | "models";

export function App() {
  const engine = useMemo(() => new OfficeEngine(), []);
  const [office, setOffice] = useState<PublicOffice | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("office");
  const [editLayout, setEditLayout] = useState(false);
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const [looks, setLooks] = useState<Record<string, { status: "drawing" | "done" | "error"; error?: string }>>({});

  const onEvent = useCallback(
    (ev: OfficeEvent) => {
      engine.handle(ev);
      if (ev.type === "office") {
        setOffice(ev.office);
        setTarget((t) => (t && ev.office.agents.some((a) => a.id === t) ? t : null));
      }
      if (ev.type === "permission_request") setPending((p) => [...p.filter((x) => x.callId !== ev.callId), ev]);
      if (ev.type === "permission_resolved") setPending((p) => p.filter((x) => x.callId !== ev.callId));
      if (ev.type === "look_progress") setLooks((l) => ({ ...l, [ev.agentId]: { status: ev.status, error: ev.error } }));
      setRuns((r) => reduceRuns(r, ev));
    },
    [engine],
  );
  const live = useOfficeStream(onEvent);

  const tokens = runs.reduce((n, r) => n + r.entries.reduce((m, e) => m + e.tokens, 0), 0);
  const working = runs.some((r) => !r.done);
  const busyAgents = new Set(runs.filter((r) => !r.done).flatMap((r) => r.entries.filter((e) => e.status === "working").map((e) => e.agentId)));

  if (!office)
    return (
      <div className="boot">
        <div className="boot-box">
          <b>Pixel Office</b>
          <span>{live ? "Cargando la oficina…" : "Conectando con el servidor… (¿corriste npm run dev?)"}</span>
        </div>
      </div>
    );

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="logo">▦</div>
          <div>
            <b>{office.name}</b>
            <small>AI office · open source</small>
          </div>
          <span className={`live ${live ? "" : "off"}`}>● {live ? "LIVE" : "OFFLINE"}</span>
        </div>
        <nav>
          <button className={tab === "office" ? "on" : ""} onClick={() => setTab("office")}>
            🏢 Oficina
          </button>
          <button className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}>
            👥 Equipo <em>{office.agents.length}</em>
          </button>
          <button className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>
            🔌 Modelos
          </button>
        </nav>
        <div className="stats">
          <span>
            Pedidos <b>{runs.length}</b>
          </span>
          <span>
            Tokens <b>{tokens.toLocaleString("es-AR")}</b>
          </span>
          <span>
            Trabajando <b>{busyAgents.size}</b>
          </span>
        </div>
      </header>

      {tab === "office" && (
        <main className="main">
          <section className="panel stage">
            <header className="panel-head">
              <span>
                <i className={`dot ${working ? "on" : ""}`} /> Oficina
              </span>
              <div className="stage-actions">
                {target && (
                  <button className="ghost" onClick={() => setTarget(null)}>
                    Hablando con {office.agents.find((a) => a.id === target)?.name} ✕
                  </button>
                )}
                <button className={`ghost ${editLayout ? "on" : ""}`} onClick={() => setEditLayout((v) => !v)}>
                  {editLayout ? "✓ Listo" : "✥ Escritorios"}
                </button>
              </div>
            </header>
            <OfficeCanvas
              engine={engine}
              office={office}
              target={target}
              onPick={setTarget}
              editLayout={editLayout}
              onLayout={(l) => void api.saveLayout(l)}
            />
            <footer className="stage-foot">
              <span>
                ● {office.agents.length - busyAgents.size}/{office.agents.length} libres
              </span>
              <span>Click en alguien para hablarle directo</span>
            </footer>
          </section>
          <ChatPanel
            office={office}
            runs={runs}
            target={target}
            setTarget={setTarget}
            busy={working}
            onSend={async (text) => {
              await api.send(text, target);
            }}
          />
        </main>
      )}
      {tab === "team" && <TeamEditor office={office} looks={looks} />}
      {tab === "models" && <ProvidersEditor office={office} />}
      {pending.length > 0 && (
        <PermissionModal
          office={office}
          request={pending[0]}
          queued={pending.length - 1}
          onDecide={async (decision) => {
            const req = pending[0];
            setPending((p) => p.filter((x) => x.callId !== req.callId));
            try {
              await api.permission(req.callId, decision);
            } catch {
              return;
            }
          }}
        />
      )}
    </div>
  );
}
