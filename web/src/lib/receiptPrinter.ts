"use client";

// レシートプリンター（SII RP-F10 など）で印刷する
// iPad の Safari からは Bluetooth のプリンターに直接つなげないため、SII の無料アプリ
// 「SII URL Print Agent」に、レシートを画像にした PDF を渡して印刷してもらう。
//   siiprintagent://1.0/print?CallbackSuccess=戻り先&CallbackFail=戻り先&Format=pdf&Data=PDFのBase64
// プリンターの選び方（Bluetoothのペアリング）は、URL Print Agent のアプリの中で設定する。
import { yen } from "./reservations";
import { lineTaxRate, taxBreakdown, type Sale } from "./sales";
import type { Settings } from "./settings";

export type PrinterConfig = {
  /** browser：ふつうの印刷（AirPrintなど）／sii：SII URL Print Agent でレシートプリンター */
  method: "browser" | "sii";
  /** 紙の幅（mm） */
  paper: 80 | 58;
  /** 会計が終わったら、すぐにレシートを印刷する */
  autoPrint: boolean;
  /** Bluetooth のつながりを保つ（印刷が速くなる） */
  keepConnect: boolean;
  /** 位置の微調整（mm）。＋で右へ、−で左へずらす */
  shiftMm: number;
  /** 文字の大きさ */
  fontSize: "small" | "normal" | "large";
  /** 精算レシートを印刷するときに、キャッシュドロアーを開ける */
  drawerOnSettle: boolean;
  /** 「現金で確定」を押したときに、キャッシュドロアーを開ける（印刷しないときも） */
  drawerOnCashConfirm: boolean;
};

const KEY = "ichigo.printer";
export const DEFAULT_PRINTER: PrinterConfig = { method: "browser", paper: 80, autoPrint: false, keepConnect: true, shiftMm: 0, fontSize: "normal", drawerOnSettle: true, drawerOnCashConfirm: true };
const FONT_SCALE = { small: 0.9, normal: 1.1, large: 1.3 } as const;
/** RP-F10 の印字幅（ドット）。80mm用の72mm＝576ドット。58mmの紙は、この真ん中に入る */
const HEAD_DOTS = 576;

/** この端末（iPad）に保存した設定。端末ごとに違ってよいので、端末の中に保存する */
export function loadPrinter(): PrinterConfig {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<PrinterConfig> | null;
    return { ...DEFAULT_PRINTER, ...(v ?? {}) };
  } catch {
    return DEFAULT_PRINTER;
  }
}
export function savePrinter(c: PrinterConfig) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // 保存できない（プライベートブラウズなど）ときは、その場だけ使う
  }
}

// ---------- レシートの中身（行のリスト） ----------

export type RLine =
  | { t: "text"; text: string; align?: "left" | "center" | "right"; size?: number; bold?: boolean }
  | { t: "row"; left: string; right: string; size?: number; bold?: boolean }
  | { t: "rule" }
  /** 枠で囲んだ文字（領収書の金額など） */
  | { t: "box"; text: string; size?: number }
  | { t: "space"; h?: number }
  /** 位置合わせ用のものさし（紙の端から何mmかを印刷する） */
  | { t: "ruler" };

