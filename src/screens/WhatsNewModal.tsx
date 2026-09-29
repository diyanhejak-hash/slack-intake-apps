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
            <li>Nama aplikasi sekarang HB Slack Intake; project dan login lama tetap tersedia.</li>
            <li>Batch File Animatic dapat mengunduh CSV berisi scene, frame, dan durasi.</li>
            <li>Undangan member channel dapat dicari; member pilihan terlihat sebagai chip.</li>
            <li>Preset template dan Custom Header dapat dikelola dari menu yang sesuai.</li>
          </ul>
        </section>

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>Perbaikan</h3>
          <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-secondary)", lineHeight: 1.65, fontSize: 13 }}>
            <li>Header tabel tetap jelas pada mode gelap.</li>
            <li>Pesan error dipersingkat dan kegagalan preview file ditampilkan.</li>
            <li>Perpindahan akun dan koneksi Slack saat logout dibuat lebih aman.</li>
          </ul>
        </section>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onClose}>Mengerti</button>
        </div>
      </div>
    </div>
  );
}
