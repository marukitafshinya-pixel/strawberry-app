"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { todayJST } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import { useShipments } from "@/lib/shipping";
import { useStoreDaysWithRegi } from "@/lib/store";
import { OTHER_ITEMS, saveOtherSales, useOtherSales, type OtherKey, type OtherMonths } from "@/lib/totalSales";

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const yen = (n: number) => (n ? n.toLocaleString("ja-JP") : "");

export default function TotalPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <TotalView />
    </Suspense>
  );
}

function TotalView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const thisYear = Number(todayJST().slice(0, 4));
  const q = Number(params.get("year"));
  const year = q >= 2000 && q <= 2100 ? q : thisYear;
  const setYear = (y: number) => router.replace(`/staff/total/?year=${y}`);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const shipments = useShipments(from, to);
  const { days: store } = useStoreDaysWithRegi(from, to);
  const other = useOtherSales(year);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  return (
    <div className="pb-24">
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">トータル実績（{year}年）</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setYear(year - 1)} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前の年
        </button>
        <span className="text-lg font-bold">{year}年</span>
        <button onClick={() => setYear(year + 1)} className="rounded-lg border bg-white px-3 py-2">
          次の年 ›
        </button>
        {year !== thisYear && (
          <button onClick={() => setYear(thisYear)} className="rounded-lg border bg-white px-3 py-2 text-sm">
            今年
          </button>
        )}
      </div>
      {!shipments || !store || !other ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Table key={year} year={year} shipments={shipments} store={store} saved={other} />
      )}
    </div>
  );
}

type Row = { key: string; label: string; values: number[]; strong?: "sub" | "total"; input?: OtherKey; indent?: boolean };

