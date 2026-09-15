// PDF viewer — rebuild penuh (2026-09-16), adopsi dari Hej Pro Breakdown
// (renderer/js/pdfViewer.js): continuous vertical scroll + VIRTUALISASI lewat
// IntersectionObserver (cuma halaman dekat viewport yang beneran dirender, sisanya jadi
// placeholder kosong seukuran halaman aslinya — bukan render SEMUA halaman sekaligus kayak
// versi sebelumnya), render 2-tahap (low-res buram dulu -> full-res, swap sinkron biar gak
// kedip), zoom mengarah ke kursor, pan (tahan Space + drag), page rail loncat-halaman.
// Annotation system, page-extend, Find, dan marker/reference system Hej Pro SENGAJA TIDAK
// diikutin — itu fitur breakdown-tool yang terikat data model scene/reference yang gak ada
// padanannya di app ini.
//
// Render tiap halaman DIBUNGKUS try/catch SENDIRI-SENDIRI (poin robust dari Hej Pro,
// renderCellContent) — root cause paling mungkin dari "PDF rusak" versi sebelumnya: render
// SEMUA halaman dalam SATU loop async tanpa try/catch per-halaman, jadi kalau SATU halaman
// gagal (korup/fitur PDF gak didukung), seluruh sisa halaman ikut berhenti render diam-diam.
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ZoomIn, ZoomOut, Crop, ChevronLeft, ChevronRight } from "lucide-react";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// cMap/standard-font/wasm assets (poin revisi terbaru) — TANPA ini pdf.js diam-diam GAGAL
// decode gambar JPX/JPEG2000 (umum dari software desain kayak InDesign/Illustrator) dan font
// non-embedded, sementara teks & vektor biasa tetap tampil normal — PERSIS gejala "PDF gak show
// vector/gambar tertentu" yang dilaporkan (background/teks/garis muncul, logo/icon ilang).
// Komentar asli Hej Pro (pdfViewer.js) soal ini sama persis. File-nya di-copy dari
// node_modules/pdfjs-dist ke src/public/pdfjs/ (lihat situ) — Vite serve folder public/ apa
// adanya, path relatif "./pdfjs/..." biar tetap benar baik pas dev maupun build (base: "./").
const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;
const CMAP_URL = `${PDFJS_ASSET_BASE}cmaps/`;
const STANDARD_FONT_URL = `${PDFJS_ASSET_BASE}standard_fonts/`;
const WASM_URL = `${PDFJS_ASSET_BASE}wasm/`;

const RENDER_MARGIN_PX = 800; // rootMargin IntersectionObserver — px, resolution-independent
const LOW_RES_SCALE_FACTOR = 0.25;
const MIN_LOW_RES_SCALE = 0.2;
const MIN_SCALE_RATIO = 0.4;
const MAX_SCALE_RATIO = 4;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

interface Cell {
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  status: "idle" | "rendering" | "rendered";
  renderToken: number;
  task?: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>;
}

