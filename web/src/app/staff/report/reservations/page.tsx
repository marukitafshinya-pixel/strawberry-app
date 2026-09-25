"use client";

import Link from "next/link";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { MAX_DAYS, RangePicker, useRangeParams } from "@/components/RangePicker";
import { Legend, SERIES_COLORS, StackedColumns, type Series } from "@/components/charts";
import { addDays, formatJa, weekday } from "@/lib/date";
import { downloadCsv } from "@/lib/report";
import {
  STATUS_LABEL,
  STATUS_STYLE,
  countsTowardCapacity,
  peopleText,
  useContactsRange,
  useReservationsRange,
  useSettings,
  type Contact,
  type Reservation,
  type ReservationStatus,
} from "@/lib/reservations";
import type { Settings } from "@/lib/settings";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export default function ReservationReportPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <View />
    </Suspense>
  );
}

function View() {
  const { from, to, days, tooLong, setRange } = useRangeParams("/staff/report/reservations/");
  const { value: settings } = useSettings();
  const qf = tooLong ? "9999-12-31" : from;
  const { value: reservations } = useReservationsRange(qf, to);
  const { value: contacts } = useContactsRange(qf, to);

  if (!settings) return <p className="text-gray-500">読み込み中…</p>;
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        <Link href={`/staff/report/?from=${from}&to=${to}`} className="ml-4 text-gray-500 underline">
          売上も含めた集計へ
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">予約の集計</h1>
      <RangePicker settings={settings} from={from} to={to} days={days} onChange={setRange} />
      {tooLong ? (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-amber-800">期間は{MAX_DAYS}日以内で選んでください。</p>
      ) : !reservations || !contacts ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Report settings={settings} from={from} to={to} days={days} reservations={reservations} contacts={contacts} />
      )}
    </>
  );
}

