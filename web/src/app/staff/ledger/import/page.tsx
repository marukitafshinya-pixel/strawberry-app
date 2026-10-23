"use client";

// 帳簿：いまの会計ソフトから取り込む。月ごとの合計残高試算表（貸借対照表・損益計算書・製造原価のシート。.xls / .xlsx）を読み、
// 合っているかを確かめてから tbImport/{YYYY-MM} に保存する（管理者と経理担当）。取り込んだ月は、帳簿でその数字だけを使う
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import {
  appendJournal,
  checkTb,
  deleteTbImport,
  ledgerToJournal,
  saveTbImport,
  useJournal,
  useLedgerConfig,
  useTbImport,
  type JournalMonth,
  type LedgerConfig,
} from "@/lib/books";
import { readLedgerPdf, type LedgerFile } from "@/lib/ledgerPdf";
import { receiptToJournal, scanLedgerFiles, scanReceipts, type Receipt } from "@/lib/booksScan";
import { readTrialBalance, type TbMonth, type TbParsed } from "@/lib/tbImport";
import { openWorkbook } from "@/lib/xlsx";
import { AccountSelect, canUseLedger, LedgerHeader, yen } from "../parts";

const ym = (m: string) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

export default function ImportPage() {
  const { role } = useAuth();
  const { value: config, error: e1 } = useLedgerConfig();
  const { value: saved, error: e2 } = useTbImport();
  const { value: journal, error: e3 } = useJournal();
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2 || e3;
  return (
    <div className="pb-24">
      <LedgerHeader title="会計ソフトから取り込み" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !config || !saved || !journal ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <Import config={config} saved={saved} />
          <Saved saved={saved} />
          <Reclassify journal={journal} />
          <Receipts journal={journal} config={config} saved={saved} />
        </>
      )}
    </div>
  );
}

