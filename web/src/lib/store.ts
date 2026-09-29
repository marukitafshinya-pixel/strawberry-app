"use client";

// 店舗実績（直売・カフェ・いちご狩りの売上と客数）。1日1件、storeDaily/{YYYY-MM-DD} に保存する
import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

/** 集計項目（表の並び順）。label は Excel の「日別実績」の見出しに合わせて探す */
export const STORE_ITEMS = [
  { key: "direct", label: "直売売上", unit: "円", excel: "直売売上" },
  { key: "directCustomers", label: "客数（直売）", unit: "人", excel: "客数", after: "direct" },
  { key: "cafe", label: "カフェ売上", unit: "円", excel: "カフェ" },
  { key: "cafeCustomers", label: "客数（カフェ）", unit: "人", excel: "客数", after: "cafe" },
  { key: "ichigo", label: "いちご狩り売上", unit: "円", excel: "いちご狩り" },
  { key: "ichigoCustomers", label: "客数（いちご狩り）", unit: "人", excel: "客数", after: "ichigo" },
  { key: "total", label: "売上合計", unit: "円", excel: "売上合計" },
  { key: "totalCustomers", label: "客数（合計）", unit: "人", excel: "客数", after: "total" },
  { key: "discount", label: "値引額", unit: "円", excel: "割引額" },
] as const;

export type StoreKey = (typeof STORE_ITEMS)[number]["key"];
export type StoreDay = Partial<Record<StoreKey, number>>;
/** エアレジから取り込んだ項目（エアレジの数字を優先し、Excelでは上書きしない） */
export const AIRREGI_KEYS: StoreKey[] = ["total", "totalCustomers", "discount"];
export const STORE_KEYS = STORE_ITEMS.map((i) => i.key) as StoreKey[];

/** 期間内の店舗実績（日付 → 項目ごとの数字） */
export function useStoreDays(from: string, to: string) {
  const key = `${from}_${to}`;
  const [state, setState] = useState<{ key: string; data: Record<string, StoreDay> } | null>(null);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(query(collection(db, "storeDaily"), where(documentId(), ">=", from), where(documentId(), "<=", to)), (snap) =>
        setState({
          key,
          data: Object.fromEntries(
            snap.docs.map((d) => [d.id, Object.fromEntries(STORE_KEYS.filter((k) => typeof d.get(k) === "number").map((k) => [k, d.get(k) as number])) as StoreDay]),
          ),
        }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [from, to, key]);
  return state && state.key === key ? state.data : null;
}

/**
 * Excel の「日別実績」シートから店舗実績を読む。
 *   B列（2列目）の見出し「売上合計」「客数」「割引額」「直売売上」「客数」「カフェ」「客数」「いちご狩り」「客数」
 *   各売上のすぐ下の「客数」を、その売上の客数として読む。
 *   日付は、シートの上の「6月」「7月」…の列から順に1日、2日…と数える。
 *   前年の表（A列に「R7」などとある行から下）は読まない。
 */
export function parseStoreSheet(table: string[][], year: number) {
  const cell = (r: number, c: number) => (table[r]?.[c] ?? "").trim();
  const monthOf = (s: string) => {
    const m = s.match(/^(\d{1,2})\s*月$/);
    return m ? Number(m[1]) : 0;
  };
  // 月の見出しの行（「6月」などが2つ以上ある最初の行）
  let monthRow = -1;
  for (let r = 0; r < Math.min(table.length, 40); r++) {
    if ((table[r] ?? []).filter((c) => monthOf((c ?? "").trim())).length >= 2) {
      monthRow = r;
      break;
    }
  }
  if (monthRow < 0) return { error: "「6月」「7月」の見出しの行が見つかりません" };
  const starts: { col: number; month: number }[] = [];
  (table[monthRow] ?? []).forEach((c, i) => {
    const m = monthOf((c ?? "").trim());
    if (m) starts.push({ col: i, month: m });
  });
  const width = Math.max(...table.map((r) => r?.length ?? 0));
  const colDate = new Map<number, string>();
  starts.forEach(({ col, month }, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].col : width;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let c = col; c < end && c - col < last; c++) colDate.set(c, `${year}-${String(month).padStart(2, "0")}-${String(c - col + 1).padStart(2, "0")}`);
  });

  // 項目の行を探す（今年の表だけ。A列に別の年の印が出たらそこで終わり）
  const rowOf: Partial<Record<StoreKey, number>> = {};
  for (let r = monthRow + 1; r < table.length; r++) {
    const a = cell(r, 0);
    if (a && /^R\d+$|^20\d\d$|前年/.test(a) && Object.keys(rowOf).length > 0) break;
    const b = cell(r, 1).replace(/\s/g, "");
    for (const it of STORE_ITEMS) {
      if (rowOf[it.key] !== undefined) continue;
      if ("after" in it) {
        const base = rowOf[it.after];
        if (base !== undefined && r === base + 1 && b === it.excel) rowOf[it.key] = r;
      } else if (b === it.excel) rowOf[it.key] = r;
    }
  }
  const found = STORE_ITEMS.filter((it) => rowOf[it.key] !== undefined);
  if (found.length === 0) return { error: "「直売売上」「カフェ」「いちご狩り」などの行が見つかりません" };

  const days: Record<string, StoreDay> = {};
  for (const it of found) {
    const r = rowOf[it.key]!;
    for (const [c, d] of colDate) {
      const raw = cell(r, c).replace(/[,¥円]/g, "");
      const v = Number(raw);
      if (!raw || !Number.isFinite(v) || v < 0) continue;
      // 0 は「入力なし」と同じにする（Excel の空の日の0を取り込まない）
      if (v === 0) continue;
      (days[d] ??= {})[it.key] = Math.round(v);
    }
  }
  const dates = Object.keys(days).sort();
  return {
    error: "",
    days,
    found: found.map((it) => it.label),
    missing: STORE_ITEMS.filter((it) => rowOf[it.key] === undefined).map((it) => it.label),
    from: dates[0] ?? "",
    to: dates[dates.length - 1] ?? "",
  };
}

