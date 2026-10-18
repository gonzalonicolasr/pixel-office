import { useEffect } from "react";
import type { OfficeEvent, PermissionDecision, PublicOffice } from "../../shared/types.ts";

export type PendingPermission = Extract<OfficeEvent, { type: "permission_request" }>;

const TOOL_LABEL: Record<PendingPermission["name"], string> = {
  list_dir: "Mirar una carpeta",
  read_file: "Leer un archivo",
  search: "Buscar en archivos",
  write_file: "Escribir un archivo",
  edit_file: "Editar un archivo",
  run_command: "Correr un comando",
};

function detail(req: PendingPermission): string {
  const a = req.args;
  if (req.name === "run_command") return `$ ${String(a.command ?? "")}${a.cwd ? `\n(en ${String(a.cwd)})` : ""}`;
  if (req.name === "write_file") return `${String(a.path ?? "")}\n\n${String(a.content ?? "").slice(0, 1200)}`;
  if (req.name === "edit_file") return `${String(a.path ?? "")}\n\n- ${String(a.old_string ?? "").slice(0, 500)}\n+ ${String(a.new_string ?? "").slice(0, 500)}`;
  return JSON.stringify(a, null, 2);
}

export function PermissionModal({
  office,
  request,
  queued,
  onDecide,
}: {
  office: PublicOffice;
  request: PendingPermission;
  queued: number;
  onDecide: (d: PermissionDecision) => void;
}) {
  const agent = office.agents.find((a) => a.id === request.agentId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecide("deny");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecide]);

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="modal" style={{ ["--c" as string]: agent?.appearance.shirt ?? "#9b7bf2" }}>
        <div className="modal-head">
          <span className="lock">🔐</span>
          <div>
            <h3 id="perm-title">
              {agent?.name ?? "Alguien"} quiere: {TOOL_LABEL[request.name]}
            </h3>
            <small>{request.summary}</small>
          </div>
        </div>
        <pre className="modal-detail">{detail(request)}</pre>
        <p className="modal-note">
          Se ejecuta en tu PC con tus permisos. Carpeta de trabajo: <code>{office.settings?.workspace ?? "~"}</code>
          {queued > 0 && <> · {queued} pedido(s) más en espera</>}
        </p>
        <div className="modal-actions">
          <button className="ghost danger" onClick={() => onDecide("deny")}>
            Denegar
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={() => onDecide("always")} title={`No volver a preguntar por "${TOOL_LABEL[request.name]}" a ${agent?.name} hasta reiniciar`}>
            Siempre para {agent?.name}
          </button>
          <button autoFocus onClick={() => onDecide("allow")}>
            Permitir
          </button>
        </div>
      </div>
    </div>
  );
}
