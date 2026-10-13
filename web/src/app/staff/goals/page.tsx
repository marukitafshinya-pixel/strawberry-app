"use client";

// 目標と実績（管理者だけ）：月ごとに目標を入れて、実績と達成率を見る
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { todayJST } from "@/lib/date";
import { GOAL_ITEMS, saveGoals, useGoals, useLaborCost, type GoalKey, type GoalMonths, type HobeMonths } from "@/lib/goals";
import { downloadCsv } from "@/lib/report";
import { useReceivablesInRange, useSales } from "@/lib/sales";
import { shipAmount, useShipments } from "@/lib/shipping";
import { REGI_START, useStoreDaysWithRegi } from "@/lib/store";
import { Num } from "../total/Num";

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const yen = (n: number) => n.toLocaleString("ja-JP");
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
/** 目標を入れた月だけの実績の合計（年間の達成率は、目標を入れた月どうしで比べる） */
const onTarget = (l: { target: number[]; actual: number[] }) => sum(l.actual.filter((_, i) => l.target[i]));
/** 目標・実績・達成率の1段（高さをそろえて、左の見出しと横に並ぶようにする） */
const SUB = "flex h-9 items-center";

export default function GoalsPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <GoalsView />
    </Suspense>
  );
}

function GoalsView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  const thisYear = Number(todayJST().slice(0, 4));
  const q = Number(params.get("year"));
  const year = q >= 2000 && q <= 2100 ? q : thisYear;
  const setYear = (y: number) => router.replace(`/staff/goals/?year=${y}`);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const goals = useGoals(year);
  const labor = useLaborCost(year);
  const shipments = useShipments(from, to);
  const { days: store } = useStoreDaysWithRegi(from, to);
  const { value: sales } = useSales(to < REGI_START ? "9999-12-30" : from < REGI_START ? REGI_START : from, to < REGI_START ? "9999-12-31" : to);
  const { value: receivables } = useReceivablesInRange(from, to);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  const ready = goals && labor && shipments && store && sales && receivables;
  // 月ごとの実績
  const inMonth = (d: string, m: string) => d.slice(5, 7) === m;
  const actual: Record<Exclude<GoalKey, "hobe">, number[]> | null = ready
    ? (() => {
        // 外販：売掛にした売上（レジで売掛にした会計と、手で入れた売掛）
        const gaihan = MONTHS.map((m) => receivables.filter((r) => inMonth(r.date, m)).reduce((n, r) => n + r.amount, 0));
        // 店舗の売上には、レジで売掛にした会計も入っているので、その分を引く
        const regiCredit = MONTHS.map((m) =>
          sales
            .filter((s) => s.status === "completed" && s.payment === "credit" && s.date >= REGI_START && inMonth(s.date, m))
            .reduce((n, s) => n + s.total, 0),
        );
        const storeAll = MONTHS.map((m) =>
          Object.entries(store)
            .filter(([d]) => inMonth(d, m))
            .reduce((n, [, d]) => n + ((d.direct ?? 0) + (d.cafe ?? 0) + (d.ichigo ?? 0) || (d.total ?? 0)), 0),
        );
        const ship = MONTHS.map((m) =>
          Object.entries(shipments)
            .filter(([d]) => inMonth(d, m))
            .reduce((n, [, items]) => n + Object.values(items).reduce((a, it) => a + (it.qty && it.price !== undefined ? shipAmount(it.qty, it.price) : 0), 0), 0),
        );
        return { store: storeAll.map((v, i) => v - regiCredit[i]), gaihan, ship, labor: MONTHS.map((m) => labor[m] ?? 0) };
      })()
    : null;

  return (
    <div className="pb-24">
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">目標と実績（{year}年）</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setYear(year - 1)} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前の年
        </button>
        <span className="text-lg font-bold">{year}年</span>
        <button onClick={() => setYear(year + 1)} className="rounded-lg border bg-white px-3 py-2">
          次の年 ›
        </button>
        {year !== thisYear && (
          <button onClick={() => setYear(thisYear)} className="rounded-lg border bg-white px-3 py-2 text-sm">
            今年
          </button>
        )}
      </div>
      {!ready || !actual ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Table key={year} year={year} actual={actual} savedTargets={goals.targets} savedHobe={goals.hobe} />
      )}
    </div>
  );
}

type Line = {
  key: string;
  label: string;
  target: number[];
  actual: number[];
  /** 費用（少ないほど良い） */
  cost?: boolean;
  total?: boolean;
  /** 目標を入れる項目 */
  input?: GoalKey;
  /** 実績も手で入れる（ホーブへの支払い） */
  actualInput?: boolean;
};

