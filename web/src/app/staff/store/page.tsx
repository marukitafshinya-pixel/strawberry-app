"use client";

import { collection, doc, documentId, getDocs, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { addDays, shiftMonth, todayJST, weekday } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { guessYear } from "@/lib/shipping";
import { STORE_ITEMS, STORE_KEYS, parseStoreSheet, useStoreDays, type StoreDay, type StoreKey } from "@/lib/store";
import { openWorkbook, type Workbook } from "@/lib/xlsx";

const lastDayOf = (ym: string) => addDays(`${shiftMonth(ym, 1)}-01`, -1);
const num = (v: number) => v.toLocaleString("ja-JP");

export default function StorePage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <StoreView />
    </Suspense>
  );
}

function StoreView() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/store/?month=${m}`);
  const loaded = useStoreDays(`${month}-01`, lastDayOf(month));
  const year = month.slice(0, 4);
  const yearData = useStoreDays(`${year}-01-01`, `${year}-12-31`);
  // 取り込みのあと、表を読み直すための番号
  const [version, setVersion] = useState(0);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">店舗実績</h1>
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
      {!loaded ? (
        <p className="mt-3 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <StoreImport defaultYear={Number(year)} onDone={() => setVersion((v) => v + 1)} />
          <Grid key={`${month}_${version}`} month={month} loaded={loaded} />
        </>
      )}
      {yearData && <YearSummary year={year} data={yearData} />}
    </>
  );
}

function Grid({ month, loaded }: { month: string; loaded: Record<string, StoreDay> }) {
  const [data, setData] = useState<Record<string, StoreDay>>(loaded);
  const [changed, setChanged] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const today = todayJST();

  const days: string[] = [];
  for (let d = `${month}-01`; d <= lastDayOf(month); d = addDays(d, 1)) days.push(d);
  const rowTotal = (k: StoreKey) => days.reduce((n, d) => n + (data[d]?.[k] ?? 0), 0);

  useEffect(() => {
    if (changed.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed]);

  function setCell(date: string, k: StoreKey, v: number | undefined) {
    const day = { ...(data[date] ?? {}) };
    if (v === undefined) delete day[k];
    else day[k] = v;
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
        const day = data[d] ?? {};
        if (Object.keys(day).length === 0) batch.delete(doc(db, `storeDaily/${d}`));
        else batch.set(doc(db, `storeDaily/${d}`), { ...day, updatedAt: serverTimestamp() });
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
    const rows: (string | number)[][] = [["日付", "曜日", ...STORE_ITEMS.map((i) => i.label)]];
    for (const d of days) {
      const day = data[d];
      if (!day || Object.keys(day).length === 0) continue;
      rows.push([d, weekday(d), ...STORE_KEYS.map((k) => day[k] ?? "")]);
    }
    rows.push(["合計", "", ...STORE_KEYS.map((k) => rowTotal(k))]);
    downloadCsv(`store_${month}.csv`, rows);
  }

  const perCustomer = (sales: number, customers: number) => (customers > 0 ? yen(Math.round(sales / customers)) : "－");

  return (
    <div className="pb-24">
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={exportCsv} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
      </div>

      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max border-collapse text-sm">
          <thead className="bg-gray-50 text-xs">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-2 py-2 text-left">項目</th>
              {days.map((d) => (
                <th key={d} className={`px-1 py-1 text-center font-semibold ${d === today ? "bg-berry/15" : ""} ${weekday(d) === "日" ? "text-red-600" : weekday(d) === "土" ? "text-blue-600" : ""}`}>
                  <div>{Number(d.slice(8))}</div>
                  <div className="font-normal">{weekday(d)}</div>
                </th>
              ))}
              <th className="bg-berry/10 px-2 py-2 text-right">合計</th>
            </tr>
          </thead>
          <tbody>
            {STORE_ITEMS.map((it, i) => {
              const isSales = it.unit === "円";
              const group = i % 2 === 0 || it.key === "discount";
              return (
                <tr key={it.key} className={group ? "border-t-2 border-gray-300" : "border-t"}>
                  <td className={`sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1 ${isSales ? "font-semibold" : "pl-4 text-gray-600"}`}>{it.label}</td>
                  {days.map((d) => (
                    <td key={d} className={`px-0.5 py-0.5 ${d === today ? "bg-berry/5" : ""}`}>
                      <Cell wide={isSales} value={data[d]?.[it.key]} onChange={(v) => setCell(d, it.key, v)} label={`${Number(d.slice(8))}日 ${it.label}`} />
                    </td>
                  ))}
                  <td className="whitespace-nowrap bg-berry/5 px-2 text-right font-semibold tabular-nums">
                    {num(rowTotal(it.key))}
                    {isSales ? "円" : "人"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-500">売上は円、客数は人で入れてください。売上合計はExcelと同じく、入れた数字をそのまま使います（値引き後の金額など）。</p>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={`${Number(month.slice(5))}月の売上合計`} value={yen(rowTotal("total"))} sub={`客数 ${num(rowTotal("totalCustomers"))}人・客単価 ${perCustomer(rowTotal("total"), rowTotal("totalCustomers"))}`} strong />
        <Tile label="直売売上" value={yen(rowTotal("direct"))} sub={`客数 ${num(rowTotal("directCustomers"))}人・客単価 ${perCustomer(rowTotal("direct"), rowTotal("directCustomers"))}`} />
        <Tile label="カフェ売上" value={yen(rowTotal("cafe"))} sub={`客数 ${num(rowTotal("cafeCustomers"))}人・客単価 ${perCustomer(rowTotal("cafe"), rowTotal("cafeCustomers"))}`} />
        <Tile label="いちご狩り売上" value={yen(rowTotal("ichigo"))} sub={`客数 ${num(rowTotal("ichigoCustomers"))}人・客単価 ${perCustomer(rowTotal("ichigo"), rowTotal("ichigoCustomers"))}`} />
        <Tile label="値引額" value={yen(rowTotal("discount"))} />
        <Tile label="営業日数" value={`${days.filter((d) => (data[d]?.total ?? 0) > 0).length}日`} />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <button disabled={saving || changed.length === 0} onClick={save} className="rounded-lg bg-berry px-8 py-3 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          {changed.length > 0 && <span className="text-sm text-amber-700">{changed.length}日分 まだ保存していません</span>}
          {message && <span className="text-sm text-green-700">{message}</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>
    </div>
  );
}

/** Excel の「日別実績」タブから、店舗実績をまとめて取り込む */
function StoreImport({ defaultYear, onDone }: { defaultYear: number; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; book: Workbook } | null>(null);
  const [sheet, setSheet] = useState("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [year, setYear] = useState(defaultYear);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function openSheet(book: Workbook, name: string, fileName: string) {
    setSheet(name);
    setTable(null);
    const rows = await book.readSheet(name);
    setTable(rows);
    const y = guessYear([...rows.slice(0, 3).flat(), name, fileName]);
    if (y) setYear(y);
  }

  async function pick(f: File) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const book = await openWorkbook(await f.arrayBuffer());
      setFile({ name: f.name, book });
      const daily = book.sheetNames.filter((n) => /日別実績/.test(n)).sort((x, y) => (guessYear([y]) ?? 0) - (guessYear([x]) ?? 0));
      await openSheet(book, daily[0] ?? book.sheetNames[0], f.name);
    } catch (e) {
      setError(`読み込めませんでした：${e instanceof Error ? e.message : String(e)}`);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  const parsed = table ? parseStoreSheet(table, year) : null;
  const ok = parsed && !parsed.error ? parsed : null;
  const dayCount = ok ? Object.keys(ok.days!).length : 0;

  async function save() {
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const { db } = await getFirebase();
      // 今入っている内容を読んでから、表にある項目だけ上書きする（表が空欄のところはそのまま）
      const snap = await getDocs(query(collection(db, "storeDaily"), where(documentId(), ">=", ok.from!), where(documentId(), "<=", ok.to!)));
      const current = new Map(snap.docs.map((d) => [d.id, Object.fromEntries(STORE_KEYS.filter((k) => typeof d.get(k) === "number").map((k) => [k, d.get(k) as number])) as StoreDay]));
      const writes: [string, StoreDay][] = [];
      for (const [date, day] of Object.entries(ok.days!)) {
        const cur = current.get(date) ?? {};
        const next = { ...cur, ...day };
        if (STORE_KEYS.every((k) => cur[k] === next[k])) continue;
        writes.push([date, next]);
      }
      for (let i = 0; i < writes.length; i += 400) {
        const batch = writeBatch(db);
        for (const [date, day] of writes.slice(i, i + 400)) batch.set(doc(db, `storeDaily/${date}`), { ...day, updatedAt: serverTimestamp() });
        await batch.commit();
      }
      setMessage(writes.length > 0 ? `${writes.length}日分を保存しました。` : "すでに同じ内容が入っていました（変更なし）。");
      setFile(null);
      setTable(null);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;

  return (
    <div className="mt-3">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xlsb"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) pick(f);
        }}
      />
      {!file && (
        <button disabled={busy} onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-4 py-2 text-sm disabled:opacity-50">
          {busy ? "読み込み中…" : "Excelの店舗実績を取り込む"}
        </button>
      )}
      {message && <p className="mt-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {file && (
        <section className="mt-2 rounded-2xl border border-berry/40 bg-white p-4 text-sm shadow-sm">
          <h2 className="font-bold">店舗実績の取り込み（{file.name}）</h2>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-gray-600">タブ</span>
              <select value={sheet} disabled={busy} onChange={(e) => openSheet(file.book, e.target.value, file.name).catch((er) => setError(String(er)))} className="rounded-lg border px-2 py-1 text-base">
                {file.book.sheetNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-gray-600">何年の実績ですか</span>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-lg border px-2 py-1 text-base">
                {Array.from({ length: 8 }, (_, i) => defaultYear + 1 - i).map((y) => (
                  <option key={y} value={y}>
                    {y}年
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!table ? (
            <p className="mt-2 text-gray-500">読み込み中…</p>
          ) : parsed?.error ? (
            <p className="mt-2 text-red-600">{parsed.error}</p>
          ) : (
            ok && (
              <>
                <p className="mt-2">
                  <b>
                    {md(ok.from!)} 〜 {md(ok.to!)}
                  </b>
                  　{dayCount}日分を入れます。
                </p>
                <p className="mt-1 text-xs text-gray-700">読み取る項目：{ok.found!.join("・")}</p>
                {ok.missing!.length > 0 && <p className="mt-1 text-xs text-amber-800">見つからなかった項目：{ok.missing!.join("・")}</p>}
                <p className="mt-1 text-xs text-gray-500">表が空欄（0）の日・項目は、今入っている内容のままです。</p>
              </>
            )
          )}
          <div className="mt-3 flex gap-2">
            <button disabled={busy || !ok || dayCount === 0} onClick={save} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40">
              {busy ? "保存中…" : "取り込んで保存する"}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setFile(null);
                setTable(null);
              }}
              className="rounded-lg border px-4 py-2"
            >
              やめる
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500">表示中の月の表で、まだ保存していない入力があるときは、先に保存してください。</p>
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <div className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`mt-0.5 text-xs ${strong ? "text-white/90" : "text-gray-600"}`}>{sub}</div>}
    </div>
  );
}

/** 数字だけの小さな入力欄 */
function Cell({ value, onChange, label, wide }: { value: number | undefined; onChange: (v: number | undefined) => void; label: string; wide?: boolean }) {
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
        onChange(t === "" ? undefined : Math.min(99_999_999, Number(t)));
      }}
      className={`${wide ? "w-20" : "w-12"} rounded border px-1 py-1 text-right text-sm tabular-nums`}
    />
  );
}

/** 年間の月ごとの合計 */
function YearSummary({ year, data }: { year: string; data: Record<string, StoreDay> }) {
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const sum = (m: string, k: StoreKey) => Object.entries(data).reduce((n, [d, v]) => n + (d.startsWith(m) ? (v[k] ?? 0) : 0), 0);
  const rows = months.map((m) => ({ m, ...Object.fromEntries(STORE_KEYS.map((k) => [k, sum(m, k)])) }) as { m: string } & Record<StoreKey, number>).filter((r) => STORE_KEYS.some((k) => r[k] > 0));
  if (rows.length === 0) return null;
  const cols: { k: StoreKey; label: string }[] = [
    { k: "direct", label: "直売" },
    { k: "directCustomers", label: "客数" },
    { k: "cafe", label: "カフェ" },
    { k: "cafeCustomers", label: "客数" },
    { k: "ichigo", label: "いちご狩り" },
    { k: "ichigoCustomers", label: "客数" },
    { k: "total", label: "売上合計" },
    { k: "totalCustomers", label: "客数" },
    { k: "discount", label: "値引額" },
  ];
  return (
    <section className="mt-6 overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">{year}年 月ごとの店舗実績</h2>
      <table className="mt-2 w-full min-w-[48rem] text-sm tabular-nums">
        <thead>
          <tr className="text-xs text-gray-500">
            <th className="py-1 text-left">月</th>
            {cols.map((c) => (
              <th key={c.k} className="py-1 text-right">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.m} className="border-t">
              <td className="py-1">{Number(r.m.slice(5))}月</td>
              {cols.map((c) => (
                <td key={c.k} className={`py-1 text-right ${c.k === "total" ? "font-semibold" : ""}`}>
                  {num(r[c.k])}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t-2 font-bold">
            <td className="py-1">合計</td>
            {cols.map((c) => (
              <td key={c.k} className="py-1 text-right">
                {num(rows.reduce((n, r) => n + r[c.k], 0))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}
