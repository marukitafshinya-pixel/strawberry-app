"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import {
  carryInto,
  certLineAmount,
  certTotal,
  emptyEntry,
  isBlank,
  isBlankCertLine,
  itemsFromHistory,
  monthSums,
  readCashbookExcel,
  saveCashImport,
  saveCashItems,
  saveCashMonth,
  useCashItems,
  useCashbook,
  type CashCert,
  type CashCertLine,
  type CashEntry,
  type CashImportMonth,
  type CashMonth,
} from "@/lib/cashbook";
import { shiftMonth, todayJST } from "@/lib/date";
import { reiwa } from "@/lib/payroll";
import { useSettings } from "@/lib/reservations";
import { openWorkbook } from "@/lib/xlsx";

const yen = (n: number) => n.toLocaleString("ja-JP");
/** 最後の行に何か入れたら、次の空の行を足す（空の行は保存しない） */
const withBlankRow = (list: CashEntry[], date = ""): CashEntry[] => (list.length === 0 || !isBlank(list[list.length - 1]) ? [...list, emptyEntry(date)] : list);
const md = (d: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : "");

export default function CashbookPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <CashbookView />
    </Suspense>
  );
}

function CashbookView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/cashbook/?month=${m}`);
  const { value: all, error } = useCashbook();
  const { value: settings } = useSettings();
  const [y, m] = month.split("-").map(Number);
  /** 取り込んだら、表を読み込み直す */
  const [version, setVersion] = useState(0);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  return (
    <div className="pb-24">
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold print:hidden">現金出納帳</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="text-lg font-bold">
          {reiwa(y)} {m}月度
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
        <input type="month" value={month} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} className="rounded-lg border px-2 py-1.5" />
        <span className="flex-1" />
        {all && <ExcelImport all={all} onImported={() => setVersion(version + 1)} />}
        <button onClick={() => window.print()} className="text-sm text-gray-600 underline">
          印刷
        </button>
      </div>
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !all || !settings ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Editor key={`${month}-${version}`} month={month} all={all} storeName={settings.storeName} />
      )}
    </div>
  );
}

function Editor({ month, all, storeName }: { month: string; all: CashMonth[]; storeName: string }) {
  const saved = all.find((x) => x.month === month);
  const isFirst = !all.some((x) => x.month < month);
  const [entries, setEntries] = useState<CashEntry[]>(() => withBlankRow(saved?.entries ?? []));
  const [opening, setOpening] = useState<number | undefined>(saved?.opening);
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

  const change = (next: CashEntry[]) => {
    setEntries(withBlankRow(next));
    setDirty(true);
    setMsg("");
  };
  const set = (i: number, p: Partial<CashEntry>) => change(entries.map((e, j) => (j === i ? { ...e, ...p } : e)));
  const carry = isFirst ? (opening ?? 0) : carryInto(all, month);
  const sums = monthSums(entries);
  const closing = carry + sums.income - sums.expense;
  const balances = entries.reduce<number[]>((acc, e) => [...acc, (acc.length ? acc[acc.length - 1] : carry) + (e.income ?? 0) - (e.expense ?? 0)], []);
  // 項目の候補：保存してある候補（まだなければ、これまでに使った項目）
  const savedItems = useCashItems();
  const suggestions = savedItems ?? itemsFromHistory(all);
  const [editingItems, setEditingItems] = useState(false);
  const [y, m] = month.split("-").map(Number);
  const today = todayJST();
  const defaultDate = today.startsWith(month) ? today : "";

  /** 支払証明書を開いている行（null は新しく作る） */
  const [certRow, setCertRow] = useState<number | null | undefined>(undefined);
  /** 印刷する支払証明書（null なら出納帳を印刷する） */
  const [printCert, setPrintCert] = useState<{ date: string; cert: CashCert } | null>(null);
  useEffect(() => {
    if (!printCert) return;
    const done = () => setPrintCert(null);
    window.addEventListener("afterprint", done);
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printCert]);

  /** 支払証明書を出納帳の行にする（項目・支出・日付を証明書から入れる）。そのまま保存する */
  async function applyCert(row: number | null, date: string, cert: CashCert, print: boolean) {
    const cur = row === null ? undefined : entries[row];
    const names = [...new Set(cert.lines.filter((l) => !isBlankCertLine(l) && l.name.trim()).map((l) => l.name.trim()))].join("・");
    const entry: CashEntry = {
      date,
      item: `支払証明書 ${cert.payee.trim()}`.trim(),
      income: null,
      expense: certTotal(cert),
      memo: cur?.memo || names.slice(0, 80),
      cert,
    };
    const body = entries.filter((e) => !isBlank(e));
    const next = row === null || !cur ? [...body, entry] : entries.map((e, j) => (j === row ? entry : e));
    change(next);
    setCertRow(undefined);
    await save(withBlankRow(next));
    if (print) setPrintCert({ date, cert });
  }

  async function save(list: CashEntry[] = entries) {
    setErr("");
    setSaving(true);
    try {
      await saveCashMonth(month, list, isFirst ? (opening ?? 0) : undefined);
      // 新しく入れた項目は、候補に足しておく
      const added = [...new Set(list.map((e) => e.item.trim()).filter((x) => x && !suggestions.includes(x)))];
      if (added.length > 0 || savedItems === null) await saveCashItems([...suggestions, ...added]);
      setDirty(false);
      setMsg("保存しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* 画面で入力する表 */}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm print:hidden">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="w-10 px-2 py-2 text-right">No</th>
              <th className="w-36 px-2 py-2 text-left">日付</th>
              <th className="px-2 py-2 text-left">項目</th>
              <th className="w-28 px-2 py-2 text-right">収入</th>
              <th className="w-28 px-2 py-2 text-right">支出</th>
              <th className="w-28 px-2 py-2 text-right">現金残高</th>
              <th className="px-2 py-2 text-left">備考</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            <tr className="border-t bg-amber-50/60">
              <td />
              <td />
              <td className="px-2 py-1.5 font-semibold">繰越金</td>
              <td className="px-1 py-1 text-right">
                {isFirst ? (
                  <Num
                    value={opening ?? null}
                    label="繰越金"
                    onChange={(v) => {
                      setOpening(v ?? undefined);
                      setDirty(true);
                      setMsg("");
                    }}
                  />
                ) : (
                  <span className="px-1 tabular-nums">{yen(carry)}</span>
                )}
              </td>
              <td />
              <td className="px-2 text-right font-semibold tabular-nums">{yen(carry)}</td>
              <td className="px-2 text-xs text-gray-500">{isFirst ? "最初の月なので、手で入れてください" : "前の月の残高から自動で計算"}</td>
              <td />
            </tr>
            {entries.map((e, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 text-right text-xs text-gray-500">{i + 1}</td>
                <td className="px-1 py-1">
                  <input type="date" value={e.date} aria-label={`${i + 1}行目の日付`} onChange={(x) => set(i, { date: x.target.value })} className="w-full rounded border px-1 py-1" />
                </td>
                <td className="px-1 py-1">
                  <div className="flex items-center gap-1">
                    <input value={e.item} maxLength={80} list="cash-items" aria-label={`${i + 1}行目の項目`} onChange={(x) => set(i, { item: x.target.value })} className="min-w-0 flex-1 rounded border px-2 py-1" />
                    {e.cert && (
                      <button onClick={() => setCertRow(i)} className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800" aria-label={`${i + 1}行目の支払証明書`}>
                        証明書
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-1 py-1">
                  <Num value={e.income} label={`${i + 1}行目の収入`} onChange={(v) => set(i, { income: v })} />
                </td>
                <td className="px-1 py-1">
                  <Num value={e.expense} label={`${i + 1}行目の支出`} onChange={(v) => set(i, { expense: v })} />
                </td>
                <td className={`px-2 text-right tabular-nums ${balances[i] < 0 ? "text-red-600" : ""}`}>{yen(balances[i])}</td>
                <td className="px-1 py-1">
                  <input value={e.memo} maxLength={80} aria-label={`${i + 1}行目の備考`} onChange={(x) => set(i, { memo: x.target.value })} className="w-full rounded border px-2 py-1" />
                </td>
                <td className="px-1 text-center">
                  <button onClick={() => change(entries.filter((_, j) => j !== i))} className="px-1 text-gray-400 hover:text-red-600" aria-label={`${i + 1}行目を消す`}>
                    🗑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-gray-50 font-bold">
            <tr>
              <td />
              <td colSpan={2} className="px-2 py-2">
                合計（繰越金を除く）
              </td>
              <td className="px-2 text-right tabular-nums">{yen(sums.income)}</td>
              <td className="px-2 text-right tabular-nums">{yen(sums.expense)}</td>
              <td className={`px-2 text-right tabular-nums ${closing < 0 ? "text-red-600" : ""}`}>{yen(closing)}</td>
              <td className="px-2 text-xs font-normal text-gray-500">月末の残高（翌月へ繰り越し）</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <datalist id="cash-items">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 print:hidden">
        <button onClick={() => change([...entries, emptyEntry(defaultDate)])} className="rounded-lg border bg-white px-4 py-2 text-sm">
          ＋ 行を追加
        </button>
        <button
          onClick={() => change([...entries].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999")))}
          className="rounded-lg border bg-white px-4 py-2 text-sm"
        >
          日付順に並べる
        </button>
        <button onClick={() => setEditingItems(true)} className="rounded-lg border bg-white px-4 py-2 text-sm">
          項目の候補を編集
        </button>
        <button onClick={() => setCertRow(null)} className="rounded-lg border border-sky-600 bg-sky-50 px-4 py-2 text-sm font-semibold text-sky-800">
          ＋ 支払証明書を作る
        </button>
      </div>
      {certRow !== undefined && (
        <CertEditor
          key={certRow ?? "new"}
          date={(certRow !== null && entries[certRow]?.date) || defaultDate}
          initial={certRow !== null ? entries[certRow]?.cert : undefined}
          onClose={() => setCertRow(undefined)}
          onSave={(date, cert, print) => applyCert(certRow, date, cert, print)}
          onRemove={
            certRow !== null && entries[certRow]?.cert
              ? () => {
                  const { cert: _drop, ...rest } = entries[certRow];
                  void _drop;
                  change(entries.map((e, j) => (j === certRow ? rest : e)));
                  setCertRow(undefined);
                }
              : null
          }
        />
      )}
      {printCert && <CertPrint date={printCert.date} cert={printCert.cert} />}
      {editingItems && <ItemsEditor items={suggestions} onClose={() => setEditingItems(false)} />}

      {/* 印刷用（いままでの Excel と同じ形） */}
      <div className={`hidden text-black ${printCert ? "" : "print:block"}`}>
        <div className="flex items-end gap-6 text-[11pt]">
          <span className="font-bold">{storeName ? `${storeName}　` : ""}現金出納帳</span>
          <span>{reiwa(y)}</span>
          <span>{m}月度</span>
        </div>
        <table className="mt-2 w-full border-collapse text-[9.5pt] tabular-nums">
          <thead>
            <tr>
              {["", "日付", "項目", "収入", "支出", "現金残高", "備考"].map((h, i) => (
                <th key={i} className="border border-black px-1 py-0.5 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <P />
              <P />
              <P left>繰越金</P>
              <P>{yen(carry)}</P>
              <P />
              <P>{yen(carry)}</P>
              <P />
            </tr>
            {entries.map((e, i) => isBlank(e) ? null : (
              <tr key={i}>
                <P>{i + 1}</P>
                <P>{md(e.date)}</P>
                <P left>{e.item}</P>
                <P>{e.income === null ? "" : yen(e.income)}</P>
                <P>{e.expense === null ? "" : yen(e.expense)}</P>
                <P>{yen(balances[i])}</P>
                <P left>{e.memo}</P>
              </tr>
            ))}
            <tr className="font-bold">
              <P />
              <P />
              <P left>合計</P>
              <P>{yen(carry + sums.income)}</P>
              <P>{yen(sums.expense)}</P>
              <P>{yen(closing)}</P>
              <P />
            </tr>
          </tbody>
        </table>
        <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } body { background: #fff !important; } }`}</style>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] print:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <button onClick={() => save()} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2.5 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          {dirty && <span className="text-sm text-amber-700">まだ保存していません</span>}
          {msg && <span className="text-sm text-gray-600">{msg}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
          <span className="ml-auto text-sm">
            月末の残高 <b className={`text-lg tabular-nums ${closing < 0 ? "text-red-600" : ""}`}>{yen(closing)}円</b>
          </span>
        </div>
      </div>
    </>
  );
}

