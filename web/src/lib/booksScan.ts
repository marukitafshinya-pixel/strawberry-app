"use client";

// 帳簿：総勘定元帳のスキャン・写真と、レシート・請求書を、AIで読み取る（サーバーの readBooksPage）。
// 元帳は「経費の仕分け」（lib/ledger.ts）と同じ読み方で、文字入りPDFと同じ LedgerFile にする。
// レシート・請求書は、税率ごとに1行の仕訳（借方＝空＝未仕分け、貸方＝払った科目）にする
import { callFunction } from "./callFunction";
import type { JournalEntry } from "./books";
import { checkLedger, combineLedger, ledgerFilesToPages, ledgerPageUpload, type LedgerPageResult } from "./ledger";
import { mergeTaxRows, type LedgerFile } from "./ledgerPdf";
import { filesToPages, pageToUpload } from "./shikiri";

type Progress = (done: number, total: number) => void;

/** 文字の入っていないPDF・写真・TIFFの総勘定元帳を、1ページずつAIで読む */
export async function scanLedgerFiles(files: File[], progress: Progress): Promise<(LedgerFile & { fileName: string })[]> {
  const pages = await ledgerFilesToPages(files);
  const results: (LedgerPageResult | null)[] = [];
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length);
    try {
      const r = await callFunction<{ kind: string; file: unknown }, { result: LedgerPageResult }>("readBooksPage", { kind: "ledger", file: ledgerPageUpload(pages[i]) }, 300_000);
      results.push(r.result);
    } catch {
      results.push(null);
    }
  }
  progress(pages.length, pages.length);
  const failed = results.filter((r) => !r).length;
  return combineLedger(results).map((a) => {
    const problems = checkLedger(a)
      .filter((c) => !c.ok)
      .map((c) => `${c.label}：読んだ ${c.read.toLocaleString("ja-JP")} ／ 元帳 ${c.expected.toLocaleString("ja-JP")}`);
    if (!a.grandTotal) problems.push("総合計の行が読めていません（途中のページだけかもしれません）");
    if (failed) problems.push(`${failed}ページが読めませんでした`);
    // 消費税の行（isTax）は、すぐ前の同じ品名の行に足す（文字入りPDFと同じ）
    const rows = a.entries.map((e) => ({
      no: e.no,
      date: e.date,
      counter: e.sub ? `${e.counter}／${e.sub}` : e.counter,
      item: e.item,
      partner: e.isTax ? "消費税" : e.partner,
      amount: e.debit - e.credit,
      taxRate: /(\d+)/.test(e.taxRate) ? Number(e.taxRate.match(/(\d+)/)![1]) : 0,
    }));
    return {
      code: a.code,
      name: a.name,
      rows: mergeTaxRows(rows),
      total: a.grandTotal ? a.grandTotal.debit - a.grandTotal.credit : null,
      problems,
      fileName: files.map((f) => f.name).join("・"),
    };
  });
}

/** AIが1枚のレシート・請求書から読んだもの */
type Rate = "10%" | "8%" | "0%";
export type ReceiptResult = {
  date: string;
  partner: string;
  items: string;
  byRate: { rate: Rate; amount: number }[];
  total: number;
  /** 明細の1行ずつ（金額は linesExcludeTax なら税抜き） */
  lines?: { date: string; item: string; rate: Rate; amount: number }[];
  linesExcludeTax?: boolean;
  notes: string;
};
export type Receipt = ReceiptResult & { fileName: string; problems: string[] };

/** レシート・請求書（写真・PDF。1枚1ページ）を読む */
export async function scanReceipts(files: File[], progress: Progress): Promise<Receipt[]> {
  const pages = await filesToPages(files);
  const out: Receipt[] = [];
  for (let i = 0; i < pages.length; i++) {
    progress(i, pages.length);
    try {
      const r = (await callFunction<{ kind: string; file: unknown }, { result: ReceiptResult }>("readBooksPage", { kind: "receipt", file: pageToUpload(pages[i]) }, 300_000)).result;
      const problems: string[] = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) problems.push("日付が読めません");
      const sum = r.byRate.reduce((n, x) => n + x.amount, 0);
      if (sum !== r.total) problems.push(`税率ごとの合計 ${sum.toLocaleString("ja-JP")} が合計 ${r.total.toLocaleString("ja-JP")} と合いません`);
      if (r.lines?.length && !receiptLines(r)) problems.push("明細の合計が合計と合わないので、税率ごとに1行で入れます");
      if (r.notes) problems.push(r.notes);
      out.push({ ...r, fileName: pages[i].name, problems });
    } catch (e) {
      out.push({ date: "", partner: "", items: "", byRate: [], total: 0, notes: "", fileName: pages[i].name, problems: [e instanceof Error ? e.message : "読めませんでした"] });
    }
  }
  progress(pages.length, pages.length);
  return out;
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * 明細の1行ずつを、税込みの金額にする。税抜きの明細は行ごとに税をたし、端数のずれは税率ごとのいちばん大きい行で合わせる
 * （税率ごとの合計が、レシート・請求書の税込みの金額と同じになるように）。合計が大きく合わないときは null
 */
export function receiptLines(r: ReceiptResult): { date: string; item: string; rate: Rate; amount: number }[] | null {
  const lines = (r.lines ?? []).filter((l) => l.amount);
  if (!lines.length) return null;
  const out = lines.map((l) => ({
    date: isDate(l.date) ? l.date : r.date,
    item: l.item,
    rate: l.rate,
    amount: r.linesExcludeTax ? Math.round((l.amount * (100 + Number(l.rate.replace("%", "")))) / 100) : l.amount,
  }));
  for (const rate of new Set(out.map((l) => l.rate))) {
    const group = out.filter((l) => l.rate === rate);
    const target = r.byRate.find((x) => x.rate === rate)?.amount;
    if (target === undefined) return null;
    const diff = target - group.reduce((n, l) => n + l.amount, 0);
    if (Math.abs(diff) > Math.max(10, group.length)) return null;
    group.reduce((m, l) => (Math.abs(l.amount) > Math.abs(m.amount) ? l : m)).amount += diff;
  }
  // 明細にない税率（合計だけ書いてある）があれば、合わない
  if (r.byRate.some((x) => x.amount && !out.some((l) => l.rate === x.rate))) return null;
  return out;
}

/**
 * レシート・請求書を仕訳にする：明細の1行ずつ1行（借方＝空、貸方＝払った科目）。
 * 明細が読めないとき・合わないときは、税率ごとに1行
 */
export function receiptToJournal(r: Receipt, payCode: string): JournalEntry[] {
  const lines = receiptLines(r);
  if (lines)
    return lines.map((l, i) => ({
      date: l.date,
      debit: "",
      credit: payCode,
      amount: l.amount,
      memo: l.item.slice(0, 80),
      memo2: r.partner.slice(0, 60),
      tax: Number(l.rate.replace("%", "")),
      src: "レシート・請求書",
      ref: `rcpt:${r.date}:${r.total}:${i}:${r.partner}`.slice(0, 60),
    }));
  return r.byRate
    .filter((x) => x.amount)
    .map((x) => ({
      date: r.date,
      debit: "",
      credit: payCode,
      amount: x.amount,
      memo: r.items.slice(0, 80),
      memo2: r.partner.slice(0, 60),
      tax: Number(x.rate.replace("%", "")),
      src: "レシート・請求書",
      ref: `rcpt:${r.date}:${r.partner}:${r.total}:${x.rate}`.slice(0, 60),
    }));
}
