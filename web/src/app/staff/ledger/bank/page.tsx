"use client";

// 帳簿：預金通帳。ネットバンキングなどで書き出した入出金のCSVか、通帳の写真・PDF（AIで読む）を取り込み、摘要の言葉ごとに決めた科目で仕訳にする（管理者と経理担当）
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { shiftMonth, todayJST } from "@/lib/date";
import {
  accountOf,
  fullName,
  balanceOf,
  guessBankColumns,
  KIND_LABEL,
  KINDS,
  mergeBankImport,
  postingsInRange,
  readBankRows,
  ruleFor,
  saveBankMonths,
  saveLedgerConfig,
  SKIP,
  totalsByAccount,
  UNSORTED,
  useBooks,
  useLedgerConfig,
  type Account,
  type BankColumns,
  type BankRow,
  type BankRule,
  type Books,
  type LedgerConfig,
} from "@/lib/books";
import { scanBankFiles } from "@/lib/booksScan";
import { reiwa } from "@/lib/payroll";
import { canUseLedger, LedgerHeader, yen } from "../parts";

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export default function BankPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <BankView />
    </Suspense>
  );
}

function BankView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : todayJST().slice(0, 7);
  const setMonth = (m: string) => router.replace(`/staff/ledger/bank/?month=${m}`);
  const { value: books, error: e1 } = useBooks();
  const { value: config, error: e2 } = useLedgerConfig();
  const [y, m] = month.split("-").map(Number);
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2;
  return (
    <div className="pb-24">
      <LedgerHeader title="預金通帳" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !books || !config ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <Import books={books} config={config} onDone={(last) => setMonth(last)} />
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
              ‹ 前月
            </button>
            <span className="text-lg font-bold">
              {reiwa(y)} {m}月
            </span>
            <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
              翌月 ›
            </button>
            <input
              type="month"
              value={month}
              onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)}
              className="rounded-lg border px-2 py-1.5"
            />
          </div>
          <MonthRows key={month} month={month} books={books} config={config} />
          <Rules key={JSON.stringify(config.bankRules)} config={config} />
        </>
      )}
    </div>
  );
}

/** 預金の科目（資産のうち、現金とレジ現金を除いたもの） */
const bankAccounts = (accounts: Account[]) => accounts.filter((a) => a.kind === "asset" && !["100", "101"].includes(a.code));