function Import({ config, saved }: { config: LedgerConfig; saved: TbMonth[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<TbParsed[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function pick(files: FileList) {
    setErr("");
    setMsg("");
    const out: TbParsed[] = [];
    for (const f of Array.from(files)) {
      try {
        out.push(await readTrialBalance(await openWorkbook(await f.arrayBuffer()), f.name));
      } catch (e) {
        out.push({ month: "", rows: [], accounts: [], fileName: f.name, problems: [errorText(e)] });
      }
    }
    setList(out.sort((a, b) => a.month.localeCompare(b.month)));
  }

  const checked = list.map((t) => ({ t, c: checkTb(t, config.accounts) }));
  // つながりの確かめ：前の月（今回のファイルか、取り込み済み）の残高と、この月の繰越が合うか
  const prevOf = (month: string) => [...list.filter((x) => x.month < month && !x.problems.length), ...saved.filter((x) => x.month < month)].sort((a, b) => b.month.localeCompare(a.month))[0];
  const gaps = (t: TbParsed) => {
    const p = prevOf(t.month);
    if (!p) return [];
    return t.rows.filter((r) => (p.rows.find((x) => x.code === r.code)?.balance ?? 0) !== r.carry).map((r) => r.code);
  };
  const ok = (x: (typeof checked)[number]) => x.t.month && !x.t.problems.length && x.c.balanced && x.c.wrong.length === 0;
  const good = checked.filter(ok).map((x) => x.t);
  const dupMonths = new Set(list.map((t) => t.month).filter((m, i, a) => m && a.indexOf(m) !== i));
  const newAccounts = new Set(good.flatMap((t) => t.accounts.filter((a) => !config.accounts.some((b) => b.code === a.code)).map((a) => a.code)));

  async function save() {
    setErr("");
    setBusy(true);
    try {
      const added = await saveTbImport(good, config);
      setMsg(`${good.length}か月分を取り込みました${added ? `（勘定科目を${added}つ足しました）` : ""}`);
      setList([]);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">合計残高試算表を取り込む</h2>
      <p className="mt-1 text-xs text-gray-500">
        会計ソフトで「合計残高試算表」を1か月ずつ（集計開始月と集計終了月を同じ月にして）Excelに書き出し、まとめて選んでください。貸借対照表・損益計算書・製造原価のシートを読みます。
        同じ月をもう一度取り込むと置き換わります。取り込んだ月は、会計ソフトでつけ終わった月として、帳簿ではこの数字だけを使います（レジ・給与・通帳・出納帳からの仕訳は数えません）。
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => e.target.files?.length && pick(e.target.files)}
        className="mt-3 text-sm"
      />
      {list.length > 0 && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm tabular-nums">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="px-2 py-2 text-left">ファイル</th>
                  <th className="px-2 py-2 text-left">月</th>
                  <th className="px-2 py-2 text-right">科目</th>
                  <th className="px-2 py-2 text-right">借方合計</th>
                  <th className="px-2 py-2 text-right">貸方合計</th>
                  <th className="px-2 py-2 text-left">確かめ</th>
                </tr>
              </thead>
              <tbody>
                {checked.map(({ t, c }, i) => {
                  const g = ok({ t, c }) ? gaps(t) : [];
                  return (
                    <tr key={i} className={`border-t ${ok({ t, c }) ? "" : "bg-red-50"}`}>
                      <td className="px-2 py-1.5 text-xs">{t.fileName}</td>
                      <td className="px-2">
                        {t.month ? ym(t.month) : "－"}
                        {saved.some((x) => x.month === t.month) && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">置き換え</span>}
                      </td>
                      <td className="px-2 text-right">{t.rows.length}</td>
                      <td className="px-2 text-right">{yen(c.debit)}</td>
                      <td className="px-2 text-right">{yen(c.credit)}</td>
                      <td className="px-2 text-xs">
                        {t.problems.length ? (
                          <span className="text-red-600">{t.problems.join("／")}</span>
                        ) : !c.balanced ? (
                          <span className="text-red-600">借方と貸方の合計が合いません</span>
                        ) : c.wrong.length ? (
                          <span className="text-red-600">繰越＋借方−貸方が残高と合わない科目：{c.wrong.join("、")}</span>
                        ) : (
                          <span className="text-emerald-700">
                            ✓ 合っています
                            {g.length > 0 && <span className="ml-1 text-amber-700">（前の月の残高と繰越がちがう科目：{g.join("、")}）</span>}
                            {dupMonths.has(t.month) && <span className="ml-1 text-amber-700">（同じ月のファイルが2つあります。あとのほうを使います）</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {newAccounts.size > 0 && <p className="mt-2 text-sm text-gray-600">勘定科目にない科目が {newAccounts.size} あります。取り込むと勘定科目に足します。</p>}
          <button onClick={save} disabled={busy || good.length === 0} className="mt-3 rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
            {busy ? "取り込み中…" : `合っている${good.length}か月分を取り込む`}
          </button>
        </>
      )}
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}

function Saved({ saved }: { saved: TbMonth[] }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (saved.length === 0) return null;
  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">取り込んだ月</h2>
      <p className="mt-1 text-xs text-gray-500">いちばん古い月の「繰越金額」を期首の残高にしています。</p>
      <ul className="mt-2 divide-y text-sm">
        {saved.map((m) => (
          <li key={m.month} className="flex items-center gap-3 py-1.5">
            <span className="w-28 font-semibold">{ym(m.month)}</span>
            <span className="flex-1 text-xs text-gray-500">
              {m.rows.length}科目　{m.fileName}
            </span>
            <button
              disabled={!!busy}
              onClick={async () => {
                if (!window.confirm(`${ym(m.month)}の取り込みを消しますか？（この月は、レジ・給与・通帳・出納帳からの仕訳を使うようになります）`)) return;
                setErr("");
                setBusy(m.month);
                try {
                  await deleteTbImport(m.month);
                } catch (e) {
                  setErr(errorText(e));
                } finally {
                  setBusy("");
                }
              }}
              className="text-xs text-gray-400 underline hover:text-red-600"
            >
              消す
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}

/**
 * 総勘定元帳から仕分けし直す：会計ソフトの総勘定元帳（PDF）の行を、仕訳帳に「未仕分け」で入れる。
 * 貸方はその元帳の科目、借方は空にしておき、仕訳帳で新しい科目を選ぶ（選んだ行から、元の科目から新しい科目へ移る）
 */
function Reclassify({ journal }: { journal: JournalMonth[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<(LedgerFile & { fileName: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function pick(list: FileList) {
    setErr("");
    setMsg("");
    setBusy(true);
    const out: (LedgerFile & { fileName: string })[] = [];
    // 文字の入っているPDFは、その場で読む（速い・正確）。文字のないPDF（スキャン）・写真・TIFFは、AIで1ページずつ読む
    const scans: File[] = [];
    for (const f of Array.from(list)) {
      if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
        scans.push(f);
        continue;
      }
      try {
        const r = await readLedgerPdf(f);
        if (!r.code && r.rows.length === 0) scans.push(f);
        else out.push({ ...r, fileName: f.name });
      } catch (e) {
        out.push({ code: "", name: "", rows: [], total: null, problems: [errorText(e)], fileName: f.name });
      }
    }
    if (scans.length) {
      try {
        out.push(...(await scanLedgerFiles(scans, (done, total) => setProgress(`AIで読んでいます（${done}／${total}ページ）`))));
      } catch (e) {
        out.push({ code: "", name: "", rows: [], total: null, problems: [errorText(e)], fileName: scans.map((f) => f.name).join("・") });
      }
      setProgress("");
    }
    setFiles(out);
    setBusy(false);
  }
  const good = files.filter((f) => f.problems.length === 0);
  const unsure = files.filter((f) => f.problems.length > 0 && f.rows.length > 0 && f.code);
  const existing = new Set(journal.flatMap((m) => m.entries.map((e) => e.ref)).filter(Boolean));
  const months = (f: LedgerFile) => [...new Set(f.rows.map((r) => `${Number(r.date.slice(5, 7))}月`))].join("・");

  async function save(list = good) {
    setErr("");
    setBusy(true);
    try {
      const added = await appendJournal(journal, list.flatMap(ledgerToJournal));
      setMsg(`仕訳帳に未仕分けで ${added} 行入れました。仕訳帳で月を開き、借方の科目を選んでください`);
      setFiles([]);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">総勘定元帳から仕分けし直す</h2>
      <p className="mt-1 text-xs text-gray-500">
        会計ソフトの「総勘定元帳」をPDFにして、仕分けし直したい科目の分を選んでください（例：消耗品費・諸材料費）。1行ずつ、仕訳帳に「未仕分け」で入れます（貸方＝元の科目、借方＝空）。
        仕訳帳で借方に新しい科目を選ぶと、その金額が元の科目から新しい科目へ移ります。消費税の行は、同じ品名の行に足して税込の1行にします。同じ伝票はもう一度入れても二重になりません。
      </p>
      <p className="mt-1 text-xs text-gray-500">
        文字の入っているPDFはその場で読みます。スキャンしたPDF・写真・TIFFは、AIで1ページずつ読みます（1ページ1分ほど。AIの鍵が要ります）。
      </p>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".pdf,application/pdf,image/*,.tif,.tiff"
        onChange={(e) => e.target.files?.length && pick(e.target.files)}
        className="mt-3 text-sm"
      />
      {busy && files.length === 0 && <p className="mt-2 text-sm text-gray-500">{progress || "読んでいます…"}</p>}
      {files.length > 0 && (
        <>
          <table className="mt-3 w-full min-w-[40rem] text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-2 py-2 text-left">ファイル</th>
                <th className="px-2 py-2 text-left">科目</th>
                <th className="px-2 py-2 text-right">行</th>
                <th className="px-2 py-2 text-right">総合計</th>
                <th className="px-2 py-2 text-left">月</th>
                <th className="px-2 py-2 text-left">確かめ</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => {
                const already = f.rows.filter((r) => existing.has(`${f.code}:${r.no}`)).length;
                return (
                  <tr key={i} className={`border-t ${f.problems.length ? "bg-red-50" : ""}`}>
                    <td className="px-2 py-1.5 text-xs">{f.fileName}</td>
                    <td className="px-2">
                      {f.code} {f.name}
                    </td>
                    <td className="px-2 text-right">{f.rows.length}</td>
                    <td className="px-2 text-right">{f.total === null ? "" : yen(f.total)}</td>
                    <td className="px-2 text-xs">{months(f)}</td>
                    <td className="px-2 text-xs">
                      {f.problems.length ? (
                        <span className="text-red-600">{f.problems.join("／")}</span>
                      ) : (
                        <span className="text-emerald-700">
                          ✓ 総合計と合っています{already > 0 && <span className="ml-1 text-amber-700">（{already}行はもう入っています）</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={() => save()} disabled={busy || good.length === 0} className="rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
              {busy ? "入れています…" : `合っている${good.length}冊を、仕訳帳に未仕分けで入れる`}
            </button>
            {unsure.length > 0 && (
              <button
                onClick={() => window.confirm("合計が合っていない冊も入れますか？（入れたあと、仕訳帳で金額を確かめてください）") && save([...good, ...unsure])}
                disabled={busy}
                className="rounded-lg border border-amber-500 px-4 py-2 text-sm text-amber-900 disabled:opacity-50"
              >
                合っていない{unsure.length}冊も入れる
              </button>
            )}
          </div>
        </>
      )}
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}

/**
 * レシート・請求書を読む：写真・PDF（1枚1ページ）をAIで読み、税率ごとに1行の仕訳を、仕訳帳に未仕分けで入れる
 * （借方＝空、貸方＝払った科目。仕訳帳で借方の科目を選ぶ）
 */
function Receipts({ journal, config, saved }: { journal: JournalMonth[]; config: LedgerConfig; saved: TbMonth[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<(Receipt & { use: boolean })[]>([]);
  const [pay, setPay] = useState("100");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const importedMonths = new Set(saved.map((m) => m.month));

  async function pick(files: FileList) {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const r = await scanReceipts(Array.from(files), (done, total) => setProgress(`AIで読んでいます（${done}／${total}枚）`));
      setList(r.map((x) => ({ ...x, use: x.byRate.length > 0 && !importedMonths.has(x.date.slice(0, 7)) })));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setProgress("");
      setBusy(false);
    }
  }
  const chosen = list.filter((r) => r.use && /^\d{4}-\d{2}-\d{2}$/.test(r.date));

  async function save() {
    setErr("");
    setBusy(true);
    try {
      const added = await appendJournal(journal, chosen.flatMap((r) => receiptToJournal(r, pay)));
      setMsg(`仕訳帳に未仕分けで ${added} 行入れました。仕訳帳で月を開き、借方の科目を選んでください`);
      setList([]);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-bold">レシート・請求書を読む</h2>
      <p className="mt-1 text-xs text-gray-500">
        レシート・請求書・納品書の写真かPDFを選んでください（1枚に1ページ）。AIが日付・取引先・品名・税率ごとの金額を読み、税率ごとに1行ずつ、仕訳帳に未仕分けで入れます。
        貸方は下で選んだ「払った科目」、借方は仕訳帳で選びます（前に同じ品名・取引先で選んだ科目が候補に出ます）。試算表を取り込んだ月の分は、会計ソフトにもう入っているので、はじめはチェックを外しています。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          払った科目
          <AccountSelect accounts={config.accounts.filter((a) => a.kind === "asset" || a.kind === "liability")} value={pay} onChange={(v) => v && setPay(v)} label="払った科目" className="ml-2" />
        </label>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf,application/pdf"
          onChange={(e) => e.target.files?.length && pick(e.target.files)}
          className="text-sm"
        />
      </div>
      {busy && list.length === 0 && <p className="mt-2 text-sm text-gray-500">{progress || "読んでいます…"}</p>}
      {list.length > 0 && (
        <>
          <table className="mt-3 w-full min-w-[44rem] text-sm tabular-nums">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="w-10 px-2 py-2" />
                <th className="px-2 py-2 text-left">日付</th>
                <th className="px-2 py-2 text-left">取引先</th>
                <th className="px-2 py-2 text-left">品名</th>
                <th className="px-2 py-2 text-right">税率ごと</th>
                <th className="px-2 py-2 text-right">合計</th>
                <th className="px-2 py-2 text-left">確かめ</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className={`border-t ${r.problems.length ? "bg-amber-50" : ""}`}>
                  <td className="px-2 text-center">
                    <input type="checkbox" checked={r.use} aria-label={`${i + 1}枚目を入れる`} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)))} />
                  </td>
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="px-2">{r.partner}</td>
                  <td className="px-2">{r.items}</td>
                  <td className="px-2 text-right text-xs">{r.byRate.map((x) => `${x.rate} ${yen(x.amount)}`).join("／")}</td>
                  <td className="px-2 text-right">{yen(r.total)}</td>
                  <td className="px-2 text-xs">
                    {importedMonths.has(r.date.slice(0, 7)) && <span className="text-amber-700">試算表を取り込んだ月です。</span>}
                    {r.problems.length ? <span className="text-amber-700">{r.problems.join("／")}</span> : <span className="text-emerald-700">✓</span>}
                    <span className="ml-1 text-gray-400">{r.fileName}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={save} disabled={busy || chosen.length === 0} className="mt-3 rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
            {busy ? "入れています…" : `チェックした${chosen.length}枚を、仕訳帳に未仕分けで入れる`}
          </button>
        </>
      )}
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </section>
  );
}