/** 会計のレシート */
export function saleReceipt(s: Settings, sale: Sale, opts?: { received?: number | null }): RLine[] {
  const when = sale.createdAt?.toDate() ?? new Date();
  const date = when.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const out: RLine[] = [
    { t: "text", text: s.storeName || "（店名）", align: "center", size: 1.5, bold: true },
    ...(s.storeAddress ? [{ t: "text", text: s.storeAddress, align: "center", size: 0.85 } as RLine] : []),
    ...(s.storePhone ? [{ t: "text", text: `TEL ${s.storePhone}`, align: "center", size: 0.85 } as RLine] : []),
    ...(s.invoiceNumber ? [{ t: "text", text: `登録番号 ${s.invoiceNumber}`, align: "center", size: 0.85 } as RLine] : []),
    { t: "space" },
    { t: "text", text: sale.status === "voided" ? "【取消】" : "領 収 証", align: "center", size: 1.2, bold: true },
    { t: "row", left: date, right: `No.${sale.id.slice(0, 6).toUpperCase()}`, size: 0.85 },
    ...(sale.customerName ? [{ t: "text", text: `${sale.customerName} 様`, size: 0.95 } as RLine] : []),
    { t: "rule" },
  ];
  for (const l of sale.lines) {
    out.push({ t: "text", text: `${l.name}${lineTaxRate(l, s) === 8 ? " ※" : ""}` });
    out.push({ t: "row", left: `  ${yen(l.unitPrice)} × ${l.qty}${l.discountRate > 0 ? `（${l.discountRate}%引）` : ""}`, right: yen(l.amount), size: 0.9 });
  }
  out.push({ t: "rule" });
  out.push({ t: "row", left: "小計", right: yen(sale.subtotal) });
  if (sale.discountTotal > 0) out.push({ t: "row", left: "値引き", right: `−${yen(sale.discountTotal)}` });
  out.push({ t: "row", left: "合計", right: yen(sale.total), size: 1.4, bold: true });
  for (const r of taxBreakdown(sale.lines, s)) {
    out.push({ t: "row", left: `（${r.rate}%対象${r.rate === 8 ? "※" : ""}`, right: `${yen(r.total)} 内税 ${yen(r.tax)}）`, size: 0.85 });
  }
  if (sale.lines.some((l) => lineTaxRate(l, s) === 8)) out.push({ t: "text", text: "※は軽減税率対象", size: 0.8 });
  out.push({ t: "space", h: 0.4 });
  if (sale.payment === "credit") out.push({ t: "row", left: "お支払い", right: "売掛（後日）" });
  else {
    out.push({ t: "row", left: "お支払い", right: "現金" });
    if (opts?.received != null && opts.received >= sale.total) {
      out.push({ t: "row", left: "お預かり", right: yen(opts.received) });
      out.push({ t: "row", left: "おつり", right: yen(opts.received - sale.total), bold: true });
    }
  }
  out.push({ t: "space" });
  out.push({ t: "text", text: "ご来園ありがとうございました", align: "center", size: 0.9 });
  return out;
}

/** 宛名つきの領収書（レシートプリンター用）。一般的なお店の「領収証」の形 */
export function invoiceReceipt(s: Settings, sale: Sale, opts: { addressee: string; note: string; issueDate: string }): RLine[] {
  const [y, m, d] = opts.issueDate.split("-").map(Number);
  const taxes = taxBreakdown(sale.lines, s);
  const name = opts.addressee.trim();
  const out: RLine[] = [
    { t: "text", text: `No.${sale.id.slice(0, 6).toUpperCase()}`, align: "right", size: 0.85 },
    { t: "text", text: sale.status === "voided" ? "【取消】" : "領 収 証", align: "center", size: 1.7, bold: true },
    { t: "space", h: 0.6 },
    // 宛名（空欄なら手書きできるよう「様」だけ）
    { t: "row", left: name, right: "様", size: 1.2 },
    { t: "rule" },
    { t: "space", h: 0.4 },
    { t: "box", text: `¥${sale.total.toLocaleString("ja-JP")}-`, size: 1.9 },
    { t: "row", left: `内訳　${sale.payment === "credit" ? "売掛" : "現金"}`, right: `¥${sale.total.toLocaleString("ja-JP")}`, size: 0.9 },
    ...taxes.map((r) => ({ t: "row", left: `　（${r.rate}%対象 ${yen(r.total)}`, right: `内消費税 ${yen(r.tax)}）`, size: 0.8 }) as RLine),
    ...(opts.note.trim() ? [{ t: "text", text: `但し　${opts.note.trim()}`, size: 0.9 } as RLine] : []),
    { t: "space", h: 0.8 },
    { t: "text", text: `${y}年${String(m).padStart(2, "0")}月${String(d).padStart(2, "0")}日`, size: 0.9 },
    { t: "text", text: "上記正に領収しました。", align: "right", size: 0.9 },
    { t: "space", h: 0.6 },
    { t: "row", left: "", right: "扱者　＿＿＿＿＿＿", size: 0.9 },
    { t: "space", h: 0.8 },
    ...(sale.total - taxes.reduce((n, r) => n + r.tax, 0) >= 50000 ? [{ t: "text", text: "（収入印紙）", size: 0.85 } as RLine, { t: "space" } as RLine] : []),
    { t: "text", text: s.storeName || "（店名）", size: 1.05, bold: true },
    ...(s.storeAddress ? [{ t: "text", text: s.storeAddress, size: 0.85 } as RLine] : []),
    ...(s.storePhone ? [{ t: "text", text: `TEL ${s.storePhone}`, size: 0.85 } as RLine] : []),
    ...(s.invoiceNumber ? [{ t: "text", text: `登録番号 ${s.invoiceNumber}`, size: 0.85 } as RLine] : []),
  ];
  return out;
}

