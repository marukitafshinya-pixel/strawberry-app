"use client";

import { collection, doc, documentId, getDocs, onSnapshot, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { yen } from "@/lib/reservations";
import { useSales } from "@/lib/sales";

/** 紙幣・硬貨 */
const BILLS = [10000, 5000, 2000, 1000];
const COINS = [500, 100, 50, 10, 5, 1];

type CashCount = {
  float: number;
  counts: Record<string, number>;
  cashSales: number;
  counted: number;
  diff: number;
  memo: string;
  updatedAt?: { toDate: () => Date };
};

export default function SettlePage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <SettleLoader />
    </Suspense>
  );
}

function SettleLoader() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("date");
  const date = isValidYmd(q) ? q : todayJST();
  const setDate = (d: string) => router.replace(`/staff/checkout/settle/?date=${d}`);
  // この日の保存済みの精算（なければ null）と、前回の釣銭準備金
  const [state, setState] = useState<{ date: string; saved: CashCount | null; lastFloat: number | null } | null>(null);

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(async ({ db }) => {
      // 前回（直近2か月の中でいちばん新しい日）の釣銭準備金
      const prev = await getDocs(query(collection(db, "cashCounts"), where(documentId(), ">=", addDays(date, -62)), where(documentId(), "<", date))).catch(() => null);
      const last = prev?.docs.sort((x, y) => y.id.localeCompare(x.id))[0];
      const lastFloat = last ? ((last.get("float") as number) ?? null) : null;
      if (cancelled) return;
      unsubscribe = onSnapshot(doc(db, `cashCounts/${date}`), (s) => setState({ date, saved: s.exists() ? (s.data() as CashCount) : null, lastFloat }));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [date]);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/checkout/" className="text-gray-500 underline">
          ← 注文入力
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">レジ精算</h1>
        <div className="flex gap-2">
          <Link href={`/staff/checkout/history/?date=${date}`} className="rounded-lg border bg-white px-3 py-2 text-sm">
            この日の取引履歴
          </Link>
          <Link href={`/staff/checkout/settle/history/?month=${date.slice(0, 7)}`} className="rounded-lg border bg-white px-3 py-2 text-sm">
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
      {!state || state.date !== date ? <p className="mt-4 text-gray-500">読み込み中…</p> : <Settle key={date} date={date} saved={state.saved} lastFloat={state.lastFloat} />}
    </>
  );
}

