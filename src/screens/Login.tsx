import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { AuthStatus } from "../global";
import logo from "../assets/HB5_new.png";

export default function Login({ onLoggedIn }: { onLoggedIn: (a: AuthStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.auth.login();
      onLoggedIn(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login gagal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 32, width: 340, textAlign: "center" }}>
        <img src={logo} alt="Slack Intake Apps" style={{ width: 48, height: 48, margin: "0 auto 16px", display: "block" }} />
        <h1 style={{ marginBottom: 6 }}>Slack Intake Apps</h1>
        <p className="caption" style={{ marginBottom: 20 }}>
          Login sekali pakai akun Slack kamu sendiri — pesan terkirim sebagai identitas asli, bukan bot.
        </p>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={handleLogin} disabled={busy}>
          {busy && <Loader2 size={15} className="spin" />}
          {busy ? "Menunggu authorize di browser…" : "Login ke Slack"}
        </button>
        {error && (
          <p className="caption" style={{ color: "var(--danger)", marginTop: 12 }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