export type SettleData = {
  date: string;
  float: number;
  cashSales: number;
  cashCount: number;
  creditSales: number;
  counts: Record<string, number>;
  counted: number;
  diff: number;
  memo: string;
};

/** 精算レシート */
export function settleReceipt(s: Settings, d: SettleData): RLine[] {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const [y, m, day] = d.date.split("-").map(Number);
  const out: RLine[] = [
    { t: "text", text: "精 算 レ シ ー ト", align: "center", size: 1.3, bold: true },
    { t: "text", text: s.storeName, align: "center", size: 0.9 },
    { t: "row", left: `${y}年${m}月${day}日 分`, right: `印刷 ${now}`, size: 0.85 },
    { t: "rule" },
  ];
  for (const den of [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1]) {
    const n = d.counts[String(den)] ?? 0;
    out.push({ t: "row", left: `${den.toLocaleString("ja-JP")}円 × ${n}`, right: yen(den * n), size: 0.95 });
  }
  out.push({ t: "rule" });
  out.push({ t: "row", left: "数えた現金", right: yen(d.counted), bold: true });
  out.push({ t: "row", left: "釣銭準備金", right: yen(d.float) });
  out.push({ t: "row", left: `現金売上（${d.cashCount}件）`, right: yen(d.cashSales) });
  out.push({ t: "row", left: "あるはずの現金", right: yen(d.float + d.cashSales) });
  out.push({ t: "rule" });
  out.push({ t: "row", left: "過不足", right: d.diff === 0 ? "なし" : `${d.diff > 0 ? "+" : "−"}${yen(Math.abs(d.diff))}`, size: 1.4, bold: true });
  out.push({ t: "row", left: "売掛の売上", right: yen(d.creditSales), size: 0.9 });
  out.push({ t: "row", left: "銀行へ入れる額", right: yen(Math.max(0, d.counted - d.float)), size: 0.9 });
  if (d.memo) {
    out.push({ t: "space", h: 0.4 });
    out.push({ t: "text", text: `メモ：${d.memo}`, size: 0.9 });
  }
  out.push({ t: "space" });
  out.push({ t: "row", left: "確認者", right: "＿＿＿＿＿＿＿＿", size: 0.95 });
  return out;
}

/** 位置合わせ用：ものさしを印刷して、左がどこまで切れるかを見る */
export function alignReceipt(): RLine[] {
  return [
    { t: "text", text: "位置合わせ", align: "center", size: 1.3, bold: true },
    { t: "text", text: "紙の左はしと右はしに、どの数字があるかを見てください。", size: 0.85 },
    { t: "ruler" },
    { t: "text", text: "左はしと右はしの数字を足して2で割り、36を引いた数が「位置の微調整」の目安です。", size: 0.85 },
    { t: "text", text: "例：左はし7・右はし65なら (7+65)÷2−36＝0mm", size: 0.85 },
  ];
}

