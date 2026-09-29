"use client";

// 仕切書（出荷先から届く支払明細書）の読み取り結果と、アプリの出荷実績への当てはめ
import type { DayItems, Grade } from "./shipping";

export type ShikiriEntry = { day: number; qty: number; price: number };
export type ShikiriRow = { size: string; entries: ShikiriEntry[]; qtyTotal: number | null };
export type ShikiriBlock = { variety: string; rank: string; rows: ShikiriRow[]; amountTotal: number | null };
export type ShikiriSheet = {
  year: number;
  month: number;
  blocks: ShikiriBlock[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  fee: number | null;
  paid: number | null;
};
export type ShikiriResult = { sheets: ShikiriSheet[]; notes: string };

// ---------- ファイルを、AIに送れる大きさの画像にする ----------

export type Upload = { mediaType: "image/jpeg"; data: string };
/** 送る画像の長い辺（AIが細かく読める上限） */
const LONG_EDGE = 2576;

/** 仕切書の1ページ（画面で向きを直せるように、画像のまま持つ） */
export type Page = { name: string; canvas: HTMLCanvasElement; rotate: 0 | 90 | 180 | 270 };

/** 写真（JPEG・PNG・HEIC）かPDFを、ページごとの画像にする */
export async function filesToPages(files: File[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const f of files) {
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      const task = pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) });
      const doc = await task.promise;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = LONG_EDGE / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        pages.push({ name: `${f.name}（${i}ページ）`, canvas, rotate: autoRotate(canvas) });
      }
      await task.destroy();
    } else {
      // 写真の向き（EXIF）は createImageBitmap が直してくれる
      const bmp = await createImageBitmap(f);
      const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      pages.push({ name: f.name, canvas, rotate: autoRotate(canvas) });
    }
  }
  return pages;
}

/** 仕切書は横長の表。縦長に写っていたら、左に90度回す（いただいたスキャンはこの向き） */
const autoRotate = (c: HTMLCanvasElement): Page["rotate"] => (c.height > c.width ? 270 : 0);

