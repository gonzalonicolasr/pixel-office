import { useEffect, useState } from "react";
import type { ProviderKind, PublicOffice, PublicProvider } from "../../shared/types.ts";
import { api } from "../api.ts";

const KIND_HELP: Record<ProviderKind, string> = {
  anthropic: "API de Anthropic (Claude).",
  openai: "Cualquier API compatible con OpenAI: OpenAI, OpenRouter, Ollama (http://localhost:11434/v1), LM Studio, vLLM…",
  demo: "Respuestas simuladas, sin red ni costo. Sirve para probar la oficina.",
};

function ProviderRow({ p, inUse, onError }: { p: PublicProvider; inUse: boolean; onError: (m: string) => void }) {
  const [draft, setDraft] = useState({ ...p, apiKey: "" });
  useEffect(() => setDraft({ ...p, apiKey: "" }), [p]);
  const dirty = draft.apiKey !== "" || JSON.stringify({ ...draft, apiKey: undefined }) !== JSON.stringify({ ...p, apiKey: undefined });

  return (
    <article className="provider">
      <div className="row3">
        <label>
          Nombre
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          Tipo
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ProviderKind })}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI-compatible</option>
            <option value="demo">Demo</option>
          </select>
        </label>
        <label>
          Estado
          <span className={`status ${p.kind === "demo" || p.hasKey ? "ok" : "off"}`}>
            {p.kind === "demo" ? "listo" : p.hasKey ? "key cargada" : "sin key"}
          </span>
        </label>
      </div>
      <p className="hint">{KIND_HELP[draft.kind]}</p>
      {draft.kind !== "demo" && (
        <div className="row3">
          <label>
            URL base
            <input
              value={draft.baseUrl ?? ""}
              placeholder={draft.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value || undefined })}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={draft.apiKey}
              placeholder={p.hasKey ? "•••••• (guardada)" : "sk-…"}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </label>
          <label>
            o variable de entorno
            <input value={draft.apiKeyEnv ?? ""} placeholder="OPENAI_API_KEY" onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value || undefined })} />
          </label>
        </div>
      )}
      <div className="card-actions">
        <span className="spacer" />
        <button
          className="ghost danger"
          disabled={inUse}
          title={inUse ? "Hay personas usando este proveedor" : ""}
          onClick={async () => {
            try {
              await api.deleteProvider(p.id);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Borrar
        </button>
        <button
          disabled={!dirty}
          onClick={async () => {
            const { hasKey: _h, ...rest } = draft;
            try {
              await api.updateProvider(p.id, { ...rest, apiKey: draft.apiKey || undefined });
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Guardar
        </button>
      </div>
    </article>
  );
}

function SettingsCard({ office, onError }: { office: PublicOffice; onError: (m: string) => void }) {
  const current = office.settings ?? { workspace: "", autoApprove: false };
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(office.settings ?? { workspace: "", autoApprove: false }), [office.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  return (
    <article className="provider settings">
      <h3>Ajustes</h3>
      <label>
        Carpeta de trabajo (donde leen y escriben las personas con acceso a la PC)
        <input value={draft.workspace} onChange={(e) => setDraft({ ...draft, workspace: e.target.value })} placeholder="/home/vos/proyectos" />
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.autoApprove} onChange={(e) => setDraft({ ...draft, autoApprove: e.target.checked })} />
        Modo libre: no pedir permiso para escribir ni correr comandos
      </label>
      {draft.autoApprove && <p className="warn">Con el modo libre, cualquier persona con acceso a la PC ejecuta sin preguntarte. Usalo sólo si confiás en la tarea.</p>}
      <div className="row2">
        <label>
          Proveedor de imágenes
          <select value={draft.imageProviderId ?? ""} onChange={(e) => setDraft({ ...draft, imageProviderId: e.target.value })}>
            <option value="">— ninguno —</option>
            {office.providers
              .filter((p) => p.kind === "openai")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Modelo de imágenes
          <input value={draft.imageModel ?? ""} placeholder="gemini-3.1-flash-image / gpt-image-1" onChange={(e) => setDraft({ ...draft, imageModel: e.target.value })} />
        </label>
      </div>
      <p className="hint">Se usa para “Dibujar con IA” en el Equipo. Sirve cualquier modelo que devuelva imágenes por chat (Gemini Image, OpenRouter) o por /images (OpenAI).</p>
      <div className="card-actions">
        <span className="spacer" />
        <button
          disabled={!dirty}
          onClick={async () => {
            try {
              await api.saveSettings(draft);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Guardar ajustes
        </button>
      </div>
    </article>
  );
}

export function ProvidersEditor({ office }: { office: PublicOffice }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="editor">
      <div className="editor-head">
        <div>
          <h2>Modelos</h2>
          <p>
            Conectá los proveedores que quieras. Las keys quedan sólo en tu servidor (<code>data/office.json</code>) y nunca vuelven al
            navegador.
          </p>
        </div>
        <button
          onClick={async () => {
            try {
              await api.createProvider({ name: "Nuevo proveedor", kind: "openai", baseUrl: "http://localhost:11434/v1" });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          + Proveedor
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="cards">
        <SettingsCard office={office} onError={setError} />
        {office.providers.map((p) => (
          <ProviderRow key={p.id} p={p} inUse={office.agents.some((a) => a.providerId === p.id)} onError={setError} />
        ))}
      </div>
    </div>
  );
}
