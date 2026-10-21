"use client";

// 去年の出荷実績（日ごとの合計重量 kg）：エクセルからコピーして貼り付けたものを、日付 → kg にする。
// 2つの形が使える
// ・縦：1行に「日付」「kg」（例：2025/5/29	11.1、5/29,11.1、5月29日	11.1）
// ・横（日別実績のシートのまま）：「月」の行（6月 など。月のはじめだけ）・「日」の行（数字）・「合計重量」の行を、列をそろえてコピー
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { getFirebase } from "./firebase";

const z2h = (s: string) => s.replace(/[０-９．，／－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
const num = (s: string | undefined) => {
  const t = z2h(s ?? "").replace(/,/g, "");
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null;
};
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** 縦の1行の日付を読む（年がなければ year） */
function dateOf(s: string, year: number): string | null {
  const t = z2h(s);
  let m = t.match(/^(\d{4})[/\-年.](\d{1,2})[/\-月.](\d{1,2})日?$/);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
  if (m) return ymd(year, Number(m[1]), Number(m[2]));
  return null;
}

/** 貼り付けた文字から、日付 → kg を読む。読めなかった行の数も返す */
export function parsePastShipments(text: string, year: number): { days: Record<string, number>; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rows = lines.map((l) => l.split(/\t|,/));
  const days: Record<string, number> = {};
  // 横の形：「6月」のような月の見出しがある行
  const mi = rows.findIndex((r) => r.some((c) => /^\d{1,2}月$/.test(z2h(c))));
  if (mi >= 0 && rows.length >= mi + 3) {
    const dayRow = rows[mi + 1];
    // 合計重量の行（見出しに「合計重量」とある行。なければいちばん下の行）。間の行もまとめてコピーしてよい
    const kgRow = rows.slice(mi + 2).find((r) => r.some((c) => c.includes("合計重量"))) ?? rows[rows.length - 1];
    const cols: { c: number; d: number }[] = [];
    dayRow.forEach((c, i) => {
      const d = num(c);
      if (d != null && Number.isInteger(d) && d >= 1 && d <= 31) cols.push({ c: i, d });
    });
    if (!cols.length) return { days, skipped: lines.length };
    // 日が小さくなったら次の月。はじめの月は、最初の月の見出しから決める（見出しが月末の日の上にあるときは前の月から）
    const wraps = cols.map((_, k) => cols.slice(1, k + 1).filter((x, j) => x.d < cols[j].d).length);
    const label = rows[mi].findIndex((c) => /^\d{1,2}月$/.test(z2h(c)));
    const lm = Number(z2h(rows[mi][label]).replace("月", ""));
    const at = Math.max(
      0,
      cols.findIndex((x) => x.c >= label),
    );
    const nextWrap = wraps.findIndex((w, k) => k > at && w > wraps[at]);
    const early = cols[at].d > 20 && nextWrap > 0 && nextWrap - at <= 12 ? 1 : 0;
    const startMonth = lm - wraps[at] - early;
    let skipped = 0;
    cols.forEach((x, k) => {
      const mAbs = startMonth + wraps[k] - 1;
      const y = year + Math.floor(mAbs / 12);
      const m = (((mAbs % 12) + 12) % 12) + 1;
      const kg = num(kgRow[x.c]);
      if (kg == null) {
        if ((kgRow[x.c] ?? "").trim() !== "") skipped++;
        return;
      }
      days[ymd(y, m, x.d)] = kg;
    });
    return { days, skipped };
  }
  // 縦の形
  let skipped = 0;
  for (const r of rows) {
    const d = dateOf(r[0] ?? "", year);
    const kg = num(r[1]);
    if (d && kg != null) days[d] = kg;
    else skipped++;
  }
  return { days, skipped };
}

/** stats/pastYield：去年の出荷実績から出した天気の影響（管理者だけが読める） */
export type PastYield = {
  season: string;
  model: { n: number; b: number; c: number } | null;
  from: string;
  to: string;
  shipments: number;
  total: number;
  missing: string[];
};
export function usePastYield(): PastYield | null | undefined {
  const [v, setV] = useState<PastYield | null | undefined>(undefined);
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsub = onSnapshot(
        doc(db, "stats/pastYield"),
        (s) => setV(s.exists() ? (s.data() as PastYield) : null),
        () => setV(null),
      );
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);
  return v;
}