export function testReceipt(s: Settings, c: PrinterConfig): RLine[] {
  return [
    { t: "text", text: "テスト印刷", align: "center", size: 1.4, bold: true },
    { t: "text", text: s.storeName || "（店名）", align: "center" },
    { t: "rule" },
    { t: "row", left: "紙の幅", right: `${c.paper}mm` },
    { t: "row", left: "位置の微調整", right: `${c.shiftMm > 0 ? "+" : ""}${c.shiftMm}mm` },
    { t: "row", left: "文字の大きさ", right: { small: "小", normal: "標準", large: "大" }[c.fontSize] },
    { t: "text", text: "← 左はし", size: 0.85 },
    { t: "text", text: "右はし →", align: "right", size: 0.85 },
    { t: "row", left: "日時", right: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) },
    { t: "rule" },
    { t: "text", text: "この紙が出てくれば、設定は完了です。", align: "center", size: 0.9 },
  ];
}

// ---------- 画像にする ----------

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif';

/** レシートを白黒の画像にする（プリンターのドット数に合わせた幅） */
export function renderReceipt(
  lines: RLine[],
  paper: 80 | 58,
  opts: { fullHead?: boolean; shiftMm?: number; fontSize?: PrinterConfig["fontSize"] } = {},
): HTMLCanvasElement {
  // 203dpi のプリンターで1mm＝8ドット。80mm紙は576ドット、58mm紙は384ドットに印刷する。
  // fullHead のときは、画像をプリンターの印字幅いっぱい（576ドット）にして、中身を真ん中に置く
  const contentW = paper === 80 ? 576 : 384;
  const W = opts.fullHead ? HEAD_DOTS : contentW;
  const base = Math.round((paper === 80 ? 24 : 20) * FONT_SCALE[opts.fontSize ?? "normal"]);
  const shift = Math.round(Math.max(-10, Math.min(10, opts.shiftMm ?? 0)) * 8);
  const start = Math.max(0, Math.min(W - contentW, Math.round((W - contentW) / 2) + shift));
  const pad = start + 4;
  const right = W - (start + contentW) + 4;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = (size = 1, bold = false) => `${bold ? "bold " : ""}${Math.round(base * size)}px ${FONT}`;

  // 1回目：長い文字を折り返して、高さを決める
  type Op =
    | { kind: "text"; x: number; y: number; text: string; font: string; align: CanvasTextAlign }
    | { kind: "rule"; y: number }
    | { kind: "ruler"; y: number }
    | { kind: "box"; y: number; h: number };
  const ops: Op[] = [];
  let y = pad;
  const wrap = (text: string, f: string, maxW: number) => {
    ctx.font = f;
    const out: string[] = [];
    let cur = "";
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        out.push(cur);
        cur = ch;
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  for (const l of lines) {
    if (l.t === "rule") {
      y += base * 0.4;
      ops.push({ kind: "rule", y });
      y += base * 0.5;
      continue;
    }
    if (l.t === "ruler") {
      y += base * 0.3;
      ops.push({ kind: "ruler", y });
      y += base * 3;
      continue;
    }
    if (l.t === "space") {
      y += base * (l.h ?? 0.8);
      continue;
    }
    if (l.t === "box") {
      const f = font(l.size, true);
      const lh = Math.round(base * (l.size ?? 1) * 1.35);
      const padY = Math.round(base * 0.45);
      ops.push({ kind: "box", y, h: lh + padY * 2 });
      ops.push({ kind: "text", x: (pad + W - right) / 2, y: y + padY + Math.round(base * 0.1), text: l.text, font: f, align: "center" });
      y += lh + padY * 2 + base * 0.3;
      continue;
    }
    const f = font(l.size, l.bold);
    const lh = Math.round(base * (l.size ?? 1) * 1.35);
    if (l.t === "text") {
      for (const part of wrap(l.text, f, W - pad - right)) {
        const x = l.align === "center" ? (pad + W - right) / 2 : l.align === "right" ? W - right : pad;
        ops.push({ kind: "text", x, y, text: part, font: f, align: l.align ?? "left" });
        y += lh;
      }
    } else {
      ctx.font = f;
      const rightW = ctx.measureText(l.right).width;
      const leftParts = wrap(l.left, f, Math.max(40, W - pad - right - rightW - 12));
      leftParts.forEach((part, i) => {
        ops.push({ kind: "text", x: pad, y, text: part, font: f, align: "left" });
        if (i === leftParts.length - 1) ops.push({ kind: "text", x: W - right, y, text: l.right, font: f, align: "right" });
        y += lh;
      });
    }
  }
  y += base * 2; // 切り取り位置の余白

  // 2回目：描く
  canvas.width = W;
  canvas.height = Math.ceil(y);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  for (const op of ops) {
    if (op.kind === "rule") {
      ctx.fillRect(pad, Math.round(op.y), W - pad - right, 2);
    } else if (op.kind === "box") {
      // 太さ3ドットの枠
      const x0 = pad + 6;
      const x1 = W - right - 6;
      const y0 = Math.round(op.y);
      const y1 = Math.round(op.y + op.h);
      ctx.fillRect(x0, y0, x1 - x0, 3);
      ctx.fillRect(x0, y1 - 3, x1 - x0, 3);
      ctx.fillRect(x0, y0, 3, y1 - y0);
      ctx.fillRect(x1 - 3, y0, 3, y1 - y0);
    } else if (op.kind === "ruler") {
      // 紙の左はし（0mm）から、1mmごとの目もりと5mmごとの数字
      const top = Math.round(op.y);
      ctx.fillRect(0, top, W, 2);
      ctx.font = `bold ${Math.round(base * 0.8)}px ${FONT}`;
      ctx.textAlign = "center";
      for (let mm = 0; mm * 8 <= W; mm++) {
        const x = mm * 8;
        const h = mm % 5 === 0 ? base * 1.1 : base * 0.5;
        ctx.fillRect(Math.min(x, W - 2), top, 2, Math.round(h));
        if (mm % 5 === 0 && mm > 0) ctx.fillText(String(mm), x, top + base * 1.3);
      }
    } else {
      ctx.font = op.font;
      ctx.textAlign = op.align;
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  // 四すみに小さな点を打つ。印刷アプリが白いふちを自動で切り取ると余白の調整が効かなくなるため
  for (const [x, yy] of [
    [0, 0],
    [W - 2, 0],
    [0, canvas.height - 2],
    [W - 2, canvas.height - 2],
  ])
    ctx.fillRect(x, yy, 2, 2);
  return canvas;
}

// ---------- PDF にする（画像1枚だけの小さな PDF を自分で組み立てる） ----------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 画像（JPEG）1枚を、紙の幅ぴったりのページにした PDF（Base64） */
export function canvasToPdfBase64(canvas: HTMLCanvasElement): string {
  const jpeg = base64ToBytes(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]);
  // 印刷できる幅（80mm紙は72mm、58mm紙は48mm）に合わせる
  const printMm = canvas.width / 8;
  const wPt = (printMm / 25.4) * 72;
  const hPt = (wPt * canvas.height) / canvas.width;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    parts.push(u);
    length += u.length;
  };
  const obj = (n: number, body: string | (Uint8Array | string)[]) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    if (typeof body === "string") push(body);
    else body.forEach(push);
    push("\nendobj\n");
  };
  const content = `q ${wPt.toFixed(2)} 0 0 ${hPt.toFixed(2)} 0 0 cm /Im0 Do Q`;
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt.toFixed(2)} ${hPt.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const all = new Uint8Array(length);
  let p = 0;
  for (const part of parts) {
    all.set(part, p);
    p += part.length;
  }
  return bytesToBase64(all);
}

