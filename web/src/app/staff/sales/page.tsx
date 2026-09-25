"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { yen } from "@/lib/reservations";
import { PAYMENT_LABEL, byCategory, useImportedSales, useReceivables, useSales, type Sale } from "@/lib/sales";

export default function SalesPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <DailyClose />
    </Suspense>
  );
}

function DailyClose() {
  const params = useSearchParams();
  const router = useRouter();
  const date = isValidYmd(params.get("date")) ? params.get("date")! : todayJST();
  const setDate = (d: string) => router.replace(`/staff/sales/?date=${d}`);

  const { value: sales, error } = useSales(date, date);
  const { value: collected } = useReceivables("collected");
  const { value: imported } = useImportedSales(date, date);

  const done = (sales ?? []).filter((s) => s.status === "completed");
  const cash = done.filter((s) => s.payment === "cash").reduce((n, s) => n + s.total, 0);
  const credit = done.filter((s) => s.payment === "credit").reduce((n, s) => n + s.total, 0);
  const discount = done.reduce((n, s) => n + s.discountTotal, 0);
  const collectedToday = (collected ?? []).filter((r) => r.collectedDate === date);
  const collectedAmount = collectedToday.reduce((n, r) => n + r.amount, 0);
  const importedAmount = imported?.[0]?.amount;
  const categories = byCategory(sales ?? []);
  const sorted = [...(sales ?? [])].sort((a, b) => (b.createdAt?.toDate().getTime() ?? 0) - (a.createdAt?.toDate().getTime() ?? 0));

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">日次締め</h1>
        <Link href="/staff/checkout/" className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
          ＋ 会計する
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm">
        <button onClick={() => setDate(addDays(date, -1))} className="rounded-lg border px-3 py-2">
          ‹ 前日
        </button>
        <input type="date" value={date} onChange={(e) => isValidYmd(e.target.value) && setDate(e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
        <button onClick={() => setDate(addDays(date, 1))} className="rounded-lg border px-3 py-2">
          翌日 ›
        </button>
        {date !== todayJST() && (
          <button onClick={() => setDate(todayJST())} className="rounded-lg border px-3 py-2">
            今日
          </button>
        )}
        <span className="ml-auto font-bold">{formatJa(date, true)}</span>
      </div>

      {error ? <p className="mt-4 text-red-600">{errorText(error)}</p> : null}

      {/* 合計 */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="売上合計" value={yen(cash + credit)} strong />
        <Stat label="現金" value={yen(cash)} />
        <Stat label="売掛" value={yen(credit)} />
        <Stat label="会計件数" value={`${done.length}件`} />
      </div>
      <div className="mt-2 space-y-1 text-sm text-gray-600">
        {discount > 0 && <p>値引きの合計：{yen(discount)}（売上は値引き後の金額です）</p>}
        {collectedAmount > 0 && (
          <p>
            この日に回収した売掛：{yen(collectedAmount)}（{collectedToday.length}件）… 現金で受け取った場合は、レジの現金はこの分多くなります
          </p>
        )}
        {importedAmount !== undefined && done.length === 0 && <p>Airレジから取り込んだ売上：{yen(importedAmount)}（内訳なし）</p>}
        {importedAmount !== undefined && done.length > 0 && <p>この日はアプリの会計があるため、取り込んだ売上（{yen(importedAmount)}）ではなくアプリの合計を使います。</p>}
      </div>

      {/* 分類ごと */}
      {categories.length > 0 && (
        <section className="mt-4 rounded-2xl bg-white p-3 shadow-sm">
          <h2 className="font-bold">分類ごとの売上</h2>
          <ul className="mt-2 space-y-1">
            {categories.map((c) => (
              <li key={c.category} className="flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0">{c.category}</span>
                <span className="h-3 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <span className="block h-full bg-berry" style={{ width: `${(c.amount / Math.max(1, cash + credit)) * 100}%` }} />
                </span>
                <span className="w-24 text-right font-semibold">{yen(c.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 会計履歴 */}
      <section className="mt-4 rounded-2xl bg-white p-3 shadow-sm">
        <h2 className="font-bold">会計履歴</h2>
        {!sales && <p className="mt-2 text-gray-500">読み込み中…</p>}
        {sales && sales.length === 0 && <p className="mt-2 text-sm text-gray-400">この日の会計はありません</p>}
        <ul className="mt-2 divide-y">
          {sorted.map((s) => (
            <SaleRow key={s.id} sale={s} />
          ))}
        </ul>
      </section>
    </>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl p-3 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <div className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</div>
      <div className="mt-1 text-xl font-bold">{value}</div>
    </div>
  );
}

function SaleRow({ sale: s }: { sale: Sale }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const voided = s.status === "voided";
  const time = s.createdAt?.toDate().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

  async function voidIt() {
    const reason = window.prompt(
      `${yen(s.total)}（${s.customerName || "お客様名なし"}）の会計を取り消しますか？\n${s.payment === "credit" ? "売掛一覧からも消えます。\n" : ""}取り消す理由を入力してください（空でも可）`,
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
    <li className={`py-2 ${voided ? "opacity-50" : ""}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-2 text-left">
        <span className="text-sm text-gray-500">{time}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${s.payment === "cash" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
          {PAYMENT_LABEL[s.payment]}
        </span>
        {voided && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs">取消</span>}
        <span className={voided ? "line-through" : ""}>{s.customerName || "（お客様名なし）"}</span>
        {s.reservationId && <span className="text-xs text-gray-400">予約</span>}
        <span className={`ml-auto font-bold ${voided ? "line-through" : ""}`}>{yen(s.total)}</span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-lg bg-gray-50 p-2 text-sm">
          <ul>
            {s.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {l.name} × {l.qty}
                  {l.discountRate > 0 && <span className="ml-1 text-red-700">{l.discountRate}%引</span>}
                  <span className="ml-1 text-xs text-gray-400">{l.category}</span>
                </span>
                <span>{yen(l.amount)}</span>
              </li>
            ))}
          </ul>
          {s.memo && <p className="mt-1 text-gray-600">メモ：{s.memo}</p>}
          {voided && s.voidReason && <p className="mt-1 text-gray-600">取消の理由：{s.voidReason}</p>}
          <Link href={`/staff/receipt/?sale=${s.id}`} className="mr-2 mt-2 inline-block rounded-lg border px-3 py-1.5">
            レシート・領収書
          </Link>
          {!voided && (
            <button onClick={voidIt} disabled={busy} className="mt-2 rounded-lg border border-red-300 px-3 py-1.5 text-red-700 disabled:opacity-50">
              {busy ? "取消中…" : "この会計を取り消す"}
            </button>
          )}
          {error && <p className="mt-1 text-red-600">{error}</p>}
        </div>
      )}
    </li>
  );
}
