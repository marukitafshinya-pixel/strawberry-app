"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useCustomers } from "@/lib/customers";
import { formatJa } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { PAYMENT_LABEL, useReceivablesByCustomer, useSalesByCustomer } from "@/lib/sales";

export default function CustomerHistoryPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <History />
    </Suspense>
  );
}

function History() {
  const id = useSearchParams().get("id") ?? "";
  const { value: customers } = useCustomers();
  const customer = customers?.find((c) => c.id === id);
  const name = customer?.name ?? "";
  const { value: sales, error } = useSalesByCustomer(name);
  const { value: receivables } = useReceivablesByCustomer(name);
  const [year, setYear] = useState("");

  if (!customers) return <p className="text-gray-500">読み込み中…</p>;
  if (!customer) return <p className="text-red-600">顧客が見つかりません</p>;

  const all = [...(sales ?? [])].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt?.toDate().getTime() ?? 0) - (a.createdAt?.toDate().getTime() ?? 0));
  const years = [...new Set(all.map((s) => s.date.slice(0, 4)))];
  const shown = all.filter((s) => !year || s.date.startsWith(year));
  const done = shown.filter((s) => s.status === "completed");
  const total = done.reduce((n, s) => n + s.total, 0);
  const people = (s: (typeof all)[number]) => s.lines.filter((l) => l.category === "いちご狩り" || l.kind === "plan").reduce((n, l) => n + l.qty, 0);
  const openRec = (receivables ?? []).filter((r) => r.status === "open");
  const openTotal = openRec.reduce((n, r) => n + r.amount, 0);

  function exportCsv() {
    downloadCsv(`customer_${customer!.id}_history.csv`, [
      ["日付", "内容", "金額", "支払", "状態", "メモ"],
      ...shown.map((s) => [
        s.date,
        s.lines.map((l) => `${l.name}×${l.qty}`).join(" / "),
        s.total,
        PAYMENT_LABEL[s.payment],
        s.status === "voided" ? "取消" : "",
        s.memo,
      ]),
    ]);
  }

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/customers/" className="text-gray-500 underline">
          ← 顧客リスト
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">{customer.name} 様の取引履歴</h1>
      {customer.contract && <p className="mt-1 text-sm text-gray-600">契約内容：{customer.contract}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={`取引回数${year ? `（${year}年）` : ""}`} value={`${done.length}回`} />
        <Tile label={`取引金額の合計${year ? `（${year}年）` : ""}`} value={yen(total)} />
        <Tile label="いちご狩りの人数" value={`${done.reduce((n, s) => n + people(s), 0)}人`} />
        <Tile label="未回収の売掛" value={yen(openTotal)} sub={`${openRec.length}件`} href="/staff/receivables/" warn={openTotal > 0} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {years.length > 1 &&
          ["", ...years].map((y) => (
            <button
              key={y || "all"}
              onClick={() => setYear(y)}
              className={`rounded-full border px-3 py-1 text-sm ${year === y ? "border-berry bg-berry text-white" : "bg-white"}`}
            >
              {y ? `${y}年` : "すべて"}
            </button>
          ))}
        <button onClick={exportCsv} disabled={shown.length === 0} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm disabled:opacity-40">
          CSVで書き出す
        </button>
      </div>

      {error ? <p className="mt-3 text-red-600">読み込めませんでした</p> : null}
      {!sales && !error && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {sales && shown.length === 0 && <p className="mt-4 text-sm text-gray-400">まだ取引はありません（会計で「顧客を選ぶ」からこの顧客を選ぶと、ここに出ます）</p>}
      {shown.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">日付</th>
                <th className="px-3 py-2">内容</th>
                <th className="px-3 py-2 text-right">金額</th>
                <th className="px-3 py-2">支払</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const rec = s.receivableId ? receivables?.find((r) => r.id === s.receivableId) : undefined;
                return (
                  <tr key={s.id} className={`border-t align-top ${s.status === "voided" ? "text-gray-400 line-through" : ""}`}>
                    <td className="whitespace-nowrap px-3 py-2">{formatJa(s.date, true)}</td>
                    <td className="px-3 py-2">
                      {s.lines.map((l, i) => (
                        <div key={i}>
                          {l.name} × {l.qty}
                        </div>
                      ))}
                      {s.memo && <div className="text-xs text-gray-500">メモ：{s.memo}</div>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{yen(s.total)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {PAYMENT_LABEL[s.payment]}
                      {s.status === "voided" && <span className="ml-1 no-underline">（取消）</span>}
                      {rec && <span className={`ml-1 text-xs ${rec.status === "open" ? "text-amber-700" : "text-green-700"}`}>{rec.status === "open" ? "未回収" : "回収済み"}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Link href={`/staff/receipt/?sale=${s.id}`} className="rounded border px-2 py-1 text-xs">
                        レシート
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">
        会計の「お客様名」がこの顧客の名前と同じものを表示しています。顧客の名前を変えると、変える前の取引は出なくなります。
      </p>
    </>
  );
}

function Tile({ label, value, sub, href, warn }: { label: string; value: string; sub?: string; href?: string; warn?: boolean }) {
  const body = (
    <>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${warn ? "text-amber-700" : ""}`}>{value}</div>
      {sub && <div className="text-sm text-gray-600">{sub}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-2xl bg-white p-4 shadow-sm">
      {body}
    </Link>
  ) : (
    <div className="rounded-2xl bg-white p-4 shadow-sm">{body}</div>
  );
}
