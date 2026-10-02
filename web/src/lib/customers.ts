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
  /** 支払い条件（締め日と支払期限）。ないときは決めていない */
  terms?: PaymentTerms;
  /** いつもの支払方法（会計で顧客を選ぶと、この支払方法になる） */
  payment: "cash" | "credit" | "";
  memo: string;
  /** いちご狩りの単価（税込・円）。入れていない区分は使わない */
  prices: Partial<Record<CustomerPriceKey, number>>;
  /** この顧客だけの商品の値段（商品ID → 税込の単価）。会計でこの顧客を選ぶと、この値段になる */
  products: Record<string, number>;
  /** 取引をやめた顧客は外す（会計で選べなくなる） */
  active: boolean;
};

export function emptyCustomer(id: string): Customer {
  return { id, name: "", kana: "", phone: "", address: "", contract: "", payment: "", memo: "", prices: {}, products: {}, active: true };
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

/**
 * 支払い条件。例：月末締め・翌月末払い＝{ closing: 0, dueMonths: 1, dueDay: 0 }
 * closing：締め日（0は月末、1〜28はその日）／dueMonths：締めた月から何か月後に払うか／dueDay：支払日（0は末日）
 */
export type PaymentTerms = { closing: number; dueMonths: number; dueDay: number };

const lastDayOf = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const shift = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ym: string, d: number) => `${ym}-${pad(d === 0 ? lastDayOf(ym) : Math.min(d, lastDayOf(ym)))}`;

/** 支払い条件を文字にする（例：月末締め・翌月末払い） */
export function termsText(t?: PaymentTerms): string {
  if (!t) return "";
  const close = t.closing === 0 ? "月末締め" : `${t.closing}日締め`;
  const month = ["当月", "翌月", "翌々月", "3か月後"][t.dueMonths] ?? `${t.dueMonths}か月後`;
  return `${close}・${month}${t.dueDay === 0 ? "末" : `${t.dueDay}日`}払い`;
}

/** その月に締める請求期間（例：月末締めで2026-09なら 9/1〜9/30、20日締めなら 8/21〜9/20） */
export function billingPeriod(t: PaymentTerms | undefined, ym: string): { from: string; to: string } {
  const closing = t?.closing ?? 0;
  const to = dayOf(ym, closing);
  const prevClose = dayOf(shift(ym, -1), closing);
  const from = closing === 0 ? `${ym}-01` : nextDay(prevClose);
  return { from, to };
}

/** その日が入る請求期間の「締めの月」（例：20日締めで 9/25 なら 10月締め分） */
export function periodMonthOf(t: PaymentTerms | undefined, date: string): string {
  const ym = date.slice(0, 7);
  return date <= billingPeriod(t, ym).to ? ym : shift(ym, 1);
}

/** 支払期限（締めた日の月から dueMonths か月後の dueDay） */
export function dueDateOf(t: PaymentTerms | undefined, closedOn: string): string {
  const terms = t ?? { closing: 0, dueMonths: 1, dueDay: 0 };
  return dayOf(shift(closedOn.slice(0, 7), terms.dueMonths), terms.dueDay);
}

function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
      products: {},
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
