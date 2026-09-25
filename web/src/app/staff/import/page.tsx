"use client";

import { deleteDoc, doc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, guessColumns, parseAmount, parseCsv, parseDate, type Encoding } from "@/lib/csv";
import { formatJa, isValidYmd } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { parseItemCsv, periodFromFileName, useItemRefs, type ItemRef } from "@/lib/itemRefs";
import { yen } from "@/lib/reservations";
import { useSales } from "@/lib/sales";

export default function ImportPage() {
  const { role } = useAuth();
  const [fileName, setFileName] = useState("");
  const [buf, setBuf] = useState<ArrayBuffer | null>(null);
  const [forced, setForced] = useState<Encoding | "">("");
  const [hasHeader, setHasHeader] = useState(true);
  const [dateCol, setDateCol] = useState(0);
  const [amountCol, setAmountCol] = useState(1);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);

  const decoded = useMemo(() => (buf ? decodeCsv(buf, forced || undefined) : null), [buf, forced]);
  const rows = useMemo(() => (decoded ? parseCsv(decoded.text) : []), [decoded]);
  const header = hasHeader ? (rows[0] ?? []) : (rows[0] ?? []).map((_, i) => `${i + 1}列目`);
  const body = hasHeader ? rows.slice(1) : rows;

  /** 日付ごとに合計する（同じ日付は合算） */
  const result = useMemo(() => {
    const totals = new Map<string, { amount: number; count: number }>();
    let skipped = 0;
    for (const r of body) {
      const d = parseDate(r[dateCol] ?? "");
      const a = parseAmount(r[amountCol] ?? "");
      if (!d || a === null) {
        skipped++;
        continue;
      }
      const t = totals.get(d) ?? { amount: 0, count: 0 };
      totals.set(d, { amount: t.amount + a, count: t.count + 1 });
    }
    const list = [...totals.entries()].map(([date, t]) => ({ date, ...t })).sort((a, b) => a.date.localeCompare(b.date));
    return { list, skipped };
  }, [body, dateCol, amountCol]);

  const first = result.list[0]?.date ?? "0000-00-00";
  const last = result.list.at(-1)?.date ?? "0000-00-00";
  const { value: appSales } = useSales(first, last);
  const appDays = new Set((appSales ?? []).filter((s) => s.status === "completed").map((s) => s.date));

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;

  async function onFile(f: File | undefined) {
    setError("");
    setDone("");
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) return setError("ファイルが大きすぎます（20MBまで）");
    setFileName(f.name);
    const b = await f.arrayBuffer();
    setBuf(b);
    const r = parseCsv(decodeCsv(b).text);
    const g = guessColumns(r[0] ?? []);
    setDateCol(g.date);
    setAmountCol(g.amount);
  }

  async function save() {
    setError("");
    setDone("");
    if (result.list.length === 0) return setError("取り込める行がありません。日付と金額の列を確かめてください");
    if (!window.confirm(`${result.list.length}日分の売上を取り込みます。すでに取り込んである同じ日付は上書きされます。よろしいですか？`)) return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      // 一度に書き込める数に上限があるので、400件ずつに分ける
      for (let i = 0; i < result.list.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of result.list.slice(i, i + 400)) {
          batch.set(doc(db, `importedSales/${d.date}`), { amount: d.amount, source: "airregi", importedAt: serverTimestamp() });
        }
        await batch.commit();
      }
      setDone(`${result.list.length}日分（${formatJa(first, true)}〜${formatJa(last, true)}）を取り込みました。`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const total = result.list.reduce((n, d) => n + d.amount, 0);

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">過去売上の取り込み（Airレジ）</h1>
      <p className="mt-1 text-sm text-gray-600">
        AirレジからダウンロードしたCSVファイルを選んでください。日付ごとに合計して取り込みます。同じ日付を取り込み直すと上書きします。
        アプリで会計した日は、アプリの会計の合計を優先します。
      </p>

      <section className="mt-4 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="text-sm text-gray-600">① CSVファイル</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="mt-1 block w-full text-sm" />
        </label>
        {decoded && (
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-gray-600">{fileName}</span>
            <label className="flex items-center gap-1">
              文字コード
              <select value={forced} onChange={(e) => setForced(e.target.value as Encoding | "")} className="rounded border px-2 py-1">
                <option value="">自動（{decoded.encoding === "utf-8" ? "UTF-8" : "Shift_JIS"}）</option>
                <option value="utf-8">UTF-8</option>
                <option value="shift_jis">Shift_JIS</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              1行目は見出し
            </label>
          </div>
        )}
      </section>

      {decoded && rows.length > 0 && (
        <>
          <section className="mt-4 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-sm text-gray-600">② どの列を使うか選んでください（文字化けしているときは、上の「文字コード」を切り替えてください）</p>
            <div className="flex flex-wrap gap-4">
              <label className="text-sm">
                日付の列
                <select value={dateCol} onChange={(e) => setDateCol(Number(e.target.value))} className="ml-2 rounded-lg border px-2 py-2 text-base">
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `${i + 1}列目`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                金額の列
                <select value={amountCol} onChange={(e) => setAmountCol(Number(e.target.value))} className="ml-2 rounded-lg border px-2 py-2 text-base">
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `${i + 1}列目`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="overflow-x-auto">
              <p className="text-xs text-gray-500">ファイルの最初の5行</p>
              <table className="mt-1 min-w-max text-xs">
                <tbody>
                  {rows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t">
                      {r.map((c, j) => (
                        <td key={j} className={`px-2 py-1 ${j === dateCol ? "bg-blue-50" : j === amountCol ? "bg-amber-50" : ""}`}>
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <h2 className="font-bold">③ 取り込む内容の確認</h2>
            <p className="mt-1 text-sm">
              {result.list.length}日分・合計 <b>{yen(total)}</b>
              {result.skipped > 0 && <span className="ml-2 text-amber-700">（日付か金額が読めない {result.skipped}行は飛ばします）</span>}
            </p>
            <div className="mt-2 max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs text-gray-500">
                  <tr>
                    <th className="py-1">日付</th>
                    <th className="py-1 text-right">行数</th>
                    <th className="py-1 text-right">合計</th>
                    <th className="py-1 pl-2">備考</th>
                  </tr>
                </thead>
                <tbody>
                  {result.list.map((d) => (
                    <tr key={d.date} className="border-t">
                      <td className="py-1">{formatJa(d.date, true)}</td>
                      <td className="py-1 text-right tabular-nums">{d.count}</td>
                      <td className="py-1 text-right tabular-nums">{yen(d.amount)}</td>
                      <td className="py-1 pl-2 text-xs text-gray-500">{appDays.has(d.date) ? "アプリの会計があるため、表示はアプリの合計を優先" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            {done && <p className="mt-3 rounded-lg bg-green-50 p-2 text-sm text-green-800">{done}</p>}
            <button
              onClick={save}
              disabled={saving || result.list.length === 0}
              className="mt-3 w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-40"
            >
              {saving ? "取り込み中…" : `${result.list.length}日分を取り込む`}
            </button>
          </section>
        </>
      )}
      {decoded && rows.length === 0 && <p className="mt-4 text-red-600">ファイルの中身が読めませんでした。</p>}

      <ItemImport />
    </>
  );
}

/** Airレジの「商品別売上」CSVを、去年の実績として取り込む */
function ItemImport() {
  const { value: refs } = useItemRefs();
  const [items, setItems] = useState<ItemRef[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [saving, setSaving] = useState(false);

  async function onFile(f: File | undefined) {
    setError("");
    setDone("");
    setItems(null);
    if (!f) return;
    const r = parseItemCsv(parseCsv(decodeCsv(await f.arrayBuffer()).text));
    if (r.error) return setError(r.error);
    setItems(r.items);
    const p = periodFromFileName(f.name);
    setFrom(p?.from ?? "");
    setTo(p?.to ?? "");
  }

  async function save() {
    if (!items) return;
    setError("");
    if (!isValidYmd(from) || !isValidYmd(to) || from > to) return setError("期間を正しく入れてください");
    const id = `${from}_${to}`;
    if (refs?.some((r) => r.id === id) && !window.confirm("同じ期間の実績がすでにあります。上書きしますか？")) return;
    setSaving(true);
    try {
      const { db } = await getFirebase();
      await setDoc(doc(db, `itemReferences/${id}`), { from, to, items, importedAt: serverTimestamp() });
      setDone(`${items.length}品目を取り込みました。設定画面の「去年の実績から商品を追加」や、「商品別の実績」で使えます。`);
      setItems(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("この実績を削除しますか？")) return;
    try {
      const { db } = await getFirebase();
      await deleteDoc(doc(db, `itemReferences/${id}`));
    } catch (e) {
      setError(errorText(e));
    }
  }

  const total = (items ?? []).reduce((n, i) => n + i.amount, 0);
  return (
    <section className="mt-8 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">商品別の売上（去年の実績）</h2>
      <p className="text-sm text-gray-600">
        Airレジの「売上集計」→「商品別」でダウンロードしたCSVを選びます。商品の登録や、今年の売れ行きと比べる目安に使います。
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="block text-sm" />
      {items && (
        <>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="block">
              <span className="text-gray-600">期間</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border px-2 py-2 text-base" />
            </label>
            <span className="pb-2">〜</span>
            <label className="block">
              <span className="sr-only">終わり</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border px-2 py-2 text-base" />
            </label>
          </div>
          <p className="text-sm">
            {items.length}品目・合計 <b>{yen(total)}</b>
          </p>
          <div className="max-h-60 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-gray-500">
                <tr>
                  <th className="py-1">商品名</th>
                  <th className="py-1">カテゴリー</th>
                  <th className="py-1 text-right">販売数</th>
                  <th className="py-1 text-right">売上</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.name} className="border-t">
                    <td className="py-1">{i.name}</td>
                    <td className="py-1 text-gray-500">{i.category}</td>
                    <td className="py-1 text-right tabular-nums">{i.qty.toLocaleString("ja-JP")}</td>
                    <td className="py-1 text-right tabular-nums">{yen(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={save} disabled={saving} className="w-full rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-40">
            {saving ? "取り込み中…" : `${items.length}品目を取り込む`}
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && <p className="rounded-lg bg-green-50 p-2 text-sm text-green-800">{done}</p>}
      {refs && refs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-600">取り込み済み</h3>
          <ul className="mt-1 divide-y text-sm">
            {refs.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-1.5">
                <span>
                  {formatJa(r.from)} 〜 {formatJa(r.to)}（{r.items.length}品目・{yen(r.items.reduce((n, i) => n + i.amount, 0))}）
                </span>
                <button onClick={() => remove(r.id)} className="rounded border px-2 py-0.5 text-xs text-red-700">
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
