"use client";

import Link from "next/link";
import { Meter } from "@/components/charts";
import { useAuth } from "@/lib/auth";
import { formatJa, todayJST } from "@/lib/date";
import {
  STATUS_LABEL,
  STATUS_STYLE,
  capacityOf,
  countsTowardCapacity,
  useDailyCapacity,
  usePendingRequests,
  useReservations,
  useSettings,
  useWebStopped,
  yen,
} from "@/lib/reservations";
import { useSales } from "@/lib/sales";

type MenuItem = { label: string; href: string; adminOnly?: boolean };

const MENU: MenuItem[] = [
  { label: "予約管理", href: "/staff/reservations/" },
  { label: "会計", href: "/staff/checkout/" },
  { label: "売掛管理", href: "/staff/receivables/" },
  { label: "日次締め", href: "/staff/sales/" },
  { label: "ダッシュボード", href: "/staff/dashboard/" },
  { label: "集計（期間指定）", href: "/staff/report/" },
  { label: "予約の集計", href: "/staff/report/reservations/" },
  { label: "設定", href: "/staff/settings/", adminOnly: true },
  { label: "スタッフ管理", href: "/staff/members/", adminOnly: true },
  { label: "過去売上の取り込み", href: "/staff/import/", adminOnly: true },
];

export default function StaffHome() {
  const { role } = useAuth();
  const items = MENU.filter((m) => !m.adminOnly || role === "admin");
  const { value: requests } = usePendingRequests(todayJST());

  return (
    <>
      <Today requestCount={requests?.length ?? 0} />

      <h2 className="mt-8 text-lg font-bold">メニュー</h2>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((m) => (
          <li key={m.label}>
            <Link href={m.href} className="block rounded-xl border border-berry/30 bg-white p-5 text-center shadow-sm active:bg-berry/5">
              <div className="text-lg font-semibold">{m.label}</div>
              {m.href === "/staff/reservations/" && requests && requests.length > 0 && (
                <div className="mt-1 inline-block rounded-full bg-purple-700 px-2 py-0.5 text-xs text-white">リクエスト {requests.length}件</div>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 今日の予約・来店・売上がひと目で分かる部分 */
function Today({ requestCount }: { requestCount: number }) {
  const today = todayJST();
  const { value: settings } = useSettings();
  const { value: reservations } = useReservations(today);
  const { value: daily } = useDailyCapacity(today);
  const { value: stopped } = useWebStopped(today);
  const { value: sales } = useSales(today, today);
  const link = `/staff/reservations/?date=${today}`;

  const active = (reservations ?? []).filter((r) => countsTowardCapacity(r.status));
  const people = active.reduce((n, r) => n + r.people, 0);
  const visited = active.filter((r) => r.status === "visited");
  const visitedPeople = visited.reduce((n, r) => n + r.people, 0);
  const salesTotal = (sales ?? []).filter((s) => s.status === "completed").reduce((n, s) => n + s.total, 0);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">今日 {formatJa(today)}</h1>
        <Link href={link} className="text-sm text-gray-600 underline">
          予約管理を開く
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile href={link} label="今日の予約" value={reservations ? `${active.length}件` : "…"} sub={reservations ? `${people}人` : undefined} strong />
        <Tile href={link} label="来店済" value={reservations ? `${visitedPeople}人` : "…"} sub={reservations ? `残り ${people - visitedPeople}人` : undefined} />
        <Tile href={`/staff/sales/?date=${today}`} label="今日の売上" value={sales ? yen(salesTotal) : "…"} />
        <Tile href={link} label="承認待ちのリクエスト" value={`${requestCount}件`} alert={requestCount > 0} />
      </div>

      {settings && reservations && (
        <div className="mt-3 space-y-3">
          {settings.timeSlots.length === 0 && <p className="text-sm text-gray-500">時間枠がまだ設定されていません。</p>}
          {settings.timeSlots.map((t) => {
            const cap = capacityOf(settings, daily, t.id) ?? t.capacity;
            const list = (reservations ?? [])
              .filter((r) => r.slotId === t.id && r.status !== "cancelled")
              .sort((a, b) => Number(a.status === "visited") - Number(b.status === "visited"));
            const booked = list.filter((r) => countsTowardCapacity(r.status)).reduce((n, r) => n + r.people, 0);
            return (
              <div key={t.id} className="rounded-2xl bg-white p-3 shadow-sm">
                <div className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3">
                  <span className="text-lg font-bold">{t.time}</span>
                  <Meter value={booked} max={cap} />
                  <span className="text-sm tabular-nums">
                    {booked} / {cap}人
                    {booked > cap && <span className="ml-1 font-bold text-red-700">超過</span>}
                    {stopped?.[t.id] && <span className="ml-1 rounded bg-gray-700 px-1 text-xs text-white">Web停止</span>}
                  </span>
                </div>
                {list.length === 0 ? (
                  <p className="mt-1 text-sm text-gray-400">予約なし</p>
                ) : (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {list.map((r) => (
                      <li key={r.id}>
                        <Link
                          href={link}
                          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${r.status === "visited" ? "bg-gray-50 text-gray-500" : "bg-white"}`}
                        >
                          <span className={`rounded-full px-1.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                          {r.customerName}様 <b>{r.people}人</b>
                          {r.memo && <span title={r.memo}>📝</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Tile({ href, label, value, sub, strong, alert }: { href: string; label: string; value: string; sub?: string; strong?: boolean; alert?: boolean }) {
  const color = strong ? "bg-berry text-white" : alert ? "bg-purple-700 text-white" : "bg-white";
  const muted = strong || alert ? "text-white/80" : "text-gray-500";
  return (
    <Link href={href} className={`block rounded-2xl p-4 shadow-sm ${color}`}>
      <div className={`text-xs ${muted}`}>{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className={`text-sm ${strong || alert ? "text-white/90" : "text-gray-600"}`}>{sub}</div>}
    </Link>
  );
}
