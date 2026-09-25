"use client";

import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { DEFAULT_PLAN_TAX, DEFAULT_PRODUCT_TAX, type Settings, type TaxRate } from "./settings";

export type PaymentMethod = "cash" | "credit";
export const PAYMENT_LABEL: Record<PaymentMethod, string> = { cash: "現金", credit: "売掛" };

export type SaleLine = {
  kind: "plan" | "product" | "custom";
  refId: string;
  name: string;
  category: string;
  unitPrice: number;
  qty: number;
  discountRate: number;
  amount: number;
  /** 消費税率。この項目ができる前の会計には無い */
  taxRate?: TaxRate;
};

/** 明細の税率。古い会計（税率を記録していない）は、今の設定から決める */
export function lineTaxRate(l: SaleLine, s: Settings): TaxRate {
  if (l.taxRate === 8 || l.taxRate === 10) return l.taxRate;
  if (l.kind === "product") return s.products.find((p) => p.id === l.refId)?.taxRate ?? DEFAULT_PRODUCT_TAX;
  if (l.kind === "plan") return s.plans.find((p) => p.id === l.refId)?.taxRate ?? DEFAULT_PLAN_TAX;
  return 10;
}

/**
 * 税率ごとの合計（税込）と消費税額。
 * インボイスのルールどおり、消費税額は税率ごとに1回だけ計算して1円未満を切り捨てる。
 */
export function taxBreakdown(lines: SaleLine[], s: Settings) {
  return ([10, 8] as TaxRate[])
    .map((rate) => {
      const total = lines.filter((l) => lineTaxRate(l, s) === rate).reduce((n, l) => n + l.amount, 0);
      return { rate, total, tax: Math.floor((total * rate) / (100 + rate)) };
    })
    .filter((x) => x.total > 0);
}

export type Sale = {
  id: string;
  date: string;
  reservationId: string | null;
  customerName: string;
  lines: SaleLine[];
  subtotal: number;
  discountTotal: number;
  total: number;
  payment: PaymentMethod;
  status: "completed" | "voided";
  receivableId: string | null;
  memo: string;
  createdAt?: { toDate: () => Date };
  voidReason?: string;
};

export type Receivable = {
  id: string;
  customerName: string;
  amount: number;
  date: string;
  dueDate: string | null;
  status: "open" | "collected";
  source: "sale" | "manual";
  saleId: string | null;
  memo: string;
  collectedDate?: string;
};

/** 明細の金額（割引は1円未満切り捨て）。サーバー側と同じ計算 */
export function lineAmount(unitPrice: number, qty: number, discountRate: number): number {
  return Math.floor((unitPrice * qty * (100 - discountRate)) / 100);
}

function useQuery<T>(make: (db: import("firebase/firestore").Firestore) => import("firebase/firestore").Query | null, deps: unknown[]) {
  const [value, setValue] = useState<T[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      const q = make(db);
      if (cancelled || !q) return;
      unsubscribe = onSnapshot(
        q,
        (snap) => setValue(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T)),
        (e) => setError(e),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error };
}

/** 期間内の会計（取消も含む） */
export function useSales(from: string, to: string) {
  return useQuery<Sale>((db) => query(collection(db, "sales"), where("date", ">=", from), where("date", "<=", to)), [from, to]);
}

/** 売掛（状態で絞り込み。null ならすべて） */
export function useReceivables(status: "open" | "collected" | null) {
  return useQuery<Receivable>(
    (db) => (status ? query(collection(db, "receivables"), where("status", "==", status)) : query(collection(db, "receivables"))),
    [status],
  );
}

/** 取り込んだ過去売上（日付 → 金額） */
export function useImportedSales(from: string, to: string) {
  return useQuery<{ id: string; amount: number }>(
    (db) => query(collection(db, "importedSales"), where(documentId(), ">=", from), where(documentId(), "<=", to)),
    [from, to],
  );
}

/** 分類ごとの売上（値引き後）を集計する */
export function byCategory(sales: Sale[]): { category: string; amount: number }[] {
  const m = new Map<string, number>();
  for (const s of sales) {
    if (s.status !== "completed") continue;
    for (const l of s.lines) m.set(l.category, (m.get(l.category) ?? 0) + l.amount);
  }
  return [...m.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}