function Table({
  year,
  shipments,
  store,
  saved,
}: {
  year: number;
  shipments: NonNullable<ReturnType<typeof useShipments>>;
  store: NonNullable<ReturnType<typeof useStoreDaysWithRegi>["days"]>;
  saved: OtherMonths;
}) {
  const [other, setOther] = useState<OtherMonths>(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 出荷：数量×単価（単価が入っている分だけ）
  const ship = MONTHS.map((m) =>
    Object.entries(shipments)
      .filter(([d]) => d.slice(5, 7) === m)
      .reduce((n, [, items]) => n + Object.values(items).reduce((a, it) => a + (it.qty && it.price !== undefined ? it.qty * it.price : 0), 0), 0),
  );
  // 店舗：直売・カフェ・いちご狩り。内訳がない日（売上合計だけの日）は、小計に売上合計を入れる
  const storeSum = (f: (d: (typeof store)[string]) => number) =>
    MONTHS.map((m) =>
      Object.entries(store)
        .filter(([d]) => d.slice(5, 7) === m)
        .reduce((n, [, d]) => n + f(d), 0),
    );
  const direct = storeSum((d) => d.direct ?? 0);
  const cafe = storeSum((d) => d.cafe ?? 0);
  const ichigo = storeSum((d) => d.ichigo ?? 0);
  const storeSub = storeSum((d) => {
    const parts = (d.direct ?? 0) + (d.cafe ?? 0) + (d.ichigo ?? 0);
    return parts || (d.total ?? 0);
  });
  const others = OTHER_ITEMS.map((it) => MONTHS.map((m) => other[m]?.[it.key] ?? 0));
  const total = MONTHS.map((_, i) => ship[i] + storeSub[i] + others.reduce((n, o) => n + o[i], 0));

  const rows: Row[] = [
    { key: "ship", label: "出荷（いちご）", values: ship },
    { key: "direct", label: "直売", values: direct, indent: true },
    { key: "cafe", label: "カフェ", values: cafe, indent: true },
    { key: "ichigo", label: "いちご狩り", values: ichigo, indent: true },
    { key: "storeSub", label: "店舗 小計", values: storeSub, strong: "sub" },
    ...OTHER_ITEMS.map((it, i) => ({ key: it.key, label: it.label, values: others[i], input: it.key })),
    { key: "total", label: "合計", values: total, strong: "total" },
  ];
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

  function setCell(m: string, k: OtherKey, v: number | null) {
    const row = { ...(other[m] ?? {}) };
    if (v === null) delete row[k];
    else row[k] = v;
    setOther({ ...other, [m]: row });
    setDirty(true);
    setMsg("");
  }
  async function save() {
    setErr("");
    setSaving(true);
    try {
      await saveOtherSales(year, other);
      setDirty(false);
      setMsg("保存しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  function exportCsv() {
    downloadCsv(`total_${year}.csv`, [
      ["項目", ...MONTHS.map((m) => `${Number(m)}月`), "年計"],
      ...rows.map((r) => [r.label, ...r.values.map(String), String(sum(r.values))]),
    ]);
  }

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="年の合計" value={sum(total)} strong />
        <Tile label="出荷（いちご）" value={sum(ship)} />
        <Tile label="店舗 小計" value={sum(storeSub)} />
        <Tile label="玉ねぎ・そば・委託ほか" value={sum(others.flat())} />
      </div>
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">項目</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-1 py-2 text-right">
                  {Number(m)}月
                </th>
              ))}
              <th className="bg-berry/10 px-2 py-2 text-right">年計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const bg = r.strong === "total" ? "bg-berry/10" : r.strong === "sub" ? "bg-gray-50" : "bg-white";
              return (
                <tr key={r.key} className={`border-t ${r.strong ? "font-bold" : ""} ${r.strong === "total" ? "border-t-2" : ""}`}>
                  <th className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1.5 text-left font-[inherit] ${bg} ${r.indent ? "pl-6 font-normal text-gray-700" : ""}`}>
                    {r.indent ? `店舗 ${r.label}` : r.label}
                  </th>
                  {MONTHS.map((m, i) => (
                    <td key={m} className={`px-1 py-1 text-right ${bg}`}>
                      {r.input ? <Num value={other[m]?.[r.input] ?? null} label={`${Number(m)}月の${r.label}`} onChange={(v) => setCell(m, r.input!, v)} /> : <span className="px-1">{yen(r.values[i])}</span>}
                    </td>
                  ))}
                  <td className={`px-2 text-right font-bold ${r.strong === "total" ? "bg-berry/20" : "bg-berry/5"}`}>{yen(sum(r.values))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-gray-500">
        出荷は「出荷実績」の数量×単価（仕切書で直した数字も入ります。単価がまだの日は入りません）。店舗は「店舗実績」の数字（10月1日からはレジの会計）で、内訳がなく売上合計だけの日は小計にだけ入ります。
        玉ねぎ・そば・作業委託＆冷蔵庫リースは、月ごとの合計をこの表に入れて「保存する」を押してください。
      </p>
      <div className="mt-2 flex gap-3 print:hidden">
        <button onClick={exportCsv} className="text-sm text-gray-600 underline">
          CSVで書き出す
        </button>
        <button onClick={() => window.print()} className="text-sm text-gray-600 underline">
          印刷
        </button>
      </div>
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] print:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2.5 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          {dirty && <span className="text-sm text-amber-700">まだ保存していません</span>}
          {msg && <span className="text-sm text-gray-600">{msg}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
          <span className="ml-auto text-sm">
            {year}年の合計 <b className="text-lg">{sum(total).toLocaleString("ja-JP")}円</b>
          </span>
        </div>
      </div>
    </>
  );
}

function Tile({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`rounded-xl p-3 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <p className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value.toLocaleString("ja-JP")}円</p>
    </div>
  );
}

function Num({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const fmt = (v: number | null) => (v === null ? "" : String(v));
  const [text, setText] = useState(fmt(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(fmt(value));
  }
  return (
    <input
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => {
        let t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[−ー－▲]/g, "-");
        t = t.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, "");
        setText(t);
        if (t === "" || t === "-") onChange(null);
        else onChange(Math.max(-999_999_999, Math.min(999_999_999, Number(t))));
      }}
      className="w-[5.2rem] rounded border px-1 py-1 text-right"
    />
  );
}
