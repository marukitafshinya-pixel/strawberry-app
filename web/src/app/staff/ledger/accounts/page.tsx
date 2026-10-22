"use client";

// 帳簿：勘定科目（損益計算書の区分・補助科目）・決算月・自動仕訳の科目・レジの分類と売上の科目・現金出納帳の項目と科目の対応（管理者と経理担当）
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { useCashbook, type CashMonth } from "@/lib/cashbook";
import {
  accountOf,
  AUTO_LABELS,
  cashItemsUsage,
  DEFAULT_ACCOUNTS,
  DEFAULT_AUTO,
  FIXED_CODES,
  fullName,
  KIND_LABEL,
  KINDS,
  sectionOf,
  SECTIONS,
  saveLedgerConfig,
  SKIP,
  sortAccounts,
  UNSORTED,
  useAutoJournal,
  useLedgerConfig,
  type Account,
  type AccountKind,
  type AutoMonth,
  type Section,
  type LedgerConfig,
} from "@/lib/books";
import { AccountSelect, canUseLedger, LedgerHeader, yen } from "../parts";

export default function AccountsPage() {
  const { role } = useAuth();
  const { value: config, error: e1 } = useLedgerConfig();
  const { value: cash, error: e2 } = useCashbook();
  const { value: auto, error: e3 } = useAutoJournal();
  if (!canUseLedger(role)) return <p>この画面は管理者と経理担当だけが使えます。</p>;
  const error = e1 || e2 || e3;
  return (
    <div className="pb-24">
      <LedgerHeader title="勘定科目" />
      {error ? (
        <p className="mt-4 text-red-600">{errorText(error)}</p>
      ) : !config || !cash || !auto ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Editor initial={config} cash={cash} auto={auto} />
      )}
    </div>
  );
}

