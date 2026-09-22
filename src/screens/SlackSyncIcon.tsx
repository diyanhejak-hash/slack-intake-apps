import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import slackBlackImg from "../assets/SlackBlack.png";

/** Ikon bersama untuk aksi Pull/Push Slack, dipakai kontrol global dan overlay per-cell. */
export default function SlackSyncIcon({ direction, busy }: { direction: "down" | "up"; busy: boolean }) {
  if (busy) return <Loader2 size={14} className="spin" />;
  const Arrow = direction === "down" ? ArrowDown : ArrowUp;
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 15, height: 15, flexShrink: 0 }}>
      <img className="slack-sync-logo" src={slackBlackImg} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      <span
        style={{
          position: "absolute", right: -4, bottom: -4, width: 11, height: 11, borderRadius: "50%",
          background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center",
          border: "1.5px solid var(--surface)",
        }}
      >
        <Arrow size={7} color="#fff" strokeWidth={3} />
      </span>
    </span>
  );
}