export default function PdfViewer({ filePath, onCapture }: { filePath: string; onCapture: (dataUrl: string, filename: string) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const cells = useRef<Map<number, Cell>>(new Map());
  const dims = useRef<Map<number, { w: number; h: number }>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [fitScale, setFitScale] = useState(1);
  const [scale, setScale] = useState(1);
  // renderCell dipanggil dari dalam IntersectionObserver yang dibuat SEKALI per dokumen (effect
  // scope-nya cuma [numPages], gak re-run tiap zoom) — kalau renderCell baca `scale` langsung
  // dari closure, halaman yang BARU kelihatan (discroll) abis di-zoom bakal ke-render pakai
  // scale LAMA (closure observer-nya beku di scale saat observer dibuat). Ref selalu kebaca
  // paling baru, lepas dari kapan closure-nya dibuat.
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  const [status, setStatus] = useState("Memuat PDF…");
  const [displayedPage, setDisplayedPage] = useState(1);

  const [captureMode, setCaptureMode] = useState(false);
  const [captureQuality, setCaptureQuality] = useState(2);
  const dragRef = useRef<{ pageNum: number; startX: number; startY: number } | null>(null);
  const [selection, setSelection] = useState<{ pageNum: number; x: number; y: number; w: number; h: number } | null>(null);

  const panRef = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  function assumedDims(pageNum: number) {
    return dims.current.get(pageNum) || dims.current.get(1) || { w: 612, h: 792 };
  }

  function placeholderSize(pageNum: number) {
    const d = assumedDims(pageNum);
    return { w: Math.ceil(d.w * scale), h: Math.ceil(d.h * scale) };
  }

  // Load dokumen — baca bytes lewat main process (poin §9: fetch(file://) gak konsisten di
  // Electron dengan contextIsolation), BUKAN fetch(url) di renderer.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    setStatus("Memuat PDF…");
    setNumPages(0);
    dims.current.clear();
    cells.current.clear();
    (async () => {
      try {
        const bytes = await window.api.file.readBytes(filePath);
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({
          data: bytes,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONT_URL,
          wasmUrl: WASM_URL,
        });
        const doc = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        pdfRef.current = doc;
        const page1 = await doc.getPage(1);
        const vp1 = page1.getViewport({ scale: 1 });
        dims.current.set(1, { w: vp1.width, h: vp1.height });
        const availW = Math.max(100, (scrollRef.current?.clientWidth || 800) - 32);
        const availH = Math.max(100, (scrollRef.current?.clientHeight || 600) - 32);
        const fit = clamp(vp1.width > vp1.height ? availW / vp1.width : availH / vp1.height, 0.1, 2);
        setFitScale(fit);
        setScale(fit);
        setNumPages(doc.numPages);
        setStatus("");
      } catch (err) {
        if (!cancelled) setStatus(err instanceof Error ? `Gagal buka PDF: ${err.message}` : "Gagal buka PDF");
      }
    })();
    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      cells.current.forEach((cell) => { cell.renderToken++; cell.task?.cancel(); });
      void loadingTask?.destroy().catch(() => undefined);
      pdfRef.current = null;
    };
  }, [filePath]);

  // Render 2-tahap: low-res dulu (cepat, buram), lalu full-res — swap SINKRON (resize+drawImage
  // tanpa await di antara) biar browser gak sempat ngecat frame kosong. Try/catch SENDIRI per
  // halaman — satu halaman gagal TIDAK menghentikan halaman lain.
  async function renderCell(pageNum: number) {
    const cell = cells.current.get(pageNum);
    const doc = pdfRef.current;
    if (!cell || !doc || cell.status !== "idle") return;
    cell.status = "rendering";
    const myToken = ++cell.renderToken;
    try {
      const page = await doc.getPage(pageNum);
      const vp1 = page.getViewport({ scale: 1 });
      if (!dims.current.has(pageNum)) dims.current.set(pageNum, { w: vp1.width, h: vp1.height });
      if (myToken !== cell.renderToken) return;

      const renderPass = async (targetScale: number) => {
        const offscreen = document.createElement("canvas");
        const viewport = page.getViewport({ scale: targetScale });
        offscreen.width = Math.max(1, Math.ceil(viewport.width));
        offscreen.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = offscreen.getContext("2d");
        if (!ctx) return false;
        cell.task = page.render({ canvas: offscreen, canvasContext: ctx, viewport });
        await cell.task.promise;
        if (myToken !== cell.renderToken) return false;
        cell.canvas.width = offscreen.width;
        cell.canvas.height = offscreen.height;
        cell.canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
        return true;
      };

      const targetScale = scaleRef.current;
      const lowScale = Math.max(MIN_LOW_RES_SCALE, targetScale * LOW_RES_SCALE_FACTOR);
      if (!(await renderPass(lowScale))) return;
      cell.status = "rendered";
      if (!(await renderPass(targetScale))) return;
    } catch (err) {
      if (err instanceof Error && err.name === "RenderingCancelledException") return;
      if (myToken !== cell.renderToken) return;
      cell.status = "idle";
      // ponytail: 1 halaman gagal cuma di-log, gak nge-throw ke atas — sisa halaman lain harus
      // tetap lanjut render (ini akar fix "PDF rusak" dari root cause di komentar file ini).
      console.error(`Gagal render halaman ${pageNum}:`, err);
    }
  }

  function unmountCell(pageNum: number) {
    const cell = cells.current.get(pageNum);
    if (!cell) return;
    cell.renderToken++;
    cell.task?.cancel();
    cell.canvas.width = 0;
    cell.canvas.height = 0;
    cell.status = "idle";
  }

  function rerenderInPlace(pageNum: number) {
    const cell = cells.current.get(pageNum);
    if (!cell || cell.status === "idle") return;
    cell.renderToken++;
    cell.task?.cancel();
    cell.status = "idle";
    renderCell(pageNum);
  }

  // IntersectionObserver — pasang ulang tiap numPages berubah (dokumen baru).
  useEffect(() => {
    if (!numPages || !scrollRef.current) return;
    observerRef.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) renderCell(pageNum);
          else unmountCell(pageNum);
        }
      },
      { root: scrollRef.current, rootMargin: `${RENDER_MARGIN_PX}px 0px` }
    );
    observerRef.current = observer;
    cells.current.forEach((cell) => observer.observe(cell.root));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages]);

  // Zoom berubah -> render ulang halaman yang lagi/udah kelihatan, ditunda dikit (debounce)
  // biar scroll-zoom cepat gak nge-trigger render mahal berkali-kali.
  const zoomTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!numPages) return;
    if (zoomTimerRef.current) window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      cells.current.forEach((cell, pageNum) => {
        if (cell.status !== "idle") rerenderInPlace(pageNum);
      });
    }, 150);
    return () => {
      if (zoomTimerRef.current) window.clearTimeout(zoomTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  function scrollToPage(pageNum: number, behavior: ScrollBehavior = "auto") {
    const target = clamp(pageNum, 1, numPages);
    const cell = cells.current.get(target);
    const scroller = scrollRef.current;
    if (!cell || !scroller) return;
    const containerRect = scroller.getBoundingClientRect();
    const cellRect = cell.root.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + (cellRect.top - containerRect.top), behavior });
    setDisplayedPage(target);
  }

  function onScroll() {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const containerRect = scroller.getBoundingClientRect();
    const mid = containerRect.top + containerRect.height / 2;
    let best = displayedPage;
    let bestDist = Infinity;
    cells.current.forEach((cell, pageNum) => {
      const r = cell.root.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = pageNum;
      }
    });
    if (best !== displayedPage) setDisplayedPage(best);
  }

  function applyScale(next: number, anchorClientX?: number, anchorClientY?: number) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const clamped = clamp(next, fitScale * MIN_SCALE_RATIO, fitScale * MAX_SCALE_RATIO);
    if (clamped === scale) return;
    const rect = scroller.getBoundingClientRect();
    const anchorX = anchorClientX ?? rect.left + rect.width / 2;
    const anchorY = anchorClientY ?? rect.top + rect.height / 2;
    const contentX = scroller.scrollLeft + (anchorX - rect.left);
    const contentY = scroller.scrollTop + (anchorY - rect.top);
    const ratio = clamped / scale;
    setScale(clamped);
    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      scrollRef.current.scrollLeft = contentX * ratio - (anchorX - rect.left);
      scrollRef.current.scrollTop = contentY * ratio - (anchorY - rect.top);
    });
  }

  // Poin revisi UI — "Fit" lama (pilih otomatis mana yang lebih kecil antara fit-lebar/fit-
  // tinggi) kadang nyisain page KURANG dari tinggi viewport di satu sumbu, jadi ujung halaman
  // BERIKUTNYA ikut nyembul kelihatan sedikit ("di antara 2 page"). Dipecah jadi 2 tombol
  // eksplisit — Fit Tinggi SELALU bikin 1 halaman persis setinggi viewport (jelas 1 halaman,
  // gak ada bocoran halaman lain), Fit Lebar buat mode baca (halaman selebar viewport, boleh
  // scroll vertikal antar halaman).
  function fitWidth() {
    const d = assumedDims(displayedPage);
    const scroller = scrollRef.current;
    if (!scroller) return;
    const availW = Math.max(100, scroller.clientWidth - 32);
    applyScale(availW / d.w);
    requestAnimationFrame(() => scrollToPage(displayedPage));
  }

  function fitHeight() {
    const d = assumedDims(displayedPage);
    const scroller = scrollRef.current;
    if (!scroller) return;
    const availH = Math.max(100, scroller.clientHeight - 32);
    applyScale(availH / d.h);
    requestAnimationFrame(() => scrollToPage(displayedPage));
  }

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    applyScale(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }

  // Pan (tahan Space + drag) — port persis dari Command Builder/Hej Pro, guard pakai :hover
  // (matches("... :hover") setara containerRef.matches(':hover')) bukan activeElement, biar
  // konsisten kepicu berapa pun yang lagi fokus.
  useEffect(() => {
    function isTypingTarget(el: Element | null) {
      const tag = (el?.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || spaceHeldRef.current) return;
      if (isTypingTarget(document.activeElement)) return;
      if (!scrollRef.current?.matches(":hover")) return;
      e.preventDefault();
      spaceHeldRef.current = true;
      setSpaceHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      spaceHeldRef.current = false;
      panRef.current = null;
      setSpaceHeld(false);
    }
    function onMouseDown(e: MouseEvent) {
      if (!spaceHeldRef.current || e.button !== 0 || !scrollRef.current) return;
      e.preventDefault();
      panRef.current = { startX: e.clientX, startY: e.clientY, scrollLeft: scrollRef.current.scrollLeft, scrollTop: scrollRef.current.scrollTop };
    }
    function onMouseMove(e: MouseEvent) {
      const pan = panRef.current;
      const scroller = scrollRef.current;
      if (!pan || !scroller) return;
      scroller.scrollLeft = pan.scrollLeft - (e.clientX - pan.startX);
      scroller.scrollTop = pan.scrollTop - (e.clientY - pan.startY);
    }
    function onMouseUp() {
      panRef.current = null;
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    const scroller = scrollRef.current;
    scroller?.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      scroller?.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ---- Capture: toggle mode, drag-select 1 kotak per halaman, render ulang di resolusi
  // tinggi (captureQuality 1x-4x) buat hasil crop tajam, independen dari scale layar. ----
  function onPageMouseDown(pageNum: number, e: React.MouseEvent<HTMLCanvasElement>) {
    if (!captureMode) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { pageNum, startX: e.clientX - rect.left, startY: e.clientY - rect.top };
    setSelection({ pageNum, x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0 });
  }
  function onPageMouseMove(pageNum: number, e: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pageNum !== pageNum) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSelection({ pageNum, x: Math.min(drag.startX, x), y: Math.min(drag.startY, y), w: Math.abs(x - drag.startX), h: Math.abs(y - drag.startY) });
  }
  async function onPageMouseUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    const doc = pdfRef.current;
    if (!drag || !selection || selection.w < 4 || selection.h < 4 || !doc) {
      setSelection(null);
      return;
    }
    const cell = cells.current.get(drag.pageNum);
    const d = dims.current.get(drag.pageNum);
    if (!cell || !d) {
      setSelection(null);
      return;
    }
    const fx = selection.x / cell.canvas.clientWidth;
    const fy = selection.y / cell.canvas.clientHeight;
    const fw = selection.w / cell.canvas.clientWidth;
    const fh = selection.h / cell.canvas.clientHeight;
    setSelection(null);

    const page = await doc.getPage(drag.pageNum);
    const hiScale = fitScale * clamp(captureQuality, 1, 4);
    const viewport = page.getViewport({ scale: hiScale });
    const off = document.createElement("canvas");
    off.width = Math.ceil(viewport.width);
    off.height = Math.ceil(viewport.height);
    const ctx = off.getContext("2d");
    if (!ctx) return;
    await page.render({ canvas: off, canvasContext: ctx, viewport }).promise;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(fw * off.width));
    out.height = Math.max(1, Math.round(fh * off.height));
    out.getContext("2d")?.drawImage(off, fx * off.width, fy * off.height, fw * off.width, fh * off.height, 0, 0, out.width, out.height);
    onCapture(out.toDataURL("image/png"), `capture-p${drag.pageNum}-${Date.now()}.png`);
  }

  return (
    // flex:1 (bukan height:420 fixed lagi, poin revisi "ruang kosong") — ngisi PENUH tinggi
    // section Display yang disediakan parent-nya, minHeight angka jaga-jaga kalau parent gak
    // ngasih tinggi pasti (sama pola kayak VideoPlayer).
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 280, border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: 6, borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
        <button className="icon-btn" title="Halaman sebelumnya" onClick={() => scrollToPage(displayedPage - 1, "smooth")}>
          <ChevronLeft size={13} />
        </button>
        <span className="caption" style={{ whiteSpace: "nowrap" }}>
          {displayedPage} / {numPages || "—"}
        </span>
        <button className="icon-btn" title="Halaman berikutnya" onClick={() => scrollToPage(displayedPage + 1, "smooth")}>
          <ChevronRight size={13} />
        </button>
        <button className="icon-btn" title="Zoom out" onClick={() => applyScale(scale / 1.25)}>
          <ZoomOut size={13} />
        </button>
        <span className="caption">{Math.round((scale / fitScale) * 100)}%</span>
        <button className="icon-btn" title="Zoom in" onClick={() => applyScale(scale * 1.25)}>
          <ZoomIn size={13} />
        </button>
        <button className="icon-btn" title="Fit lebar halaman ke lebar viewer" onClick={fitWidth} style={{ width: "auto", padding: "0 8px" }}>
          Fit Lebar
        </button>
        <button className="icon-btn" title="Fit tinggi halaman ke tinggi viewer (double-click) — jamin 1 halaman utuh kelihatan" onClick={fitHeight} style={{ width: "auto", padding: "0 8px" }}>
          Fit Tinggi
        </button>
        <button
          className={`icon-btn ${captureMode ? "active" : ""}`}
          title="Toggle capture (drag pilih area di halaman)"
          onClick={() => setCaptureMode((v) => !v)}
          style={captureMode ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
        >
          <Crop size={13} />
        </button>
        {captureMode && (
          <select value={captureQuality} onChange={(e) => setCaptureQuality(Number(e.target.value))} title="Kualitas capture" style={{ padding: "2px 4px" }}>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={3}>3x</option>
            <option value={4}>4x</option>
          </select>
        )}
        <span className="caption" style={{ marginLeft: "auto" }}>
          {status || `${numPages} halaman — tahan Space buat pan`}
        </span>
      </div>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {numPages > 0 && (
          <div style={{ width: 28, flexShrink: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "8px 0", borderRight: "1px solid var(--border)" }}>
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                className="icon-btn"
                onClick={() => scrollToPage(p, "smooth")}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  fontSize: 9,
                  padding: 0,
                  border: "1px solid var(--border)",
                  ...(p === displayedPage ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : {}),
                }}
                title={`Halaman ${p}`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <div
          ref={scrollRef}
          className="scrollbar-thin"
          style={{ flex: 1, overflow: "auto", padding: 16, cursor: spaceHeld ? "grab" : captureMode ? "crosshair" : "default" }}
          onWheel={onWheel}
          onScroll={onScroll}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("canvas") && window.getSelection()?.toString()) return;
            fitHeight();
          }}
        >
          <div ref={listRef} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, width: "max-content", margin: "0 auto" }}>
            {Array.from({ length: numPages }, (_, i) => i + 1).map((p) => {
              const size = placeholderSize(p);
              return (
                <div
                  key={p}
                  data-page={p}
                  ref={(el) => {
                    if (!el) {
                      cells.current.delete(p);
                      return;
                    }
                    const canvas = el.querySelector("canvas") as HTMLCanvasElement;
                    const existing = cells.current.get(p);
                    if (!existing) cells.current.set(p, { root: el, canvas, status: "idle", renderToken: 0 });
                    observerRef.current?.observe(el);
                  }}
                  style={{ position: "relative", width: size.w, height: size.h }}
                >
                  <canvas
                    style={{ display: "block", width: "100%", height: "100%", boxShadow: "0 0 0 1px var(--border)", background: "#fff" }}
                    onMouseDown={(e) => onPageMouseDown(p, e)}
                    onMouseMove={(e) => onPageMouseMove(p, e)}
                    onMouseUp={onPageMouseUp}
                  />
                  {selection && selection.pageNum === p && (
                    <div
                      style={{
                        position: "absolute",
                        left: selection.x,
                        top: selection.y,
                        width: selection.w,
                        height: selection.h,
                        border: "1px dashed var(--accent)",
                        background: "rgba(47,111,235,0.15)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