/** ホーム画面に追加したアプリとして開いているか（Safari のタブではなく） */
export function isHomeScreenApp(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * 印刷のあとに戻ってくるページ。
 * ホーム画面のアプリから呼んだときは付けない（付けると、戻り先のページが Safari で開いてしまうため）。
 * そのときは画面左上の「◀ いちごスタッフ」か、アプリの切り替えで戻る。
 */
function callbackParams(returnUrl: string): string[] {
  if (isHomeScreenApp()) return [];
  const back = new URL(returnUrl, window.location.href).toString();
  const fail = back + (back.includes("?") ? "&" : "?") + "printError=1";
  return [`CallbackSuccess=${encodeURIComponent(back)}`, `CallbackFail=${encodeURIComponent(fail)}`];
}

/** SII URL Print Agent を呼んで印刷する。終わると returnUrl に戻ってくる（Safari のとき） */
export function printWithSii(lines: RLine[], c: PrinterConfig, returnUrl: string, opts: { drawer?: boolean } = {}) {
  const pdf = canvasToPdfBase64(renderReceipt(lines, c.paper, { fullHead: true, shiftMm: c.shiftMm, fontSize: c.fontSize }));
  const params = [
    ...callbackParams(returnUrl),
    `BtKeepConnect=${c.keepConnect ? "always" : "no"}`,
    // Drawer=yes で、印刷と一緒にプリンターにつないだキャッシュドロアーを開ける（URL Print Agent の仕様）
    ...(opts.drawer ? ["Drawer=yes"] : []),
    "Format=pdf",
    `Data=${encodeURIComponent(pdf)}`,
  ];
  window.location.href = `siiprintagent://1.0/print?${params.join("&")}`;
}

/**
 * レシートを出さずにキャッシュドロアーだけ開ける。
 * URL Print Agent には「開けるだけ」の命令がないので、ほぼ白い1mmの紙（カットも紙送りもなし）を
 * Drawer=yes で送って開けてもらう。
 */
export function openDrawerWithSii(c: PrinterConfig, returnUrl: string) {
  const canvas = document.createElement("canvas");
  canvas.width = HEAD_DOTS;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 真っ白だと URL Print Agent が「印刷するものがない」として何もしない（ドロアーも開かない）ので、
  // 端に小さな点を置く（58mmの紙なら紙の外なので、紙には何も出ない）
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 2, 2);
  ctx.fillRect(canvas.width - 2, canvas.height - 2, 2, 2);
  const params = [
    ...callbackParams(returnUrl),
    `BtKeepConnect=${c.keepConnect ? "always" : "no"}`,
    "Drawer=yes",
    "CutType=off",
    "CutFeed=no",
    "Format=pdf",
    `Data=${encodeURIComponent(canvasToPdfBase64(canvas))}`,
  ];
  window.location.href = `siiprintagent://1.0/print?${params.join("&")}`;
}

