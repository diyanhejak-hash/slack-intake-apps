// Toast global (poin revisi, diminta user) — pesan info/sukses/error non-blocking, ganti alert()
// buat hasil aksi ("update berhasil", dst) yang gak butuh user klik OK buat lanjut. Pola pub/sub
// sama kayak emojiPresetStore.ts, biar bisa dipanggil dari mana aja (MainTable.tsx, dst) tanpa
// prop-drilling, ditampilin lewat 1 host (ToastHost.tsx) yang di-mount sekali.
export interface Toast {
  id: string;
  message: string;
  kind: "info" | "success" | "error";
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l(toasts));
}

// Poin revisi (diminta user, "kecepetan ilangnya") — durasi default dinaikin 3.5s -> 6s.
export function showToast(message: string, kind: Toast["kind"] = "info", duration = 6000) {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, message, kind }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, duration);
}

export function subscribeToasts(listener: Listener) {
  listeners.add(listener);
  listener(toasts);
  return () => { listeners.delete(listener); };
}
