"use client";

// ネットバンキングの「入出金明細」のPDF（文字が入っているもの）を、AIを使わずにそのまま読む。
// 1ページの文字を位置ごとに行にし、見出し（日付・摘要・出金・入金・残高）の行を探して、各文字をいちばん近い見出しの列に入れる。
// できた表は、CSVと同じ読み方（guessBankColumns・readBankRows）で通帳の行にする
import { guessBankColumns, readBankRows, type BankRow } from "./books";
import { openPdf } from "./pdf";

type Item = { str: string; x: number; y: number; w: number };

/** 文字の幅（全角＝2、半角＝1）。1つの文字のかたまりを切ったときの位置を見積もるのに使う */
const units = (t: string) => [...t].reduce((n, c) => n + (/[\u0000-\u00ff\uff61-\uff9f]/.test(c) ? 1 : 2), 0);

/** 「26-09-01 | ｶ)ﾎﾂｶｲﾄﾞｳ」のように、区切り（|・2つ以上の空白）をはさんで1つになっている文字を、位置を見積もって分ける */
function splitItem(it: Item): Item[] {
  const total = units(it.str) || 1;
  const out: Item[] = [];
  let at = 0;
  for (const part of it.str.split(/([|｜]|\s{2,})/)) {
    const u = units(part);
    if (part.trim() && !/^[|｜]$/.test(part)) {
      const lead = units(part.match(/^\s*/)![0]);
      const body = part.trim();
      out.push({ str: body, x: it.x + (it.w * (at + lead)) / total, y: it.y, w: (it.w * units(body)) / total });
    }
    at += u;
  }
  return out;
}

/** 1ページの文字 → 表（見出しの行が1行目）。見出しが見つからなければ null */
export function pageToTable(items: Item[]): string[][] | null {
  // 区切りの「|」は列の見出しにならないので外す
  const list = items.flatMap(splitItem);
  // 同じ高さ（2pt 以内）の文字を1行に
  const lines: Item[][] = [];
  for (const it of [...list].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l[0].y - it.y) <= 2);
    if (line) line.push(it);
    else lines.push([it]);
  }
  lines.forEach((l) => l.sort((a, b) => a.x - b.x));
  const hi = lines.findIndex((l) => guessBankColumns([l.map((it) => it.str.trim())]));
  if (hi < 0) return null;
  const center = (it: Item) => it.x + it.w / 2;
  const heads = lines[hi].map(center);
  // 見出しの真ん中と真ん中のあいだで、列を分ける
  const col = (it: Item) => {
    const c = center(it);
    let k = 0;
    while (k + 1 < heads.length && c > (heads[k] + heads[k + 1]) / 2) k++;
    return k;
  };
  const table = [lines[hi].map((it) => it.str.trim())];
  for (const l of lines.slice(hi + 1)) {
    const row = heads.map(() => "");
    for (const it of l) row[col(it)] += it.str.trim();
    table.push(row);
  }
  return table;
}

/**
 * 入出金明細のPDFを読む。文字の入っていないPDF（スキャン）や、読める行がないときは null（AIで読む）。
 * 何ページあっても、ページごとに見出しを探して読む
 */
export async function readBankPdf(file: File, account: string): Promise<BankRow[] | null> {
  const doc = await (await openPdf(await file.arrayBuffer())).promise;
  const rows: BankRow[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const items = tc.items.flatMap((it) => ("str" in it ? [{ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }] : []));
    const table = pageToTable(items);
    const col = table && guessBankColumns(table);
    if (!table || !col) continue;
    // ページの中の順のまま（残高のつながりを確かめるため、並べ替えは最後に）
    rows.push(...readBankRows(table, col, account, false));
  }
  return rows.length ? rows : null;
}
