"use client";

import { doc, serverTimestamp, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { addDays, shiftMonth, todayJST, weekday } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { summarize, unitWeight, useShipments, useShippingConfig, type DayItems, type Grade } from "@/lib/shipping";

type Mode = "qty" | "price";

const lastDayOf = (ym: string) => addDays(`${shiftMonth(ym, 1)}-01`, -1);

export default function ShippingPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <ShippingView />
    </Suspense>
  );
}

function ShippingView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/shipping/?month=${m}`);
  const { value: config, exists } = useShippingConfig();
  // 1日の「前日の単価」のために、前の月の最終日も読む
  const from = addDays(`${month}-01`, -1);
  const to = lastDayOf(month);
  const loaded = useShipments(from, to);
  const year = month.slice(0, 4);
  const yearData = useShipments(`${year}-01-01`, `${year}-12-31`);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        {role === "admin" && (
          <Link href="/staff/shipping/settings/" className="ml-4 text-gray-500 underline">
            規格・出荷先の設定
          </Link>
        )}
      </p>
      <h1 className="mt-2 text-xl font-bold">
        出荷実績{config?.destination && <span className="ml-2 text-base font-normal text-gray-600">（{config.destination}）</span>}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-28 text-center text-lg font-bold">
          {month.slice(0, 4)}年{Number(month.slice(5))}月
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
        {month !== todayJST().slice(0, 7) && (
          <button onClick={() => setMonth(todayJST().slice(0, 7))} className="rounded-lg border bg-white px-3 py-2">
            今月
          </button>
        )}
      </div>
      {!config || !loaded ? (
        <p className="mt-3 text-gray-500">読み込み中…</p>
      ) : !exists ? (
        // 規格が保存されるまでは入力できない（入れた数字が規格とつながらなくなるため）
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-amber-800">
          先に管理者が規格を保存してください。
          {role === "admin" && (
            <Link href="/staff/shipping/settings/" className="ml-1 font-bold underline">
              規格・出荷先の設定へ
            </Link>
          )}
        </p>
      ) : (
        <Grid key={month} month={month} grades={config.grades} loaded={loaded} />
      )}
      {config && exists && yearData && <YearSummary year={year} grades={config.grades} data={yearData} />}
    </>
  );
}

function Grid({ month, grades, loaded }: { month: string; grades: Grade[]; loaded: Record<string, DayItems> }) {
  const [mode, setMode] = useState<Mode>("qty");
  const [data, setData] = useState<Record<string, DayItems>>(loaded);
  const [changed, setChanged] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const days: string[] = [];
  for (let d = `${month}-01`; d <= lastDayOf(month); d = addDays(d, 1)) days.push(d);
  const monthData = Object.fromEntries(days.map((d) => [d, data[d] ?? {}]));
  const summary = summarize(grades, monthData);
  const totalAmount = summary.reduce((n, s) => n + s.amount, 0);
  const totalWeight = Math.round(summary.reduce((n, s) => n + s.weightKg, 0) * 10) / 10;

  useEffect(() => {
    if (changed.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);

  function setCell(date: string, gradeId: string, field: "qty" | "price", v: number | undefined) {
    const day = { ...(data[date] ?? {}) };
    const item = { ...(day[gradeId] ?? {}) };
    if (v === undefined) delete item[field];
    else item[field] = v;
    if (Object.keys(item).length === 0) delete day[gradeId];
    else day[gradeId] = item;
    setData({ ...data, [date]: day });
    if (!changed.includes(date)) setChanged([...changed, date]);
    setMessage("");
  }

  /** 前の日の単価を、この日に写す（数量はそのまま） */
  function copyPrevPrices(date: string) {
    const prev = data[addDays(date, -1)] ?? {};
    const day = { ...(data[date] ?? {}) };
    for (const g of grades) {
      const p = prev[g.id]?.price;
      if (p === undefined) continue;
      day[g.id] = { ...(day[g.id] ?? {}), price: p };
    }
    setData({ ...data, [date]: day });
    if (!changed.includes(date)) setChanged([...changed, date]);
    setMessage("");
  }

  async function save() {
    setError("");
    setSaving(true);
    try {
      const { db } = await getFirebase();
      const batch = writeBatch(db);
      for (const d of changed) {
        const items = data[d] ?? {};
        if (Object.keys(items).length === 0) batch.delete(doc(db, `shipments/${d}`));
        else batch.set(doc(db, `shipments/${d}`), { items, updatedAt: serverTimestamp() });
      }
      await batch.commit();
      setChanged([]);
      setMessage("保存しました");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  function exportCsv() {
    const rows: (string | number)[][] = [["日付", "曜日", "区分", "規格", "数量", "単価", "金額"]];
    for (const d of days)
      for (const g of grades) {
        const it = data[d]?.[g.id];
        if (!it?.qty && it?.price === undefined) continue;
        rows.push([d, weekday(d), g.group, g.name, it?.qty ?? 0, it?.price ?? "", it?.qty && it.price !== undefined ? it.qty * it.price : ""]);
      }
    downloadCsv(`shipments_${month}.csv`, rows);
  }

  const dayTotal = (d: string) => grades.reduce((n, g) => n + (data[d]?.[g.id]?.qty ?? 0) * (data[d]?.[g.id]?.price ?? 0), 0);
  const dayQty = (d: string) => grades.reduce((n, g) => n + (data[d]?.[g.id]?.qty ?? 0), 0);
  const today = todayJST();

  return (
    <div className="pb-24">
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1">
          {(
            [
              ["qty", "数量を入れる"],
              ["price", "単価を入れる"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded-lg px-4 py-2 ${mode === m ? "bg-white font-bold shadow-sm" : "text-gray-600"}`}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={exportCsv} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
      </div>
      {mode === "price" && <p className="mt-2 text-sm text-gray-600">日付の下の「←」を押すと、前の日の単価をその日に写します。</p>}

      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max border-collapse text-sm">
          <thead className="bg-gray-50 text-xs">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-2 py-2 text-left">規格</th>
              {days.map((d) => (
                <th key={d} className={`px-1 py-1 text-center font-semibold ${d === today ? "bg-berry/15" : ""} ${weekday(d) === "日" ? "text-red-600" : weekday(d) === "土" ? "text-blue-600" : ""}`}>
                  <div>{Number(d.slice(8))}</div>
                  <div className="font-normal">{weekday(d)}</div>
                  {mode === "price" && (
                    <button onClick={() => copyPrevPrices(d)} className="mt-0.5 rounded border bg-white px-1 text-[10px]" title="前の日の単価を写す">
                      ←
                    </button>
                  )}
                </th>
              ))}
              <th className="bg-berry/10 px-2 py-2 text-right">合計</th>
              <th className="bg-berry/10 px-2 py-2 text-right">重量</th>
              <th className="bg-berry/10 px-2 py-2 text-right">金額</th>
              <th className="bg-berry/10 px-2 py-2 text-right">平均単価</th>
              <th className="bg-berry/10 px-2 py-2 text-right">1粒単価</th>
            </tr>
          </thead>
          <tbody>
            {grades.map((g, i) => {
              const s = summary[i];
              const firstOfGroup = i === 0 || grades[i - 1].group !== g.group;
              return (
                <tr key={g.id} className={firstOfGroup ? "border-t-2 border-gray-300" : "border-t"}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1">
                    <span className="mr-1 rounded bg-gray-100 px-1 text-xs">{g.group}</span>
                    <span className="font-semibold">{g.name}</span>
                    <div className="text-[10px] text-gray-500">
                      {g.gRange}g・{unitWeight(g)}g
                    </div>
                  </td>
                  {days.map((d) => (
                    <td key={d} className={`px-0.5 py-0.5 ${d === today ? "bg-berry/5" : ""}`}>
                      <Cell value={data[d]?.[g.id]?.[mode]} onChange={(v) => setCell(d, g.id, mode, v)} label={`${Number(d.slice(8))}日 ${g.group}${g.name} ${mode === "qty" ? "数量" : "単価"}`} />
                    </td>
                  ))}
                  <td className="bg-berry/5 px-2 text-right font-semibold tabular-nums">{s.qty.toLocaleString("ja-JP")}</td>
                  <td className="bg-berry/5 px-2 text-right tabular-nums">{s.weightKg.toLocaleString("ja-JP")}kg</td>
                  <td className="bg-berry/5 px-2 text-right font-semibold tabular-nums">
                    {s.amount.toLocaleString("ja-JP")}
                    {s.unpriced > 0 && <div className="text-[10px] font-normal text-amber-700">単価なし{s.unpriced}</div>}
                  </td>
                  <td className="bg-berry/5 px-2 text-right tabular-nums">{s.avgPrice !== null ? `¥${s.avgPrice.toLocaleString("ja-JP")}` : "—"}</td>
                  <td className="bg-berry/5 px-2 text-right tabular-nums">{s.perBerry !== null ? `¥${s.perBerry}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50 text-xs font-semibold">
            <tr className="border-t-2">
              <td className="sticky left-0 z-10 bg-gray-50 px-2 py-1">日計（数量）</td>
              {days.map((d) => (
                <td key={d} className="px-1 text-right tabular-nums">
                  {dayQty(d) || ""}
                </td>
              ))}
              <td className="px-2 text-right tabular-nums">{summary.reduce((n, s) => n + s.qty, 0).toLocaleString("ja-JP")}</td>
              <td className="px-2 text-right tabular-nums">{totalWeight.toLocaleString("ja-JP")}kg</td>
              <td colSpan={3} />
            </tr>
            <tr className="border-t">
              <td className="sticky left-0 z-10 bg-gray-50 px-2 py-1">日計（金額）</td>
              {days.map((d) => (
                <td key={d} className="px-1 text-right tabular-nums">
                  {dayTotal(d) ? (dayTotal(d) / 1000).toFixed(1) + "k" : ""}
                </td>
              ))}
              <td colSpan={2} />
              <td className="px-2 text-right tabular-nums">{totalAmount.toLocaleString("ja-JP")}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-500">日計（金額）の「k」は千円です（例：12.5k ＝ 12,500円）。金額は 数量×単価 で、単価が入っていない日の分は含みません。</p>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label={`${Number(month.slice(5))}月の出荷金額`} value={yen(totalAmount)} strong />
        <Tile label="出荷重量" value={`${totalWeight.toLocaleString("ja-JP")}kg`} />
        <Tile label="出荷日数" value={`${days.filter((d) => dayQty(d) > 0).length}日`} />
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <button onClick={save} disabled={saving || changed.length === 0} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          {message && <span className="text-sm text-green-700">{message}</span>}
          {changed.length > 0 && !message && <span className="text-sm text-gray-500">{changed.length}日分の変更を保存していません</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <div className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

/** 数字だけの小さな入力欄 */
function Cell({ value, onChange, label }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(value === undefined ? "" : String(value));
  }
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
        setText(t);
        onChange(t === "" ? undefined : Math.min(9_999_999, Number(t)));
      }}
      className="w-12 rounded border px-1 py-1 text-right text-sm tabular-nums"
    />
  );
}

/** 年間の月ごとの合計 */
function YearSummary({ year, grades, data }: { year: string; grades: Grade[]; data: Record<string, DayItems> }) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const rows = months
    .map((m) => {
      const days = Object.fromEntries(Object.entries(data).filter(([d]) => d.startsWith(m)));
      const s = summarize(grades, days);
      return { m, qty: s.reduce((n, x) => n + x.qty, 0), kg: Math.round(s.reduce((n, x) => n + x.weightKg, 0) * 10) / 10, amount: s.reduce((n, x) => n + x.amount, 0) };
    })
    .filter((r) => r.qty > 0);
  if (rows.length === 0) return null;
  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">{year}年 月ごとの出荷</h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="py-1">月</th>
            <th className="py-1 text-right">数量</th>
            <th className="py-1 text-right">重量</th>
            <th className="py-1 text-right">金額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.m} className="border-t">
              <td className="py-1">{Number(r.m.slice(5))}月</td>
              <td className="py-1 text-right tabular-nums">{r.qty.toLocaleString("ja-JP")}</td>
              <td className="py-1 text-right tabular-nums">{r.kg.toLocaleString("ja-JP")}kg</td>
              <td className="py-1 text-right font-semibold tabular-nums">{yen(r.amount)}</td>
            </tr>
          ))}
          <tr className="border-t-2 font-bold">
            <td className="py-1">合計</td>
            <td className="py-1 text-right tabular-nums">{rows.reduce((n, r) => n + r.qty, 0).toLocaleString("ja-JP")}</td>
            <td className="py-1 text-right tabular-nums">{(Math.round(rows.reduce((n, r) => n + r.kg, 0) * 10) / 10).toLocaleString("ja-JP")}kg</td>
            <td className="py-1 text-right tabular-nums">{yen(rows.reduce((n, r) => n + r.amount, 0))}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
