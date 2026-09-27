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
  type Op = { kind: "text"; x: number; y: number; text: string; font: string; align: CanvasTextAlign } | { kind: "rule"; y: number } | { kind: "ruler"; y: number };
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

/** SII URL Print Agent を呼んで印刷する。終わると returnUrl に戻ってくる */
export function printWithSii(lines: RLine[], c: PrinterConfig, returnUrl: string, opts: { drawer?: boolean } = {}) {
  const pdf = canvasToPdfBase64(renderReceipt(lines, c.paper, { fullHead: true, shiftMm: c.shiftMm, fontSize: c.fontSize }));
  const back = new URL(returnUrl, window.location.href).toString();
  const fail = back + (back.includes("?") ? "&" : "?") + "printError=1";
  const params = [
    `CallbackSuccess=${encodeURIComponent(back)}`,
    `CallbackFail=${encodeURIComponent(fail)}`,
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
 * URL Print Agent には「開けるだけ」の命令がないので、白い1mmの紙（カットも紙送りもなし）を
 * Drawer=yes で送って開けてもらう。
 */
export function openDrawerWithSii(c: PrinterConfig, returnUrl: string) {
  const canvas = document.createElement("canvas");
  canvas.width = HEAD_DOTS;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const back = new URL(returnUrl, window.location.href).toString();
  const fail = back + (back.includes("?") ? "&" : "?") + "printError=1";
  const params = [
    `CallbackSuccess=${encodeURIComponent(back)}`,
    `CallbackFail=${encodeURIComponent(fail)}`,
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

/** 設定に合わせて印刷する。kind でドロアーを開けるかを決める */
export function printReceipt(lines: RLine[], returnUrl: string, kind: "sale-cash" | "settle" | "other" = "other") {
  const c = loadPrinter();
  const drawer = (kind === "settle" && c.drawerOnSettle) || (kind === "sale-cash" && c.drawerOnCashConfirm);
  if (c.method === "sii") printWithSii(lines, c, returnUrl, { drawer });
  else printInBrowser(lines, c.paper, c.fontSize);
}
