import { useState } from "react";
import PromptModal from "./PromptModal";

export default function SendRecovery({ projectId, itemId, channelId }: { projectId: string; itemId: string; channelId?: string }) {
  const [needsLink, setNeedsLink] = useState(false);
  const [busy, setBusy] = useState(false);
  async function recover(threadLink?: string) {
    setBusy(true);
    try {
      const result = await window.api.send.recover({ projectId, itemId, channelId, threadLink });
      setNeedsLink(!!result.needsThreadLink);
      if (result.message) alert(result.message);
    } catch (err) { alert(err instanceof Error ? err.message : "Pemulihan gagal."); }
    finally { setBusy(false); }
  }
  return <>
    <button className="btn" disabled={busy} onClick={() => recover()}>Pulihkan</button>
    {needsLink && <PromptModal title="Link pesan utama Slack" label="Salin link pesan utama yang sudah terkirim pada channel tujuan." onSubmit={(value) => recover(value)} onCancel={() => setNeedsLink(false)} />}
  </>;
}
