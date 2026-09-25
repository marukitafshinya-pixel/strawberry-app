"use client";

// 給与（管理者だけが使う）
import { collection, doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { parseAmount } from "./csv";
import { getFirebase } from "./firebase";

export type Employee = {
  id: string;
  /** 社員番号 */
  code: string;
  name: string;
  /** 振込 or 現金 */
  payMethod: "transfer" | "cash";
  bankName: string;
  branchName: string;
  accountType: "普通" | "当座";
  accountNumber: string;
  /** 給与の表に出すか（退職した人は外す） */
  active: boolean;
};

/** 給与の打ち込み項目（PDFの給与集計表と同じ並び） */
export const PAY_ITEMS = [
  { key: "monthly", label: "基本給（月給）", group: "pay" },
  { key: "hourly", label: "基本給（時給）", group: "pay" },
  { key: "officer", label: "役員報酬", group: "pay" },
  { key: "commute", label: "非課税通勤費", group: "pay" },
  { key: "health", label: "健康保険料", group: "social" },
  { key: "care", label: "介護保険料", group: "social" },
  { key: "pension", label: "厚生年金保険料", group: "social" },
  { key: "employment", label: "雇用保険料", group: "social" },
  { key: "socialAdj", label: "社会保険料調整", group: "social", signed: true },
  { key: "incomeTax", label: "所得税", group: "tax" },
  { key: "residentTax", label: "住民税", group: "tax" },
  { key: "yearEnd", label: "年末調整", group: "tax", signed: true, note: "還付はプラス、徴収はマイナス" },
] as const;

export type PayKey = (typeof PAY_ITEMS)[number]["key"];
export type PayRow = Partial<Record<PayKey, number>>;

/** 事業所負担分 */
export const EMPLOYER_ITEMS = [
  { key: "health", label: "健康保険料" },
  { key: "care", label: "介護保険料" },
  { key: "pension", label: "厚生年金保険料" },
  { key: "employment", label: "雇用保険料" },
  { key: "childAllowance", label: "児童手当拠出金" },
] as const;
export type EmployerKey = (typeof EMPLOYER_ITEMS)[number]["key"];

export type Payroll = {
  /** 振込日（支給日） */
  paymentDate: string;
  rows: Record<string, PayRow>;
  employer: Partial<Record<EmployerKey, number>>;
  memo: string;
};

const v = (r: PayRow, k: PayKey) => r[k] ?? 0;

/** 1人分の合計（支給合計・社会保険料計・差引支給額） */
export function computeRow(r: PayRow) {
  const pay = v(r, "monthly") + v(r, "hourly") + v(r, "officer") + v(r, "commute");
  const social = v(r, "health") + v(r, "care") + v(r, "pension") + v(r, "employment") + v(r, "socialAdj");
  const net = pay - social - v(r, "incomeTax") - v(r, "residentTax") + v(r, "yearEnd");
  return { pay, social, net };
}

export function emptyPayroll(): Payroll {
  return { paymentDate: "", rows: {}, employer: {}, memo: "" };
}

/** 和暦（令和）の年 */
export function reiwa(year: number): string {
  return year >= 2019 ? `令和${year - 2018}年` : `${year}年`;
}

export function useEmployees() {
  const [list, setList] = useState<Employee[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, "employees"),
        (snap) =>
          setList(
            snap.docs
              .map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))
              .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true })),
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

export function usePayroll(month: string) {
  // 読み込んだデータに月を付けておき、表示中の月と一致するときだけ使う
  // （月を切り替えた直後に、前の月の金額を別の月として保存してしまわないように）
  const [state, setState] = useState<{ month: string; payroll: Payroll } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, `payrolls/${month}`),
        (s) => setState({ month, payroll: s.exists() ? { ...emptyPayroll(), ...(s.data() as Partial<Payroll>) } : emptyPayroll() }),
        setError,
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [month]);
  return { value: state && state.month === month ? state.payroll : null, error };
}

/** CSVから読み取った1人分 */
export type PayrollCsvEntry = {
  code: string;
  name: string;
  row: PayRow;
  /** 支払方法・振込先（CSVに列があるときだけ） */
  bank?: Pick<Employee, "payMethod" | "bankName" | "branchName" | "accountType" | "accountNumber">;
};

/**
 * 給与のCSV（この画面の「CSVで書き出す」と同じ形）を読み取る。
 * 見出しの名前で列を探すので、列の順番が違っても、無い列があっても読める。
 */
export function parsePayrollCsv(rows: string[][]): { entries: PayrollCsvEntry[]; error?: string } {
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (label: string) => header.indexOf(label);
  const codeCol = col("社員番号");
  const nameCol = col("氏名");
  if (codeCol < 0 || nameCol < 0) return { entries: [], error: "1行目に「社員番号」と「氏名」の見出しがありません" };
  const items = PAY_ITEMS.map((it) => ({ key: it.key, i: col(it.label) })).filter((x) => x.i >= 0);
  if (items.length === 0) return { entries: [], error: "金額の列（基本給（月給）など）が見つかりません" };
  const bankCols = { method: col("支払方法"), bank: col("銀行名"), branch: col("支店名"), type: col("種別"), account: col("口座番号") };

  const entries: PayrollCsvEntry[] = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const code = get(codeCol);
    const name = get(nameCol).replace(/\s+/g, " ");
    if (name === "合計" || (!code && !name)) continue;
    if (!code) return { entries: [], error: `${n + 2}行目：社員番号がありません` };
    const row: PayRow = {};
    for (const { key, i } of items) {
      const text = get(i);
      if (text === "") continue;
      const v = parseAmount(text);
      if (v === null) return { entries: [], error: `${n + 2}行目（${name}）：「${text}」を金額として読めません` };
      if (v !== 0) row[key] = v;
    }
    const entry: PayrollCsvEntry = { code, name, row };
    if (bankCols.method >= 0) {
      entry.bank = {
        payMethod: get(bankCols.method) === "現金" ? "cash" : "transfer",
        bankName: get(bankCols.bank),
        branchName: get(bankCols.branch),
        accountType: get(bankCols.type) === "当座" ? "当座" : "普通",
        accountNumber: get(bankCols.account).replace(/[^0-9-]/g, ""),
      };
    }
    entries.push(entry);
  }
  if (entries.length === 0) return { entries: [], error: "取り込める行がありません" };
  const codes = entries.map((e) => e.code);
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup) return { entries: [], error: `社員番号 ${dup} が2回出てきます` };
  return { entries };
}
