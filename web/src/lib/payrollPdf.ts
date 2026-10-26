"use client";

// 給与集計表のPDF（「〇年〇月度分給与集計表」。表計算ソフトから印刷したPDF）を読み取る。
// PDFの中の文字をそのまま読むので、画像（スキャン）のPDFは読めない。ファイルはこの端末の中だけで読み、どこにも送らない。
import { openPdf } from "./pdf";
import { PAY_ITEMS, computeRow, type PayKey, type PayRow, type PayrollCsvEntry } from "./payroll";

/** PDFの文字1つ分のかたまり（x・y は左下から、w は幅。単位はポイント） */
export type PdfText = { str: string; x: number; y: number; w: number };

export type PayrollPdfResult = {
  entries: PayrollCsvEntry[];
  /** PDFに書いてある月度（"2026-07"）。読めなければ null */
  month: string | null;
  /** 支給合計・社会保険料計・差引支給合計が、PDFの数字と合わなかった人 */
  mismatches: string[];
  error?: string;
};

/** 見出しの名前（PDFの表と同じ）。PAY_ITEMS のほかに、確かめるための合計の列 */
const CHECK_COLS = { pay: "支給合計", social: "社会保険料計", net: "差引支給合計" } as const;

/**
 * PDFの中には、ふつうの漢字の代わりに「部首の文字」（⼭・⺠・⻄ など）が入っていることがある。
 * ほとんどは NFKC でふつうの漢字に直るが、直らないもの（CJK部首補助）はここで直す
 */
const RADICALS: Record<string, string> = {
  "⺟": "母",
  "⺠": "民",
  "⻄": "西",
  "⻑": "長",
  "⻘": "青",
  "⻝": "食",
  "⻤": "鬼",
  "⻨": "麦",
  "⻩": "黄",
  "⻫": "斉",
  "⻭": "歯",
  "⻯": "竜",
  "⻲": "亀",
  "⻆": "角",
};
const nfkc = (s: string) => s.normalize("NFKC").replace(/[\u2E80-\u2EFF]/g, (c) => RADICALS[c] ?? c);

