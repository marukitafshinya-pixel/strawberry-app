// 文字読み取り（Google Cloud Vision）の結果から、仕切書の表を組み立てる。
// 読み取りで分かるのは「どの文字が、紙のどこにあったか」だけなので、
// 見出しの「1日〜31日」の位置から列を、「数量」「単価」の位置から行を決めて、数字を当てはめる。
import type { ShikiriBlock, ShikiriRow, ShikiriSheet } from "./shikiri";

/** 読み取った文字1つ分（単語）。座標は画像のピクセル */
export type OcrWord = { t: string; x0: number; y0: number; x1: number; y1: number };
export type OcrPage = { width: number; height: number; words: OcrWord[] };

type W = { t: string; x: number; y: number; x0: number; x1: number; h: number };

const median = (a: number[]) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
/** 数字だけの単語か（3けたごとの区切りが「.」と読まれたものも数字とみなす） */
const isNum = (t: string) => /^\d+$/.test(t) || /^\d{1,3}([,.]\d{3})+$/.test(t);
const toNum = (t: string) => Number(t.replace(/[,.]/g, ""));
/** 全角の数字などを半角にそろえる */
const norm = (t: string) =>
  t
    .normalize("NFKC")
    .replace(/[，､、]/g, ",")
    .replace(/\s/g, "");

/** 画像を90度単位で回したときの座標（どの向きで読めば表になるかを試すため） */
export function rotateWords(p: OcrPage, r: 0 | 90 | 180 | 270): W[] {
  return p.words.map((w) => {
    const c = [
      [w.x0, w.y0],
      [w.x1, w.y1],
    ].map(([x, y]) => (r === 0 ? [x, y] : r === 90 ? [p.height - y, x] : r === 180 ? [p.width - x, p.height - y] : [y, p.width - x]));
    const x0 = Math.min(c[0][0], c[1][0]);
    const x1 = Math.max(c[0][0], c[1][0]);
    const y0 = Math.min(c[0][1], c[1][1]);
    const y1 = Math.max(c[0][1], c[1][1]);
    return { t: norm(w.t), x: (x0 + x1) / 2, y: (y0 + y1) / 2, x0, x1, h: y1 - y0 };
  });
}

type Header = { a: number; b: number; slope: number; x0: number; y0: number; days: number };

/** 見出しの「1日」〜「31日」を探し、列の位置（x = a + b×日）と、紙の傾きを求める */
export function findHeader(ws: W[]): Header | null {
  const hs = median(ws.map((w) => w.h)) || 10;
  const cands: { d: number; x: number; y: number }[] = [];
  for (const w of ws) {
    // 表の数字は右寄せで、見出しの「N日」の右端とそろっているので、列の位置は右端で見る
    const m = w.t.match(/^(\d{1,2})日$/);
    if (m) {
      cands.push({ d: Number(m[1]), x: w.x1, y: w.y });
      continue;
    }
    // 「1」「日」と分かれて読まれたとき
    if (/^\d{1,2}$/.test(w.t)) {
      const nichi = ws.find((v) => v.t.startsWith("日") && v.x > w.x && v.x0 <= w.x1 + hs * 1.5 && Math.abs(v.y - w.y) < hs);
      if (nichi) cands.push({ d: Number(w.t), x: nichi.x1, y: w.y });
    }
  }
  const ok = cands.filter((c) => c.d >= 1 && c.d <= 31);
  let best: { set: typeof ok; slope: number } | null = null;
  // 2つの候補を通る線に、ほかの候補がどれだけ乗るかで、見出しの行を決める
  for (let i = 0; i < ok.length; i++)
    for (let j = i + 1; j < ok.length; j++) {
      const p = ok[i];
      const q = ok[j];
      if (p.d === q.d || (q.x - p.x) / (q.d - p.d) <= 0) continue;
      const slope = (q.y - p.y) / (q.x - p.x);
      if (Math.abs(slope) > 0.1) continue;
      const bx = (q.x - p.x) / (q.d - p.d);
      const set = ok.filter((c) => Math.abs(c.y - (p.y + slope * (c.x - p.x))) < hs * 0.8 && Math.abs(c.x - (p.x + bx * (c.d - p.d))) < bx * 0.4);
      const days = new Set(set.map((c) => c.d)).size;
      if (!best || days > new Set(best.set.map((c) => c.d)).size) best = { set, slope };
    }
  if (!best || new Set(best.set.map((c) => c.d)).size < 8) return null;
  // 見つかった見出しで線を引きなおし、それに乗る見出しを集めなおす（2回）
  let s = best.set;
  let fit = { slope: 0, mx: 0, my: 0, a: 0, b: 0 };
  for (let k = 0; k < 3; k++) {
    const mx = s.reduce((n, c) => n + c.x, 0) / s.length;
    const my = s.reduce((n, c) => n + c.y, 0) / s.length;
    const slope = s.reduce((n, c) => n + (c.x - mx) * (c.y - my), 0) / (s.reduce((n, c) => n + (c.x - mx) ** 2, 0) || 1);
    fit = { slope, mx, my, ...fitColumns(s, slope, mx, my) };
    const f = fit;
    const byDay = new Map<number, { d: number; x: number; y: number; err: number }>();
    for (const c of ok) {
      if (Math.abs(c.y - (f.my + f.slope * (c.x - f.mx))) > hs) continue;
      const err = Math.abs(straighten(c.x, c.y, f.slope, f.mx, f.my).x - (f.a + f.b * c.d));
      if (err > f.b * 0.35) continue;
      const prev = byDay.get(c.d);
      if (!prev || err < prev.err) byDay.set(c.d, { ...c, err });
    }
    if (byDay.size < 8) break;
    s = [...byDay.values()];
  }
  return { a: fit.a, b: fit.b, slope: fit.slope, x0: fit.mx, y0: fit.my, days: new Set(s.map((c) => c.d)).size };
}

