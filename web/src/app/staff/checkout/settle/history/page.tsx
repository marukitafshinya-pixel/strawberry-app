"use client";

import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { addDays, formatJa, shiftMonth, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";

type Row = { id: string; float: number; cashSales: number; counted: number; diff: number; memo: string };

export default function SettleHistoryPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <View />
    </Suspense>
  );
}

function View() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/checkout/settle/history/?month=${m}`);
  const [state, setState] = useState<{ month: string; rows: Row[] } | null>(null);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    const from = `${month}-01`;
    const to = addDays(`${shiftMonth(month, 1)}-01`, -1);
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(query(collection(db, "cashCounts"), where(documentId(), ">=", from), where(documentId(), "<=", to)), (snap) =>
        setState({ month, rows: snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Row, "id">) })).sort((a, b) => b.id.localeCompare(a.id)) }),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [month]);

  const rows = state && state.month === month ? state.rows : null;
  const totalDiff = (rows ?? []).reduce((n, r) => n + r.diff, 0);
  const totalSales = (rows ?? []).reduce((n, r) => n + r.cashSales, 0);
  const [y, m] = month.split("-").map(Number);

  function exportCsv() {
    downloadCsv(`settlements_${month}.csv`, [
      ["日付", "釣銭準備金", "現金売上", "数えた現金", "過不足", "メモ"],
      ...(rows ?? []).map((r) => [r.id, r.float, r.cashSales, r.counted, r.diff, r.memo]),
    ]);
  }

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/checkout/history/" className="text-gray-500 underline">
          ← 取引履歴
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">精算履歴</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-28 text-center text-lg font-bold">
          {y}年{m}月
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
        <button onClick={exportCsv} disabled={!rows || rows.length === 0} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm disabled:opacity-40">
          CSVで書き出す
        </button>
      </div>

      {rows && rows.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-white p-3 shadow-sm">
            <div className="text-xs text-gray-500">精算した日数</div>
            <div className="text-xl font-bold">{rows.length}日</div>
          </div>
          <div className="rounded-2xl bg-white p-3 shadow-sm">
            <div className="text-xs text-gray-500">現金売上の合計</div>
            <div className="text-xl font-bold tabular-nums">{yen(totalSales)}</div>
          </div>
          <div className="rounded-2xl bg-white p-3 shadow-sm">
            <div className="text-xs text-gray-500">過不足の合計</div>
            <div className={`text-xl font-bold tabular-nums ${totalDiff < 0 ? "text-red-600" : totalDiff > 0 ? "text-sky-700" : ""}`}>{diffText(totalDiff)}</div>
          </div>
        </div>
      )}

      {!rows && <p className="mt-3 text-gray-500">読み込み中…</p>}
      {rows && rows.length === 0 && <p className="mt-4 text-sm text-gray-400">この月の精算はまだありません</p>}
      {rows && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">日付</th>
                <th className="px-3 py-2 text-right">釣銭準備金</th>
                <th className="px-3 py-2 text-right">現金売上</th>
                <th className="px-3 py-2 text-right">数えた現金</th>
                <th className="px-3 py-2 text-right">過不足</th>
                <th className="px-3 py-2">メモ</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2">{formatJa(r.id)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{yen(r.float)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{yen(r.cashSales)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{yen(r.counted)}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.diff < 0 ? "text-red-600" : r.diff > 0 ? "text-sky-700" : "text-green-700"}`}>{diffText(r.diff)}</td>
                  <td className="px-3 py-2 text-gray-600">{r.memo}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link href={`/staff/checkout/settle/?date=${r.id}`} className="rounded border px-2 py-1 text-xs">
                      開く
                    </Link>
                    <Link href={`/staff/checkout/history/?date=${r.id}`} className="ml-1 rounded border px-2 py-1 text-xs">
                      取引
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-gray-500">現金売上は、精算を保存したときの金額です。あとで取引を直したときは、その日の精算を開いて保存し直してください。</p>
    </>
  );
}

function diffText(d: number): string {
  return d === 0 ? "ぴったり" : `${d > 0 ? "+" : "−"}${yen(Math.abs(d))}`;
}
