// CSVファイルの読み込み（AirレジのCSVなど）

export type Encoding = "utf-8" | "shift_jis";

/**
 * 文字コードを判定して文字列にする。
 * UTF-8として正しく読めればUTF-8、読めなければShift_JIS（Excelで保存したCSVに多い）として読む。
 */
export function decodeCsv(buf: ArrayBuffer, forced?: Encoding): { text: string; encoding: Encoding } {
  const bytes = new Uint8Array(buf);
  if (forced) return { text: new TextDecoder(forced).decode(bytes).replace(/^﻿/, ""), encoding: forced };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "shift_jis" };
  }
}

/** CSVを行と列に分ける（"" で囲まれた値の中のカンマ・改行にも対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 日付の文字を "YYYY-MM-DD" にする。読めなければ null */
export function parseDate(v: string): string | null {
  const s = v
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, "/");
  const m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/) ?? s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 金額の文字を数にする（¥・円・カンマ・全角数字・マイナスに対応）。読めなければ null */
export function parseAmount(v: string): number | null {
  const s = v
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[−ー－▲△]/g, "-")
    // Shift_JIS では「¥」が「\」として読まれるので、どちらも取り除く
    .replace(/[¥￥\\円,，\s]/g, "");
  if (s === "" || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

/** 見出しの名前から、日付と金額の列を推測する */
export function guessColumns(header: string[]): { date: number; amount: number } {
  const find = (words: string[]) => header.findIndex((h) => words.some((w) => h.includes(w)));
  const date = find(["日付", "日時", "売上日", "会計日", "date", "Date"]);
  let amount = find(["売上合計", "合計金額", "税込", "合計", "売上", "金額", "amount", "Amount"]);
  if (amount === date) amount = -1;
  return { date: Math.max(0, date), amount: amount >= 0 ? amount : Math.min(1, header.length - 1) };
}

/** 文字 → Shift_JIS のバイト（はじめて使うときに、ブラウザの読み取り機能から逆引きの表を作る） */
let sjisTable: Map<string, number[]> | null = null;
function sjisMap(): Map<string, number[]> {
  if (sjisTable) return sjisTable;
  const dec = new TextDecoder("shift_jis");
  const m = new Map<string, number[]>();
  // 半角カナ
  for (let b = 0xa1; b <= 0xdf; b++) m.set(dec.decode(new Uint8Array([b])), [b]);
  // 2バイト文字
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi > 0x9f && hi < 0xe0) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const c = dec.decode(new Uint8Array([hi, lo]));
      if (c.length === 1 && c !== "\ufffd" && !m.has(c)) m.set(c, [hi, lo]);
    }
  }
  sjisTable = m;
  return m;
}

/** 文字列を Shift_JIS にする（Windowsのソフト向け。Shift_JIS にない文字は「?」） */
export function encodeShiftJis(text: string): Uint8Array {
  const m = sjisMap();
  const out: number[] = [];
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else out.push(...(m.get(c) ?? [0x3f]));
  }
  return new Uint8Array(out);
}
