"use client";

// 顧客リスト（団体・取引先・常連さんなど）。スタッフだけが見られる
import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

/** 顧客ごとに決められる、いちご狩りの単価 */
export const CUSTOMER_PRICES = [
  { key: "adult", label: "大人" },
  { key: "child", label: "小学生" },
  { key: "infant", label: "幼児" },
] as const;
export type CustomerPriceKey = (typeof CUSTOMER_PRICES)[number]["key"];

export type Customer = {
  id: string;
  name: string;
  /** ふりがな（並べ替え・検索用） */
  kana: string;
  phone: string;
  address: string;
  memo: string;
  /** いちご狩りの単価（税込・円）。入れていない区分は使わない */
  prices: Partial<Record<CustomerPriceKey, number>>;
  /** 取引をやめた顧客は外す（会計で選べなくなる） */
  active: boolean;
};

export function emptyCustomer(id: string): Customer {
  return { id, name: "", kana: "", phone: "", address: "", memo: "", prices: {}, active: true };
}

export function useCustomers() {
  const [list, setList] = useState<Customer[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, "customers"),
        (snap) =>
          setList(
            snap.docs
              .map((d) => ({ ...emptyCustomer(d.id), ...(d.data() as Partial<Customer>), id: d.id }))
              .sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja")),
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

/** 検索（名前・ふりがな・電話） */
export function matchCustomer(c: Customer, q: string): boolean {
  const s = q.trim();
  if (!s) return true;
  return c.name.includes(s) || c.kana.includes(s) || c.phone.replace(/-/g, "").includes(s.replace(/-/g, ""));
}
