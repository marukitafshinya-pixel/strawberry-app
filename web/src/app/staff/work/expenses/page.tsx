"use client";

// 経費の仕分け（管理者だけ）：総勘定元帳のスキャン（TIFF・PDF・写真）を1ページずつAIで読み取り、科目ごとに確かめて保存する。
// このあと、保存した明細を仕入れ先ごとにまとめ、「今年だけ」「毎年かかる（修繕費・店舗消耗品・ホーブ出荷資材・ホーブ生産資材）」に分ける
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import {
  checkLedger,
  combineLedger,
  ledgerFilesToPages,
  ledgerPageUpload,
  saveLedgerAccounts,
  useLedgerAccounts,
  useLedgerPeriods,
  type LedgerAccount,
  type LedgerPageResult,
  type SavedAccount,
} from "@/lib/ledger";
import type { Page } from "@/lib/shikiri";
import { KeyBox } from "../../shipping/Shikiri";
import { Classify } from "./Classify";

const yen = (n: number) => n.toLocaleString("ja-JP");
const md = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : d);
/** 同時に読み取るページの数 */
const PARALLEL = 3;

type PageState = { status: "wait" | "reading" | "done" | "error"; result: LedgerPageResult | null; error: string };

export default function ExpensesPage() {
  const { role } = useAuth();
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  return (
    <div className="space-y-6 pb-24">
      <p className="text-sm">
        <Link href="/staff/work/" className="text-gray-500 underline">
          ← 作業用フォルダ
        </Link>
      </p>
      <h1 className="text-xl font-bold">🧾 経費の仕分け</h1>
      <div className="print:hidden">
        <ImportLedger />
      </div>
      <SavedLedger />
    </div>
  );
}