/** ふつうの印刷（AirPrint など）で、レシートの画像だけを印刷する */
export function printInBrowser(lines: RLine[], paper: 80 | 58, fontSize: PrinterConfig["fontSize"] = "normal") {
  const img = renderReceipt(lines, paper, { fontSize }).toDataURL("image/png");
  const box = document.createElement("div");
  box.id = "receipt-print-box";
  box.innerHTML = `<img src="${img}" style="width:${paper === 80 ? 72 : 48}mm" alt="">`;
  const style = document.createElement("style");
  style.textContent = `#receipt-print-box{display:none}@media print{body>*:not(#receipt-print-box){display:none!important}#receipt-print-box{display:block}@page{margin:3mm}}`;
  document.body.append(box, style);
  const img2 = box.querySelector("img")!;
  const go = () => {
    window.print();
    setTimeout(() => {
      box.remove();
      style.remove();
    }, 500);
  };
  if (img2.complete) go();
  else img2.onload = go;
}

// ---------- 横長の領収書（紙の長さの向きに横向きで印刷する） ----------

export type InvoiceOpts = { addressee: string; note: string; issueDate: string; handler?: string };

/**
 * 横長の領収書を描く（一般的なお店の領収証と同じ並び）。
 * 横向きに描いてから90度回して、紙の幅に合わせた縦長の画像にする。
 */