function Editor({ initial, cash, auto }: { initial: LedgerConfig; cash: CashMonth[]; auto: AutoMonth[] }) {
  const [c, setC] = useState<LedgerConfig>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [onlyUnsorted, setOnlyUnsorted] = useState(false);
  const [add, setAdd] = useState<Account>({ code: "", name: "", kind: "expense" });
  const [newCat, setNewCat] = useState("");

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (p: Partial<LedgerConfig>) => {
    setC({ ...c, ...p });
    setDirty(true);
    setMsg("");
  };
  const setAccount = (code: string, p: Partial<Account>) => update({ accounts: c.accounts.map((a) => (a.code === code ? { ...a, ...p } : a)) });
  const usage = cashItemsUsage(cash);
  const isSorted = (item: string) => !!c.itemMap[item] && c.itemMap[item] !== UNSORTED;
  const unsortedCount = usage.filter((u) => !isSorted(u.item)).length;
  const shown = onlyUnsorted ? usage.filter((u) => !isSorted(u.item)) : usage;
  const accountName = (code: string) => fullName(c.accounts, accountOf(c.accounts, code));
  // レジの分類：自動仕訳を作った月に出てきた分類と、科目を決めてある分類
  const seen = new Map<string, number | null>();
  for (const m of auto) for (const [k, v] of Object.entries(m.categories)) seen.set(k, (seen.get(k) ?? 0) + v);
  for (const k of Object.keys(c.salesMap)) if (!seen.has(k)) seen.set(k, null);
  const categories = [...seen.entries()].sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1) || a[0].localeCompare(b[0], "ja"));
  const usedCodes = new Set([...Object.values(c.itemMap), ...c.bankRules.map((r) => r.code), ...Object.values(c.salesMap)]);
  const autoCodes = new Set(Object.values(c.auto));

  const addProblem = !add.code.trim()
    ? ""
    : !/^[0-9A-Za-z-]{1,10}$/.test(add.code.trim())
      ? "コードは半角の英数字10文字まで"
      : c.accounts.some((a) => a.code === add.code.trim())
        ? "そのコードはもう使っています"
        : !add.name.trim()
          ? "科目名を入れてください"
          : "";

  async function save() {
    setErr("");
    if (c.accounts.some((a) => !a.name.trim())) return setErr("科目名が空の科目があります");
    setSaving(true);
    try {
      await saveLedgerConfig(c);
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
      <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">決算月</h2>
        <label className="mt-2 flex items-center gap-2 text-sm">
          期のはじまり
          <select value={c.fiscalStart} onChange={(e) => update({ fiscalStart: Number(e.target.value) })} className="rounded border px-2 py-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}月
              </option>
            ))}
          </select>
          <span className="text-gray-500">（決算は {c.fiscalStart === 1 ? 12 : c.fiscalStart - 1}月）</span>
        </label>
      </section>

      <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">レジの売上・売掛・給与の仕訳に使う科目</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {AUTO_LABELS.map((x) => (
            <label key={x.key} className="text-sm">
              <span className="font-semibold">{x.label}</span>
              <AccountSelect
                accounts={c.accounts.filter((a) => a.code !== UNSORTED)}
                value={c.auto[x.key]}
                label={x.label}
                onChange={(v) => v && update({ auto: { ...c.auto, [x.key]: v } })}
                className="mt-0.5 w-full"
              />
              <span className="text-xs text-gray-500">{x.note}</span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">変えたら、仕訳帳か決算書の画面で「作り直す」を押すと、前の月にも使われます。</p>
      </section>

      <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">レジの分類と売上の科目</h2>
        <p className="mt-1 text-xs text-gray-500">
          レジで売った商品・プランの「分類」ごとに、どの売上の科目にするかを決めます。決めていない分類は「{accountName(c.auto.sales)}」になります。分類は、自動仕訳を作った月の売上から出ます。
        </p>
        <table className="mt-3 w-full min-w-[28rem] text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="px-2 py-2 text-left">レジの分類</th>
              <th className="w-32 px-2 py-2 text-right">売上（作った月の合計）</th>
              <th className="px-2 py-2 text-left">売上の科目</th>
            </tr>
          </thead>
          <tbody>
            {categories.map(([cat, amount]) => (
              <tr key={cat} className="border-t">
                <td className="px-2 py-1.5">{cat}</td>
                <td className="px-2 text-right">{amount === null ? "" : yen(amount)}</td>
                <td className="px-1 py-1">
                  <AccountSelect
                    accounts={c.accounts.filter((a) => sectionOf(a) === "sales")}
                    value={c.salesMap[cat] ?? ""}
                    empty={`（決めない → ${accountName(c.auto.sales)}）`}
                    label={`${cat}の売上の科目`}
                    onChange={(v) => {
                      const salesMap = { ...c.salesMap };
                      if (v) salesMap[cat] = v;
                      else delete salesMap[cat];
                      update({ salesMap });
                    }}
                    className="w-full"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center gap-2">
          <input value={newCat} maxLength={40} placeholder="分類の名前" aria-label="足す分類の名前" onChange={(e) => setNewCat(e.target.value)} className="rounded border px-2 py-1 text-sm" />
          <button
            disabled={!newCat.trim() || categories.some(([k]) => k === newCat.trim())}
            onClick={() => {
              update({ salesMap: { ...c.salesMap, [newCat.trim()]: c.auto.sales } });
              setNewCat("");
            }}
            className="rounded-lg border px-3 py-1 text-sm disabled:opacity-40"
          >
            ＋ 分類を足す
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-bold">現金出納帳の項目と勘定科目</h2>
          {unsortedCount > 0 ? (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-sm text-amber-900">科目が決まっていない項目：{unsortedCount}</span>
          ) : (
            usage.length > 0 && <span className="rounded bg-emerald-100 px-2 py-0.5 text-sm text-emerald-900">全部の項目の科目が決まっています</span>
          )}
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={onlyUnsorted} onChange={(e) => setOnlyUnsorted(e.target.checked)} />
            決まっていない項目だけ
          </label>
        </div>
        <p className="mt-1 text-xs text-gray-500">出納帳の「項目」ごとに、どの科目にするかを決めます。決めると、いままでの出入りも全部その科目で帳簿に入ります。</p>
        {usage.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">現金出納帳にまだ項目がありません。</p>
        ) : (
          <div className="mt-3 max-h-[60vh] overflow-auto">
            <table className="w-full min-w-[40rem] text-sm tabular-nums">
              <thead className="sticky top-0 bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="px-2 py-2 text-left">出納帳の項目</th>
                  <th className="w-14 px-2 py-2 text-right">件数</th>
                  <th className="w-28 px-2 py-2 text-right">収入</th>
                  <th className="w-28 px-2 py-2 text-right">支出</th>
                  <th className="px-2 py-2 text-left">勘定科目</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.item} className={`border-t ${isSorted(u.item) ? "" : "bg-amber-50"}`}>
                    <td className="px-2 py-1.5">{u.item}</td>
                    <td className="px-2 text-right">{u.count}</td>
                    <td className="px-2 text-right">{u.income ? yen(u.income) : ""}</td>
                    <td className="px-2 text-right">{u.expense ? yen(u.expense) : ""}</td>
                    <td className="px-1 py-1">
                      <AccountSelect
                        accounts={c.accounts.filter((a) => a.code !== UNSORTED)}
                        value={c.itemMap[u.item] ?? ""}
                        empty="（未分類）"
                        label={`${u.item}の勘定科目`}
                        onChange={(v) => {
                          const itemMap = { ...c.itemMap };
                          if (v) itemMap[u.item] = v;
                          else delete itemMap[u.item];
                          update({ itemMap });
                        }}
                        className="w-full"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">勘定科目の一覧</h2>
        <p className="mt-1 text-xs text-gray-500">名前と種類を変えられます。「現金」「開始残高」「未分類」と、レジ・給与の仕訳に使っている科目は消せません。</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="w-20 px-2 py-2 text-left">コード</th>
                <th className="px-2 py-2 text-left">科目名</th>
                <th className="w-24 px-2 py-2 text-left">種類</th>
                <th className="w-44 px-2 py-2 text-left">損益計算書の区分</th>
                <th className="w-44 px-2 py-2 text-left">補助科目の親</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {c.accounts
                .filter((a) => !a.hidden)
                .map((a) => (
                <tr key={a.code} className="border-t">
                  <td className="px-2 py-1 tabular-nums">{a.code}</td>
                  <td className={`px-1 py-1 ${a.parent ? "pl-6" : ""}`}>
                    <input
                      value={a.name}
                      maxLength={40}
                      aria-label={`${a.code}の科目名`}
                      onChange={(e) => setAccount(a.code, { name: e.target.value })}
                      className="w-full rounded border px-2 py-1"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <KindSelect
                      value={a.kind}
                      disabled={FIXED_CODES.includes(a.code)}
                      onChange={(k) => setAccount(a.code, { kind: k, section: undefined, parent: undefined })}
                      label={`${a.code}の種類`}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <SectionSelect account={a} onChange={(section) => setAccount(a.code, { section, parent: undefined })} />
                  </td>
                  <td className="px-1 py-1">
                    <ParentSelect accounts={c.accounts} account={a} onChange={(parent) => setAccount(a.code, { parent })} />
                  </td>
                  <td className="px-1 text-center">
                    {!FIXED_CODES.includes(a.code) && !autoCodes.has(a.code) && (
                      <button
                        onClick={() => {
                          const msg = usedCodes.has(a.code)
                            ? `「${a.name}」は出納帳の項目・通帳の言葉・レジの分類に使っています。消すと、それは未分類になります。消しますか？`
                            : `「${a.name}」を消しますか？（この科目の仕訳は「未登録」として残ります）`;
                          if (!window.confirm(msg)) return;
                          update({
                            removed: [...c.removed, a.code],
                            accounts: c.accounts.filter((b) => b.code !== a.code).map((b) => (b.parent === a.code ? { ...b, parent: undefined } : b)),
                            salesMap: Object.fromEntries(Object.entries(c.salesMap).filter(([, v]) => v !== a.code)),
                            itemMap: Object.fromEntries(Object.entries(c.itemMap).filter(([, v]) => v !== a.code)),
                            bankRules: c.bankRules.filter((r) => r.code !== a.code),
                          });
                        }}
                        className="px-1 text-gray-400 hover:text-red-600"
                        aria-label={`${a.name}を消す`}
                      >
                        🗑
                      </button>
                    )}
                  </td>
                </tr>
                ))}
            </tbody>
            <tfoot className="border-t-2">
              <tr>
                <td className="px-1 py-2">
                  <input
                    value={add.code}
                    maxLength={10}
                    placeholder="例 556"
                    aria-label="足す科目のコード"
                    onChange={(e) => setAdd({ ...add, code: e.target.value })}
                    className="w-full rounded border px-2 py-1"
                  />
                </td>
                <td className="px-1 py-2">
                  <input
                    value={add.name}
                    maxLength={40}
                    placeholder="例 研修費"
                    aria-label="足す科目の名前"
                    onChange={(e) => setAdd({ ...add, name: e.target.value })}
                    className="w-full rounded border px-2 py-1"
                  />
                </td>
                <td className="px-1 py-2">
                  <KindSelect value={add.kind} onChange={(k) => setAdd({ ...add, kind: k, section: undefined, parent: undefined })} label="足す科目の種類" />
                </td>
                <td className="px-1 py-2">
                  <SectionSelect account={add} onChange={(section) => setAdd({ ...add, section, parent: undefined })} />
                </td>
                <td className="px-1 py-2">
                  <ParentSelect accounts={c.accounts} account={add} onChange={(parent) => setAdd({ ...add, parent })} />
                </td>
                <td className="px-1 py-2">
                  <button
                    disabled={!add.code.trim() || !!addProblem}
                    onClick={() => {
                      update({ accounts: sortAccounts([...c.accounts, { ...add, code: add.code.trim(), name: add.name.trim() }]) });
                      setAdd({ code: "", name: "", kind: add.kind, section: add.section });
                    }}
                    className="rounded-lg bg-berry px-3 py-1 text-sm font-bold text-white disabled:opacity-40"
                  >
                    足す
                  </button>
                </td>
              </tr>
              {addProblem && (
                <tr>
                  <td colSpan={6} className="px-2 text-xs text-red-600">
                    {addProblem}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
        <button
          onClick={() => {
            if (!window.confirm("勘定科目と、レジ・給与の仕訳に使う科目を、はじめのものに戻しますか？（出納帳の項目との対応と決算月はそのまま）")) return;
            const codes = new Set(DEFAULT_ACCOUNTS.map((a) => a.code));
            update({
              accounts: DEFAULT_ACCOUNTS,
              itemMap: Object.fromEntries(Object.entries(c.itemMap).filter(([, v]) => codes.has(v))),
              auto: DEFAULT_AUTO,
              bankRules: c.bankRules.filter((r) => r.code === SKIP || codes.has(r.code)),
              salesMap: Object.fromEntries(Object.entries(c.salesMap).filter(([, v]) => codes.has(v))),
            });
          }}
          className="mt-3 text-sm text-gray-500 underline"
        >
          はじめの一覧に戻す
        </button>
      </section>

      <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-3 border-t bg-gray-50/95 py-3">
        <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "保存する"}
        </button>
        {dirty && <span className="text-sm text-amber-700">保存していない変更があります</span>}
        {msg && <span className="text-sm text-emerald-700">{msg}</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </>
  );
}

function KindSelect({ value, onChange, label, disabled }: { value: AccountKind; onChange: (k: AccountKind) => void; label: string; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value as AccountKind)} className="w-full rounded border bg-white px-1 py-1 disabled:bg-gray-100">
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {KIND_LABEL[k]}
        </option>
      ))}
    </select>
  );
}

