// Host tampilan toast (poin revisi) — dipasang SEKALI di section nama project (MainTable.tsx),
// posisi absolute nutup seluruh section itu biar bisa center beneran ("tengah atas"), tapi
// pointerEvents none biar gak ngeblok klik ke tombol back/rename di baris yang sama.
import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "../lib/toast";

const KIND_STYLE: Record<Toast["kind"], React.CSSProperties> = {
  info: { background: "var(--surface-2, var(--surface))", border: "1px solid var(--border-strong)" },
  success: { background: "var(--success)", color: "#fff" },
  error: { background: "var(--danger)", color: "#fff" },
};

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 4, pointerEvents: "none", zIndex: 45,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            padding: "5px 14px", borderRadius: 999, fontSize: 12, fontWeight: 500,
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)", whiteSpace: "pre-line", textAlign: "center",
            maxWidth: "70vw", ...KIND_STYLE[t.kind],
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