/** 傾きを直した座標で、列の位置 x = a + b×日 を求める */
function fitColumns(s: { d: number; x: number; y: number }[], slope: number, cx: number, cy: number) {
  const pts = s.map((c) => ({ d: c.d, x: straighten(c.x, c.y, slope, cx, cy).x }));
  const md = pts.reduce((n, p) => n + p.d, 0) / pts.length;
  const mx = pts.reduce((n, p) => n + p.x, 0) / pts.length;
  const b = pts.reduce((n, p) => n + (p.d - md) * (p.x - mx), 0) / (pts.reduce((n, p) => n + (p.d - md) ** 2, 0) || 1);
  return { a: mx - b * md, b };
}

/** 紙の傾きを直した座標（見出しの行が水平になるように回す） */
function straighten(x: number, y: number, slope: number, cx: number, cy: number) {
  const t = Math.atan(slope);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * Math.cos(t) + dy * Math.sin(t), y: cy - dx * Math.sin(t) + dy * Math.cos(t) };
}

type Line = { y: number; words: W[]; text: string };

/** 同じ高さの単語を1行にまとめる */
function toLines(ws: W[], tol: number): Line[] {
  const sorted = [...ws].sort((p, q) => p.y - q.y);
  const lines: { y: number; words: W[] }[] = [];
  for (const w of sorted) {
    const l = lines.find((x) => Math.abs(x.y - w.y) < tol);
    if (l) {
      l.words.push(w);
      l.y = l.words.reduce((n, v) => n + v.y, 0) / l.words.length;
    } else lines.push({ y: w.y, words: [w] });
  }
  return lines
    .map((l) => {
      const words = mergeNumbers(l.words.sort((p, q) => p.x - q.x));
      return { y: l.y, words, text: words.map((w) => w.t).join("") };
    })
    .sort((p, q) => p.y - q.y);
}

/** 「2,550」「,」「640」のように分かれて読まれた数字を1つにする */
function mergeNumbers(ws: W[]): W[] {
  const out: W[] = [];
  for (const w of ws) {
    const prev = out[out.length - 1];
    if (prev && /^[\d,]+$/.test(prev.t) && /^[\d,]+$/.test(w.t) && (prev.t.endsWith(",") || w.t.startsWith(",")) && w.x0 - prev.x1 < Math.max(prev.h, w.h) * 0.6) {
      out[out.length - 1] = { ...prev, t: prev.t + w.t, x1: w.x1, x: (prev.x0 + w.x1) / 2 };
    } else out.push(w);
  }
  return out;
}