export function renderInvoiceLandscape(s: Settings, sale: Sale, o: InvoiceOpts, paper: 80 | 58, fontSize: PrinterConfig["fontSize"] = "normal"): HTMLCanvasElement {
  const H = paper === 80 ? 576 : 384; // 紙の幅（ドット）＝横向きにしたときの高さ
  const k = (H / 384) * (FONT_SCALE[fontSize] / FONT_SCALE.normal); // 大きさの倍率
  const L = Math.round(H * 2.9); // 紙の長さ（ドット）＝横向きにしたときの幅
  const land = document.createElement("canvas");
  land.width = L;
  land.height = H;
  const ctx = land.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, L, H);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  const px = (n: number) => Math.round(n * k);
  const text = (t: string, x: number, y: number, size: number, opts: { bold?: boolean; align?: CanvasTextAlign } = {}) => {
    ctx.font = `${opts.bold ? "bold " : ""}${px(size)}px ${FONT}`;
    ctx.textAlign = opts.align ?? "left";
    ctx.fillText(t, x, y);
  };
  const [y, m, d] = o.issueDate.split("-").map(Number);
  const taxes = taxBreakdown(sale.lines, s);
  const M = px(24); // 左右の余白
  // 下の段（内訳・但し書き・店の情報）は、左に寄りすぎないよう少し内側から書く
  const LX = Math.round(L * 0.09);
  const yenText = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

  // 番号（右上）と表題
  text(`No.${sale.id.slice(0, 6).toUpperCase()}`, L - M, px(6), 14, { align: "right" });
  text(sale.status === "voided" ? "【取消】" : "領 収 証", L / 2, px(14), 38, { bold: true, align: "center" });
  // 金額の枠の位置（宛名の下線も同じ幅にする）
  const bw = Math.round(L * 0.56);
  const bx = Math.round((L - bw) / 2);
  // 宛名（空欄なら手書きできるよう「様」だけ）と下線
  const nameY = px(70);
  text(o.addressee.trim(), bx + px(8), nameY, 24);
  text("様", bx + bw - px(8), nameY, 24, { align: "right" });
  ctx.fillRect(bx, nameY + px(32), bw, Math.max(2, px(2)));
  const by = px(116);
  const bh = px(58);
  const t = Math.max(3, px(3));
  ctx.fillRect(bx, by, bw, t);
  ctx.fillRect(bx, by + bh - t, bw, t);
  ctx.fillRect(bx, by, t, bh);
  ctx.fillRect(bx + bw - t, by, t, bh);
  text(`${yenText(sale.total)}-`, L / 2, by + px(9), 40, { bold: true, align: "center" });
  // 内訳・税・但し書き（枠の下）
  let yy = by + bh + px(10);
  text(`内訳　${sale.payment === "credit" ? "売掛" : "現金"}　${yenText(sale.total)}`, LX, yy, 18);
  const taxText = taxes.map((r) => `${r.rate}%対象 ${yen(r.total)}（内消費税 ${yen(r.tax)}）`).join("　");
  text(taxText, L - LX, yy + px(2), 15, { align: "right" });
  yy += px(26);
  if (o.note.trim()) text(`但し　${o.note.trim()}`, LX, yy, 18);
  // 下の段：左に日付と店の情報、右に「上記正に領収しました」と扱者
  yy += px(30);
  text(`${y}年${String(m).padStart(2, "0")}月${String(d).padStart(2, "0")}日`, LX, yy, 16);
  const RX = Math.round(L * 0.66);
  text("上記正に領収しました。", RX, yy, 16);
  // 住所・電話・登録番号を左に並べ、その右に店名を大きく
  const info = [
    ...(s.storeAddress ? [s.storeAddress] : []),
    ...(s.storePhone ? [`TEL ${s.storePhone}`] : []),
    ...(s.invoiceNumber ? [`登録番号 ${s.invoiceNumber}`] : []),
  ];
  const iy0 = yy + px(26);
  let iy = iy0;
  let infoW = 0;
  ctx.font = `${px(15)}px ${FONT}`;
  for (const t of info) {
    text(t, LX, iy, 15);
    ctx.font = `${px(15)}px ${FONT}`;
    infoW = Math.max(infoW, ctx.measureText(t).width);
    iy += px(20);
  }
  // 店名は住所の段の高さの真ん中に（長いときは入る大きさまで小さくする）
  const nameX = LX + Math.round(infoW) + px(22);
  const room = RX - px(16) - nameX;
  let nameSize = 30;
  ctx.font = `bold ${px(nameSize)}px ${FONT}`;
  while (nameSize > 16 && ctx.measureText(s.storeName || "（店名）").width > room) {
    nameSize -= 1;
    ctx.font = `bold ${px(nameSize)}px ${FONT}`;
  }
  const blockH = Math.max(px(20) * info.length, px(nameSize));
  text(s.storeName || "（店名）", nameX, iy0 + Math.round((blockH - px(nameSize)) / 2) - px(2), nameSize, { bold: true });
  // 扱者（選んだ名前。空欄なら手書き用の下線だけ）
  const sy = yy + px(38);
  text("扱者", RX, sy, 16);
  if (o.handler?.trim()) text(o.handler.trim(), RX + px(56), sy, 18, { bold: true });
  ctx.fillRect(RX + px(50), sy + px(24), px(170), Math.max(2, px(2)));
  // 収入印紙が必要な金額のとき
  if (sale.total - taxes.reduce((n, r) => n + r.tax, 0) >= 50000) {
    const sx = L - M - px(80);
    ctx.strokeStyle = "#000";
    ctx.setLineDash([px(4), px(4)]);
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy - px(4), px(80), px(80));
    ctx.setLineDash([]);
    text("収入印紙", sx + px(40), sy + px(30), 12, { align: "center" });
  }

  // 90度回して、紙の幅（H）×紙の長さ（L）の縦長にする（文字の上が紙の右側になる）
  const out = document.createElement("canvas");
  out.width = H;
  out.height = L;
  const o2 = out.getContext("2d")!;
  o2.translate(H, 0);
  o2.rotate(Math.PI / 2);
  o2.drawImage(land, 0, 0);
  return out;
}