function Settle({ date, saved, lastFloat }: { date: string; saved: CashCount | null; lastFloat: number | null }) {
  const { user } = useAuth();
  const { value: sales } = useSales(date, date);
  const [float, setFloat] = useState(String(saved?.float ?? lastFloat ?? ""));
  const [counts, setCounts] = useState<Record<string, string>>(
    Object.fromEntries([...BILLS, ...COINS].map((d) => [String(d), saved?.counts?.[d] ? String(saved.counts[d]) : ""])),
  );
  const [memo, setMemo] = useState(saved?.memo ?? "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const done = (sales ?? []).filter((s) => s.status === "completed");
  const cashSales = done.filter((s) => s.payment === "cash").reduce((n, s) => n + s.total, 0);
  const creditSales = done.filter((s) => s.payment === "credit").reduce((n, s) => n + s.total, 0);
  const cashCount = done.filter((s) => s.payment === "cash").length;
  const voided = (sales ?? []).filter((s) => s.status === "voided").length;

  const num = (v: string) => Number(v || 0);
  const counted = [...BILLS, ...COINS].reduce((n, d) => n + d * num(counts[String(d)]), 0);
  const floatN = num(float);
  const expected = floatN + cashSales;
  const diff = counted - expected;
  const anyCounted = [...BILLS, ...COINS].some((d) => counts[String(d)] !== "");
  const digits = (v: string) => v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");

  async function save() {
    if (!user) return;
    setError("");
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, `cashCounts/${date}`), {
        float: floatN,
        counts: Object.fromEntries([...BILLS, ...COINS].map((d) => [String(d), num(counts[String(d)])]).filter(([, n]) => (n as number) > 0)),
        cashSales,
        counted,
        diff,
        memo: memo.trim().slice(0, 500),
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      });
      setMessage("精算を保存しました");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const row = (d: number) => (
    <div key={d} className="grid grid-cols-[5.5rem_1fr_7rem] items-center gap-2">
      <span className="font-semibold tabular-nums">{d.toLocaleString("ja-JP")}円{d >= 1000 ? "札" : "玉"}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCounts({ ...counts, [d]: String(Math.max(0, num(counts[String(d)]) - 1) || "") })}
          className="h-10 w-10 rounded-lg border text-lg"
          aria-label={`${d}円を1枚減らす`}
        >
          −
        </button>
        <input
          inputMode="numeric"
          value={counts[String(d)]}
          placeholder="0"
          onChange={(e) => setCounts({ ...counts, [d]: digits(e.target.value).slice(0, 5) })}
          className="h-10 w-20 rounded-lg border px-2 text-right text-lg tabular-nums"
          aria-label={`${d}円の枚数`}
        />
        <button type="button" onClick={() => setCounts({ ...counts, [d]: String(num(counts[String(d)]) + 1) })} className="h-10 w-10 rounded-lg border text-lg" aria-label={`${d}円を1枚増やす`}>
          ＋
        </button>
        <span className="text-sm text-gray-500">枚</span>
      </span>
      <span className="text-right tabular-nums">{yen(d * num(counts[String(d)]))}</span>
    </div>
  );

  return (
    <div className="mt-4 grid gap-4 pb-24 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <label className="block">
            <span className="font-bold">釣銭準備金</span>
            <span className="ml-2 text-xs text-gray-500">（朝、レジに入れておいたお金）</span>
            <span className="mt-2 flex items-center gap-2">
              <input
                inputMode="numeric"
                value={float}
                onChange={(e) => setFloat(digits(e.target.value).slice(0, 8))}
                className="w-40 rounded-lg border px-3 py-2 text-right text-lg tabular-nums"
                aria-label="釣銭準備金"
              />
              円
              {!saved && lastFloat !== null && <span className="text-xs text-gray-500">前回の金額を入れています</span>}
            </span>
          </label>
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-bold">レジの中の現金を数える</h2>
          <p className="mt-1 text-xs text-gray-500">釣銭準備金も含めて、レジに入っているお金をすべて数えてください。</p>
          <h3 className="mt-3 text-sm font-semibold text-gray-600">紙幣</h3>
          <div className="mt-1 space-y-2">{BILLS.map(row)}</div>
          <h3 className="mt-4 text-sm font-semibold text-gray-600">硬貨</h3>
          <div className="mt-1 space-y-2">{COINS.map(row)}</div>
          <div className="mt-4 flex justify-between border-t pt-3 text-lg font-bold">
            <span>数えた現金の合計</span>
            <span className="tabular-nums">{yen(counted)}</span>
          </div>
          <button onClick={() => setCounts(Object.fromEntries(Object.keys(counts).map((k) => [k, ""])))} className="mt-2 text-sm text-gray-500 underline">
            枚数をすべて消す
          </button>
        </section>
      </div>

      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-bold">{formatJa(date, true)} の精算</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <Row label="釣銭準備金" value={yen(floatN)} />
            <Row label={`現金売上（${cashCount}件）`} value={sales ? yen(cashSales) : "…"} />
            <Row label="レジにあるはずの現金" value={yen(expected)} strong />
            <Row label="数えた現金" value={yen(counted)} strong />
          </dl>
          <div
            className={`mt-3 rounded-xl p-4 text-center ${
              !anyCounted ? "bg-gray-50 text-gray-500" : diff === 0 ? "bg-green-50 text-green-800" : diff > 0 ? "bg-sky-50 text-sky-800" : "bg-red-50 text-red-700"
            }`}
          >
            <div className="text-sm">過不足</div>
            <div className="text-3xl font-bold tabular-nums">
              {!anyCounted ? "—" : diff === 0 ? "ぴったり" : `${diff > 0 ? "+" : "−"}${yen(Math.abs(diff))}`}
            </div>
            {anyCounted && diff !== 0 && <div className="text-sm">{diff > 0 ? "現金が多いです（過剰）" : "現金が足りません（不足）"}</div>}
          </div>
          <dl className="mt-3 space-y-1 border-t pt-2 text-xs text-gray-500">
            <Row label="売掛の売上（現金ではない）" value={yen(creditSales)} />
            {voided > 0 && <Row label="取り消した会計" value={`${voided}件`} />}
            <Row label="おつりを除いて銀行に入れる額" value={yen(Math.max(0, counted - floatN))} />
          </dl>
          <p className="mt-2 text-xs text-gray-400">現金売上は、このアプリの会計だけで計算しています。</p>
        </section>

        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <label className="block text-sm">
            <span className="text-gray-600">メモ（過不足の理由など）</span>
            <textarea value={memo} maxLength={500} rows={2} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
          </label>
          <button onClick={save} disabled={saving} className="mt-3 w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
            {saving ? "保存中…" : saved ? "精算を保存し直す" : "精算を保存"}
          </button>
          {message && <p className="mt-2 text-sm text-green-700">{message}</p>}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {saved?.updatedAt && (
            <p className="mt-2 text-xs text-gray-500">
              保存済み：{saved.updatedAt.toDate().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              （その時の過不足 {saved.diff === 0 ? "なし" : `${saved.diff > 0 ? "+" : "−"}${yen(Math.abs(saved.diff))}`}）
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "text-base font-bold" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
