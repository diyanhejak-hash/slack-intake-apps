import { useState } from "react";
import { X } from "lucide-react";

// Ganti window.prompt() — Electron TIDAK implement prompt() (beda dari alert()/confirm()
// yang jalan normal), klik yang manggil prompt() jadinya silent no-op tanpa dialog apa pun.
// Ini akar bug "Save As gak bisa" & (potensial) tombol Link di toolbar reply.
export default function PromptModal({
  title,
  label,
  defaultValue = "",
  placeholder,
  submitLabel = "OK",
  onSubmit,
  onCancel,
}: {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [touched, setTouched] = useState(false);
  const invalid = touched && !value.trim();

  function submit() {
    if (!value.trim()) {
      setTouched(true);
      return;
    }
    onSubmit(value.trim());
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 360, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onCancel}>
            <X size={13} />
          </button>
        </div>
        {label && (
          <div className="label" style={{ marginBottom: 4 }}>
            {label}
          </div>
        )}
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          className={invalid ? "input-error" : ""}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          style={{ width: "100%" }}
        />
        {invalid && (
          <span className="caption" style={{ color: "var(--danger)" }}>
            Wajib diisi.
          </span>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>
            Batal
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