function Table({
  year,
  actual,
  savedTargets,
  savedHobe,
}: {
  year: number;
  actual: Record<Exclude<GoalKey, "hobe">, number[]>;
  savedTargets: GoalMonths;
  savedHobe: HobeMonths;
}) {
  const [targets, setTargets] = useState<GoalMonths>(savedTargets);
  const [hobe, setHobe] = useState<HobeMonths>(savedHobe);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const today = todayJST();
  const curMonth = today.startsWith(`${year}-`) ? today.slice(5, 7) : "";

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const t = (k: GoalKey) => MONTHS.map((m) => targets[m]?.[k] ?? 0);
  const item = (k: GoalKey) => GOAL_ITEMS.find((x) => x.key === k)!;
  const hobeActual = MONTHS.map((m) => hobe[m] ?? 0);
  const ichigoKeys = ["store", "gaihan", "ship"] as const;
  const lines: Line[] = [
    ...ichigoKeys.map((k) => ({ key: k, label: item(k).label, target: t(k), actual: actual[k], input: k })),
    {
      key: "ichigo",
      label: "いちご金額 合計",
      target: MONTHS.map((_, i) => sum(ichigoKeys.map((k) => t(k)[i]))),
      actual: MONTHS.map((_, i) => sum(ichigoKeys.map((k) => actual[k][i]))),
      total: true,
    },
    { key: "labor", label: item("labor").label, target: t("labor"), actual: actual.labor, input: "labor", cost: true },
    { key: "hobe", label: item("hobe").label, target: t("hobe"), actual: hobeActual, input: "hobe", cost: true, actualInput: true },
  ];

  function setTarget(m: string, k: GoalKey, v: number | null) {
    const row = { ...(targets[m] ?? {}) };
    if (v === null) delete row[k];
    else row[k] = v;
    setTargets({ ...targets, [m]: row });
    setDirty(true);
    setMsg("");
  }
  function setHobeActual(m: string, v: number | null) {
    const next = { ...hobe };
    if (v === null) delete next[m];
    else next[m] = v;
    setHobe(next);
    setDirty(true);
    setMsg("");
  }
  async function save() {
    setErr("");
    setSaving(true);
    try {
      await saveGoals(year, targets, hobe);
      setDirty(false);
      setMsg("保存しました");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  function exportCsv() {
    downloadCsv(`goals_${year}.csv`, [
      ["項目", "", ...MONTHS.map((m) => `${Number(m)}月`), "年計"],
      ...lines.flatMap((l) => [
        [l.label, "目標", ...l.target, sum(l.target)],
        [l.label, "実績", ...l.actual, sum(l.actual)],
        [l.label, "達成率", ...l.target.map((v, i) => pct(l.actual[i], v)), pct(onTarget(l), sum(l.target))],
      ]),
    ]);
  }

  const ichigo = lines.find((l) => l.key === "ichigo")!;
  const laborL = lines.find((l) => l.key === "labor")!;
  const hobeL = lines.find((l) => l.key === "hobe")!;
  return (
    <>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Tile label="いちご金額（店舗・外販・出荷）" target={sum(ichigo.target)} actual={sum(ichigo.actual)} onTarget={onTarget(ichigo)} strong />
        <Tile label="人件費" target={sum(laborL.target)} actual={sum(laborL.actual)} onTarget={onTarget(laborL)} cost />
        <Tile label="ホーブへの支払い" target={sum(hobeL.target)} actual={sum(hobeL.actual)} onTarget={onTarget(hobeL)} cost />
      </div>
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-xs text-gray-600">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">項目</th>
              {MONTHS.map((m) => (
                <th key={m} className={`px-1 py-2 text-right ${m === curMonth ? "text-berry-dark" : ""}`}>
                  {Number(m)}月{m === curMonth && <span className="ml-0.5 text-[10px]">（今月）</span>}
                </th>
              ))}
              <th className="bg-berry/10 px-2 py-2 text-right">年計</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const bg = l.total ? "bg-rose-50" : l.cost ? "bg-slate-50" : "bg-white";
              return (
                <tr key={l.key} className={`border-t ${l.total ? "font-bold" : ""} ${l.key === "labor" ? "border-t-2 border-gray-300" : ""}`}>
                  <th className={`sticky left-0 z-10 whitespace-nowrap px-2 py-1.5 text-left align-top font-[inherit] ${bg}`}>
                    <div className="h-6">{l.label}</div>
                    {["目標", "実績", l.cost ? "目標比" : "達成率"].map((x) => (
                      <div key={x} className={`${SUB} text-[11px] font-normal text-gray-500`}>
                        {x}
                      </div>
                    ))}
                  </th>
                  {MONTHS.map((m, i) => (
                    <td key={m} className={`px-1 py-1.5 text-right align-top ${bg}`}>
                      <div className="h-6" />
                      <div className={`${SUB} justify-end`}>
                        {l.input ? (
                          <Num
                            value={targets[m]?.[l.input] ?? null}
                            label={`${Number(m)}月の${l.label}の目標`}
                            placeholder="目標"
                            onChange={(v) => setTarget(m, l.input!, v)}
                          />
                        ) : (
                          <span className="px-1">{l.target[i] ? yen(l.target[i]) : "－"}</span>
                        )}
                      </div>
                      <div className={`${SUB} justify-end`}>
                        {l.actualInput ? (
                          <Num value={hobe[m] ?? null} label={`${Number(m)}月の${l.label}の実績`} placeholder="実績" onChange={(v) => setHobeActual(m, v)} />
                        ) : (
                          <span className="px-1">{l.actual[i] ? yen(l.actual[i]) : "－"}</span>
                        )}
                      </div>
                      <div className={`${SUB} justify-end`}>
                        <Rate actual={l.actual[i]} target={l.target[i]} cost={l.cost} />
                      </div>
                    </td>
                  ))}
                  <td className="bg-berry/5 px-2 py-1.5 text-right align-top font-bold">
                    <div className="h-6" />
                    <div className={`${SUB} justify-end`}>{yen(sum(l.target))}</div>
                    <div className={`${SUB} justify-end`}>{yen(sum(l.actual))}</div>
                    <div className={`${SUB} justify-end`}>
                      <Rate actual={onTarget(l)} target={sum(l.target)} cost={l.cost} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-gray-600">
        白い欄に月ごとの目標を入れて「保存する」を押してください。いちご金額は、達成率が100%以上なら緑、届かなければ赤です。人件費とホーブへの支払いは、目標比が100%以下（目標の中に収まった）なら緑、超えたら赤です。年計の達成率は、目標を入れた月だけで計算します。
      </p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        実績の出し方：店舗＝「店舗実績」の売上（10月1日からはレジの会計）から、レジで売掛にした会計を引いたもの。外販＝売掛にした売上（レジで売掛にした会計と、手で入れた売掛）。出荷＝「出荷実績」の数量×単価に消費税（8%）を足した税込の金額（単価がまだの日は入りません）。人件費＝「給与」のその月度の会社の負担（総支給＋事業所負担）。ホーブへの支払いの実績は、この表に手で入れます。
      </p>
      <div className="mt-2 flex gap-3 print:hidden">
        <button onClick={exportCsv} className="text-sm text-gray-600 underline">
          CSVで書き出す
        </button>
        <button onClick={() => window.print()} className="text-sm text-gray-600 underline">
          印刷
        </button>
      </div>
      <style>{`@media print { @page { size: A4 landscape; margin: 8mm; } body { background: #fff !important; } }`}</style>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] print:hidden">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <button onClick={save} disabled={saving || !dirty} className="rounded-lg bg-berry px-6 py-2.5 font-bold text-white disabled:opacity-40">
            {saving ? "保存中…" : "保存する"}
          </button>
          {dirty && <span className="text-sm text-amber-700">まだ保存していません</span>}
          {msg && <span className="text-sm text-gray-600">{msg}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </div>
    </>
  );
}

const pct = (a: number, t: number) => (t ? `${Math.round((a / t) * 1000) / 10}%` : "");

/** 達成率（費用は目標比）。売上は100%以上が緑、費用は100%以下が緑 */
function Rate({ actual, target, cost }: { actual: number; target: number; cost?: boolean }) {
  if (!target) return <span className="pr-1 text-[11px] font-normal text-gray-300">－</span>;
  const p = Math.round((actual / target) * 1000) / 10;
  const good = cost ? p <= 100 : p >= 100;
  return <span className={`pr-1 text-[11px] font-semibold ${good ? "text-emerald-700" : "text-red-600"}`}>{p.toLocaleString("ja-JP")}%</span>;
}

function Tile({
  label,
  target,
  actual,
  onTarget,
  strong,
  cost,
}: {
  label: string;
  target: number;
  actual: number;
  onTarget: number;
  strong?: boolean;
  cost?: boolean;
}) {
  const p = target ? Math.round((onTarget / target) * 1000) / 10 : null;
  const good = p !== null && (cost ? p <= 100 : p >= 100);
  return (
    <div className={`rounded-xl p-3 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <p className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}（年間）</p>
      <p className="mt-1 text-xl font-bold tabular-nums">実績 {yen(actual)}円</p>
      <p className={`mt-0.5 text-xs tabular-nums ${strong ? "text-white/90" : "text-gray-600"}`}>
        目標 {yen(target)}円
        {p !== null && (
          <b className={`ml-1 ${strong ? "" : good ? "text-emerald-700" : "text-red-600"}`}>
            （{cost ? "目標比" : "達成率"} {p.toLocaleString("ja-JP")}%）
          </b>
        )}
      </p>
    </div>
  );
}
