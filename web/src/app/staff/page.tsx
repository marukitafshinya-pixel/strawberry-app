"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { formatJa, todayJST } from "@/lib/date";
import { countsTowardCapacity, usePendingRequests, useReservations, yen } from "@/lib/reservations";
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
  { label: "商品別の実績（去年と今年）", href: "/staff/report/items/" },
  { label: "出荷実績", href: "/staff/shipping/" },
  { label: "給与", href: "/staff/payroll/", adminOnly: true },
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
  const { value: reservations } = useReservations(today);
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
