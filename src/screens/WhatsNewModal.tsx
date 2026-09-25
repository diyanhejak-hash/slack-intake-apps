import { X } from "lucide-react";

export default function WhatsNewModal({ version, onClose }: { version: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="whats-new-title"
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "rgba(0,0,0,.5)" }}
      onMouseDown={onClose}
    >
      <div className="card" style={{ width: "min(460px, 100%)", padding: 20, background: "var(--surface)" }} onMouseDown={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <h2 id="whats-new-title" style={{ fontSize: 20 }}>Yang Baru di v{version}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={15} />
          </button>
        </div>

        <section style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Fitur Baru</h3>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-secondary)", lineHeight: 1.65, fontSize: 13 }}>
            <li>Tambahkan Custom Header seperti Grade atau Priority.</li>
            <li>Setiap header memiliki dropdown dan reaction Slack.</li>
            <li>Mendukung Filter, Sort, Push, Pull, Realtime, serta Instant Intake.</li>
            <li>Custom Header ikut tersimpan saat Export, Import, dan Duplicate Project.</li>
          </ul>
        </section>

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Perbaikan</h3>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-secondary)", lineHeight: 1.65, fontSize: 13 }}>
            <li>Urutan reaction: Artis → Status → Custom Header.</li>
            <li>Mencegah emoji reaction ganda.</li>
            <li>Penghapusan header dan sinkronisasi Slack dibuat lebih aman.</li>
          </ul>
        </section>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>Mengerti</button>
        </div>
      </div>
    </div>
  );
}
