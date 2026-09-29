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
 * 出荷の表（Excel）の読み取り。いただいた「日別実績」の表と同じ形：
 *   「6月」「7月」…の行、その下に日（1〜31）の行、その下に A列=区分・B列=規格、各日の列に数字
 *   A列（または月の行・日の行）に「数量」とあれば数量の表、「単価」とあれば単価の表として読む。
 *   どちらとも書いていない表は単価の表として読む。
 * 日付は「〇月」と書いてある列から順に1日、2日…と数える（日の行の数字がずれていても大丈夫なように）。
 * 区分や規格名は少し違っても（「粒」と「粒売り」、「プレミアム20」と「プレミアム」）同じものとして扱う。
 */
export function parseShipmentTable(table: string[][], grades: Grade[], year: number) {
  const cell = (r: number, c: number) => (table[r]?.[c] ?? "").trim();
  const isDay = (s: string) => /^\d{1,2}$/.test(s) && Number(s) >= 1 && Number(s) <= 31;
  const monthOf = (s: string) => {
    const m = s.match(/^(\d{1,2})\s*月$/);
    return m && Number(m[1]) >= 1 && Number(m[1]) <= 12 ? Number(m[1]) : 0;
  };
  const norm = (s: string) => s.replace(/\s/g, "").normalize("NFKC");
  const like = (a: string, b: string) => a === b || (a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a)));
  const findGrade = (group: string, name: string) => {
    const inGroup = grades.filter((g) => like(norm(g.group), group));
    return inGroup.find((g) => norm(g.name) === name) ?? inGroup.find((g) => like(norm(g.name), name));
  };

  const qty: Record<string, Record<string, number>> = {};
  const price: Record<string, Record<string, number>> = {};
  type Found = { grade: Grade; label: string; qtyDays: number; priceDays: number };
  const found = new Map<string, Found>();
  const unmatched = new Set<string>();
  let blocks = 0;

  // 1回目：表（「〇月」の行＋日の行）を探し、数量の表か単価の表かを見出しで決める
  type Block = { r: number; starts: { col: number; month: number }[]; kind: "qty" | "price" | null };
  const found0: Block[] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r] ?? [];
    // 日の行：1〜31の数字が20個以上
    if (row.filter((c) => isDay((c ?? "").trim())).length < 20) continue;
    // 月の行：すぐ上の行の「〇月」
    const starts: { col: number; month: number }[] = [];
    (table[r - 1] ?? []).forEach((c, i) => {
      const m = monthOf((c ?? "").trim());
      if (m) starts.push({ col: i, month: m });
    });
    if (starts.length === 0) continue;
    const label = [cell(r - 1, 0), cell(r, 0), cell(r - 2, 0)].join(" ");
    found0.push({ r, starts, kind: /数量|個数|パック数/.test(label) ? "qty" : /単価|価格/.test(label) ? "price" : null });
  }
  // 見出しがない表：2つ以上あれば上を数量・下を単価、1つだけなら単価の表（単価表のExcel）
  const labeled = new Set(found0.map((b) => b.kind).filter(Boolean));
  found0.forEach((b, i) => {
    if (b.kind) return;
    if (found0.length === 1) b.kind = "price";
    else if (!labeled.has("qty") && i === 0) b.kind = "qty";
    else b.kind = labeled.has("price") && !labeled.has("qty") ? "qty" : "price";
  });

  for (const { r, starts, kind: k } of found0) {
    const row = table[r] ?? [];
    const kind = k ?? "price";
    const target = kind === "qty" ? qty : price;
    blocks++;
    // 列 → 日付（月の列から順に数える）
    const colDate = new Map<number, string>();
    starts.forEach(({ col, month }, k) => {
      const end = k + 1 < starts.length ? starts[k + 1].col : row.length;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let c = col; c < end && c - col < last; c++) {
        colDate.set(c, `${year}-${String(month).padStart(2, "0")}-${String(c - col + 1).padStart(2, "0")}`);
      }
    });
    // 規格の行（空の行か、次の表で終わり）
    let group = "";
    for (let rr = r + 1; rr < table.length; rr++) {
      const g0 = cell(rr, 0);
      const name = norm(cell(rr, 1));
      if (!g0 && !name) break;
      if (g0) group = norm(g0);
      if (!name) continue;
      const grade = findGrade(group, name);
      if (!grade) {
        unmatched.add(`${group} ${name}`);
        continue;
      }
      const f = found.get(grade.id) ?? { grade, label: `${group} ${name}`, qtyDays: 0, priceDays: 0 };
      for (const [c, d] of colDate) {
        const raw = (table[rr]?.[c] ?? "").replace(/[,¥円]/g, "").trim();
        const v = Number(raw);
        if (!raw || !Number.isFinite(v) || v < 0) continue;
        // 数量の0は「出荷なし」なので入れない
        if (kind === "qty" && v === 0) continue;
        (target[d] ??= {})[grade.id] = Math.round(v);
        if (kind === "qty") f.qtyDays++;
        else f.priceDays++;
      }
      found.set(grade.id, f);
    }
  }
  if (blocks === 0) return { error: "「6月」「7月」の行と、日（1〜31）の行が見つかりません" };
  const dates = [...new Set([...Object.keys(qty), ...Object.keys(price)])].sort();
  return {
    error: "",
    qty,
    price,
    matched: [...found.values()],
    unmatched: [...unmatched],
    from: dates[0] ?? "",
    to: dates[dates.length - 1] ?? "",
    qtyDays: Object.keys(qty).length,
    priceDays: Object.keys(price).length,
  };
}

/** シート名や表の見出しから年を読む（「2026」「R8」「令和8年」） */
export function guessYear(texts: string[]): number | null {
  for (const t of texts) {
    const y = t.match(/20\d\d/);
    if (y) return Number(y[0]);
    const r = t.normalize("NFKC").match(/(?:R|令和)\s*(\d{1,2})/);
    if (r) return 2018 + Number(r[1]);
  }
  return null;
}