function Report({
  settings,
  from,
  to,
  days,
  reservations,
  contacts,
}: {
  settings: Settings;
  from: string;
  to: string;
  days: number;
  reservations: Reservation[];
  contacts: Record<string, Contact>;
}) {
  const [statusFilter, setStatusFilter] = useState<ReservationStatus | "active" | "all">("active");
  const [showTable, setShowTable] = useState(false);
  const monthly = days > 62;

  const stats = useMemo(() => {
    const active = reservations.filter((r) => countsTowardCapacity(r.status));
    const cancelled = reservations.filter((r) => r.status === "cancelled");
    const requests = reservations.filter((r) => r.status === "request");
    const people = active.reduce((n, r) => n + r.people, 0);
    const web = active.filter((r) => r.source === "web");
    const count = <K extends string>(list: Reservation[], key: (r: Reservation) => K[], w: (r: Reservation, k: K) => number) => {
      const m = new Map<K, number>();
      for (const r of list) for (const k of key(r)) m.set(k, (m.get(k) ?? 0) + w(r, k));
      return m;
    };
    return {
      active,
      people,
      cancelled,
      requests,
      web,
      byPlan: [...count(active, (r) => [r.planName], (r) => r.people)].sort((a, b) => b[1] - a[1]),
      byCategory: [...count(active, (r) => r.lines.map((l) => l.name), (r, k) => r.lines.filter((l) => l.name === k).reduce((n, l) => n + l.qty, 0))].sort(
        (a, b) => b[1] - a[1],
      ),
      bySlot: [...count(active, (r) => [r.slotTime], (r) => r.people)].sort((a, b) => a[0].localeCompare(b[0])),
      byWeekday: WEEKDAYS.map((w) => [w, active.filter((r) => weekday(r.date) === w).reduce((n, r) => n + r.people, 0)] as [string, number]),
    };
  }, [reservations]);

  // 時間枠ごとの色（設定の並び順で固定。9つ目以降は「その他」）
  const slotSeries: Series[] = useMemo(() => {
    const times = [...new Set([...settings.timeSlots.map((t) => t.time), ...stats.active.map((r) => r.slotTime)])].sort();
    const main = times.slice(0, SERIES_COLORS.length - 1).map((t, i) => ({ key: t, label: t, color: SERIES_COLORS[i] }));
    return times.length > main.length ? [...main, { key: "その他", label: "その他の時間", color: SERIES_COLORS[SERIES_COLORS.length - 1] }] : main;
  }, [settings, stats.active]);
  const slotKey = (t: string) => (slotSeries.some((s) => s.key === t) ? t : "その他");

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const rows = (monthly ? [...new Set(dates.map((d) => d.slice(0, 7)))] : dates).map((k) => {
    const values: Record<string, number> = {};
    for (const r of stats.active) if (r.date.startsWith(k)) values[slotKey(r.slotTime)] = (values[slotKey(r.slotTime)] ?? 0) + r.people;
    return monthly
      ? { key: k, label: `${Number(k.slice(5))}月`, sub: `${k.slice(0, 4)}年${Number(k.slice(5))}月`, values }
      : { key: k, label: String(Number(k.slice(8))), sub: formatJa(k), values };
  });
  const usedSeries = slotSeries.filter((s) => rows.some((r) => (r.values[s.key] ?? 0) > 0));

  const list = reservations
    .filter((r) => (statusFilter === "all" ? true : statusFilter === "active" ? countsTowardCapacity(r.status) : r.status === statusFilter))
    .sort((a, b) => (a.date + a.slotTime).localeCompare(b.date + b.slotTime));

  function exportList() {
    if (!window.confirm("お客様の名前・電話番号・メールが入ったファイルを書き出します。\n保存したファイルは、関係者以外に渡さないよう注意してください。")) return;
    downloadCsv(`reservations_${from}_${to}.csv`, [
      ["日付", "曜日", "時間", "お名前", "人数", "内訳", "プラン", "ステータス", "受付", "予約番号", "電話", "メール", "メモ"],
      ...list.map((r) => [
        r.date,
        weekday(r.date),
        r.slotTime,
        r.customerName,
        r.people,
        peopleText(r),
        r.planName,
        STATUS_LABEL[r.status],
        r.source === "web" ? "Web" : "スタッフ",
        r.code ?? "",
        contacts[r.id]?.phone ?? "",
        contacts[r.id]?.email ?? "",
        r.memo ?? "",
      ]),
    ]);
  }

  const totalAll = stats.active.length + stats.cancelled.length;
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile label="予約件数" value={`${stats.active.length}件`} sub={`1日平均 ${(stats.active.length / days).toFixed(1)}件`} strong />
        <Tile label="予約人数" value={`${stats.people}人`} sub={stats.active.length > 0 ? `1件あたり ${(stats.people / stats.active.length).toFixed(1)}人` : undefined} />
        <Tile
          label="Web予約"
          value={`${stats.web.length}件`}
          sub={stats.active.length > 0 ? `全体の ${Math.round((stats.web.length / stats.active.length) * 100)}%` : undefined}
        />
        <Tile
          label="キャンセル"
          value={`${stats.cancelled.length}件`}
          sub={totalAll > 0 ? `キャンセル率 ${Math.round((stats.cancelled.length / totalAll) * 100)}%` : undefined}
        />
        <Tile label="リクエスト（未承認）" value={`${stats.requests.length}件`} sub={`${stats.requests.reduce((n, r) => n + r.people, 0)}人`} />
        <Tile label="来店済" value={`${reservations.filter((r) => r.status === "visited").length}件`} />
      </div>

      <Card title={monthly ? "月ごとの予約人数（時間枠別）" : "日ごとの予約人数（時間枠別）"} className="mt-4">
        <Legend series={usedSeries} />
        {stats.people === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400">この期間の予約はありません</p>
        ) : (
          <div className="mt-2">
            <StackedColumns rows={rows} series={usedSeries} ariaLabel="予約人数" unit="人" />
          </div>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} />
          表で見る
        </label>
        {showTable && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1 pr-3">{monthly ? "月" : "日付"}</th>
                  {usedSeries.map((s) => (
                    <th key={s.key} className="py-1 pr-3 text-right">
                      {s.label}
                    </th>
                  ))}
                  <th className="py-1 text-right">合計</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => Object.keys(r.values).length > 0)
                  .map((r) => (
                    <tr key={r.key} className="border-t">
                      <td className="py-1 pr-3">{r.sub}</td>
                      {usedSeries.map((s) => (
                        <td key={s.key} className="py-1 pr-3 text-right tabular-nums">
                          {r.values[s.key] ?? 0}
                        </td>
                      ))}
                      <td className="py-1 text-right font-semibold tabular-nums">{Object.values(r.values).reduce((n, v) => n + v, 0)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card title="曜日別の人数">
          <CountList items={stats.byWeekday} keepOrder />
        </Card>
        <Card title="時間枠別の人数">
          <CountList items={stats.bySlot} keepOrder />
        </Card>
        <Card title="プラン別の人数">
          <CountList items={stats.byPlan} />
        </Card>
        <Card title="料金区分別の人数">
          <CountList items={stats.byCategory} />
        </Card>
      </div>

      <Card title={`予約の一覧（${list.length}件）`} className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="rounded-lg border px-2 py-2 text-base">
            <option value="active">有効な予約（キャンセル・リクエスト以外）</option>
            <option value="all">すべて</option>
            {(Object.keys(STATUS_LABEL) as ReservationStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}のみ
              </option>
            ))}
          </select>
          <button onClick={exportList} disabled={list.length === 0} className="ml-auto rounded-lg border px-3 py-2 text-sm disabled:opacity-40">
            一覧をCSVで書き出す
          </button>
        </div>
        {list.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400">該当する予約はありません</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1 pr-3">日付</th>
                  <th className="py-1 pr-3">時間</th>
                  <th className="py-1 pr-3">お名前</th>
                  <th className="py-1 pr-3 text-right">人数</th>
                  <th className="py-1 pr-3">プラン</th>
                  <th className="py-1 pr-3">ステータス</th>
                  <th className="py-1 pr-3">受付</th>
                  <th className="py-1">電話</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1.5 pr-3">
                      <Link href={`/staff/reservations/?date=${r.date}`} className="underline">
                        {formatJa(r.date)}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">{r.slotTime}</td>
                    <td className="py-1.5 pr-3">{r.customerName} 様</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums" title={peopleText(r)}>
                      {r.people}
                    </td>
                    <td className="py-1.5 pr-3">{r.planName}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{r.source === "web" ? `Web ${r.code ?? ""}` : "スタッフ"}</td>
                    <td className="py-1.5">
                      {contacts[r.id]?.phone && (
                        <a href={`tel:${contacts[r.id].phone}`} className="underline">
                          {contacts[r.id].phone}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
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

function CountList({ items, keepOrder }: { items: [string, number][]; keepOrder?: boolean }) {
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
            <span className="block h-full rounded-r" style={{ width: `${(v / max) * 100}%`, background: SERIES_COLORS[0], minWidth: v > 0 ? 3 : 0 }} />
          </span>
          <span className="text-right font-semibold tabular-nums">{v.toLocaleString("ja-JP")}人</span>
        </li>
      ))}
    </ul>
  );
}
