"use client";

import Link from "next/link";
import { useState } from "react";
import { formatJa, todayJST } from "@/lib/date";
import { useItemRefs, type ItemRefDoc } from "@/lib/itemRefs";
import { yen } from "@/lib/reservations";
import { downloadCsv } from "@/lib/report";
import { useSales } from "@/lib/sales";

/** 日付の年だけを変える（2/29は2/28にする） */
function withYear(ymd: string, year: number): string {
  const md = ymd.slice(5) === "02-29" ? "02-28" : ymd.slice(5);
  return `${year}-${md}`;
}

export default function ItemReportPage() {
  const { value: refs, error } = useItemRefs();
  const [selected, setSelected] = useState("");
  if (error) return <p className="text-red-600">読み込めませんでした</p>;
  if (!refs) return <p className="text-gray-500">読み込み中…</p>;
  const ref = refs.find((r) => r.id === selected) ?? refs[0];
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/report/" className="text-gray-500 underline">
          ← 集計
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">商品別の実績（去年と今年）</h1>
      {!ref ? (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-amber-800">
          まだ去年の実績がありません。管理者が <Link href="/staff/import/" className="underline">取り込み</Link> の画面で、Airレジの「商品別」CSVを取り込んでください。
        </p>
      ) : (
        <>
          {refs.length > 1 && (
            <select value={ref.id} onChange={(e) => setSelected(e.target.value)} className="mt-3 rounded-lg border px-3 py-2 text-base">
              {refs.map((r) => (
                <option key={r.id} value={r.id}>
                  {formatJa(r.from, true)} 〜 {formatJa(r.to, true)}
                </option>
              ))}
            </select>
          )}
          <Compare key={ref.id} ref_={ref} />
        </>
      )}
    </>
  );
}

function Compare({ ref_: ref }: { ref_: ItemRefDoc }) {
  const year = Number(todayJST().slice(0, 4));
  const refYear = Number(ref.from.slice(0, 4));
  // 去年の実績と同じ時期の、今年（アプリの会計）
  const shift = year - refYear;
  const from = withYear(ref.from, Number(ref.from.slice(0, 4)) + shift);
  const to = withYear(ref.to, Number(ref.to.slice(0, 4)) + shift);
  const { value: sales } = useSales(from, to);

  const now = new Map<string, { qty: number; amount: number }>();
  for (const s of sales ?? []) {
    if (s.status !== "completed") continue;
    for (const l of s.lines) {
      const t = now.get(l.name) ?? { qty: 0, amount: 0 };
      now.set(l.name, { qty: t.qty + l.qty, amount: t.amount + l.amount });
    }
  }
  const rows = [
    ...ref.items.map((i) => ({ name: i.name, category: i.category, last: i, now: now.get(i.name) })),
    // 去年はなかった商品（今年から売り始めたもの・名前を変えたもの）
    ...[...now.entries()].filter(([n]) => !ref.items.some((i) => i.name === n)).map(([name, v]) => ({ name, category: "", last: undefined, now: v })),
  ].sort((a, b) => (b.last?.amount ?? 0) - (a.last?.amount ?? 0) || (b.now?.amount ?? 0) - (a.now?.amount ?? 0));
  const lastTotal = ref.items.reduce((n, i) => n + i.amount, 0);
  const nowTotal = [...now.values()].reduce((n, v) => n + v.amount, 0);
  const today = todayJST();

  function exportCsv() {
    downloadCsv(`items_${ref.from}_${ref.to}.csv`, [
      ["商品名", "カテゴリー", "去年の販売数", "去年の売上", "今年の販売数", "今年の売上"],
      ...rows.map((r) => [r.name, r.category, r.last?.qty ?? 0, r.last?.amount ?? 0, r.now?.qty ?? 0, r.now?.amount ?? 0]),
    ]);
  }

  return (
    <>
      <p className="mt-3 text-sm text-gray-600">
        去年：{formatJa(ref.from, true)}〜{formatJa(ref.to, true)}（Airレジ）／ 今年：{formatJa(from, true)}〜{formatJa(to, true)}（アプリの会計）
        {today < to && <span className="ml-1">※今年はまだ途中です</span>}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="text-xs text-gray-500">去年の売上</div>
          <div className="text-xl font-bold tabular-nums">{yen(lastTotal)}</div>
        </div>
        <div className="rounded-2xl bg-white p-3 shadow-sm">
          <div className="text-xs text-gray-500">今年の売上（同じ時期）</div>
          <div className="text-xl font-bold tabular-nums">{sales ? yen(nowTotal) : "…"}</div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
      </div>
      <div className="mt-2 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">商品名</th>
              <th className="px-3 py-2 text-right">去年 販売数</th>
              <th className="px-3 py-2 text-right">去年 売上</th>
              <th className="px-3 py-2 text-right">今年 販売数</th>
              <th className="px-3 py-2 text-right">今年 売上</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t">
                <td className="px-3 py-1.5">
                  {r.name}
                  {r.category && <span className="ml-1 text-xs text-gray-400">{r.category}</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.last ? r.last.qty.toLocaleString("ja-JP") : "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.last ? yen(r.last.amount) : "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.now ? r.now.qty.toLocaleString("ja-JP") : "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.now ? yen(r.now.amount) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        今年の数字は、アプリの会計で売った商品の名前が去年と同じものを並べています。いちご狩りはアプリでは「プラン名（区分）」の名前になるので、別の行に出ます。
      </p>
    </>
  );
}