/** 向きを直した画像（JPEG の base64） */
export function pageToUpload(p: Page, quality = 0.88): Upload {
  const side = p.rotate === 90 || p.rotate === 270;
  const out = document.createElement("canvas");
  out.width = side ? p.canvas.height : p.canvas.width;
  out.height = side ? p.canvas.width : p.canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((p.rotate * Math.PI) / 180);
  ctx.drawImage(p.canvas, -p.canvas.width / 2, -p.canvas.height / 2);
  const url = out.toDataURL("image/jpeg", quality);
  return { mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

/** 全ページを送れる大きさ（合計 約9MB まで）にする */
export function pagesToUploads(pages: Page[]): Upload[] {
  for (const q of [0.88, 0.8, 0.7, 0.6]) {
    const ups = pages.map((p) => pageToUpload(p, q));
    if (ups.reduce((n, u) => n + u.data.length, 0) <= 8_500_000) return ups;
  }
  throw new Error("ページが多すぎます。1か月分ずつに分けて読み取ってください");
}

// ---------- 仕切書の行 → アプリの規格 ----------

/** 仕切書の行（例：秀品の「16入り」）に当たるアプリの規格を探す。見つからなければ "" */
export function guessGrade(block: ShikiriBlock, row: ShikiriRow, grades: Grade[]): string {
  const size = row.size.replace(/\s/g, "");
  // 粒売り（プレミアム・ロイヤル）は名前で探す
  const byName = grades.find((g) => g.name && (size.includes(g.name) || g.name.includes(size)));
  if (byName && !/\d/.test(size)) return byName.id;
  const n = Number(size.match(/\d+/)?.[0] ?? NaN);
  if (!Number.isFinite(n)) return byName?.id ?? "";
  const rank = block.rank.replace(/\s/g, "");
  const group = /^A/.test(rank) ? "A" : /秀/.test(rank) ? "秀" : "";
  const cands = grades.filter((g) => g.count === n);
  return (cands.find((g) => g.group === group) ?? (group ? undefined : cands[0]))?.id ?? "";
}

// ---------- 数字の確かめ ----------

export type Check = { label: string; read: number; printed: number | null; ok: boolean };

/** 読み取った数字の合計が、仕切書に印刷された合計と合うか */
export function checkSheet(s: ShikiriSheet): { rows: Map<ShikiriRow, Check>; blocks: Map<ShikiriBlock, Check>; sheet: Check[] } {
  const rows = new Map<ShikiriRow, Check>();
  const blocks = new Map<ShikiriBlock, Check>();
  let amount = 0;
  for (const b of s.blocks) {
    let bAmt = 0;
    for (const r of b.rows) {
      const q = r.entries.reduce((n, e) => n + e.qty, 0);
      bAmt += r.entries.reduce((n, e) => n + e.qty * e.price, 0);
      rows.set(r, { label: `${r.size}の数量計`, read: q, printed: r.qtyTotal, ok: r.qtyTotal === null || r.qtyTotal === q });
    }
    amount += bAmt;
    blocks.set(b, { label: `${b.variety} ${b.rank}の品種合計額`, read: bAmt, printed: b.amountTotal, ok: b.amountTotal === null || b.amountTotal === bAmt });
  }
  const sheet: Check[] = [{ label: "8%軽対象合計額（税抜）", read: amount, printed: s.subtotal, ok: s.subtotal === null || s.subtotal === amount }];
  if (s.subtotal !== null && s.tax !== null && s.total !== null)
    sheet.push({ label: "税込金額（合計額＋消費税）", read: s.subtotal + s.tax, printed: s.total, ok: s.subtotal + s.tax === s.total });
  return { rows, blocks, sheet };
}

// ---------- アプリの出荷実績との比べ・当てはめ ----------

export type Change = { date: string; gradeId: string; before: { qty?: number; price?: number }; after: { qty?: number; price?: number } };

const pad = (n: number) => String(n).padStart(2, "0");
export const monthDays = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * 仕切書の数字にしたときに変わるところ。
 * mapping（仕切書の行 → 規格ID）で規格が決まった行だけを見る。
 * clearMissing が true なら、仕切書で0（載っていない）の日の数量は消す。
 */
export function diffSheet(s: ShikiriSheet, mapping: Map<ShikiriRow, string>, current: Record<string, DayItems>, clearMissing: boolean): Change[] {
  const want = new Map<string, Map<string, ShikiriEntry>>(); // 規格 → 日 → 数字
  for (const b of s.blocks)
    for (const r of b.rows) {
      const id = mapping.get(r);
      if (!id) continue;
      const m = want.get(id) ?? new Map<string, ShikiriEntry>();
      for (const e of r.entries) {
        if (e.day < 1 || e.day > monthDays(s.year, s.month) || e.qty <= 0) continue;
        const date = `${s.year}-${pad(s.month)}-${pad(e.day)}`;
        // 同じ規格が2行に分かれていたら足す（単価はあとの行）
        const prev = m.get(date);
        m.set(date, prev ? { day: e.day, qty: prev.qty + e.qty, price: e.price } : e);
      }
      want.set(id, m);
    }
  const out: Change[] = [];
  for (const [gradeId, days] of want) {
    for (let d = 1; d <= monthDays(s.year, s.month); d++) {
      const date = `${s.year}-${pad(s.month)}-${pad(d)}`;
      const before = current[date]?.[gradeId] ?? {};
      const e = days.get(date);
      const after = e ? { qty: e.qty, price: e.price } : clearMissing ? {} : before;
      if ((before.qty ?? 0) !== (after.qty ?? 0) || (before.price ?? 0) !== (after.price ?? 0)) out.push({ date, gradeId, before, after });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 変わるところを当てはめた、日ごとの新しい出荷（保存する日だけ） */
export function applyChanges(changes: Change[], current: Record<string, DayItems>): Record<string, DayItems> {
  const out: Record<string, DayItems> = {};
  for (const c of changes) {
    const items = (out[c.date] ??= { ...(current[c.date] ?? {}) });
    if (c.after.qty) items[c.gradeId] = { qty: c.after.qty, ...(c.after.price ? { price: c.after.price } : {}) };
    else delete items[c.gradeId];
  }
  return out;
}
