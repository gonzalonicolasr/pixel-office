import { useEffect, useRef, useState } from "react";
import type { PublicOffice } from "../../shared/types.ts";
import { type Run, type Step, entryText } from "../runs.ts";
import { Markdown } from "./Markdown.tsx";

interface Props {
  office: PublicOffice;
  runs: Run[];
  target: string | null;
  setTarget: (id: string | null) => void;
  onSend: (text: string) => Promise<void>;
  busy: boolean;
}

export function ChatPanel({ office, runs, target, setTarget, onSend, busy }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const byId = new Map(office.agents.map((a) => [a.id, a]));
  const lead = office.agents.find((a) => a.lead);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    try {
      await onSend(t);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="panel chat">
      <header className="panel-head">
        <span>💬 Conversación</span>
        <small>{runs.length} pedidos</small>
      </header>
      <div className="log" ref={log}>
        {!runs.length && (
          <div className="empty">
            Escribile al equipo abajo. {lead ? `${lead.name} lee el pedido` : "El líder lee el pedido"} y se lo pasa a quien
            corresponda. Hacé click en alguien de la oficina para hablarle directo.
          </div>
        )}
        {runs.map((r) => (
          <div key={r.id} className="run">
            <div className="msg user">
              <span className="who">Vos {r.target ? `→ ${byId.get(r.target)?.name ?? "?"}` : "→ equipo"}</span>
              <p>{r.text}</p>
            </div>
            {r.routing && !r.note && lead && (
              <div className="route">
                <span style={{ color: lead.appearance.shirt }}>{lead.name}</span> está viendo a quién le toca…
              </div>
            )}
            {r.note && (
              <div className="route">
                <span style={{ color: lead?.appearance.shirt }}>{lead?.name}</span>: {r.note}
              </div>
            )}
            {r.entries.map((e) => {
              const a = byId.get(e.agentId);
              return (
                <div key={e.agentId} className={`msg agent ${e.status}`} style={{ ["--c" as string]: a?.appearance.shirt ?? "#999" }}>
                  <span className="who">
                    {a?.name ?? "?"} <em>{a?.role}</em>
                    {e.status === "working" && <i className="pulse" />}
                    {e.status === "done" && <small>{e.tokens} tok</small>}
                  </span>
                  {e.from && <div className="task">📄 {e.task}</div>}
                  {e.steps.map((st, i) => (
                    <StepView key={i} step={st} />
                  ))}
                  {!entryText(e) && !e.steps.length && <p>{e.status === "working" ? "…" : ""}</p>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="composer">
        <div className="targets">
          <button className={!target ? "on" : ""} onClick={() => setTarget(null)}>
            👥 Equipo
          </button>
          {office.agents.map((a) => (
            <button
              key={a.id}
              className={target === a.id ? "on" : ""}
              style={{ ["--c" as string]: a.appearance.shirt }}
              onClick={() => setTarget(a.id)}
            >
              {a.name}
            </button>
          ))}
        </div>
        <div className="input-row">
          <textarea
            value={text}
            placeholder={target ? `Mensaje directo a ${byId.get(target)?.name}…` : "¿Qué necesitás? El líder lo reparte…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
          />
          <button className="send" disabled={!text.trim()} onClick={() => void submit()}>
            {busy ? "…" : "Enviar"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

const STATE_ICON = { running: "⏳", asking: "🔐", ok: "✓", error: "✕", denied: "⛔" };

function StepView({ step }: { step: Step }) {
  if (step.kind === "text") return step.text.trim() ? <Markdown text={step.text} /> : null;
  return (
    <details className={`tool ${step.state}`}>
      <summary>
        <span className="tool-icon">{STATE_ICON[step.state]}</span>
        <code>{step.name}</code> <span className="tool-sum">{step.summary}</span>
        {step.state === "asking" && <em> esperando tu permiso</em>}
        {step.state === "denied" && <em> denegado</em>}
      </summary>
      {step.output && <pre>{step.output}</pre>}
    </details>
  );
}
