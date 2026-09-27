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
  /** 契約内容（例：通常価格から10%引き） */
  contract: string;
  /** いつもの支払方法（会計で顧客を選ぶと、この支払方法になる） */
  payment: "cash" | "credit" | "";
  memo: string;
  /** いちご狩りの単価（税込・円）。入れていない区分は使わない */
  prices: Partial<Record<CustomerPriceKey, number>>;
  /** 取引をやめた顧客は外す（会計で選べなくなる） */
  active: boolean;
};

export function emptyCustomer(id: string): Customer {
  return { id, name: "", kana: "", phone: "", address: "", contract: "", payment: "", memo: "", prices: {}, active: true };
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

/** 顧客のCSVを読み取る（見出しの名前で列を探す。1列目に名前がある表にも対応） */
export function parseCustomerCsv(rows: string[][], parseAmount: (v: string) => number | null) {
  const h = rows.findIndex((r) => r.some((c) => /大人|小学生|幼児/.test(c)));
  if (h < 0) return { items: [] as Omit<Customer, "id">[], error: "「大人」「小学生」「幼児」の見出しがある表を選んでください" };
  const header = rows[h].map((c) => c.trim());
  const find = (test: (c: string) => boolean) => header.findIndex(test);
  let nameCol = find((c) => /名前|顧客|団体名|会社名|取引先/.test(c) && !/契約/.test(c));
  if (nameCol < 0) nameCol = header.findIndex((c) => c === "");
  if (nameCol < 0) nameCol = 0;
  const cols = {
    contract: find((c) => /契約|内容/.test(c)),
    adult: find((c) => c.includes("大人")),
    child: find((c) => c.includes("小学生")),
    infant: find((c) => c.includes("幼児")),
    payment: find((c) => c.includes("支払")),
    phone: find((c) => c.includes("電話")),
    address: find((c) => c.includes("住所")),
    kana: find((c) => /ふりがな|フリガナ|かな/.test(c)),
    memo: find((c) => /メモ|備考/.test(c)),
  };
  const items: Omit<Customer, "id">[] = [];
  for (const r of rows.slice(h + 1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const name = get(nameCol);
    if (!name) continue;
    const prices: Customer["prices"] = {};
    for (const k of ["adult", "child", "infant"] as const) {
      const v = parseAmount(get(cols[k]));
      if (v !== null && v >= 0) prices[k] = v;
    }
    const pay = get(cols.payment);
    items.push({
      name: name.slice(0, 100),
      kana: get(cols.kana).slice(0, 100),
      phone: get(cols.phone).slice(0, 30),
      address: get(cols.address).slice(0, 200),
      contract: get(cols.contract).slice(0, 200),
      payment: pay.includes("売掛") ? "credit" : pay.includes("現金") ? "cash" : "",
      memo: get(cols.memo).slice(0, 500),
      prices,
      active: true,
    });
  }
  if (items.length === 0) return { items, error: "取り込める顧客がありません" };
  return { items: items.slice(0, 500) };
}

/** 検索（名前・ふりがな・電話） */
export function matchCustomer(c: Customer, q: string): boolean {
  const s = q.trim();
  if (!s) return true;
  return c.name.includes(s) || c.kana.includes(s) || c.phone.replace(/-/g, "").includes(s.replace(/-/g, ""));
}