function SectionSelect({ account, onChange }: { account: Account; onChange: (s: Section) => void }) {
  const list = SECTIONS.filter((x) => x.kind === account.kind);
  if (list.length === 0) return <span className="px-1 text-xs text-gray-400">（貸借対照表）</span>;
  return (
    <select
      value={sectionOf(account) ?? ""}
      aria-label={`${account.code || "足す科目"}の区分`}
      onChange={(e) => onChange(e.target.value as Section)}
      className="w-full rounded border bg-white px-1 py-1"
    >
      {list.map((x) => (
        <option key={x.key} value={x.key}>
          {x.label}
        </option>
      ))}
    </select>
  );
}

/** 補助科目にするときの親（同じ区分の、補助科目でない科目） */
function ParentSelect({ accounts, account, onChange }: { accounts: Account[]; account: Account; onChange: (p: string | undefined) => void }) {
  const sec = sectionOf(account);
  const hasChildren = accounts.some((b) => b.parent === account.code);
  const list = accounts.filter((b) => b.code !== account.code && !b.hidden && !b.parent && b.kind === account.kind && sectionOf(b) === sec && !FIXED_CODES.includes(b.code));
  if (!sec || hasChildren || FIXED_CODES.includes(account.code)) return <span className="px-1 text-xs text-gray-400">{hasChildren ? "（補助科目あり）" : ""}</span>;
  return (
    <select
      value={account.parent ?? ""}
      aria-label={`${account.code || "足す科目"}の親の科目`}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="w-full rounded border bg-white px-1 py-1"
    >
      <option value="">（なし）</option>
      {list.map((b) => (
        <option key={b.code} value={b.code}>
          {b.code} {b.name}
        </option>
      ))}
    </select>
  );
}
