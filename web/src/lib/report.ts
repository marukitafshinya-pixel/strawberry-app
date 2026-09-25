// 売上・予約の集計（ダッシュボードと集計画面で共通）
import { NEUTRAL, SERIES_COLORS, type Series } from "@/components/charts";
import type { Sale } from "./sales";
import { DEFAULT_PLAN_CATEGORY, type Settings } from "./settings";

export const IMPORTED = "__imported";
export const OTHER = "その他";

/**
 * 分類ごとの色の順番。期間を切り替えても同じ分類は同じ色になるよう、
 * 設定画面の並び（プラン → 商品）で固定する。8つ目以降は「その他」にまとめる。
 */
export function categoryOrder(settings: Settings, seen: string[]): string[] {
  const fromSettings = [
    ...settings.plans.map((p) => p.category ?? DEFAULT_PLAN_CATEGORY),
    ...settings.products.map((p) => p.group || OTHER),
  ];
  const all = [...new Set([...fromSettings, ...[...seen].sort()])].filter((c) => c !== OTHER);
  return [...all.slice(0, SERIES_COLORS.length - 1), OTHER];
}

/**
 * 日付 → 分類 → 金額。
 * アプリで会計した日はアプリの会計の合計、会計がない日は取り込んだ売上（内訳なし）を使う。
 */
export function buildDailySales(settings: Settings, sales: Sale[], imported: { id: string; amount: number }[]) {
  const byDay = new Map<string, Record<string, number>>();
  const done = sales.filter((s) => s.status === "completed");
  const order = categoryOrder(settings, [...new Set(done.flatMap((s) => s.lines.map((l) => l.category)))]);
  const fold = (c: string) => (order.includes(c) ? c : OTHER);
  for (const s of done) {
    const m = byDay.get(s.date) ?? {};
    for (const l of s.lines) m[fold(l.category)] = (m[fold(l.category)] ?? 0) + l.amount;
    byDay.set(s.date, m);
  }
  for (const im of imported) if (!byDay.has(im.id)) byDay.set(im.id, { [IMPORTED]: im.amount });
  const used = new Set([...byDay.values()].flatMap((m) => Object.keys(m)));
  const series: Series[] = [
    ...order.map((c, i) => ({ key: c, label: c, color: SERIES_COLORS[i] })).filter((s) => used.has(s.key)),
    ...(used.has(IMPORTED) ? [{ key: IMPORTED, label: "取り込み（内訳なし）", color: NEUTRAL }] : []),
  ];
  return { byDay, series };
}

export const sumValues = (v: Record<string, number>) => Object.values(v).reduce((n, x) => n + x, 0);

/** CSVファイルとして保存する（Excelで文字化けしないよう先頭にBOMを付ける） */
export function downloadCsv(fileName: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // ページに一度置いてから押すと、どのブラウザでもファイル名が付く
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
