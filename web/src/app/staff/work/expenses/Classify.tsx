"use client";

// 経費を仕入れ先ごとにまとめ、「今年だけ」（新規ハウス資材・その他）と「毎年かかる」（修繕費・店舗消耗品・ホーブ出荷資材・ホーブ生産資材）に分ける。
// 分けた結果を、来年度予算の参考の表にする（印刷・CSV）
import { useMemo, useState } from "react";
import {
  catGroup,
  catLabel,
  catOf,
  EXPENSE_CATS,
  itemKey,
  partnerOf,
  setLedgerRule,
  useLedgerRules,
  type ExpenseCat,
  type LedgerRules,
  type SavedAccount,
} from "@/lib/ledger";
import { errorText } from "@/lib/callFunction";
import { downloadCsv } from "@/lib/report";

const yen = (n: number) => n.toLocaleString("ja-JP");
const net = (e: { debit: number; credit: number }) => e.debit - e.credit;
/** 項目の順（未分類は最後） */
const CAT_ORDER: (ExpenseCat | null)[] = [...EXPENSE_CATS.map((c) => c.key), null];

type ItemSum = { item: string; total: number; count: number; cat: ExpenseCat | null; own: ExpenseCat | null };
type PartnerSum = { partner: string; total: number; count: number; items: ItemSum[]; accounts: string[]; rule: ExpenseCat | null };

/** 仕入れ先ごと・品名ごとにまとめる（消費税の行も、同じ品名に足す） */
function summarize(accounts: SavedAccount[], rules: LedgerRules): PartnerSum[] {
  const byP = new Map<string, PartnerSum & { itemMap: Map<string, ItemSum> }>();
  for (const a of accounts)
    for (const e of a.entries) {
      const p = partnerOf(e);
      let ps = byP.get(p);
      if (!ps) {
        ps = { partner: p, total: 0, count: 0, items: [], accounts: [], rule: rules.partners[p] ?? null, itemMap: new Map() };
        byP.set(p, ps);
      }
      ps.total += net(e);
      if (!e.isTax) ps.count++;
      if (!ps.accounts.includes(a.name)) ps.accounts.push(a.name);
      const k = e.item.replace(/\s+/g, "");
      let it = ps.itemMap.get(k);
      if (!it) {
        it = { item: k, total: 0, count: 0, cat: catOf(e, rules), own: rules.items[itemKey(p, e.item)] ?? null };
        ps.itemMap.set(k, it);
      }
      it.total += net(e);
      if (!e.isTax) it.count++;
    }
  return [...byP.values()]
    .map(({ itemMap, ...ps }) => ({ ...ps, items: [...itemMap.values()].sort((x, y) => y.total - x.total) }))
    .sort((x, y) => y.total - x.total);
}