/** 行の中で、ラベル（例：「税込金額」）のすぐ右にある数字 */
function numberAfter(line: Line, label: string): number | null {
  let text = "";
  let end = -1;
  for (const w of line.words) {
    text += w.t;
    if (end < 0 && text.includes(label)) end = w.x1;
  }
  if (end < 0) return null;
  const n = line.words.filter((w) => w.x0 >= end - 2 && isNum(w.t)).sort((p, q) => p.x - q.x)[0];
  return n ? toNum(n.t) : null;
}

/** OCRの1ページから、仕切書1か月分を組み立てる */
export function parseOcrPage(page: OcrPage, fallbackYear: number): { sheet: ShikiriSheet | null; notes: string[] } {
  // 4つの向きを試して、見出しの日付がいちばん多く見つかる向きで読む
  let ws: W[] = [];
  let head: Header | null = null;
  for (const r of [0, 270, 90, 180] as const) {
    const cand = rotateWords(page, r);
    const h = findHeader(cand);
    if (h && (!head || h.days > head.days)) {
      head = h;
      ws = cand;
    }
    if (head && head.days >= 28) break;
  }
  if (!head) return { sheet: null, notes: ["表の見出し（1日〜31日）が見つかりませんでした。向きや明るさを確かめてください"] };
  const H = head;
  const notes: string[] = [];
  const st = ws.map((w) => {
    const c = straighten(w.x, w.y, H.slope, H.x0, H.y0);
    const d = c.x - w.x;
    return { ...w, x: c.x, y: c.y, x0: w.x0 + d, x1: w.x1 + d };
  });
  const hs = median(st.map((w) => w.h)) || 10;
  const lines = toLines(st, hs * 0.55);
  const colX = (d: number) => H.a + H.b * d;
  // 数字の右端がどの列の右端に近いか
  const dayOf = (x1: number) => {
    const d = Math.round((x1 - H.a) / H.b);
    return d >= 1 && d <= 31 && Math.abs(x1 - colX(d)) < H.b * 0.5 ? d : 0;
  };
  const leftEdge = colX(1) - H.b * 1.2;
  const totalFrom = colX(31) + H.b * 0.5;

  // 年と月（見出しより上の「2026年 7月分」）
  let year = fallbackYear;
  let month = 0;
  for (const l of lines) {
    if (l.y > H.y0 + hs) break;
    const m = l.text.match(/(\d{1,2})月分/);
    if (m) {
      month = Number(m[1]);
      const y = l.text.match(/(20\d\d)年/);
      if (y) year = Number(y[1]);
    }
  }
  if (!month) notes.push("「何月分」が読めませんでした");

  // 表の行
  type DataLine = { kind: "qty" | "price" | ""; y: number; vals: Map<number, number>; totals: number[]; label: string };
  const blocks: { variety: string; rank: string; y: number; lines: DataLine[] }[] = [];
  const sizes: { text: string; y: number }[] = [];
  const amountTotals: { y: number; v: number }[] = [];
  let subtotal: number | null = null;
  let tax: number | null = null;
  let total: number | null = null;
  let fee: number | null = null;
  let paid: number | null = null;
  const cur = () => {
    if (!blocks.length) blocks.push({ variety: "", rank: "", y: H.y0, lines: [] });
    return blocks[blocks.length - 1];
  };
  for (const l of lines) {
    if (l.y <= H.y0 + hs * 0.6) continue;
    const left = l.words.filter((w) => w.x < leftEdge);
    const leftText = left.map((w) => w.t).join("");
    // 合計の欄
    if (l.text.includes("合計額") && l.text.includes("品種")) {
      const v = numberAfter(l, "合計額");
      if (v !== null) amountTotals.push({ y: l.y, v });
    }
    subtotal ??= numberAfter(l, "対象合計額");
    tax ??= numberAfter(l, "消費税(8%)") ?? numberAfter(l, "消費税");
    total ??= numberAfter(l, "税込金額");
    fee ??= numberAfter(l, "送金料");
    paid ??= numberAfter(l, "送金額");
    if (/^品種/.test(leftText) || (/品種/.test(leftText) && !l.text.includes("合計"))) {
      blocks.push({ variety: leftText.replace(/^.*品種/, ""), rank: "", y: l.y, lines: [] });
      continue;
    }
    if (/^規格/.test(leftText)) {
      cur().rank = leftText.replace(/^規格/, "");
      continue;
    }
    const vals = new Map<number, number>();
    const totals: number[] = [];
    for (const w of l.words) {
      if (w.x < leftEdge || !isNum(w.t)) continue;
      if (w.x1 > totalFrom) totals.push(toNum(w.t));
      else {
        const d = dayOf(w.x1);
        if (d && !vals.has(d)) vals.set(d, toNum(w.t));
      }
    }
    const kind = /数量|数/.test(leftText) ? "qty" : /単価|単|価/.test(leftText) ? "price" : "";
    // サイズの文字（「8入りR」「プレミアム」など）は、数量・単価のラベルより左
    const sizeText = left
      .filter((w) => !/^(数量|単価|数|量|単|価)$/.test(w.t))
      .map((w) => w.t)
      .join("")
      .replace(/数量|単価/g, "");
    if (sizeText && !/^(サイズ|品種|規格)/.test(sizeText)) sizes.push({ text: sizeText, y: l.y });
    if (vals.size >= 10 || (kind && vals.size > 0)) cur().lines.push({ kind, y: l.y, vals, totals, label: leftText });
    else if (totals.length && cur().lines.length) cur().lines[cur().lines.length - 1].totals.push(...totals);
  }

  // 数量と単価の行を組にする（ラベルが読めない行は、上から数量・単価の順とみなす）
  const outBlocks: ShikiriBlock[] = [];
  for (const b of blocks) {
    const rows: ShikiriRow[] = [];
    const ls = b.lines;
    // 数量の行から1つの組が始まり、そのすぐ下の単価の行と組になる。
    // ラベルが読めない行は、前の行の続き（数量→単価→数量…）とみなす
    const pairs: { q: DataLine | null; p: DataLine | null }[] = [];
    let prevKind: DataLine["kind"] = "price";
    for (const l of ls) {
      const kind: DataLine["kind"] = l.kind || (prevKind === "qty" ? "price" : "qty");
      prevKind = kind;
      const last = pairs[pairs.length - 1];
      if (kind === "price" && last && last.q && !last.p && l.y - last.q.y < hs * 2.5) last.p = l;
      else if (kind === "price") pairs.push({ q: null, p: l });
      else pairs.push({ q: l, p: null });
    }
    const empty: DataLine = { kind: "", y: 0, vals: new Map(), totals: [], label: "" };
    let idx = 0;
    for (const pr of pairs) {
      idx++;
      if (!pr.q || !pr.p) notes.push(`${b.variety}の${idx}行目は「${pr.q ? "単価" : "数量"}」の行が読めませんでした`);
      const q = pr.q ?? { ...empty, y: pr.p!.y - hs * 1.3 };
      const p = pr.p ?? { ...empty, y: q.y + hs * 1.3 };
      const mid = (q.y + p.y) / 2;
      const size = sizes.filter((s) => s.y > q.y - hs * 1.2 && s.y < p.y + hs * 1.2).sort((s1, s2) => Math.abs(s1.y - mid) - Math.abs(s2.y - mid))[0]?.text ?? `${idx}行目`;
      const entries = [];
      const missing: number[] = [];
      for (let d = 1; d <= 31; d++) {
        const qty = q.vals.get(d) ?? 0;
        if (!qty) continue;
        const price = p.vals.get(d);
        if (price === undefined) missing.push(d);
        entries.push({ day: d, qty, price: price ?? 0 });
      }
      if (missing.length) notes.push(`${size}：${missing.join("・")}日の単価が読めませんでした`);
      const t = [...q.totals, ...p.totals];
      rows.push({ size, entries, qtyTotal: t.length ? t[0] : null });
    }
    if (rows.length) outBlocks.push({ variety: b.variety, rank: b.rank, rows, amountTotal: null });
  }
  // 品種合計額は、そのまとまりの下に書いてある
  for (const at of amountTotals) {
    const bi = blocks.filter((b) => b.lines.length).findLastIndex((b) => b.lines[0].y < at.y);
    const ob = bi >= 0 ? outBlocks[bi] : undefined;
    if (ob && ob.amountTotal === null) ob.amountTotal = at.v;
  }
  if (!outBlocks.length) return { sheet: null, notes: [...notes, "表の数字が読めませんでした"] };
  return { sheet: { year, month: month || 1, blocks: outBlocks, subtotal, tax, total, fee, paid }, notes };
}
