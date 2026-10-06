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
import { OTHER_ITEMS, canForecast, saveOtherSales, useOtherSales, type Forecast, type ForecastKey, type OtherKey, type OtherMonths } from "@/lib/totalSales";

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const yen = (n: number) => (n ? n.toLocaleString("ja-JP") : "");

type Shipments = NonNullable<ReturnType<typeof useShipments>>;
type StoreDays = NonNullable<ReturnType<typeof useStoreDaysWithRegi>["days"]>;
/** 出荷の月ごとの金額：数量×単価（単価が入っている分だけ） */
const monthlyShip = (shipments: Shipments) =>
  MONTHS.map((m) =>
    Object.entries(shipments)
      .filter(([d]) => d.slice(5, 7) === m)
      .reduce((n, [, items]) => n + Object.values(items).reduce((a, it) => a + (it.qty && it.price !== undefined ? it.qty * it.price : 0), 0), 0),
  );
/** 店舗の月ごとの金額：直売・カフェ・いちご狩り。内訳がない日（売上合計だけの日）は、小計に売上合計を入れる */
const monthlyStore = (store: StoreDays) => {
  const sumBy = (f: (d: StoreDays[string]) => number) =>
    MONTHS.map((m) =>
      Object.entries(store)
        .filter(([d]) => d.slice(5, 7) === m)
        .reduce((n, [, d]) => n + f(d), 0),
    );
  return {
    direct: sumBy((d) => d.direct ?? 0),
    cafe: sumBy((d) => d.cafe ?? 0),
    ichigo: sumBy((d) => d.ichigo ?? 0),
    sub: sumBy((d) => (d.direct ?? 0) + (d.cafe ?? 0) + (d.ichigo ?? 0) || (d.total ?? 0)),
  };
};

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
  // 予測の参考にする、前の年の実績
  const prevShipments = useShipments(`${year - 1}-01-01`, `${year - 1}-12-31`);
  const { days: prevStore } = useStoreDaysWithRegi(`${year - 1}-01-01`, `${year - 1}-12-31`);
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
      {!shipments || !store || !other || !prevShipments || !prevStore ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Table key={year} year={year} shipments={shipments} store={store} saved={other.months} savedForecast={other.forecast} prevShipments={prevShipments} prevStore={prevStore} />
      )}
    </div>
  );
}

type Row = {
  key: string;
  label: string;
  /** 合計に使う数字（予測を入れた月は予測） */
  values: number[];
  strong?: "sub" | "total";
  input?: OtherKey;
  indent?: boolean;
  /** 予測を入れられる行（出荷・店舗） */
  fkey?: ForecastKey;
  /** 実績（予測を入れられる行だけ） */
  actual?: number[];
  /** その月に予測を使っているか */
  isFc?: boolean[];
  /** 前の年の実績（予測の参考） */
  prev?: number[];
};

