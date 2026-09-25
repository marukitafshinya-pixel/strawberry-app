"use client";

// 給与（管理者だけが使う）
import { collection, doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
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
