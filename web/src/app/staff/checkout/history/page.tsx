"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { yen } from "@/lib/reservations";
import { NO_HANDLER, PAYMENT_LABEL, byHandler, useSales, type Sale } from "@/lib/sales";

export default function HistoryPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <History />
    </Suspense>
  );
}

function History() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("date");
  const date = isValidYmd(q) ? q : todayJST();
  const setDate = (d: string) => router.replace(`/staff/checkout/history/?date=${d}`);
  const { value: sales, error } = useSales(date, date);
  const [showVoided, setShowVoided] = useState(false);
  const [handlerFilter, setHandlerFilter] = useState("");

  const list = [...(sales ?? [])].sort((a, b) => (b.createdAt?.toDate().getTime() ?? 0) - (a.createdAt?.toDate().getTime() ?? 0));
  const done = list.filter((s) => s.status === "completed");
  const handlerRows = byHandler(list);
  const shown = (showVoided ? list : done).filter((s) => !handlerFilter || (s.handler?.trim() || NO_HANDLER) === handlerFilter);
  const total = done.reduce((n, s) => n + s.total, 0);
  const cash = done.filter((s) => s.payment === "cash").reduce((n, s) => n + s.total, 0);
  const credit = total - cash;
  const voidedCount = list.length - done.length;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <Link href="/staff/checkout/" className="text-gray-500 underline">
            ← 注文入力
          </Link>
          <span className="ml-3 text-lg font-bold text-gray-900">取引履歴</span>
        </p>
        <div className="flex gap-2">
          <Link href={`/staff/checkout/settle/?date=${date}`} className="rounded-lg border bg-white px-3 py-2 text-sm">
            この日の精算
          </Link>
          <Link href={`/staff/checkout/settle/history/?month=${date.slice(0, 7)}`} className="rounded-lg border border-emerald-700 bg-white px-3 py-2 text-sm font-semibold text-emerald-800">
            精算履歴
          </Link>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setDate(addDays(date, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前日
        </button>
        <input type="date" value={date} onChange={(e) => isValidYmd(e.target.value) && setDate(e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
        <button onClick={() => setDate(addDays(date, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌日 ›
        </button>
        {date !== todayJST() && (
          <button onClick={() => setDate(todayJST())} className="rounded-lg border bg-white px-3 py-2">
            今日
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={`${formatJa(date)}の売上`} value={yen(total)} sub={`${done.length}件`} />
        <Tile label="現金" value={yen(cash)} />
        <Tile label="売掛" value={yen(credit)} />
        <Tile label="取り消した会計" value={`${voidedCount}件`} />
      </div>

      {handlerRows.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl bg-white p-3 shadow-sm">
          <h2 className="text-sm font-bold">取扱者ごと</h2>
          <table className="mt-1 w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b text-xs text-gray-500">
                <th className="py-1 text-left font-semibold">取扱者</th>
                <th className="py-1 text-right font-semibold">件数</th>
                <th className="py-1 text-right font-semibold">現金</th>
                <th className="py-1 text-right font-semibold">売掛</th>
                <th className="py-1 text-right font-semibold">合計</th>
              </tr>
            </thead>
            <tbody>
              {handlerRows.map((h) => (
                <tr
                  key={h.handler}
                  onClick={() => setHandlerFilter(handlerFilter === h.handler ? "" : h.handler)}
                  className={`cursor-pointer border-b last:border-0 ${handlerFilter === h.handler ? "bg-emerald-50 font-semibold" : ""}`}
                >
                  <td className="py-1.5">{h.handler}</td>
                  <td className="py-1.5 text-right">{h.count}件</td>
                  <td className="py-1.5 text-right">{yen(h.cash)}</td>
                  <td className="py-1.5 text-right">{yen(h.credit)}</td>
                  <td className="py-1.5 text-right">{yen(h.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-gray-500">名前を押すと、その人の会計だけを下に表示します（もう一度押すと全員に戻ります）。</p>
        </div>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
        取り消した会計も表示する
        {handlerFilter && (
          <button onClick={() => setHandlerFilter("")} className="ml-3 rounded-full border border-emerald-700 px-3 py-0.5 text-xs text-emerald-800">
            {handlerFilter} だけ表示中 ×
          </button>
        )}
      </label>

      {error ? <p className="mt-3 text-red-600">{errorText(error)}</p> : null}
      {!sales && !error && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {sales && shown.length === 0 && <p className="mt-4 text-sm text-gray-400">この日の取引はありません</p>}
      <ul className="mt-3 space-y-2">
        {shown.map((s) => (
          <SaleRow key={s.id} s={s} />
        ))}
      </ul>
    </>
  );
}

function SaleRow({ s }: { s: Sale }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const voided = s.status === "voided";
  const time = s.createdAt?.toDate().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

  async function remove() {
    const reason = window.prompt(
      `${time ?? ""} の会計（${yen(s.total)}）を削除（取消）しますか？\n売上から外れ、売掛なら売掛も消えます。\n理由があれば入れてください。`,
      "",
    );
    if (reason === null) return;
    setBusy(true);
    setError("");
    try {
      await callFunction("voidSale", { id: s.id, reason });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rounded-xl border bg-white p-3 ${voided ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm tabular-nums text-gray-500">{time}</span>
        <span className="text-xs text-gray-400">No.{s.id.slice(0, 6).toUpperCase()}</span>
        {s.customerName && <span className="font-semibold">{s.customerName} 様</span>}
        <span className={`rounded px-1.5 text-xs ${s.payment === "credit" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-600"}`}>{PAYMENT_LABEL[s.payment]}</span>
        <span className="rounded bg-emerald-50 px-1.5 text-xs text-emerald-800">担当：{s.handler?.trim() || "未選択"}</span>
        {voided && <span className="rounded bg-gray-200 px-1.5 text-xs">取消</span>}
        <span className={`ml-auto text-lg font-bold tabular-nums ${voided ? "line-through" : ""}`}>{yen(s.total)}</span>
      </div>
      <ul className="mt-1 text-sm text-gray-700">
        {s.lines.map((l, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span>
              {l.name} {yen(l.unitPrice)} × {l.qty}
              {l.discountRate > 0 && <span className="text-red-700">（{l.discountRate}%引）</span>}
            </span>
            <span className="tabular-nums">{yen(l.amount)}</span>
          </li>
        ))}
      </ul>
      {s.memo && <p className="mt-1 text-xs text-gray-500">メモ：{s.memo}</p>}
      {voided && s.voidReason && <p className="mt-1 text-xs text-gray-500">取消の理由：{s.voidReason}</p>}
      <div className="mt-2 flex flex-wrap gap-2 text-sm">
        <Link href={`/staff/receipt/?sale=${s.id}`} className="rounded-lg border px-3 py-1.5">
          レシート
        </Link>
        {!voided && (
          <>
            <Link href={`/staff/checkout/?edit=${s.id}`} className="rounded-lg border border-sky-600 px-3 py-1.5 font-semibold text-sky-800">
              修正
            </Link>
            <button onClick={remove} disabled={busy} className="rounded-lg border px-3 py-1.5 text-red-700 disabled:opacity-50">
              {busy ? "処理中…" : "削除"}
            </button>
          </>
        )}
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </li>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white p-3 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}
