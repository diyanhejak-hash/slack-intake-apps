import { useEffect, useState } from "react";
import type { AuthStatus } from "./global";
import Login from "./screens/Login";
import StartMenu from "./screens/StartMenu";
import MainTable from "./screens/MainTable";
import SlackDesktopSuggestion from "./screens/SlackDesktopSuggestion";
import HbSessionClosing from "./screens/HbSessionClosing";

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sistem Admin/Member (poin revisi, diminta user) — dicek SEKALI abis login (isAdminMember
  // butuh 1 panggilan Slack, listChannels() milik user yang login -- lihat adminAccess.cjs),
  // dipassing ke StartMenu (gate Settings gear) & MainTable (gate toggle Realtime Sync + menu
  // Otomasi Kata Kunci). null selama belum ke-load = default MASIH nyembunyiin semua (aman).
  const [adminStatus, setAdminStatus] = useState<{ isOwner: boolean; isAdminMember: boolean } | null>(null);

  useEffect(() => {
    const onRejected = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      alert(event.reason instanceof Error ? event.reason.message : "Operasi gagal. Coba lagi.");
    };
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialogs = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length);
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (!focusable.length) { event.preventDefault(); return; }
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
    };
    window.addEventListener("unhandledrejection", onRejected);
    document.addEventListener("keydown", trapFocus, true);
    return () => {
      window.removeEventListener("unhandledrejection", onRejected);
      document.removeEventListener("keydown", trapFocus, true);
    };
  }, []);
  useEffect(() => {
    window.api.auth.status().then(setAuth).catch((err) => setError(err instanceof Error ? err.message : "Gagal memuat aplikasi."));
  }, []);
  useEffect(() => {
    if (!auth?.loggedIn) return;
    // Satu-satunya refresh direktori user dari Slack per sesi aplikasi. Semua layar membaca
    // cache lokal; kegagalan refresh tidak mengosongkan cache lama.
    window.api.slack.refreshUsers().catch(() => undefined);
    window.api.admin.getStatus().then(setAdminStatus).catch(() => setAdminStatus({ isOwner: false, isAdminMember: false }));
  }, [auth?.loggedIn]);

  if (error) {
    return <div style={{ padding: 32 }}><h2>Gagal memuat aplikasi</h2><p>{error}</p><button className="btn" onClick={() => location.reload()}>Coba Lagi</button></div>;
  }
  if (!auth) {
    return (
      <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center" }}>
        <span className="caption">Memuat…</span>
      </div>
    );
  }

  if (!auth.loggedIn) {
    return <Login onLoggedIn={setAuth} />;
  }

  return (
    <>
      {!projectId ? (
        <StartMenu auth={auth} isOwner={!!adminStatus?.isOwner} isAdminMember={!!adminStatus?.isAdminMember} onOpenProject={setProjectId} />
      ) : (
        // key={projectId}: paksa remount pas ganti project (mis. abis Save As) biar semua state
        // lokal (selected, undo stack, drawer, dst) reset bersih — bukan cuma refetch data project.
        <MainTable key={projectId} projectId={projectId} isAdminMember={!!adminStatus?.isAdminMember} onBackToStartMenu={() => setProjectId(null)} onOpenProject={setProjectId} />
      )}
      {/* Poin revisi: saran install Slack Desktop — CUMA muncul setelah login (biar gak ganggu
          layar Login), non-blocking, sekali doang per komputer. */}
      <SlackDesktopSuggestion />
      <HbSessionClosing />
    </>
  );
}
