"use client";

// 去年の商品別の実績（AirレジのCSV「商品別売上」から取り込む）
// 商品の登録や、今年の売れ行きと比べるときの目安に使う。個人情報は入っていない。
import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { parseAmount } from "./csv";
import { getFirebase } from "./firebase";
import type { TaxRate } from "./settings";

export type ItemRef = {
  name: string;
  /** Airレジのカテゴリー（未設定なら空） */
  category: string;
  /** 売上（税込・円） */
  amount: number;
  /** 販売数 */
  qty: number;
};

export type ItemRefDoc = { id: string; from: string; to: string; items: ItemRef[] };

/** いちご狩りの料金はプランで扱うので、商品には追加しない */
export const PLAN_CATEGORY_NAMES = ["いちご狩り"];

/** 商品別CSVを読み取る（見出しの名前で列を探す） */
export function parseItemCsv(rows: string[][]): { items: ItemRef[]; error?: string } {
  const header = (rows[0] ?? []).map((h) => h.trim());
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const nameCol = find("商品名");
  const catCol = find("カテゴリー", "カテゴリ");
  const amountCol = find("販売総売上", "売上", "売上合計");
  const qtyCol = find("販売商品数", "数量", "販売数");
  if (nameCol < 0 || amountCol < 0 || qtyCol < 0) return { items: [], error: "「商品名」「販売総売上」「販売商品数」の列が見つかりません。Airレジの「商品別」のCSVを選んでください" };
  const items: ItemRef[] = [];
  for (const r of rows.slice(1)) {
    const name = (r[nameCol] ?? "").trim().replace(/[\s　]+$/, "");
    if (!name) continue;
    const category = catCol >= 0 ? (r[catCol] ?? "").trim() : "";
    items.push({
      name: name.slice(0, 50),
      category: category === "未設定" ? "" : category.slice(0, 20),
      amount: parseAmount(r[amountCol] ?? "") ?? 0,
      qty: parseAmount(r[qtyCol] ?? "") ?? 0,
    });
  }
  if (items.length === 0) return { items: [], error: "取り込める行がありません" };
  return { items: items.slice(0, 500) };
}

/** ファイル名の「20250601-20251130」から期間を読む */
export function periodFromFileName(name: string): { from: string; to: string } | null {
  const m = name.match(/(\d{4})(\d{2})(\d{2})\D{0,3}(\d{4})(\d{2})(\d{2})/);
  return m ? { from: `${m[1]}-${m[2]}-${m[3]}`, to: `${m[4]}-${m[5]}-${m[6]}` } : null;
}

/** 目安の値段：売上 ÷ 販売数 を10円単位に丸める（割引の分だけ実際の値段より少し安く出る） */
export function suggestPrice(r: ItemRef): number {
  return r.qty > 0 ? Math.round(r.amount / r.qty / 10) * 10 : 0;
}

/** 目安の税率：雑貨・送料・保冷剤は10%、それ以外（食べ物・飲み物）は8% */
export function suggestTax(name: string): TaxRate {
  return /雑貨|送料|保冷剤|箱|バック|バッグ/.test(name) ? 10 : 8;
}

export function useItemRefs() {
  const [list, setList] = useState<ItemRefDoc[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, "itemReferences"),
        (snap) =>
          setList(
            snap.docs
              .map((d) => ({ id: d.id, ...(d.data() as Omit<ItemRefDoc, "id">) }))
              .sort((a, b) => b.to.localeCompare(a.to)),
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