function Table({
  year,
  shipments,
  store,
  saved,
  savedForecast,
  prevShipments,
  prevStore,
}: {
  year: number;
  shipments: Shipments;
  store: StoreDays;
  prevShipments: Shipments;
  prevStore: StoreDays;
  saved: OtherMonths;
  savedForecast: Forecast;
}) {
  const [other, setOther] = useState<OtherMonths>(saved);
  const [fc, setFc] = useState<Forecast>(savedForecast);
  const today = todayJST();
  const fcMonth = MONTHS.map((m) => canForecast(year, m, today));
  const curMonth = today.startsWith(`${year}-`) ? today.slice(5, 7) : "";
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

  const ship = monthlyShip(shipments);
  const { direct, cafe, ichigo, sub: storeSub } = monthlyStore(store);
  const prevShip = monthlyShip(prevShipments);
  const prev = monthlyStore(prevStore);
  // 予測：当月と先の月だけ。過ぎた月は予測があっても実績を使う
  const fcOf = (k: ForecastKey, i: number): number | undefined => (fcMonth[i] ? fc[MONTHS[i]]?.[k] : undefined);
  const use = (k: ForecastKey, actual: number[]) => {
    const isFc = actual.map((_, i) => fcOf(k, i) !== undefined);
    return { values: actual.map((a, i) => fcOf(k, i) ?? a), isFc, actual };
  };
  const uShip = use("ship", ship);
  const uDirect = use("direct", direct);
  const uCafe = use("cafe", cafe);
  const uIchigo = use("ichigo", ichigo);
  // 店舗の小計：店舗のどれかに予測を入れた月は、直売・カフェ・いちご狩りの（予測を入れた）合計
  const storeFc = MONTHS.map((_, i) => uDirect.isFc[i] || uCafe.isFc[i] || uIchigo.isFc[i]);
  const uStoreSub = storeSub.map((a, i) => (storeFc[i] ? uDirect.values[i] + uCafe.values[i] + uIchigo.values[i] : a));
  const others = OTHER_ITEMS.map((it) => MONTHS.map((m) => other[m]?.[it.key] ?? 0));
  const total = MONTHS.map((_, i) => uShip.values[i] + uStoreSub[i] + others.reduce((n, o) => n + o[i], 0));
  const totalFc = MONTHS.map((_, i) => uShip.isFc[i] || storeFc[i]);

  const rows: Row[] = [
    { key: "ship", label: "出荷（いちご）", fkey: "ship", ...uShip, prev: prevShip },
    { key: "direct", label: "直売", indent: true, fkey: "direct", ...uDirect, prev: prev.direct },
    { key: "cafe", label: "カフェ", indent: true, fkey: "cafe", ...uCafe, prev: prev.cafe },
    { key: "ichigo", label: "いちご狩り", indent: true, fkey: "ichigo", ...uIchigo, prev: prev.ichigo },
    { key: "storeSub", label: "店舗 小計", values: uStoreSub, strong: "sub", isFc: storeFc },
    ...OTHER_ITEMS.map((it, i) => ({ key: it.key, label: it.label, values: others[i], input: it.key })),
    { key: "total", label: "合計", values: total, strong: "total", isFc: totalFc },
  ];
  const anyFc = totalFc.some(Boolean);
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

  function setCell(m: string, k: OtherKey, v: number | null) {
    const row = { ...(other[m] ?? {}) };
    if (v === null) delete row[k];
    else row[k] = v;
    setOther({ ...other, [m]: row });
    setDirty(true);
    setMsg("");
  }
  function setForecast(m: string, k: ForecastKey, v: number | null) {
    const row = { ...(fc[m] ?? {}) };
    if (v === null) delete row[k];
    else row[k] = v;
    setFc({ ...fc, [m]: row });
    setDirty(true);
    setMsg("");
  }
  async function save() {
    setErr("");
    setSaving(true);
    try {
      await saveOtherSales(year, other, fc, today);
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
      ...rows.map((r) => [r.indent ? `店舗 ${r.label}` : r.label, ...r.values.map((v, i) => `${v}${r.isFc?.[i] ? "（予測）" : ""}`), String(sum(r.values))]),
    ]);
  }

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="年の合計" value={sum(total)} strong />
        <Tile label="出荷（いちご）" value={sum(uShip.values)} />
        <Tile label="店舗 小計" value={sum(uStoreSub)} />
        <Tile label="玉ねぎ・そば・委託ほか" value={sum(others.flat())} />
      </div>
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">項目</th>
              {MONTHS.map((m) => (
                <th key={m} className={`px-1 py-2 text-right ${m === curMonth ? "text-berry-dark" : ""}`}>
                  {Number(m)}月{m === curMonth && <span className="ml-0.5 text-[10px]">（今月）</span>}
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
                  {MONTHS.map((m, i) => {
                    const fcCell = r.isFc?.[i] ? "bg-amber-50 text-amber-900" : bg;
                    if (r.input)
                      return (
                        <td key={m} className={`px-1 py-1 text-right ${bg}`}>
                          <Num value={other[m]?.[r.input] ?? null} label={`${Number(m)}月の${r.label}`} onChange={(v) => setCell(m, r.input!, v)} />
                        </td>
                      );
                    if (r.fkey && fcMonth[i])
                      return (
                        <td key={m} className={`px-1 py-1 text-right align-top ${fcCell}`}>
                          <Num value={fc[m]?.[r.fkey] ?? null} label={`${Number(m)}月の${r.indent ? "店舗 " : ""}${r.label}の予測`} placeholder="予測" onChange={(v) => setForecast(m, r.fkey!, v)} />
                          {m === curMonth && <span className="block pr-1 text-[10px] font-normal text-gray-500">実績 {(r.actual?.[i] ?? 0).toLocaleString("ja-JP")}</span>}
                          <button
                            onClick={() => (r.prev?.[i] ? setForecast(m, r.fkey!, r.prev[i]) : undefined)}
                            disabled={!r.prev?.[i]}
                            title="押すと、前の年の実績を予測に入れます"
                            aria-label={`${Number(m)}月の${r.indent ? "店舗 " : ""}${r.label}の前年`}
                            className="block w-full pr-1 text-right text-[10px] font-normal text-sky-700 underline decoration-dotted disabled:text-gray-400 disabled:no-underline"
                          >
                            前年 {(r.prev?.[i] ?? 0).toLocaleString("ja-JP")}
                          </button>
                        </td>
                      );
                    return (
                      <td key={m} className={`px-1 py-1 text-right ${fcCell}`}>
                        <span className="px-1">{yen(r.values[i])}</span>
                      </td>
                    );
                  })}
                  <td className={`px-2 text-right font-bold ${r.strong === "total" ? "bg-berry/20" : "bg-berry/5"}`}>{yen(sum(r.values))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-gray-600">
        <span className="mr-1 inline-block rounded bg-amber-50 px-1.5 text-amber-900 ring-1 ring-amber-200">予測</span>
        出荷と店舗は、今月とそれより先の月に予測を入れられます。マスの下の「前年」は前の年の同じ月の実績で、押すとその金額が予測に入ります。予測を入れた月は、合計に予測を使います（今月は、今日までの実績も小さく出ます）。月が過ぎると予測は使わず、実績になります。
        {anyFc && <b className="ml-1 text-amber-800">（色の付いた数字は予測を含みます）</b>}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
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

function Num({ value, onChange, label, placeholder }: { value: number | null; onChange: (v: number | null) => void; label: string; placeholder?: string }) {
  // 3けたごとにカンマを入れて見せる
  const fmt = (v: number | null) => (v === null ? "" : v.toLocaleString("ja-JP"));
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
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        let t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[−ー－▲]/g, "-");
        t = t.replace(/[^0-9-]/g, "").replace(/(?!^)-/g, "");
        if (t === "" || t === "-") {
          setText(t);
          return onChange(null);
        }
        const n = Math.max(-999_999_999, Math.min(999_999_999, Number(t)));
        setText(fmt(n));
        setPrev(n);
        onChange(n);
      }}
      className="w-[5.2rem] rounded border px-1 py-1 text-right"
    />
  );
}