/** 中身の画像を、プリンターの印字幅いっぱいの画像の真ん中に置く（位置の調整つき） */
function frameForHead(content: HTMLCanvasElement, shiftMm: number): HTMLCanvasElement {
  const W = HEAD_DOTS;
  const shift = Math.round(Math.max(-10, Math.min(10, shiftMm)) * 8);
  const start = Math.max(0, Math.min(W - content.width, Math.round((W - content.width) / 2) + shift));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = content.height + 16;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, c.height);
  ctx.drawImage(content, start, 8);
  ctx.fillStyle = "#000";
  for (const [x, yy] of [
    [0, 0],
    [W - 2, 0],
    [0, c.height - 2],
    [W - 2, c.height - 2],
  ])
    ctx.fillRect(x, yy, 2, 2);
  return c;
}

/** 横長の領収書を、設定に合わせて印刷する */
export function printInvoice(s: Settings, sale: Sale, o: InvoiceOpts, returnUrl: string) {
  const c = loadPrinter();
  const img = renderInvoiceLandscape(s, sale, o, c.paper, c.fontSize);
  if (c.method === "sii") {
    const pdf = canvasToPdfBase64(frameForHead(img, c.shiftMm));
    const params = [...callbackParams(returnUrl), `BtKeepConnect=${c.keepConnect ? "always" : "no"}`, "Format=pdf", `Data=${encodeURIComponent(pdf)}`];
    window.location.href = `siiprintagent://1.0/print?${params.join("&")}`;
    return;
  }
  const box = document.createElement("div");
  box.id = "receipt-print-box";
  box.innerHTML = `<img src="${img.toDataURL("image/png")}" style="width:${c.paper === 80 ? 72 : 48}mm" alt="">`;
  const style = document.createElement("style");
  style.textContent = `#receipt-print-box{display:none}@media print{body>*:not(#receipt-print-box){display:none!important}#receipt-print-box{display:block}@page{margin:3mm}}`;
  document.body.append(box, style);
  const im = box.querySelector("img")!;
  const go = () => {
    window.print();
    setTimeout(() => {
      box.remove();
      style.remove();
    }, 500);
  };
  if (im.complete) go();
  else im.onload = go;
}

/** 設定に合わせて印刷する。kind でドロアーを開けるかを決める */
export function printReceipt(lines: RLine[], returnUrl: string, kind: "sale-cash" | "settle" | "other" = "other") {
  const c = loadPrinter();
  const drawer = (kind === "settle" && c.drawerOnSettle) || (kind === "sale-cash" && c.drawerOnCashConfirm);
  if (c.method === "sii") printWithSii(lines, c, returnUrl, { drawer });
  else printInBrowser(lines, c.paper, c.fontSize);
}