/** 同じ高さの文字を1行にまとめる（上の行から順に） */
function lines(items: PdfText[]): PdfText[][] {
  const out: { y: number; items: PdfText[] }[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    const l = out.find((x) => Math.abs(x.y - it.y) <= 2);
    if (l) l.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  return out.map((l) => l.items.sort((a, b) => a.x - b.x));
}

/** 行の文字を、1文字ずつの位置つきで並べる（空白は除く） */
function chars(line: PdfText[]): { c: string; x0: number; x1: number }[] {
  const out: { c: string; x0: number; x1: number }[] = [];
  for (const it of line) {
    const cs = [...it.str];
    const cw = cs.length ? it.w / cs.length : 0;
    cs.forEach((c, i) => {
      const n = nfkc(c).replace(/\s/g, "");
      if (n) out.push({ c: n, x0: it.x + i * cw, x1: it.x + (i + 1) * cw });
    });
  }
  return out;
}

/** 見出しの行から、見出しの名前の真ん中の位置を探す */
function labelCenters(line: PdfText[], labels: string[]): Map<string, number> {
  const cs = chars(line);
  const text = cs.map((c) => c.c).join("");
  const out = new Map<string, number>();
  for (const label of labels) {
    const i = text.indexOf(nfkc(label));
    if (i < 0) continue;
    const end = i + [...nfkc(label)].length - 1;
    out.set(label, (cs[i].x0 + cs[end].x1) / 2);
  }
  return out;
}

const NUM = /^-?[0-9,]+$/;
const toNum = (s: string) => Number(nfkc(s).replace(/,/g, ""));

/** PDFの文字から、従業員ごとの金額を読む */
export function parsePayrollPdfText(items: PdfText[]): PayrollPdfResult {
  const ls = lines(items);
  const joined = ls.map((l) => nfkc(l.map((i) => i.str).join("")).replace(/\s/g, ""));

  // 月度：「令和8年7月度分給与集計表」
  let month: string | null = null;
  for (const t of joined) {
    const m = /令和(\d+)年(\d+)月度分給与集計表/.exec(t);
    if (m) {
      month = `${2018 + Number(m[1])}-${m[2].padStart(2, "0")}`;
      break;
    }
  }

  // 見出しの行：「支給合計」と「社会保険料計」がある行
  const hi = joined.findIndex((t) => t.includes(CHECK_COLS.pay) && t.includes(CHECK_COLS.social));
  if (hi < 0)
    return {
      entries: [],
      month,
      mismatches: [],
      error:
        "「給与集計表」の見出し（支給合計・社会保険料計）が見つかりません。表計算ソフトから印刷したPDFを選んでください（スキャンした画像のPDFは読めません）",
    };
  const labels = [...PAY_ITEMS.map((i) => i.label as string), ...Object.values(CHECK_COLS)];
  const centers = labelCenters(ls[hi], labels);
  if (!centers.size) return { entries: [], month, mismatches: [], error: "見出しの位置が読み取れませんでした" };
  const firstCol = Math.min(...centers.values()) - 15;

  // 従業員の行：左の端に「（連番）社員番号 氏名」がある行
  type Row = { code: string; name: string; nums: { n: number; right: number }[] };
  const rows: Row[] = [];
  for (const l of ls.slice(hi + 1)) {
    const left = l.filter((i) => i.x + i.w <= firstCol);
    let text = "";
    let prevEnd: number | null = null;
    for (const i of left) {
      // 氏と名の間の空白は、空白の文字のこともあれば、すき間だけのこともある
      if (prevEnd !== null && i.x - prevEnd > 1.5) text += " ";
      text += i.str.trim() ? i.str : " ";
      prevEnd = i.x + i.w;
    }
    const m = /(\d{1,8})\s*([^\d\s][^\d]*)$/.exec(nfkc(text).trim());
    if (!m) continue;
    const nums = l.filter((i) => i.x >= firstCol && NUM.test(nfkc(i.str).trim())).map((i) => ({ n: toNum(i.str), right: i.x + i.w }));
    rows.push({ code: m[1], name: m[2].replace(/\s+/g, " ").trim(), nums });
  }
  if (!rows.length) return { entries: [], month, mismatches: [], error: "従業員の行（社員番号と氏名）が見つかりません" };

  // 列の右端：金額は列の右に寄せて書いてあるので、全員の数字の右端をまとめる
  const rights: number[] = [];
  for (const r of rows)
    for (const x of r.nums) {
      const near = rights.findIndex((v) => Math.abs(v - x.right) <= 3);
      if (near < 0) rights.push(x.right);
    }
  rights.sort((a, b) => a - b);
  // 見出しの真ん中より右で、次の見出しの真ん中より左にある、いちばん近い右端が、その列の右端
  const sorted = [...centers.entries()].sort((a, b) => a[1] - b[1]);
  const colRight = new Map<string, number>();
  sorted.forEach(([label, c], i) => {
    const next = sorted[i + 1]?.[1] ?? Infinity;
    const r = rights.find((v) => v > c && v < next);
    if (r !== undefined) colRight.set(label, r);
  });
  const valueOf = (r: Row, label: string) => {
    const right = colRight.get(label);
    if (right === undefined) return 0;
    return r.nums.find((x) => Math.abs(x.right - right) <= 3)?.n ?? 0;
  };

  const entries: PayrollCsvEntry[] = [];
  const mismatches: string[] = [];
  for (const r of rows) {
    const row: PayRow = {};
    for (const it of PAY_ITEMS) {
      const v = valueOf(r, it.label);
      if (v) row[it.key as PayKey] = v;
    }
    entries.push({ code: r.code, name: r.name, row });
    // PDFの合計の列と、読んだ金額から計算した合計を比べる（読み違いに気づけるように）
    const c = computeRow(row);
    const bad = (
      [
        ["支給合計", c.pay, valueOf(r, CHECK_COLS.pay)],
        ["社会保険料計", c.social, valueOf(r, CHECK_COLS.social)],
        ["差引支給合計", c.net, valueOf(r, CHECK_COLS.net)],
      ] as const
    ).filter(([label, calc, pdf]) => colRight.has(label) && calc !== pdf);
    if (bad.length)
      mismatches.push(
        `${r.code} ${r.name}（${bad.map(([l, calc, pdf]) => `${l} PDF ${pdf.toLocaleString("ja-JP")}・計算 ${calc.toLocaleString("ja-JP")}`).join("、")}）`,
      );
  }
  return { entries, month, mismatches };
}

/** PDFファイルを読み取る（1ページ目だけ） */
export async function readPayrollPdf(file: File): Promise<PayrollPdfResult> {
  const task = await openPdf(await file.arrayBuffer());
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const items: PdfText[] = [];
    for (const i of tc.items) if ("str" in i && i.str) items.push({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width });
    return parsePayrollPdfText(items);
  } finally {
    await task.destroy();
  }
}
