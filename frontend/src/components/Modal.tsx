import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconX } from "./Icons";

/** Ventana con encabezado y pie fijos; el contenido hace scroll entre los dos. El pie es el
 *  `.modal-foot` que cada ventana pone al final de su contenido. */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
  small,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  small?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}${small ? " small" : ""}`} role="dialog" aria-modal aria-label={title}>
        <div className="modal-head">
          <div className="modal-title">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <IconX width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
