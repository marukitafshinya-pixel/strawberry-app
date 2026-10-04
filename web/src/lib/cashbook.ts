"use client";

// 現金出納帳：月ごとに、現金の出入り（日付・項目・収入・支出・備考）を記録する。
// 繰越金は、それより前の月の出入りから自動で計算する（いちばん最初の月だけ、繰越金を手で入れる）。
import { collection, doc, onSnapshot, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import type { Workbook } from "./xlsx";

export type CashEntry = {
  /** 日付（YYYY-MM-DD）。分からないときは "" */
  date: string;
  item: string;
  income: number | null;
  expense: number | null;
  memo: string;
};
export type CashMonth = { month: string; entries: CashEntry[]; opening?: number };

export const emptyEntry = (date = ""): CashEntry => ({ date, item: "", income: null, expense: null, memo: "" });

/** 1か月分の 収入・支出 の合計（繰越金を除く） */
export function monthSums(entries: CashEntry[]) {
  const income = entries.reduce((n, e) => n + (e.income ?? 0), 0);
  const expense = entries.reduce((n, e) => n + (e.expense ?? 0), 0);
  return { income, expense };
}

/** その月の繰越金：それより前の月の（最初の繰越金＋収入−支出）を足したもの */
export function carryInto(all: CashMonth[], month: string): number {
  return all
    .filter((m) => m.month < month)
    .reduce((n, m) => {
      const s = monthSums(m.entries);
      return n + (m.opening ?? 0) + s.income - s.expense;
    }, 0);
}

/** 全部の月（古い順） */
export function useCashbook() {
  const [list, setList] = useState<CashMonth[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, "cashbook"),
        (snap) =>
          setList(
            snap.docs
              .map((d) => ({ month: d.id, entries: (d.get("entries") as CashEntry[] | undefined) ?? [], opening: d.get("opening") as number | undefined }))
              .sort((a, b) => a.month.localeCompare(b.month)),
          ),
        setError,
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return { value: list, error };
}

const clean = (e: CashEntry): CashEntry => ({
  date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : "",
  item: e.item.trim().slice(0, 80),
  income: e.income === null || !Number.isFinite(e.income) ? null : Math.round(e.income),
  expense: e.expense === null || !Number.isFinite(e.expense) ? null : Math.round(e.expense),
  memo: e.memo.trim().slice(0, 80),
});
const isBlank = (e: CashEntry) => !e.date && !e.item && e.income === null && e.expense === null && !e.memo;

export async function saveCashMonth(month: string, entries: CashEntry[], opening?: number) {
  const { db } = await getFirebase();
  const data: Record<string, unknown> = { entries: entries.map(clean).filter((e) => !isBlank(e)), updatedAt: serverTimestamp() };
  if (opening !== undefined) data.opening = Math.round(opening);
  await setDoc(doc(db, `cashbook/${month}`), data);
}

// ---------- 「項目」の候補（プルダウン） ----------

/** 保存してある候補（まだ一度も保存していなければ null） */
export function useCashItems() {
  const [items, setItems] = useState<string[] | null | undefined>(undefined);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, "config/cashbookItems"),
        (s) => setItems(s.exists() ? ((s.get("items") as string[] | undefined) ?? []).filter((x) => typeof x === "string") : null),
        () => setItems(null),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return items;
}

/** これまでに使った項目（よく使う順）。候補をまだ保存していないときの、はじめの候補 */
export function itemsFromHistory(all: CashMonth[]): string[] {
  const count = new Map<string, number>();
  for (const x of all) for (const e of x.entries) if (e.item.trim()) count.set(e.item.trim(), (count.get(e.item.trim()) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([k]) => k);
}

export async function saveCashItems(items: string[]) {
  const { db } = await getFirebase();
  const list = [...new Set(items.map((x) => x.trim().slice(0, 80)).filter(Boolean))].slice(0, 500);
  await setDoc(doc(db, "config/cashbookItems"), { items: list, updatedAt: serverTimestamp() });
}

// ---------- Excel（いままでの現金出納帳）の取り込み ----------

export type CashImportMonth = CashMonth & { sheet: string; excelClosing: number | null };

/** シート名（R8.8月、R7.3月 、～R6.５月、R6.6月～ など）から年月（YYYY-MM）を読む */
export function monthOfSheet(name: string): string | null {
  const z = name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = z.match(/R\s*(\d{1,2})\s*[.．]\s*(\d{1,2})\s*月/);
  if (!m) return null;
  const y = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

const num = (s: string | undefined): number | null => {
  const t = (s ?? "").replace(/[,，\s￥¥円]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** Excel の日付（シリアル値）→ YYYY-MM-DD */
const excelDate = (s: string | undefined): string => {
  const n = num(s);
  if (n === null || n < 20000 || n > 80000) return "";
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
};

/**
 * いままでの現金出納帳（月ごとのシート）を読む。
 * 1行目：表題、2行目：見出し（日付・項目・収入・支出・現金残高・備考）、3行目：繰越金、4行目から：明細、最後の行：合計
 * 列：A=番号 B=日付 C=項目 D=収入 E=支出 F=現金残高 G=備考
 */
export async function readCashbookExcel(wb: Workbook): Promise<CashImportMonth[]> {
  const out: CashImportMonth[] = [];
  for (const sheet of wb.sheetNames) {
    const month = monthOfSheet(sheet);
    if (!month) continue;
    const rows = await wb.readSheet(sheet);
    if (!(rows[1] ?? []).some((c) => (c ?? "").includes("項目"))) continue;
    const entries: CashEntry[] = [];
    let opening: number | undefined;
    let excelClosing: number | null = null;
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const item = (row[2] ?? "").trim();
      const income = num(row[3]);
      const expense = num(row[4]);
      const bal = num(row[5]);
      if (bal !== null) excelClosing = bal;
      if (r === 2 && item === "繰越金") {
        opening = income ?? 0;
        continue;
      }
      // 合計の行（項目がなく、43行目＝明細の後ろ）は入れない
      if (!item && r >= 42) continue;
      const e: CashEntry = { date: excelDate(row[1]), item, income, expense, memo: (row[6] ?? "").trim() };
      if (!e.item && e.income === null && e.expense === null && !e.memo) continue;
      entries.push(e);
    }
    out.push({ sheet, month, entries, opening, excelClosing });
  }
  out.sort((a, b) => a.month.localeCompare(b.month));
  // 同じ月のシートが2つあるときは、あとの方をまとめて1か月にする
  const merged: CashImportMonth[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.month === m.month) {
      last.entries.push(...m.entries);
      last.excelClosing = m.excelClosing;
      last.sheet += `・${m.sheet}`;
    } else merged.push(m);
  }
  // 繰越金は前の月から計算するので、いちばん古い月の分だけ残す
  merged.forEach((m, i) => {
    if (i > 0) delete m.opening;
  });
  return merged;
}

/** 取り込んだ月をまとめて保存する（同じ月はまるごと置き換える） */
export async function saveCashImport(months: CashImportMonth[]) {
  const { db } = await getFirebase();
  for (let i = 0; i < months.length; i += 400) {
    const batch = writeBatch(db);
    for (const m of months.slice(i, i + 400)) {
      const data: Record<string, unknown> = { entries: m.entries.map(clean).filter((e) => !isBlank(e)), updatedAt: serverTimestamp() };
      if (m.opening !== undefined) data.opening = Math.round(m.opening);
      batch.set(doc(db, `cashbook/${m.month}`), data);
    }
    await batch.commit();
  }
}
