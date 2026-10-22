"use client";

// 帳簿：いまの会計ソフトから取り込む。月ごとの合計残高試算表（貸借対照表・損益計算書・製造原価のシート。.xls / .xlsx）を読み、
// 合っているかを確かめてから tbImport/{YYYY-MM} に保存する（管理者と経理担当）。取り込んだ月は、帳簿でその数字だけを使う
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { checkTb, deleteTbImport, saveTbImport, useLedgerConfig, useTbImport, type LedgerConfig } from "@/lib/books";
import { readTrialBalance, type TbMonth, type TbParsed } from "@/lib/tbImport";
import { openWorkbook } from "@/lib/xlsx";
import { canUseLedger, LedgerHeader, yen } from "../parts";

const ym = (m: string) => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;

export default function ImportPage() {
  const { role } = useAuth();
  const { value: config, error: e1 } = useLedgerConfig();
  const { value: saved, error: e2 } = useTbImport();
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2;
  return (
    <div className="pb-24">
      <LedgerHeader title="会計ソフトから取り込み" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !config || !saved ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <Import config={config} saved={saved} />
          <Saved saved={saved} />
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
