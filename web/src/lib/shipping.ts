"use client";

// いちごの出荷実績
import { collection, doc, documentId, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";
import { newId } from "./settings";

/** 出荷の規格（例：秀 20粒入り） */
export type Grade = {
  id: string;
  /** 区分（例：粒売り・秀・A） */
  group: string;
  name: string;
  /** 1パックの粒数（粒売りは1） */
  count: number;
  /** 1粒の重さの範囲（例："16-22"） */
  gRange: string;
  /** 1粒の平均の重さ（g） */
  avgG: number;
};

export type ShippingConfig = { destination: string; grades: Grade[] };

/** 日ごとの出荷：規格ID → 数量（パック・粒）と単価（円） */
export type DayItems = Record<string, { qty?: number; price?: number }>;

/** 出荷単位の重さ（g）＝ 粒数 × 1粒の平均 */
export const unitWeight = (g: Grade) => Math.round(g.count * g.avgG * 10) / 10;

/** はじめに入れておく規格（いただいた出荷実績の表と同じ） */
export function defaultGrades(): Grade[] {
  const g = (group: string, name: string, count: number, gRange: string, avgG: number): Grade => ({ id: newId(), group, name, count, gRange, avgG });
  return [
    g("粒売り", "プレミアム", 1, "40-50", 45),
    g("粒売り", "ロイヤル", 1, "30-40", 35),
    g("秀", "8粒", 8, "25-30", 27),
    g("秀", "16粒", 16, "22-25", 23.5),
    g("秀", "20粒入り", 20, "16-22", 19.5),
    g("秀", "24粒入り", 24, "13-16", 14.5),
    g("秀", "30粒入り", 30, "10-13", 12.5),
    g("秀", "35粒入り", 35, "8-10", 9),
    g("A", "16粒", 16, "22-25", 23.5),
    g("A", "20粒入り", 20, "16-22", 19.5),
    g("A", "24粒入り", 24, "13-16", 14.5),
    g("A", "30粒入り", 30, "10-13", 12.5),
  ];
}

export function useShippingConfig() {
  const [value, setValue] = useState<ShippingConfig | null>(null);
  const [exists, setExists] = useState(true);
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(doc(db, "shipping/config"), (s) => {
        setExists(s.exists());
        const d = s.data() as Partial<ShippingConfig> | undefined;
        setValue({ destination: d?.destination ?? "", grades: d?.grades ?? defaultGrades() });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return { value, exists };
}

/** 期間内の出荷（日付 → 規格ごとの数量・単価） */
export function useShipments(from: string, to: string) {
  const [state, setState] = useState<{ key: string; data: Record<string, DayItems> } | null>(null);
  const key = `${from}_${to}`;
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(query(collection(db, "shipments"), where(documentId(), ">=", from), where(documentId(), "<=", to)), (snap) =>
        setState({ key, data: Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("items") as DayItems) ?? {}])) }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [from, to, key]);
  return state && state.key === key ? state.data : null;
}

/** 規格ごとの集計（数量・重さ・金額・平均単価・1粒単価）。単価が入っていない日の数量は別に数える */
export function summarize(grades: Grade[], days: Record<string, DayItems>) {
  return grades.map((g) => {
    let qty = 0;
    let amount = 0;
    let unpriced = 0;
    for (const items of Object.values(days)) {
      const it = items[g.id];
      if (!it?.qty) continue;
      qty += it.qty;
      if (it.price === undefined) unpriced += it.qty;
      else amount += it.qty * it.price;
    }
    const priced = qty - unpriced;
    const avgPrice = priced > 0 ? Math.round(amount / priced) : null;
    return {
      grade: g,
      qty,
      weightKg: Math.round((qty * unitWeight(g)) / 100) / 10,
      amount,
      unpriced,
      avgPrice,
      perBerry: avgPrice !== null ? Math.round(avgPrice / g.count) : null,
    };
  });
}

/**
 * 単価表（Excel）の読み取り。いただいた表と同じ形：
 *   1行目に「6月」「7月」…、2行目に日（1〜31）、3行目から A列=区分・B列=規格、各日の列に単価
 * 区分や規格名は少し違っても（「粒」と「粒売り」、「プレミアム20」と「プレミアム」）同じものとして扱う。
 */
export function parsePriceTable(table: string[][], grades: Grade[], year: number) {
  const isDay = (s: string) => /^\d{1,2}$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 31;
  // 日の行：1〜31の数字がいちばん多い行
  let dayRow = -1;
  let best = 0;
  table.slice(0, 10).forEach((r, i) => {
    const n = (r ?? []).filter((c) => isDay(c ?? "")).length;
    if (n > best) {
      best = n;
      dayRow = i;
    }
  });
  if (dayRow < 1 || best < 5) return { error: "「6月」「7月」の行と、日（1〜31）の行が見つかりません" as string };
  const monthRow = table[dayRow - 1] ?? [];
  const days = table[dayRow];
  // 列 → 日付
  const colDate = new Map<number, string>();
  let month = 0;
  for (let c = 0; c < days.length; c++) {
    const m = (monthRow[c] ?? "").match(/(\d{1,2})\s*月/);
    if (m) month = Number(m[1]);
    if (!month || !isDay(days[c] ?? "")) continue;
    const d = `${year}-${String(month).padStart(2, "0")}-${String(Number(days[c])).padStart(2, "0")}`;
    if (!Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) colDate.set(c, d);
  }
  const firstDayCol = Math.min(...colDate.keys());

  const norm = (s: string) => s.replace(/\s/g, "").normalize("NFKC");
  const like = (a: string, b: string) => a === b || (a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a)));
  const findGrade = (group: string, name: string) => {
    const inGroup = grades.filter((g) => like(norm(g.group), group));
    return inGroup.find((g) => norm(g.name) === name) ?? inGroup.find((g) => like(norm(g.name), name));
  };

  const prices: Record<string, Record<string, number>> = {};
  const matched: { grade: Grade; label: string; cells: number }[] = [];
  const unmatched: string[] = [];
  let group = "";
  for (const r of table.slice(dayRow + 1)) {
    if (!r) continue;
    if ((r[0] ?? "").trim()) group = norm(r[0]);
    const name = norm(r[1] ?? "");
    if (!name) continue;
    const label = `${group} ${name}`;
    const g = findGrade(group, name);
    if (!g || matched.some((m) => m.grade.id === g.id)) {
      unmatched.push(label);
      continue;
    }
    let cells = 0;
    for (const [c, d] of colDate) {
      if (c < firstDayCol) continue;
      const v = Number((r[c] ?? "").replace(/[,¥円]/g, ""));
      if (!(r[c] ?? "").trim() || !Number.isFinite(v) || v < 0) continue;
      (prices[d] ??= {})[g.id] = Math.round(v);
      cells++;
    }
    matched.push({ grade: g, label, cells });
  }
  const dates = Object.keys(prices).sort();
  return { prices, matched, unmatched, from: dates[0] ?? "", to: dates[dates.length - 1] ?? "", error: "" };
}