/** 項目の候補（プルダウン）を編集する：いらない候補を消す・新しく足す */
function ItemsEditor({ items, onClose }: { items: string[]; onClose: () => void }) {
  const [list, setList] = useState(items);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(next: string[]) {
    setErr("");
    setBusy(true);
    try {
      await saveCashItems(next);
      setList(next);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center print:hidden" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">項目の候補（プルダウン）</h2>
          <button onClick={onClose} disabled={busy} className="px-2 text-2xl text-gray-500" aria-label="閉じる">
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">× を押すと候補から消えます（これまでの出納帳の記録は変わりません）。出納帳に新しい項目を入れて保存すると、自動で候補に足されます。</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            setText("");
            if (!list.includes(v)) void save([v, ...list]);
          }}
        >
          <input value={text} maxLength={80} onChange={(e) => setText(e.target.value)} placeholder="新しい項目" aria-label="新しい項目" className="flex-1 rounded-lg border px-3 py-2" />
          <button disabled={busy || !text.trim()} className="rounded-lg bg-berry px-4 font-bold text-white disabled:opacity-40">
            追加
          </button>
        </form>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <ul className="mt-3 flex-1 divide-y overflow-y-auto rounded-lg border">
          {list.length === 0 && <li className="px-3 py-4 text-center text-sm text-gray-400">候補はありません</li>}
          {list.map((it) => (
            <li key={it} className="flex items-center gap-2 px-3 py-1.5">
              <span className="flex-1 break-all">{it}</span>
              <button onClick={() => save(list.filter((x) => x !== it))} disabled={busy} className="rounded px-2 text-lg text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label={`${it}を候補から消す`}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-right text-xs text-gray-500">{list.length}件</p>
      </div>
    </div>
  );
}

const wareki = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { y: "令和　年", m: "　月", d: "　日" };
  const [y, m, dd] = d.split("-").map(Number);
  return { y: y >= 2019 ? `令和${y - 2018}年` : `${y}年`, m: `${m}月`, d: `${dd}日` };
};
const emptyLine = (): CashCertLine => ({ name: "", price: null, qty: null });
/** 最後の行に何か入れたら、次の空の行を足す */
const withBlankLine = (lines: CashCertLine[]) => (lines.length === 0 || !isBlankCertLine(lines[lines.length - 1]) ? [...lines, emptyLine()] : lines);
const REQUESTER_KEY = "ichigo.certRequester";

/** 支払証明書の入力（保存すると出納帳の行になる） */
function CertEditor({
  date: date0,
  initial,
  onClose,
  onSave,
  onRemove,
}: {
  date: string;
  initial?: CashCert;
  onClose: () => void;
  onSave: (date: string, cert: CashCert, print: boolean) => Promise<void>;
  onRemove: (() => void) | null;
}) {
  const [date, setDate] = useState(date0);
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [lines, setLines] = useState<CashCertLine[]>(() => withBlankLine(initial?.lines ?? []));
  const [requester, setRequester] = useState(() => {
    if (initial) return initial.requester;
    try {
      return window.localStorage.getItem(REQUESTER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setLine = (i: number, p: Partial<CashCertLine>) => setLines(withBlankLine(lines.map((l, j) => (j === i ? { ...l, ...p } : l))));
  const cert: CashCert = { payee, lines: lines.filter((l) => !isBlankCertLine(l)), requester };
  const total = certTotal(cert);

  async function go(print: boolean) {
    setErr("");
    if (!payee.trim()) return setErr("支払先を入れてください");
    if (cert.lines.length === 0) return setErr("支払内容を1行以上入れてください");
    setBusy(true);
    try {
      try {
        window.localStorage.setItem(REQUESTER_KEY, requester.trim());
      } catch {
        // 覚えられなくても続ける
      }
      await onSave(date, cert, print);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center print:hidden" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[94vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-xl sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">支払証明書</h2>
          <button onClick={onClose} disabled={busy} className="px-2 text-2xl text-gray-500" aria-label="閉じる">
            ×
          </button>
        </div>
        <p className="text-xs text-gray-500">保存すると、出納帳に「支払証明書 支払先」の行として、合計金額が支出に入ります。</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-gray-600">日付（精算日）</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-2" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">請求者</span>
            <input value={requester} maxLength={30} onChange={(e) => setRequester(e.target.value)} aria-label="請求者" className="mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
        </div>
        <label className="mt-3 block text-sm">
          <span className="text-gray-600">支払先</span>
          <input value={payee} maxLength={80} onChange={(e) => setPayee(e.target.value)} aria-label="支払先" placeholder="例：北欧パン等　7月分" className="mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <p className="mt-3 text-sm text-gray-600">支払内容（1行入れると、次の行が増えます）</p>
        <table className="mt-1 w-full text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="text-left font-normal">内容</th>
              <th className="w-24 text-right font-normal">単価</th>
              <th className="w-16 text-right font-normal">数量</th>
              <th className="w-24 text-right font-normal">金額</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-1">
                  <input value={l.name} maxLength={60} onChange={(e) => setLine(i, { name: e.target.value })} aria-label={`支払内容${i + 1}の内容`} className="w-full rounded border px-2 py-1" />
                </td>
                <td className="py-0.5 pr-1">
                  <Num value={l.price} label={`支払内容${i + 1}の単価`} onChange={(v) => setLine(i, { price: v })} />
                </td>
                <td className="py-0.5 pr-1">
                  <Num value={l.qty} label={`支払内容${i + 1}の数量`} onChange={(v) => setLine(i, { qty: v })} />
                </td>
                <td className="py-0.5 text-right tabular-nums">{isBlankCertLine(l) ? "" : yen(certLineAmount(l))}</td>
                <td className="text-center">
                  {!isBlankCertLine(l) && (
                    <button onClick={() => setLines(withBlankLine(lines.filter((_, j) => j !== i)))} className="px-1 text-gray-400 hover:text-red-600" aria-label={`支払内容${i + 1}を消す`}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-gray-500">数量を空けると1として計算します。</p>
        <p className="mt-3 text-right">
          合計金額 <b className="text-xl tabular-nums">{yen(total)}円</b>
        </p>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => go(false)} disabled={busy} className="rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
            保存（出納帳に入れる）
          </button>
          <button onClick={() => go(true)} disabled={busy} className="rounded-lg border border-berry py-3 font-bold text-berry disabled:opacity-50">
            保存して印刷
          </button>
        </div>
        {onRemove && (
          <button onClick={onRemove} disabled={busy} className="mt-2 w-full py-2 text-sm text-red-700 underline">
            この行から支払証明書を外す
          </button>
        )}
      </div>
    </div>
  );
}

/** 支払証明書の印刷（いままでの Excel の「支払証明書」と同じ並び） */
function CertPrint({ date, cert }: { date: string; cert: CashCert }) {
  const w = wareki(date);
  const total = certTotal(cert);
  const rows = [...cert.lines];
  while (rows.length < 5) rows.push(emptyLine());
  const line = "border-b border-black";
  return (
    <div className="hidden text-black print:block">
      <div className="mx-auto w-[150mm] border border-black px-[8mm] py-[6mm] text-[11pt]">
        <p className="text-center text-[16pt] font-bold tracking-[0.5em]">支払証明書</p>
        <div className="mt-4 flex items-end gap-4">
          <span className="w-20">日付</span>
          <span className={`${line} w-32 text-center`}>{w.y}</span>
          <span>{w.m}</span>
          <span>{w.d}</span>
        </div>
        <div className={`mt-3 flex items-end gap-4 ${line} pb-1`}>
          <span className="w-20">支払先</span>
          <span className="flex-1">{cert.payee}</span>
        </div>
        <div className="mt-3 flex gap-4">
          <span className="w-20">支払内容</span>
          <table className="flex-1 border-collapse tabular-nums">
            <thead>
              <tr className="text-[9pt]">
                <th className="text-left font-normal">内容</th>
                <th className="w-24 text-right font-normal">単価</th>
                <th className="w-12 text-right font-normal">数量</th>
                <th className="w-24 text-right font-normal">金額</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={i} className={line}>
                  <td className="h-[8mm]">{l.name}</td>
                  <td className="text-right">{l.price === null ? "" : yen(l.price)}</td>
                  <td className="text-right">{isBlankCertLine(l) ? "" : (l.qty ?? 1)}</td>
                  <td className="text-right">{isBlankCertLine(l) ? "" : yen(certLineAmount(l))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={`mt-4 flex ${line} border-t border-t-black py-1`}>
          <span className="flex-1">仮払金</span>
          <span className="tabular-nums">{yen(total)}</span>
        </div>
        <div className={`flex ${line} py-1`}>
          <span className="flex-1">支払金額</span>
          <span className="tabular-nums">{yen(total)}</span>
        </div>
        <div className={`mt-2 flex ${line} border-t border-t-black py-1 font-bold`}>
          <span className="flex-1">合計金額</span>
          <span className="tabular-nums">{yen(total)}円</span>
        </div>
        <div className="mt-4 flex items-start gap-4">
          <div>
            <p className="text-[9pt]">決済印</p>
            <div className="mt-1 h-[22mm] w-[22mm] border border-black" />
          </div>
          <div className="mt-6 flex-1 space-y-3">
            <p className="flex gap-4">
              <span className="w-16">請求者</span>
              <span className={`${line} flex-1`}>{cert.requester}</span>
            </p>
            <p className="flex gap-4">
              <span className="w-16">精算日</span>
              <span className={`${line} flex-1`}>
                {w.y} {w.m} {w.d}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function P({ children, left }: { children?: React.ReactNode; left?: boolean }) {
  return <td className={`border border-black px-1 py-0.5 ${left ? "text-left" : "text-right"}`}>{children}</td>;
}

/** 金額の入力（マイナスも入れられる。返品などで支出をマイナスにするとき） */
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
        else onChange(Math.max(-99_999_999, Math.min(99_999_999, Number(t))));
      }}
      className="w-full rounded border px-2 py-1 text-right tabular-nums"
    />
  );
}

/** いままでの Excel の現金出納帳を取り込む */
function ExcelImport({ all, onImported }: { all: CashMonth[]; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<CashImportMonth[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function onFile(f: File) {
    setMsg("");
    try {
      const months = await readCashbookExcel(await openWorkbook(await f.arrayBuffer()));
      if (months.length === 0) return setMsg("現金出納帳のシート（R8.8月 のような名前）が見つかりませんでした");
      // すでにもっと前の月があるときは、取り込む最初の月の繰越金は前の月から計算する
      if (all.some((x) => x.month < months[0].month)) delete months[0].opening;
      setPreview(months);
    } catch (e) {
      setMsg(errorText(e));
    }
  }

  async function run() {
    if (!preview) return;
    const overwrite = preview.filter((p) => all.some((x) => x.month === p.month)).length;
    if (overwrite > 0 && !window.confirm(`${overwrite}か月分は、すでに入力があります。Excelの内容で置き換えますか？`)) return;
    setBusy(true);
    try {
      await saveCashImport(preview);
      setMsg(`${preview.length}か月分を取り込みました`);
      setPreview(null);
      onImported();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // 取り込んだあとの月末残高を、Excel の残高と比べる
  const check = (() => {
    if (!preview) return [];
    const merged = [...all.filter((x) => !preview.some((p) => p.month === x.month)), ...preview].sort((a, b) => a.month.localeCompare(b.month));
    return preview.map((p) => {
      const s = monthSums(p.entries);
      const first = !merged.some((x) => x.month < p.month);
      const closing = (first ? (p.opening ?? 0) : carryInto(merged, p.month)) + s.income - s.expense;
      return { ...p, closing, ok: p.excelClosing === null || p.excelClosing === closing };
    });
  })();

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xlsb"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }}
      />
      <button onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-3 py-2 text-sm">
        Excelの出納帳から取り込む
      </button>
      {msg && !preview && <span className="text-sm text-gray-600">{msg}</span>}
      {preview && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => !busy && setPreview(null)}>
          <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-2xl sm:rounded-2xl">
            <h2 className="text-lg font-bold">Excelの現金出納帳を取り込む</h2>
            <p className="mt-1 text-sm text-gray-600">シートごとに1か月分として取り込みます。月末の残高をExcelと比べています。</p>
            <table className="mt-3 w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="text-left">シート</th>
                  <th className="text-left">月</th>
                  <th className="text-right">明細</th>
                  <th className="text-right">月末の残高</th>
                  <th className="text-right">Excel</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {check.map((c) => (
                  <tr key={c.month} className="border-t">
                    <td className="py-1">{c.sheet}</td>
                    <td>{c.month}</td>
                    <td className="text-right">{c.entries.length}件</td>
                    <td className="text-right tabular-nums">{yen(c.closing)}</td>
                    <td className="text-right tabular-nums">{c.excelClosing === null ? "－" : yen(c.excelClosing)}</td>
                    <td className="pl-2">{c.ok ? <span className="text-emerald-700">一致</span> : <span className="font-bold text-red-600">違う</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
            <div className="mt-4 flex gap-2">
              <button onClick={run} disabled={busy} className="flex-1 rounded-lg bg-berry py-3 font-bold text-white disabled:opacity-50">
                {busy ? "取り込み中…" : `${preview.length}か月分を取り込む`}
              </button>
              <button onClick={() => setPreview(null)} disabled={busy} className="rounded-lg border px-4">
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