export function Classify({ accounts, periodLabel }: { accounts: SavedAccount[]; periodLabel: string }) {
  const rules = useLedgerRules();
  const [open, setOpen] = useState<string | null>(null);
  const [onlyUnset, setOnlyUnset] = useState(false);
  const [error, setError] = useState("");
  const list = useMemo(() => (rules ? summarize(accounts, rules) : null), [accounts, rules]);
  if (!rules || !list) return <p className="text-sm text-gray-500">読み込み中…</p>;

  // 項目ごとの合計と、その中の仕入れ先
  const byCat = new Map<ExpenseCat | null, { total: number; partners: Map<string, number> }>();
  for (const ps of list)
    for (const it of ps.items) {
      const c = byCat.get(it.cat) ?? { total: 0, partners: new Map() };
      c.total += it.total;
      c.partners.set(ps.partner, (c.partners.get(ps.partner) ?? 0) + it.total);
      byCat.set(it.cat, c);
    }
  const groupTotal = (g: string) => [...byCat.entries()].filter(([k]) => catGroup(k) === g).reduce((s, [, v]) => s + v.total, 0);
  const unsetCount = list.filter((ps) => ps.items.some((it) => it.cat == null)).length;

  async function setRule(kind: "partners" | "items", key: string, v: string) {
    setError("");
    try {
      await setLedgerRule(kind, key, (v || null) as ExpenseCat | null);
    } catch (e) {
      setError(`変えられませんでした：${errorText(e)}`);
    }
  }

  function csv() {
    const rows: (string | number)[][] = [["区分", "項目", "仕入れ先", "金額（税込）"]];
    for (const k of CAT_ORDER) {
      const c = byCat.get(k);
      if (!c) continue;
      for (const [p, t] of [...c.partners.entries()].sort((x, y) => y[1] - x[1])) rows.push([catGroup(k), catLabel(k), p, t]);
      rows.push([catGroup(k), `${catLabel(k)} 計`, "", c.total]);
    }
    rows.push(
      ["", "毎年かかる 計", "", groupTotal("毎年かかる")],
      ["", "今年だけ 計", "", groupTotal("今年だけ")],
      ["", "未分類 計", "", groupTotal("未分類")],
    );
    downloadCsv(`経費の仕分け_${periodLabel}.csv`, rows, { shiftJis: true });
  }

  const sel = "rounded border px-1 py-0.5 text-sm";
  return (
    <>
      <section className="rounded-xl border bg-white p-4 print:hidden">
        <h2 className="font-bold">③ 仕入れ先ごとに分ける</h2>
        <p className="mt-1 text-sm text-gray-600">
          仕入れ先ごとに項目を選ぶと、その仕入れ先の明細はすべてその項目になります。品名ごとに別の項目にしたいときは「品名」を開いて選んでください（品名のほうが優先）。決めた分け方は、次の年の元帳にもそのまま使います。
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyUnset} onChange={(e) => setOnlyUnset(e.target.checked)} />
          未分類が残っている仕入れ先だけ出す（{unsetCount}件）
        </label>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-600">
              <tr>
                <th className="px-2 py-1">仕入れ先</th>
                <th className="px-2 py-1 text-right">件数</th>
                <th className="px-2 py-1 text-right">金額（税込）</th>
                <th className="px-2 py-1">項目</th>
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {list
                .filter((ps) => !onlyUnset || ps.items.some((it) => it.cat == null))
                .map((ps) => {
                  const mixed = ps.items.some((it) => it.own != null && it.own !== ps.rule);
                  const unset = ps.items.some((it) => it.cat == null);
                  return (
                    <PartnerRows
                      key={ps.partner}
                      ps={ps}
                      open={open === ps.partner}
                      onToggle={() => setOpen(open === ps.partner ? null : ps.partner)}
                      mixed={mixed}
                      unset={unset}
                      sel={sel}
                      onPartner={(v) => setRule("partners", ps.partner, v)}
                      onItem={(item, v) => setRule("items", itemKey(ps.partner, item), v)}
                    />
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">④ 来年度予算の参考（{periodLabel}）</h2>
          <button onClick={() => window.print()} className="ml-auto rounded-lg border bg-white px-3 py-1.5 text-sm print:hidden">
            🖨 印刷
          </button>
          <button onClick={csv} className="rounded-lg border bg-white px-3 py-1.5 text-sm print:hidden">
            📄 CSVに書き出す
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-3">
          {(["毎年かかる", "今年だけ", "未分類"] as const).map((g) => (
            <div
              key={g}
              className={`rounded-xl border p-3 ${g === "毎年かかる" ? "border-sky-300 bg-sky-50" : g === "未分類" ? "border-amber-300 bg-amber-50" : ""}`}
            >
              <p className="text-xs text-gray-600">{g}</p>
              <p className="text-xl font-bold tabular-nums">{yen(groupTotal(g))}円</p>
            </div>
          ))}
        </div>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {CAT_ORDER.map((k) => {
              const c = byCat.get(k);
              if (!c) return null;
              return (
                <CatRows
                  key={k ?? "none"}
                  label={`${catGroup(k) === "未分類" ? "" : `${catGroup(k)}／`}${catLabel(k)}`}
                  total={c.total}
                  partners={c.partners}
                />
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function PartnerRows({
  ps,
  open,
  onToggle,
  mixed,
  unset,
  sel,
  onPartner,
  onItem,
}: {
  ps: PartnerSum;
  open: boolean;
  onToggle: () => void;
  mixed: boolean;
  unset: boolean;
  sel: string;
  onPartner: (v: string) => void;
  onItem: (item: string, v: string) => void;
}) {
  return (
    <>
      <tr className={`border-t ${unset ? "bg-amber-50" : ""}`}>
        <td className="px-2 py-1">
          <p className="font-bold">{ps.partner}</p>
          <p className="text-xs text-gray-500">{ps.accounts.join("・")}</p>
        </td>
        <td className="px-2 py-1 text-right">{ps.count}</td>
        <td className="px-2 py-1 text-right tabular-nums">{yen(ps.total)}</td>
        <td className="px-2 py-1">
          <CatSelect value={ps.rule} onChange={onPartner} className={sel} />
          {mixed && <span className="ml-1 text-xs text-gray-500">（品名ごとに別あり）</span>}
        </td>
        <td className="px-2 py-1">
          <button onClick={onToggle} className="rounded border px-2 py-0.5 text-xs">
            {open ? "閉じる" : `品名（${ps.items.length}）`}
          </button>
        </td>
      </tr>
      {open &&
        ps.items.map((it) => (
          <tr key={it.item} className={`text-xs ${it.cat == null ? "bg-amber-50" : "bg-gray-50"}`}>
            <td className="py-1 pr-2 pl-6">{it.item}</td>
            <td className="px-2 py-1 text-right">{it.count}</td>
            <td className="px-2 py-1 text-right tabular-nums">{yen(it.total)}</td>
            <td className="px-2 py-1" colSpan={2}>
              <CatSelect value={it.own} onChange={(v) => onItem(it.item, v)} className={sel} emptyLabel={`仕入れ先と同じ（${catLabel(ps.rule)}）`} />
            </td>
          </tr>
        ))}
    </>
  );
}

function CatSelect({
  value,
  onChange,
  className,
  emptyLabel = "未分類",
}: {
  value: string | null;
  onChange: (v: string) => void;
  className: string;
  emptyLabel?: string;
}) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={`${className} ${value ? "" : "text-gray-500"}`}>
      <option value="">{emptyLabel}</option>
      {(["今年だけ", "毎年かかる"] as const).map((g) => (
        <optgroup key={g} label={g}>
          {EXPENSE_CATS.filter((c) => c.group === g).map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function CatRows({ label, total, partners }: { label: string; total: number; partners: Map<string, number> }) {
  return (
    <>
      <tr className="border-t bg-gray-50 font-bold">
        <td className="px-2 py-1">{label}</td>
        <td className="px-2 py-1 text-right tabular-nums">{yen(total)}円</td>
      </tr>
      {[...partners.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([p, t]) => (
          <tr key={p} className="text-xs">
            <td className="py-0.5 pr-2 pl-6">{p}</td>
            <td className="px-2 py-0.5 text-right tabular-nums">{yen(t)}</td>
          </tr>
        ))}
    </>
  );
}