/** 科目のプルダウン（「帳簿に入れない」も選べる） */
function CodeSelect({ accounts, value, onChange, label, empty }: { accounts: Account[]; value: string; onChange: (v: string) => void; label: string; empty: string }) {
  return (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} className="w-full rounded border bg-white px-1 py-1">
      <option value="">{empty}</option>
      <option value={SKIP}>帳簿に入れない（ほかの仕訳で入っている）</option>
      {KINDS.map((k) => (
        <optgroup key={k} label={KIND_LABEL[k]}>
          {accounts
            .filter((a) => a.kind === k && a.code !== UNSORTED && (!a.hidden || a.code === value))
            .map((a) => (
              <option key={a.code} value={a.code}>
                {a.parent ? "　└ " : ""}
                {a.code} {fullName(accounts, a)}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
const codeName = (accounts: Account[], code: string) => (code === SKIP ? "帳簿に入れない" : fullName(accounts, accountOf(accounts, code)));

function Import({ books, config, onDone }: { books: Books; config: LedgerConfig; onDone: (lastMonth: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const banks = bankAccounts(config.accounts);
  const [account, setAccount] = useState(banks[0]?.code ?? "110");
  const [table, setTable] = useState<{ name: string; rows: string[][] } | null>(null);
  const [col, setCol] = useState<BankColumns | null>(null);
  // 写真・PDFをAIで読んだ行
  const [scan, setScan] = useState<{ name: string; rows: BankRow[]; problems: string[] } | null>(null);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function pickFiles(files: File[]) {
    setErr("");
    setMsg("");
    setTable(null);
    setCol(null);
    setScan(null);
    const isCsv = (f: File) => /\.csv$/i.test(f.name) || f.type === "text/csv";
    if (files.length === 1 && isCsv(files[0])) return pick(files[0]);
    if (files.some(isCsv)) return setErr("CSVは1つずつ選んでください（写真・PDFといっしょには選べません）");
    setBusy(true);
    try {
      const r = await scanBankFiles(files, account, (done, total) => setProgress(`AIで読んでいます（${done}／${total}ページ）`));
      setScan({ name: files.map((f) => f.name).join("・"), ...r });
      if (!r.rows.length) setErr("入出金の行が読めませんでした");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setProgress("");
      setBusy(false);
    }
  }

  async function pick(file: File) {
    const rows = parseCsv(decodeCsv(await file.arrayBuffer()).text);
    const guess = guessBankColumns(rows);
    setTable({ name: file.name, rows });
    setCol(guess ?? { header: 0, date: 0, desc: 1, deposit: 2, withdrawal: 3, balance: 4 });
    if (!guess) setErr("見出し（日付・入金・出金など）が見つかりませんでした。下で列を選んでください。");
  }
  const parsed = scan ? scan.rows.map((r) => ({ ...r, account })) : table && col ? readBankRows(table.rows, col, account) : [];
  const header = table && col ? (table.rows[col.header] ?? []) : [];

  async function save() {
    setErr("");
    setBusy(true);
    try {
      const months = mergeBankImport(books.bank, parsed, account);
      await saveBankMonths(months);
      setMsg(`${parsed.length}行を取り込みました（${parsed[0].date}〜${parsed[parsed.length - 1].date}）`);
      setTable(null);
      setCol(null);
      setScan(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone(months[months.length - 1].month);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const colSelect = (k: keyof Omit<BankColumns, "header">, label: string) => (
    <label className="text-xs">
      {label}
      <select value={col?.[k] ?? -1} onChange={(e) => col && setCol({ ...col, [k]: Number(e.target.value) })} className="ml-1 rounded border bg-white px-1 py-0.5">
        <option value={-1}>（なし）</option>
        {header.map((h, i) => (
          <option key={i} value={i}>
            {i + 1}列目 {h.slice(0, 12)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">通帳を取り込む（CSV・写真・PDF）</h2>
      <p className="mt-1 text-xs text-gray-500">
        ネットバンキングで書き出した「入出金明細」のCSVか、通帳のページの写真・PDF（何ページでもまとめて選べます。ページの順に選んでください）を選んでください。
        写真・PDFはAIで読みます（1ページ1分ほど。AIの鍵が要ります）。読んだ行は、残高のつながりで確かめて、合わないところを知らせます。
        どちらも、同じ期間をもう一度取り込むと、その期間は新しいファイルで置き換わります（二重になりません）。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          どの預金
          <select value={account} onChange={(e) => setAccount(e.target.value)} className="ml-2 rounded border bg-white px-2 py-1.5">
            {banks.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".csv,text/csv,.pdf,application/pdf,image/*"
          disabled={busy}
          onChange={(e) => e.target.files?.length && pickFiles(Array.from(e.target.files))}
          className="text-sm"
        />
      </div>
      {busy && !table && !scan && <p className="mt-2 text-sm text-gray-500">{progress || "読んでいます…"}</p>}
      {((table && col) || scan) && (
        <div className="mt-3 rounded-lg border p-3">
          <p className="text-sm font-semibold">{scan ? scan.name : table?.name}</p>
          {scan && scan.problems.length > 0 && (
            <ul className="mt-2 list-disc rounded-lg bg-amber-50 py-2 pr-2 pl-6 text-xs text-amber-900">
              {scan.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {table && col && (
          <div className="mt-2 flex flex-wrap gap-3">
            <label className="text-xs">
              見出しの行
              <input
                type="number"
                min={1}
                max={table.rows.length}
                value={col.header + 1}
                onChange={(e) => setCol({ ...col, header: Math.max(0, Math.min(table.rows.length - 1, Number(e.target.value) - 1)) })}
                className="ml-1 w-16 rounded border px-1 py-0.5"
              />
            </label>
            {colSelect("date", "日付")}
            {colSelect("desc", "摘要")}
            {colSelect("deposit", "入金")}
            {colSelect("withdrawal", "出金")}
            {colSelect("balance", "残高")}
          </div>
          )}
          {parsed.length === 0 ? (
            <p className="mt-2 text-sm text-red-600">読める行がありません。列を確かめてください。</p>
          ) : (
            <>
              <p className="mt-2 text-sm">
                {parsed.length}行（{parsed[0].date}〜{parsed[parsed.length - 1].date}）　入金 {yen(parsed.reduce((n, r) => n + r.deposit, 0))}円　出金{" "}
                {yen(parsed.reduce((n, r) => n + r.withdrawal, 0))}円
              </p>
              <div className={`mt-2 overflow-auto text-xs ${scan ? "max-h-96" : "max-h-48"}`}>
                <table className="w-full tabular-nums">
                  <tbody>
                    {parsed.slice(0, scan ? 1000 : 8).map((r, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-1">{r.date}</td>
                        <td className="px-1">{r.desc}</td>
                        <td className="px-1 text-right">{r.deposit ? `+${yen(r.deposit)}` : ""}</td>
                        <td className="px-1 text-right">{r.withdrawal ? `−${yen(r.withdrawal)}` : ""}</td>
                        <td className="px-1 text-right text-gray-500">{r.balance === null ? "" : yen(r.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!scan && parsed.length > 8 && <p className="text-gray-500">ほか {parsed.length - 8} 行</p>}
              </div>
              <button onClick={save} disabled={busy} className="mt-3 rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
                {busy ? "取り込み中…" : `「${accountOf(config.accounts, account).name}」に取り込む`}
              </button>
            </>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}

/** その月の通帳の行。行ごとに科目を決められる（決めなければ、摘要の言葉で決まる） */
function MonthRows({ month, books, config }: { month: string; books: Books; config: LedgerConfig }) {
  const saved = books.bank.find((x) => x.month === month)?.rows ?? [];
  const [rows, setRows] = useState<BankRow[]>(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // 取り込み直したなど、保存してある行が変わったら読み直す（直している途中でなければ）
  const savedKey = JSON.stringify(saved);
  const [prevKey, setPrevKey] = useState(savedKey);
  if (prevKey !== savedKey && !dirty) {
    setPrevKey(savedKey);
    setRows(saved);
  }
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const accounts = config.accounts;
  const set = (i: number, code: string) => {
    setRows(
      rows.map((r, j) => {
        if (j !== i) return r;
        const next: BankRow = { ...r, code };
        if (!code) delete next.code;
        return next;
      }),
    );
    setDirty(true);
    setMsg("");
  };
  async function save(list: BankRow[] = rows) {
    setErr("");
    setSaving(true);
    try {
      await saveBankMonths([{ month, rows: list }]);
      setDirty(false);
      setPrevKey(JSON.stringify(list));
      setMsg(list.length ? "保存しました" : "この月の通帳を消しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  // 通帳の残高と帳簿の残高（預金ごと、この月の最後の行で比べる）
  const totals = totalsByAccount(postingsInRange(books, config, "0000-00", month));
  const checks = [...new Set(rows.map((r) => r.account))].map((code) => {
    const last = [...rows].reverse().find((r) => r.account === code && r.balance !== null);
    const a = accountOf(accounts, code);
    return { a, bank: last?.balance ?? null, book: balanceOf(a.kind, totals.get(code)) };
  });
  const unsorted = rows.filter((r) => (r.code || ruleFor(r.desc, config.bankRules)?.code || UNSORTED) === UNSORTED).length;

  if (rows.length === 0) return <p className="mt-3 text-sm text-gray-500">この月の通帳はまだ取り込んでいません。</p>;
  return (
    <>
      {unsorted > 0 && (
        <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
          科目が決まっていない行が {unsorted} 行あります。行ごとに選ぶか、下の「摘要の言葉と科目」に言葉を足してください。
        </p>
      )}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[56rem] text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="w-14 px-2 py-2 text-left">日付</th>
              <th className="w-24 px-2 py-2 text-left">預金</th>
              <th className="px-2 py-2 text-left">摘要</th>
              <th className="w-24 px-2 py-2 text-right">入金</th>
              <th className="w-24 px-2 py-2 text-right">出金</th>
              <th className="w-24 px-2 py-2 text-right">残高</th>
              <th className="w-64 px-2 py-2 text-left">科目</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const rule = ruleFor(r.desc, config.bankRules);
              const code = r.code || rule?.code || UNSORTED;
              return (
                <tr key={i} className={`border-t ${code === UNSORTED ? "bg-amber-50" : code === SKIP ? "text-gray-400" : ""}`}>
                  <td className="px-2 py-1.5">{md(r.date)}</td>
                  <td className="px-2 text-xs">{accountOf(accounts, r.account).name}</td>
                  <td className="px-2">{r.desc}</td>
                  <td className="px-2 text-right">{r.deposit ? yen(r.deposit) : ""}</td>
                  <td className="px-2 text-right">{r.withdrawal ? yen(r.withdrawal) : ""}</td>
                  <td className="px-2 text-right text-gray-500">{r.balance === null ? "" : yen(r.balance)}</td>
                  <td className="px-1 py-1">
                    <CodeSelect
                      accounts={accounts}
                      value={r.code ?? ""}
                      onChange={(v) => set(i, v)}
                      label={`${i + 1}行目の科目`}
                      empty={rule ? `言葉「${rule.keyword}」→ ${codeName(accounts, rule.code)}` : "（未分類）"}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 space-y-1 text-sm">
        {checks.map((c) =>
          c.bank === null ? null : (
            <p key={c.a.code} className={c.bank === c.book ? "text-emerald-700" : "text-amber-700"}>
              {c.a.name}：通帳の残高 {yen(c.bank)}円／帳簿の残高 {yen(c.book)}円
              {c.bank === c.book
                ? "（合っています）"
                : `（${yen(c.bank - c.book)}円ちがいます。はじめての月は、仕訳帳で取り込む前の残高を「開始残高」を相手に入れてください）`}
            </p>
          ),
        )}
      </div>
      <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-3 border-t bg-gray-50/95 py-3">
        <button onClick={() => save()} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "保存する"}
        </button>
        <button
          onClick={() => {
            if (window.confirm("この月に取り込んだ通帳の行を全部消しますか？")) save([]);
          }}
          className="text-sm text-gray-500 underline"
        >
          この月の通帳を消す
        </button>
        {dirty && <span className="text-sm text-amber-700">保存していない変更があります</span>}
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </>
  );
}

/** 摘要の言葉と科目（上から順に見て、最初に合った言葉の科目にする） */
function Rules({ config }: { config: LedgerConfig }) {
  const [rules, setRules] = useState<BankRule[]>(config.bankRules);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const change = (next: BankRule[]) => {
    setRules(next);
    setDirty(true);
    setMsg("");
  };
  async function save() {
    setErr("");
    setSaving(true);
    try {
      await saveLedgerConfig({ ...config, bankRules: rules.filter((r) => r.keyword.trim() && r.code) });
      setDirty(false);
      setMsg("保存しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="mt-8 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">摘要の言葉と科目</h2>
      <p className="mt-1 text-xs text-gray-500">
        摘要にこの言葉が入っていたら、この科目にします（上から順に見ます）。売上の入金など、レジ・売掛の自動仕訳ですでに入っているものは「帳簿に入れない」にしてください。
      </p>
      <table className="mt-3 w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="px-2 py-2 text-left">言葉</th>
            <th className="px-2 py-2 text-left">科目</th>
            <th className="w-20" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="px-1 py-1">
                <input
                  value={r.keyword}
                  maxLength={40}
                  placeholder="例 ﾃﾞﾝｷ"
                  aria-label={`${i + 1}番目の言葉`}
                  onChange={(e) => change(rules.map((x, j) => (j === i ? { ...x, keyword: e.target.value } : x)))}
                  className="w-full rounded border px-2 py-1"
                />
              </td>
              <td className="px-1 py-1">
                <CodeSelect
                  accounts={config.accounts}
                  value={r.code}
                  onChange={(v) => change(rules.map((x, j) => (j === i ? { ...x, code: v } : x)))}
                  label={`${i + 1}番目の科目`}
                  empty="（科目を選ぶ）"
                />
              </td>
              <td className="px-1 text-center whitespace-nowrap">
                <button
                  disabled={i === 0}
                  onClick={() => change([...rules.slice(0, i - 1), rules[i], rules[i - 1], ...rules.slice(i + 1)])}
                  className="px-1 text-gray-400 disabled:opacity-30"
                  aria-label={`${i + 1}番目を上へ`}
                >
                  ▲
                </button>
                <button onClick={() => change(rules.filter((_, j) => j !== i))} className="px-1 text-gray-400 hover:text-red-600" aria-label={`${i + 1}番目を消す`}>
                  🗑
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => change([...rules, { keyword: "", code: "" }])} className="mt-2 rounded-lg border px-3 py-1 text-sm">
        ＋ 言葉を足す
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "言葉を保存する"}
        </button>
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </section>
  );
}
