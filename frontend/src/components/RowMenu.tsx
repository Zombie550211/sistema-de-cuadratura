import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { api, ApiError } from "../lib/api";
import { IconDots } from "./Icons";
import { Modal } from "./Modal";

export interface RowAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** Botón ⋯ al final de una fila con sus acciones (editar, eliminar…). El menú se dibuja fuera
 *  de la tabla para que no lo recorte el scroll horizontal. */
export function RowMenu({ actions, label = "Acciones" }: { actions: RowAction[]; label?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    setPos({ top: Math.min(r.bottom + 4, window.innerHeight - 48 * actions.length - 16), right: Math.max(window.innerWidth - r.right, 8) });
  }

  return (
    <>
      <button ref={btn} className="icon-btn row-menu-btn" aria-label={label} aria-haspopup="menu" aria-expanded={!!pos} onClick={toggle}>
        <IconDots width={18} height={18} />
      </button>
      {pos &&
        createPortal(
          <div className="row-menu-backdrop" onMouseDown={() => setPos(null)}>
            <div className="row-menu" role="menu" style={pos} onMouseDown={(e) => e.stopPropagation()}>
              {actions.map((a) => (
                <button
                  key={a.label}
                  role="menuitem"
                  className={a.danger ? "danger" : undefined}
                  onClick={() => {
                    setPos(null);
                    a.onClick();
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Confirmación de borrado: hace el DELETE y avisa al terminar. */
export function ConfirmDelete({
  title,
  path,
  children,
  onClose,
  onDone,
}: {
  title: string;
  path: string;
  children: ReactNode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(path);
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose} small>
      <div className="stack modal-danger">{children}</div>
      {error && <div className="alert" style={{ marginTop: 16 }}>{error}</div>}
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </button>
        <button className="btn danger solid" onClick={confirm} disabled={busy}>
          {busy ? "Eliminando…" : "Eliminar"}
        </button>
      </div>
    </Modal>
  );
}