/**
 * エアレジの「日別」売上CSV（集計期間,売上,会計数,会計単価,客数,客単価,商品数,…,割引額）を読む。
 * 入るのは 売上合計・客数（合計）・値引額 だけ（直売・カフェ・いちご狩りの分けはこのCSVにない）。
 * 割引額はマイナスで書かれているので、プラスにして値引額にする。
 */
export function parseAirregiDailyCsv(rows: string[][]): { days: Record<string, StoreDay>; error: string } {
  const head = (rows[0] ?? []).map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const cDate = col("集計期間");
  const cSales = col("売上");
  const cCust = col("客数");
  const cDisc = col("割引額");
  if (cDate < 0 || cSales < 0) return { days: {}, error: "エアレジの日別売上のCSV（「集計期間」「売上」の列があるもの）ではないようです" };
  const days: Record<string, StoreDay> = {};
  for (const r of rows.slice(1)) {
    const d = (r[cDate] ?? "").trim().replace(/[/-]/g, "");
    if (!/^\d{8}$/.test(d)) continue;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const n = (c: number) => (c >= 0 && (r[c] ?? "").trim() !== "" ? Number((r[c] ?? "").replace(/[,¥円]/g, "")) : NaN);
    const day: StoreDay = {};
    const sales = n(cSales);
    const cust = n(cCust);
    const disc = n(cDisc);
    if (Number.isFinite(sales) && sales > 0) day.total = Math.round(sales);
    if (Number.isFinite(cust) && cust > 0) day.totalCustomers = Math.round(cust);
    if (Number.isFinite(disc) && disc !== 0) day.discount = Math.abs(Math.round(disc));
    if (Object.keys(day).length > 0) days[date] = day;
  }
  return { days, error: Object.keys(days).length === 0 ? "取り込める日がありませんでした" : "" };
}
