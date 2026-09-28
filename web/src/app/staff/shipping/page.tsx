"use client";

import { collection, doc, documentId, getDocs, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { addDays, shiftMonth, todayJST, weekday } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { guessYear, parseShipmentTable, summarize, unitWeight, useShipments, useShippingConfig, type DayItems, type Grade } from "@/lib/shipping";
import { openWorkbook, type Workbook } from "@/lib/xlsx";

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
  // 取り込みのあと、表を読み直すための番号
  const [version, setVersion] = useState(0);

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
        <>
          <PriceImport grades={config.grades} defaultYear={Number(year)} onDone={() => setVersion((v) => v + 1)} />
          <Grid key={`${month}_${version}`} month={month} grades={config.grades} loaded={loaded} />
        </>
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

  /** 期間の毎日に、規格ごとの単価をまとめて入れる（空欄の規格は変えない） */
  function applyBulkPrices(from: string, to: string, prices: Record<string, number>, onlyShipped: boolean) {
    const next = { ...data };
    const touched = new Set(changed);
    let count = 0;
    for (const d of days) {
      if (d < from || d > to) continue;
      const day = { ...(next[d] ?? {}) };
      let dayChanged = false;
      for (const [gid, price] of Object.entries(prices)) {
        if (onlyShipped && !day[gid]?.qty) continue;
        day[gid] = { ...(day[gid] ?? {}), price };
        dayChanged = true;
      }
      if (dayChanged) {
        next[d] = day;
        touched.add(d);
        count++;
      }
    }
    setData(next);
    setChanged([...touched]);
    setMessage("");
    return count;
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
      {mode === "price" && (
        <>
          <p className="mt-2 text-sm text-gray-600">日付の下の「←」を押すと、前の日の単価をその日に写します。</p>
          <BulkPrice month={month} grades={grades} onApply={applyBulkPrices} />
        </>
      )}

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

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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

/** 出荷の表（Excel）を取り込んで、日ごとの数量・単価をまとめて保存する */
function PriceImport({ grades, defaultYear, onDone }: { grades: Grade[]; defaultYear: number; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; book: Workbook | null; csv: string[][] | null } | null>(null);
  const [sheet, setSheet] = useState("");
  const [table, setTable] = useState<string[][] | null>(null);
  const [year, setYear] = useState(defaultYear);
  const [useQty, setUseQty] = useState(true);
  const [usePrice, setUsePrice] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function openSheet(book: Workbook, name: string, fileName: string) {
    setSheet(name);
    setTable(null);
    const rows = await book.readSheet(name);
    setTable(rows);
    const y = guessYear([...(rows.slice(0, 3).flat() ?? []), name, fileName]);
    if (y) setYear(y);
  }

  async function pick(f: File) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const buf = await f.arrayBuffer();
      if (/\.csv$/i.test(f.name)) {
        const rows = parseCsv(decodeCsv(buf).text);
        setFile({ name: f.name, book: null, csv: rows });
        setTable(rows);
        const y = guessYear([f.name]);
        if (y) setYear(y);
      } else {
        const book = await openWorkbook(buf);
        setFile({ name: f.name, book, csv: null });
        // 「日別実績」のシートを先に選ぶ（年の新しいものを優先）
        const names = book.sheetNames;
        const daily = names.filter((n) => /日別実績/.test(n)).sort((x, y) => (guessYear([y]) ?? 0) - (guessYear([x]) ?? 0));
        await openSheet(book, daily[0] ?? names[0], f.name);
      }
    } catch (e) {
      setError(`読み込めませんでした：${e instanceof Error ? e.message : String(e)}`);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  const parsed = table ? parseShipmentTable(table, grades, year) : null;
  const ok = parsed && !parsed.error ? parsed : null;
  const willQty = useQty && !!ok && ok.qtyDays! > 0;
  const willPrice = usePrice && !!ok && ok.priceDays! > 0;

  async function save() {
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const { db } = await getFirebase();
      // いま入っている内容を読んでから、表にある数量・単価だけ上書きする（表が空欄のところはそのまま）
      const snap = await getDocs(query(collection(db, "shipments"), where(documentId(), ">=", ok.from!), where(documentId(), "<=", ok.to!)));
      const current = new Map(snap.docs.map((d) => [d.id, (d.get("items") as DayItems) ?? {}]));
      const dates = [...new Set([...(willQty ? Object.keys(ok.qty!) : []), ...(willPrice ? Object.keys(ok.price!) : [])])].sort();
      const writes: [string, DayItems][] = [];
      for (const date of dates) {
        const items: DayItems = { ...(current.get(date) ?? {}) };
        let changed = false;
        const put = (gid: string, field: "qty" | "price", v: number) => {
          if (items[gid]?.[field] === v) return;
          items[gid] = { ...(items[gid] ?? {}), [field]: v };
          changed = true;
        };
        if (willQty) for (const [gid, v] of Object.entries(ok.qty![date] ?? {})) put(gid, "qty", v);
        if (willPrice) for (const [gid, v] of Object.entries(ok.price![date] ?? {})) put(gid, "price", v);
        if (changed) writes.push([date, items]);
      }
      // 1回に書けるのは500件までなので分ける
      for (let i = 0; i < writes.length; i += 400) {
        const batch = writeBatch(db);
        for (const [date, items] of writes.slice(i, i + 400)) batch.set(doc(db, `shipments/${date}`), { items, updatedAt: serverTimestamp() });
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

  return (
    <div className="mt-3">
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xlsb,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) pick(f);
        }}
      />
      {!file && (
        <button disabled={busy} onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-4 py-2 text-sm disabled:opacity-50">
          {busy ? "読み込み中…" : "Excelの出荷実績を取り込む（数量・単価）"}
        </button>
      )}
      {message && <p className="mt-2 text-sm text-green-700">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {file && (
        <section className="mt-2 rounded-2xl border border-berry/40 bg-white p-4 text-sm shadow-sm">
          <h2 className="font-bold">出荷実績の取り込み（{file.name}）</h2>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {file.book && (
              <label className="flex items-center gap-2">
                <span className="text-gray-600">タブ</span>
                <select
                  value={sheet}
                  disabled={busy}
                  onChange={(e) => openSheet(file.book!, e.target.value, file.name).catch((er) => setError(String(er)))}
                  className="rounded-lg border px-2 py-1 text-base"
                >
                  {file.book.sheetNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
                    {formatYmd(ok.from!)} 〜 {formatYmd(ok.to!)}
                  </b>
                  　数量：{ok.qtyDays}日分　単価：{ok.priceDays}日分
                </p>
                <div className="mt-2 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={useQty} disabled={ok.qtyDays === 0} onChange={(e) => setUseQty(e.target.checked)} />
                    数量を入れる
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={usePrice} disabled={ok.priceDays === 0} onChange={(e) => setUsePrice(e.target.checked)} />
                    単価を入れる
                  </label>
                </div>
                <ul className="mt-2 grid gap-x-4 gap-y-0.5 text-xs text-gray-700 sm:grid-cols-2">
                  {ok.matched!.map((m) => (
                    <li key={m.grade.id}>
                      表の「{m.label}」→ <b>{m.grade.group} {m.grade.name}</b>（数量{m.qtyDays}日・単価{m.priceDays}日）
                    </li>
                  ))}
                </ul>
                {ok.unmatched!.length > 0 && (
                  <p className="mt-2 text-xs text-amber-800">規格が見つからず入れないもの：{ok.unmatched!.join("、")}（規格の設定に追加すると入れられます）</p>
                )}
                <p className="mt-2 text-xs text-gray-500">表が空欄の日・規格は、今入っている内容のままです。</p>
              </>
            )
          )}
          <div className="mt-3 flex gap-2">
            <button disabled={busy || !ok || (!willQty && !willPrice)} onClick={save} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40">
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

const formatYmd = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;

/** 期間でまとめて単価を入れる */
function BulkPrice({
  month,
  grades,
  onApply,
}: {
  month: string;
  grades: Grade[];
  onApply: (from: string, to: string, prices: Record<string, number>, onlyShipped: boolean) => number;
}) {
  const first = `${month}-01`;
  const last = lastDayOf(month);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [onlyShipped, setOnlyShipped] = useState(false);
  const [note, setNote] = useState("");

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="mt-2 rounded-lg border border-berry bg-white px-4 py-2 text-sm font-bold text-berry">
        期間でまとめて単価を入れる
      </button>
    );

  const filled = Object.fromEntries(
    Object.entries(prices)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => [k, Number(v)]),
  );
  const count = Object.keys(filled).length;
  const valid = from >= first && to <= last && from <= to;

  return (
    <section className="mt-2 rounded-2xl border border-berry/40 bg-white p-4 shadow-sm">
      <h2 className="font-bold">期間でまとめて単価を入れる</h2>
      <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
        <label className="block">
          <span className="text-gray-600">期間</span>
          <input type="date" value={from} min={first} max={last} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border px-2 py-2 text-base" />
        </label>
        <span className="pb-2">〜</span>
        <label className="block">
          <span className="sr-only">終わり</span>
          <input type="date" value={to} min={first} max={last} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border px-2 py-2 text-base" />
        </label>
        <span className="pb-2 text-xs text-gray-500">表示している月（{Number(month.slice(5))}月）の中で選べます</span>
      </div>
      <p className="mt-3 text-sm text-gray-600">単価を変える規格だけ入れてください（空欄の規格はそのままです）。</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {grades.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-sm">
            <span className="w-32 shrink-0">
              <span className="mr-1 rounded bg-gray-100 px-1 text-xs">{g.group}</span>
              {g.name}
            </span>
            <input
              inputMode="numeric"
              value={prices[g.id] ?? ""}
              placeholder="—"
              aria-label={`${g.group}${g.name} まとめて入れる単価`}
              onChange={(e) => {
                const v = e.target.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "").slice(0, 7);
                setPrices({ ...prices, [g.id]: v });
                setNote("");
              }}
              className="w-24 rounded border px-2 py-1 text-right text-base tabular-nums"
            />
            <span className="text-xs text-gray-500">円</span>
          </label>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={onlyShipped} onChange={(e) => setOnlyShipped(e.target.checked)} />
        数量が入っている日だけに入れる
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          disabled={!valid || count === 0}
          onClick={() => {
            const n = onApply(from, to, filled, onlyShipped);
            setNote(`${n}日分に入れました。下の「保存する」を押すと保存されます。`);
          }}
          className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40"
        >
          表に入れる（{count}規格）
        </button>
        <button onClick={() => setOpen(false)} className="rounded-lg border px-4 py-2 text-sm">
          閉じる
        </button>
        {!valid && <span className="text-sm text-red-600">期間を正しく選んでください</span>}
        {note && <span className="text-sm text-green-700">{note}</span>}
      </div>
    </section>
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