/** 元帳を読み込む */
function ImportLedger() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [states, setStates] = useState<PageState[]>([]);
  const [accounts, setAccounts] = useState<LedgerAccount[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  // AIの鍵が登録されているか（仕切書の読み取りと同じ鍵）
  const [key, setKey] = useState<{ set: boolean; last4: string } | null>(null);
  useEffect(() => {
    callFunction<object, { set: boolean; last4: string }>("aiKeyStatus", {})
      .then(setKey)
      .catch(() => {});
  }, []);

  async function pick(files: File[]) {
    setError("");
    setSaved("");
    setAccounts(null);
    setBusy("ファイルを開いています…");
    try {
      const ps = await ledgerFilesToPages(files);
      setPages(ps);
      setStates(ps.map(() => ({ status: "wait", result: null, error: "" })));
    } catch (e) {
      console.error("元帳を開けませんでした", e);
      setError("ファイルを開けませんでした。TIFF・PDF・写真を選んでください");
    } finally {
      setBusy("");
    }
  }

  /** まだ読んでいないページ（とエラーのページ）を読み取る */
  async function readAll() {
    setError("");
    setSaved("");
    const cur = [...states];
    const todo = cur.map((s, i) => (s.status === "done" ? -1 : i)).filter((i) => i >= 0);
    const update = (i: number, s: PageState) => {
      cur[i] = s;
      setStates([...cur]);
    };
    setBusy("読み取っています…");
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = todo[next++];
        update(i, { status: "reading", result: null, error: "" });
        try {
          const r = await callFunction<{ file: ReturnType<typeof ledgerPageUpload>; page: number }, { result: LedgerPageResult }>(
            "readLedgerPage",
            { file: ledgerPageUpload(pages[i]), page: i },
            320_000,
          );
          update(i, { status: "done", result: r.result, error: "" });
        } catch (e) {
          update(i, { status: "error", result: null, error: errorText(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
    setBusy("");
    setAccounts(combineLedger(cur.map((s) => s.result)));
  }

  async function save() {
    if (!accounts?.length) return;
    setBusy("保存しています…");
    setError("");
    try {
      await saveLedgerAccounts(accounts);
      setSaved(`${accounts.length}科目（${accounts.reduce((n, a) => n + a.entries.length, 0)}件）を保存しました`);
      setPages([]);
      setStates([]);
      setAccounts(null);
    } catch (e) {
      setError(`保存できませんでした：${errorText(e)}`);
    } finally {
      setBusy("");
    }
  }

  /** 明細の金額・品名・取引先を直す */
  function edit(code: string, idx: number, patch: Partial<LedgerAccount["entries"][number]>) {
    setAccounts((list) =>
      list ? list.map((a) => (a.code !== code ? a : { ...a, entries: a.entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)) })) : list,
    );
  }

  const done = states.filter((s) => s.status === "done").length;
  const errors = states.filter((s) => s.status === "error").length;
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="font-bold">① 総勘定元帳を読み込む</h2>
      <p className="mt-1 text-sm text-gray-600">
        スキャンしたファイル（TIFF・PDF・写真）を選んで「読み取る」を押すと、AIが1ページずつ表を読みます（1ページ30秒〜1分ほど）。読み取ったら、月度合計・総合計と合うかを確かめて保存します。画像は保存しません。
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".tif,.tiff,image/tiff,application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = "";
          if (fs.length) void pick(fs);
        }}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={!!busy} onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-4 py-2 font-bold disabled:opacity-50">
          📄 ファイルを選ぶ
        </button>
        {pages.length > 0 && (
          <button
            disabled={!!busy || done === pages.length}
            onClick={readAll}
            className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40"
          >
            {errors ? "読めなかったページを読み直す" : `${pages.length}ページを読み取る`}
          </button>
        )}
        {busy && <span className="text-sm text-gray-600">{busy}</span>}
      </div>
      {key && <KeyBox status={key} admin onChange={setKey} />}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {errors > 0 && !busy && (
        <p className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">
          読めなかったページがあります：{[...new Set(states.filter((s) => s.status === "error").map((s) => s.error))].join(" ／ ")}
        </p>
      )}
      {saved && <p className="mt-2 rounded-lg bg-green-50 p-2 text-sm text-green-800">✅ {saved}</p>}

      {pages.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {pages.map((p, i) => {
            const s = states[i];
            const r = s?.result;
            return (
              <button
                key={i}
                onClick={() => setView(i)}
                className={`w-36 rounded-lg border p-2 text-left text-xs ${s?.status === "error" ? "border-red-400 bg-red-50" : s?.status === "done" ? "border-green-400 bg-green-50" : "bg-gray-50"}`}
              >
                <p className="font-bold">{i + 1}ページ</p>
                <p className="truncate text-gray-600">
                  {s?.status === "reading"
                    ? "読み取り中…"
                    : s?.status === "done" && r
                      ? `${r.accountCode} ${r.accountName}・${r.entries.length}件`
                      : s?.status === "error"
                        ? s.error
                        : "まだ"}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {accounts && (
        <div className="mt-4 space-y-3">
          <h3 className="font-bold">読み取った結果（科目ごと）</h3>
          {accounts.length === 0 && <p className="text-sm text-gray-500">読み取れた明細がありません。</p>}
          {accounts.map((a) => {
            const checks = checkLedger(a);
            const bad = checks.filter((c) => !c.ok);
            const total = a.entries.reduce((s, e) => s + e.debit - e.credit, 0);
            return (
              <div key={a.code} className={`rounded-xl border p-3 ${bad.length ? "border-red-300" : "border-green-300"}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="font-bold">
                    {a.code} {a.name}
                  </p>
                  <p className="text-sm">
                    {a.entries.length}件・{yen(total)}円
                  </p>
                  <p className={`text-sm font-bold ${bad.length ? "text-red-600" : "text-green-700"}`}>
                    {checks.length === 0 ? "合計の行がありません" : bad.length ? `✗ 合わない：${bad.map((c) => c.label).join("・")}` : "✓ 合計と合っています"}
                  </p>
                  <span className="text-xs text-gray-500">
                    ページ：
                    {a.pages.map((p) => (
                      <button key={p} onClick={() => setView(p)} className="mx-0.5 underline">
                        {p + 1}
                      </button>
                    ))}
                  </span>
                  <button onClick={() => setOpen(open === a.code ? null : a.code)} className="ml-auto rounded border px-2 py-1 text-xs">
                    {open === a.code ? "明細を閉じる" : "明細を見る・直す"}
                  </button>
                </div>
                {bad.length > 0 && (
                  <ul className="mt-1 text-xs text-red-700">
                    {bad.map((c) => (
                      <li key={c.label}>
                        {c.label}：読み取り {yen(c.read)}円 ／ 元帳 {yen(c.expected)}円（差 {yen(c.read - c.expected)}円）
                      </li>
                    ))}
                  </ul>
                )}
                {a.notes.length > 0 && <p className="mt-1 text-xs text-amber-700">AIのメモ：{a.notes.join(" ／ ")}</p>}
                {open === a.code && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-max text-xs">
                      <thead className="bg-gray-50 text-left text-gray-600">
                        <tr>
                          <th className="px-1 py-1">日付</th>
                          <th className="px-1 py-1">伝票</th>
                          <th className="px-1 py-1">相手科目／補助</th>
                          <th className="px-1 py-1">品名</th>
                          <th className="px-1 py-1">取引先</th>
                          <th className="px-1 py-1 text-right">金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.entries.map((e, i) => (
                          <tr key={i} className={`border-t ${e.isTax ? "text-gray-500" : ""}`}>
                            <td className="px-1 py-0.5 whitespace-nowrap">{md(e.date)}</td>
                            <td className="px-1 py-0.5">{e.no}</td>
                            <td className="px-1 py-0.5 whitespace-nowrap">
                              {e.counter}
                              {e.sub && `／${e.sub}`}
                            </td>
                            <td className="px-1 py-0.5">
                              <input value={e.item} onChange={(x) => edit(a.code, i, { item: x.target.value })} className="w-36 rounded border px-1" />
                              {e.isTax && <span className="ml-1">（消費税）</span>}
                            </td>
                            <td className="px-1 py-0.5">
                              <input value={e.partner} onChange={(x) => edit(a.code, i, { partner: x.target.value })} className="w-44 rounded border px-1" />
                            </td>
                            <td className="px-1 py-0.5 text-right">
                              <input
                                inputMode="numeric"
                                value={e.debit - e.credit}
                                onChange={(x) => {
                                  const v = Number(x.target.value.replace(/[^\d-]/g, ""));
                                  if (Number.isFinite(v)) edit(a.code, i, v >= 0 ? { debit: v, credit: 0 } : { debit: 0, credit: -v });
                                }}
                                className="w-24 rounded border px-1 text-right tabular-nums"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
          {accounts.length > 0 && (
            <div>
              <button disabled={!!busy} onClick={save} className="rounded-lg bg-berry px-5 py-2 font-bold text-white disabled:opacity-40">
                {accounts.length}科目を保存する
              </button>
              <p className="mt-1 text-xs text-gray-500">
                同じ期間・同じ科目がもう保存されていれば、入れ替わります。1つの科目のページは、まとめて一度に読み込んでください。
              </p>
            </div>
          )}
        </div>
      )}

      {view != null && pages[view] && (
        <div className="fixed inset-0 z-50 overflow-auto bg-black/70 p-3" onClick={() => setView(null)}>
          <div className="mx-auto max-w-3xl">
            <p className="mb-2 text-center text-white">{view + 1}ページ（どこかを押すと閉じます）</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pages[view].canvas.toDataURL("image/jpeg", 0.85)} alt={`${view + 1}ページ`} className="w-full bg-white" />
          </div>
        </div>
      )}
    </section>
  );
}

/** 保存した元帳 */
function SavedLedger() {
  const periods = useLedgerPeriods();
  const [pick, setPick] = useState<string | null>(null);
  const period = pick ?? periods?.[0]?.from ?? null;
  const accounts = useLedgerAccounts(period);
  const [open, setOpen] = useState<string | null>(null);
  const label = (p: { from: string; to: string }) =>
    `${p.from.slice(0, 4)}年${Number(p.from.slice(5, 7))}月〜${p.to.slice(0, 4)}年${Number(p.to.slice(5, 7))}月`;
  return (
    <>
      <section className="rounded-xl border bg-white p-4 print:hidden">
        <h2 className="font-bold">② 保存した元帳</h2>
        {periods === null ? (
          <p className="mt-2 text-sm text-gray-500">読み込み中…</p>
        ) : periods.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">まだ保存した元帳はありません。</p>
        ) : (
          <>
            <select value={period ?? ""} onChange={(e) => setPick(e.target.value)} className="mt-2 rounded-lg border px-3 py-2">
              {periods.map((p) => (
                <option key={p.from} value={p.from}>
                  {label(p)}
                </option>
              ))}
            </select>
            {accounts === null ? (
              <p className="mt-2 text-sm text-gray-500">読み込み中…</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-600">
                    <tr>
                      <th className="px-2 py-1">科目</th>
                      <th className="px-2 py-1 text-right">件数</th>
                      <th className="px-2 py-1 text-right">合計（税込）</th>
                      <th className="px-2 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <SavedRow key={a.code} a={a} open={open === a.code} onToggle={() => setOpen(open === a.code ? null : a.code)} />
                    ))}
                    <tr className="border-t bg-gray-50 font-bold">
                      <td className="px-2 py-1">合計</td>
                      <td className="px-2 py-1 text-right">{accounts.reduce((n, a) => n + a.entries.length, 0)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {yen(accounts.reduce((n, a) => n + a.entries.reduce((s, e) => s + e.debit - e.credit, 0), 0))}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
      {accounts && accounts.length > 0 && period && (
        <Classify accounts={accounts} periodLabel={label(periods!.find((p) => p.from === period) ?? { from: period, to: "" })} />
      )}
    </>
  );
}

function SavedRow({ a, open, onToggle }: { a: SavedAccount; open: boolean; onToggle: () => void }) {
  const total = a.entries.reduce((s, e) => s + e.debit - e.credit, 0);
  return (
    <>
      <tr className="border-t">
        <td className="px-2 py-1">
          {a.code} {a.name}
        </td>
        <td className="px-2 py-1 text-right">{a.entries.length}</td>
        <td className="px-2 py-1 text-right tabular-nums">{yen(total)}</td>
        <td className="px-2 py-1">
          <button onClick={onToggle} className="rounded border px-2 py-0.5 text-xs">
            {open ? "閉じる" : "明細"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="bg-gray-50 px-2 py-1">
            <table className="w-full text-xs">
              <tbody>
                {a.entries.map((e, i) => (
                  <tr key={i} className={e.isTax ? "text-gray-500" : ""}>
                    <td className="px-1 whitespace-nowrap">{md(e.date)}</td>
                    <td className="px-1">{e.item}</td>
                    <td className="px-1">{e.isTax ? "（消費税）" : ""}</td>
                    <td className="px-1">{e.partner}</td>
                    <td className="px-1 whitespace-nowrap">
                      {e.counter}
                      {e.sub && `／${e.sub}`}
                    </td>
                    <td className="px-1 text-right tabular-nums">{yen(e.debit - e.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
