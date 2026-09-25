"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { HBars, Legend, SERIES_COLORS, StackedColumns, type Series } from "@/components/charts";
import { addDays, formatJa, isValidYmd, todayJST, weekday } from "@/lib/date";
import { buildDailySales, downloadCsv, sumValues } from "@/lib/report";
import { STATUS_LABEL, countsTowardCapacity, useReservationsRange, useSettings, yen, type ReservationStatus } from "@/lib/reservations";
import { PAYMENT_LABEL, useImportedSales, useSales } from "@/lib/sales";
import type { Settings } from "@/lib/settings";

const MAX_DAYS = 366;

export default function ReportPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <ReportView />
    </Suspense>
  );
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

/** よく使う期間 */
function presets(settings: Settings, today: string): { label: string; from: string; to: string }[] {
  const y = Number(today.slice(0, 4));
  const ym = today.slice(0, 7);
  const firstOfMonth = `${ym}-01`;
  const lastOfMonth = addDays(`${new Date(Date.UTC(y, Number(ym.slice(5)), 1)).toISOString().slice(0, 7)}-01`, -1);
  const prevFirst = new Date(Date.UTC(y, Number(ym.slice(5)) - 2, 1)).toISOString().slice(0, 10);
  const monday = addDays(today, -((new Date(Date.parse(today)).getUTCDay() + 6) % 7));
  // 今シーズン（営業期間）：年をまたがない前提。またぐ設定なら今年の開始日から翌年の終了日まで
  const seasonFrom = `${y}-${settings.seasonStart}`;
  const seasonTo = settings.seasonStart <= settings.seasonEnd ? `${y}-${settings.seasonEnd}` : `${y + 1}-${settings.seasonEnd}`;
  return [
    { label: "今日", from: today, to: today },
    { label: "今週", from: monday, to: addDays(monday, 6) },
    { label: "今月", from: firstOfMonth, to: lastOfMonth },
    { label: "先月", from: prevFirst, to: addDays(firstOfMonth, -1) },
    { label: "今シーズン", from: seasonFrom, to: seasonTo },
    { label: "今年", from: `${y}-01-01`, to: `${y}-12-31` },
    { label: "去年", from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}

function ReportView() {
  const params = useSearchParams();
  const router = useRouter();
  const today = todayJST();
  const defFrom = `${today.slice(0, 7)}-01`;
  const qFrom = params.get("from");
  const qTo = params.get("to");
  const from = isValidYmd(qFrom) ? qFrom : defFrom;
  const to = isValidYmd(qTo) && qTo >= from ? qTo : today < from ? from : today;
  const days = daysBetween(from, to);
  const tooLong = days > MAX_DAYS;
  const setRange = (f: string, t: string) => router.replace(`/staff/report/?from=${f}&to=${t}`);

  const { value: settings } = useSettings();
  // 期間が長すぎるときは読み込まない（表示が重くなるため）
  const qf = tooLong ? "9999-12-31" : from;
  const { value: reservations } = useReservationsRange(qf, to);
  const { value: sales } = useSales(qf, to);
  const { value: imported } = useImportedSales(qf, to);

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">集計（期間を指定）</h1>

      {/* 期間の指定（グラフの上に1列で） */}
      <section className="mt-4 space-y-2 rounded-2xl bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={from} onChange={(e) => isValidYmd(e.target.value) && setRange(e.target.value, to < e.target.value ? e.target.value : to)} className="rounded-lg border px-3 py-2 text-base" />
          〜
          <input type="date" value={to} onChange={(e) => isValidYmd(e.target.value) && setRange(from > e.target.value ? e.target.value : from, e.target.value)} className="rounded-lg border px-3 py-2 text-base" />
          <span className="text-sm text-gray-600">{days}日間</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets(settings, today).map((p) => (
            <button
              key={p.label}
              onClick={() => setRange(p.from, p.to)}
              className={`rounded-full border px-3 py-1 text-sm ${p.from === from && p.to === to ? "border-berry bg-berry text-white" : ""}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {tooLong ? (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-amber-800">期間は{MAX_DAYS}日以内で選んでください。</p>
      ) : !reservations || !sales || !imported ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Report settings={settings} from={from} to={to} reservations={reservations} sales={sales} imported={imported} />
      )}
    </>
  );
}

function Report({
  settings,
  from,
  to,
  reservations,
  sales,
  imported,
}: {
  settings: Settings;
  from: string;
  to: string;
  reservations: NonNullable<ReturnType<typeof useReservationsRange>["value"]>;
  sales: NonNullable<ReturnType<typeof useSales>["value"]>;
  imported: { id: string; amount: number }[];
}) {
  const [showTable, setShowTable] = useState(false);
  const days = daysBetween(from, to);
  const monthly = days > 62;

  // ---------- 予約 ----------
  const r = useMemo(() => {
    const active = reservations.filter((x) => countsTowardCapacity(x.status));
    const byStatus = Object.fromEntries((Object.keys(STATUS_LABEL) as ReservationStatus[]).map((st) => [st, reservations.filter((x) => x.status === st).length]));
    const tally = (key: (x: (typeof active)[number]) => string[] | string, weight: (x: (typeof active)[number], k: string) => number) => {
      const m = new Map<string, number>();
      for (const x of active) {
        const ks = key(x);
        for (const k of Array.isArray(ks) ? ks : [ks]) m.set(k, (m.get(k) ?? 0) + weight(x, k));
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      count: active.length,
      people: active.reduce((n, x) => n + x.people, 0),
      web: active.filter((x) => x.source === "web").length,
      staff: active.filter((x) => x.source !== "web").length,
      byStatus,
      byPlan: tally((x) => x.planName, (x) => x.people),
      bySlot: tally((x) => x.slotTime, (x) => x.people).sort((a, b) => a[0].localeCompare(b[0])),
      byCategory: tally(
        (x) => x.lines.map((l) => l.name),
        (x, k) => x.lines.filter((l) => l.name === k).reduce((n, l) => n + l.qty, 0),
      ),
    };
  }, [reservations]);

  // ---------- 売上 ----------
  const s = useMemo(() => {
    const done = sales.filter((x) => x.status === "completed");
    const { byDay, series } = buildDailySales(settings, sales, imported);
    const total = [...byDay.values()].reduce((n, v) => n + sumValues(v), 0);
    const importedTotal = [...byDay.values()].reduce((n, v) => n + (v.__imported ?? 0), 0);
    const cash = done.filter((x) => x.payment === "cash").reduce((n, x) => n + x.total, 0);
    const credit = done.filter((x) => x.payment === "credit").reduce((n, x) => n + x.total, 0);
    const discount = done.reduce((n, x) => n + x.discountTotal, 0);
    const voided = sales.filter((x) => x.status === "voided").length;
    // 商品ごと（数量と金額）
    const items = new Map<string, { qty: number; amount: number; category: string }>();
    for (const x of done)
      for (const l of x.lines) {
        const it = items.get(l.name) ?? { qty: 0, amount: 0, category: l.category };
        items.set(l.name, { qty: it.qty + l.qty, amount: it.amount + l.amount, category: l.category });
      }
    return { done, byDay, series, total, importedTotal, cash, credit, discount, voided, items: [...items.entries()].sort((a, b) => b[1].amount - a[1].amount) };
  }, [settings, sales, imported]);

  // グラフ用（長い期間は月ごと）
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const rows = monthly
    ? [...new Set(dates.map((d) => d.slice(0, 7)))].map((m) => {
        const values: Record<string, number> = {};
        for (const [d, v] of s.byDay) if (d.startsWith(m) && d >= from && d <= to) for (const [k, n] of Object.entries(v)) values[k] = (values[k] ?? 0) + n;
        return { key: m, label: `${Number(m.slice(5))}月`, sub: `${m.slice(0, 4)}年${Number(m.slice(5))}月`, values };
      })
    : dates.map((d) => ({ key: d, label: String(Number(d.slice(8))), sub: formatJa(d), values: s.byDay.get(d) ?? {} }));
  const rowSeries: Series[] = s.series.filter((x) => rows.some((row) => (row.values[x.key] ?? 0) > 0));
  const catTotals = rowSeries
    .map((x) => ({ key: x.key, label: x.label, color: x.color, value: rows.reduce((n, row) => n + (row.values[x.key] ?? 0), 0) }))
    .sort((a, b) => b.value - a.value);

  function exportCsv() {
    const header = ["日付", "曜日", "予約件数", "予約人数", ...rowSeries.map((x) => x.label), "売上合計"];
    const body = dates.map((d) => {
      const act = reservations.filter((x) => x.date === d && countsTowardCapacity(x.status));
      const v = s.byDay.get(d) ?? {};
      return [d, weekday(d), act.length, act.reduce((n, x) => n + x.people, 0), ...rowSeries.map((x) => v[x.key] ?? 0), sumValues(v)];
    });
    downloadCsv(`report_${from}_${to}.csv`, [header, ...body]);
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} />
          表で見る
        </label>
        <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
      </div>

      {/* 予約 */}
      <h2 className="mt-4 text-lg font-bold">予約</h2>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="予約件数" value={`${r.count}件`} sub={`Web ${r.web}件・スタッフ入力 ${r.staff}件`} />
        <Tile label="予約人数" value={`${r.people}人`} sub={r.count > 0 ? `1件あたり ${(r.people / r.count).toFixed(1)}人` : undefined} />
        <Tile label="キャンセル" value={`${r.byStatus.cancelled}件`} />
        <Tile label="リクエスト（未承認）" value={`${r.byStatus.request}件`} />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card title="プラン別の人数">
          <CountList items={r.byPlan} unit="人" />
        </Card>
        <Card title="料金区分別の人数">
          <CountList items={r.byCategory} unit="人" />
        </Card>
        <Card title="時間枠別の人数">
          <CountList items={r.bySlot} unit="人" keepOrder />
        </Card>
      </div>

      {/* 売上 */}
      <h2 className="mt-6 text-lg font-bold">売上</h2>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="売上合計" value={yen(s.total)} strong sub={s.importedTotal > 0 ? `うち取り込み ${yen(s.importedTotal)}` : undefined} />
        <Tile label={PAYMENT_LABEL.cash} value={yen(s.cash)} />
        <Tile label={PAYMENT_LABEL.credit} value={yen(s.credit)} />
        <Tile
          label="会計件数"
          value={`${s.done.length}件`}
          sub={s.done.length > 0 ? `客単価 ${yen(Math.round((s.cash + s.credit) / s.done.length))}` : undefined}
        />
      </div>
      <p className="mt-2 text-sm text-gray-600">
        {s.discount > 0 && `値引きの合計 ${yen(s.discount)}（売上は値引き後）　`}
        {s.voided > 0 && `取り消した会計 ${s.voided}件（売上に含めていません）`}
      </p>

      <Card title={monthly ? "月ごとの売上" : "日ごとの売上"} className="mt-3">
        <Legend series={rowSeries} />
        {s.total === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">この期間の売上はありません</p>
        ) : (
          <div className="mt-2">
            <StackedColumns rows={rows} series={rowSeries} ariaLabel={`${from}〜${to}の売上`} />
          </div>
        )}
        {showTable && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1 pr-3">{monthly ? "月" : "日付"}</th>
                  {rowSeries.map((x) => (
                    <th key={x.key} className="py-1 pr-3 text-right">
                      {x.label}
                    </th>
                  ))}
                  <th className="py-1 text-right">合計</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((row) => sumValues(row.values) > 0)
                  .map((row) => (
                    <tr key={row.key} className="border-t">
                      <td className="py-1 pr-3">{row.sub}</td>
                      {rowSeries.map((x) => (
                        <td key={x.key} className="py-1 pr-3 text-right tabular-nums">
                          {(row.values[x.key] ?? 0).toLocaleString("ja-JP")}
                        </td>
                      ))}
                      <td className="py-1 text-right font-semibold tabular-nums">{sumValues(row.values).toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title="分類ごとの売上">
          {catTotals.length === 0 ? (
            <p className="text-sm text-gray-400">売上はありません</p>
          ) : (
            <HBars items={catTotals.map((c) => ({ ...c, note: s.total > 0 ? `${Math.round((c.value / s.total) * 100)}%` : undefined }))} />
          )}
        </Card>
        <Card title="商品・プランごと（アプリの会計のみ）">
          {s.items.length === 0 ? (
            <p className="text-sm text-gray-400">会計はありません</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {s.items.slice(0, showTable ? undefined : 10).map(([name, it]) => (
                  <tr key={name} className="border-t">
                    <td className="py-1">
                      {name}
                      <span className="ml-1 text-xs text-gray-400">{it.category}</span>
                    </td>
                    <td className="py-1 text-right tabular-nums">{it.qty.toLocaleString("ja-JP")}</td>
                    <td className="py-1 text-right font-semibold tabular-nums">{yen(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!showTable && s.items.length > 10 && <p className="mt-1 text-xs text-gray-500">上位10件を表示（「表で見る」ですべて表示）</p>}
        </Card>
      </div>
    </>
  );
}

function Tile({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl p-4 shadow-sm ${strong ? "bg-berry text-white" : "bg-white"}`}>
      <div className={`text-xs ${strong ? "text-white/80" : "text-gray-500"}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`text-sm ${strong ? "text-white/90" : "text-gray-600"}`}>{sub}</div>}
    </div>
  );
}

function Card({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl bg-white p-4 shadow-sm ${className}`}>
      <h3 className="mb-2 font-bold">{title}</h3>
      {children}
    </section>
  );
}

/** 件数・人数の一覧（横棒つき・値は常に表示） */
function CountList({ items, unit, keepOrder }: { items: [string, number][]; unit: string; keepOrder?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-gray-400">ありません</p>;
  const list = keepOrder ? items : [...items].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...list.map((i) => i[1]));
  return (
    <ul className="space-y-1.5">
      {list.map(([k, v]) => (
        <li key={k} className="grid grid-cols-[7rem_1fr_auto] items-center gap-2 text-sm">
          <span className="truncate" title={k}>
            {k}
          </span>
          <span className="h-2.5">
            <span className="block h-full rounded-r" style={{ width: `${(v / max) * 100}%`, background: SERIES_COLORS[0], minWidth: 3 }} />
          </span>
          <span className="text-right font-semibold tabular-nums">
            {v.toLocaleString("ja-JP")}
            {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}
