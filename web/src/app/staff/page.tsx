"use client";

import Link from "next/link";
import { useState } from "react";
import { errorText } from "@/lib/callFunction";
import { assignMenuSlots, cellsOf, fitSlot, MENU_COLS, saveMenuLayout, useMenuLayout, type MenuLayout } from "@/lib/menuLayout";
import { useAuth } from "@/lib/auth";
import { formatJa, todayJST } from "@/lib/date";
import { callFunction } from "@/lib/callFunction";
import { countsTowardCapacity, STATUS_LABEL, STATUS_STYLE, usePendingRequests, useReservations, useUnseenReservations, yen, type Reservation } from "@/lib/reservations";
import { useSales } from "@/lib/sales";

type MenuItem = { label: string; href: string; adminOnly?: boolean; big?: boolean; color?: string };

const MENU: MenuItem[] = [
  { label: "予約管理", href: "/staff/reservations/", big: true, color: "border-berry bg-berry text-white" },
  { label: "会計（レジ）", href: "/staff/checkout/", big: true, color: "border-emerald-700 bg-emerald-700 text-white" },
  { label: "売掛管理", href: "/staff/receivables/" },
  { label: "顧客リスト", href: "/staff/customers/" },
  { label: "日次締め", href: "/staff/sales/" },
  { label: "ダッシュボード", href: "/staff/dashboard/" },
  { label: "集計（期間指定）", href: "/staff/report/" },
  { label: "予約の集計", href: "/staff/report/reservations/" },
  { label: "商品別の実績（去年と今年）", href: "/staff/report/items/" },
  { label: "年ごとの比較", href: "/staff/report/yearly/" },
  { label: "出荷実績", href: "/staff/shipping/" },
  { label: "店舗実績", href: "/staff/store/" },
  { label: "給与", href: "/staff/payroll/", adminOnly: true },
  { label: "商品設定", href: "/staff/products/", adminOnly: true },
  { label: "設定", href: "/staff/settings/", adminOnly: true },
  { label: "スタッフ管理", href: "/staff/members/", adminOnly: true },
  { label: "過去売上の取り込み", href: "/staff/import/", adminOnly: true },
];

/** タイルのキー（配置の保存に使う）："/staff/report/items/" → "report-items" */
const keyOf = (m: MenuItem) => m.href.split("/").filter(Boolean).slice(1).join("-") || "home";

export default function StaffHome() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  const items = MENU.filter((m) => !m.adminOnly || isAdmin);
  const { value: requests } = usePendingRequests(todayJST());
  const { value: unseen } = useUnseenReservations();
  const saved = useMenuLayout();
  // 並べ替え中の配置（null＝並べ替えていない）
  const [arrange, setArrange] = useState<MenuLayout | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 配置は管理者のメニュー（全部のタイル）で決める。スタッフには管理者用のタイルの所が空いて見える
  const allKeys = MENU.map(keyOf);
  const layout = arrange ?? saved ?? null;
  const cols = layout?.cols ?? 3;
  const widthOf = (k: string) => Math.min(MENU.find((m) => keyOf(m) === k)?.big ? 2 : 1, cols);
  const slots = assignMenuSlots(allKeys, layout?.slots, cols, widthOf);
  const shown = arrange ? MENU : items;
  const used = shown.flatMap((m) => cellsOf(slots.get(keyOf(m)) ?? 0, widthOf(keyOf(m))));
  const rows = (used.length ? Math.floor(Math.max(...used) / cols) + 1 : 1) + (arrange ? 2 : 0);
  const usedSet = new Set(used);
  const empties = arrange ? Array.from({ length: rows * cols }, (_, i) => i).filter((i) => !usedSet.has(i)) : [];
  const pos = (slot: number, k?: string) => ({
    gridColumnStart: (slot % cols) + 1,
    gridRowStart: Math.floor(slot / cols) + 1,
    ...(k && widthOf(k) > 1 ? { gridColumnEnd: `span ${widthOf(k)}` } : {}),
  });

  function start() {
    setArrange({ cols, slots: Object.fromEntries(allKeys.map((k) => [k, slots.get(k) ?? 0])) });
    setPicked(null);
    setError("");
  }
  /** 選んだタイルを、押したマスへ移す（ほかのタイルがあれば入れ替える） */
  function moveTo(slot: number) {
    if (!arrange || !picked) return;
    const from = slots.get(picked) ?? 0;
    const to = fitSlot(slot, widthOf(picked), cols);
    const cells = new Set(cellsOf(to, widthOf(picked)));
    // 移した先にあったタイルは、元の場所へ（入れ替え）。入りきらなければ、元の場所にいちばん近い空きへ
    const others = allKeys.filter((k) => k !== picked && cellsOf(slots.get(k) ?? 0, widthOf(k)).some((c) => cells.has(c)));
    const next: Record<string, number> = {};
    const occupied = new Set<number>();
    for (const k of allKeys) {
      if (k === picked || others.includes(k)) continue;
      next[k] = slots.get(k) ?? 0;
      for (const c of cellsOf(next[k], widthOf(k))) occupied.add(c);
    }
    next[picked] = to;
    for (const c of cells) occupied.add(c);
    const fits = (s: number, w: number) => s >= 0 && (s % cols) + w <= cols && cellsOf(s, w).every((c) => !occupied.has(c));
    for (const o of others) {
      const w = widthOf(o);
      const want = fitSlot(from, w, cols);
      let best = -1;
      for (let d = 0; best < 0 && d < 400; d++) for (const s of [want - d, want + d]) if (best < 0 && fits(s, w)) best = s;
      next[o] = best;
      for (const c of cellsOf(best, w)) occupied.add(c);
    }
    setArrange({ ...arrange, slots: next });
    setPicked(null);
  }
  function tapTile(k: string) {
    if (picked === k) return setPicked(null);
    if (picked) return moveTo(slots.get(k) ?? 0);
    setPicked(k);
  }
  /** 横のマスの数を変える（並びの順番はそのまま、上から詰めなおす） */
  function changeCols(n: number) {
    if (!arrange) return;
    const w = (k: string) => Math.min(MENU.find((m) => keyOf(m) === k)?.big ? 2 : 1, n);
    setArrange({ cols: n, slots: Object.fromEntries(assignMenuSlots(allKeys, arrange.slots, n, w)) });
  }
  function reset() {
    const w = (k: string) => (MENU.find((m) => keyOf(m) === k)?.big ? 2 : 1);
    setArrange({ cols: 3, slots: Object.fromEntries(assignMenuSlots(allKeys, undefined, 3, w)) });
    setPicked(null);
  }
  async function save() {
    if (!arrange) return;
    setSaving(true);
    setError("");
    try {
      await saveMenuLayout(arrange);
      setArrange(null);
      setPicked(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const tileBody = (m: MenuItem) => (
    <>
      <div className={m.href === "/staff/checkout/" ? "text-3xl font-bold" : m.big ? "text-2xl font-bold" : "text-lg font-semibold"}>{m.label}</div>
      {m.href === "/staff/reservations/" && (
        <div className="mt-1 flex flex-wrap justify-center gap-1">
          {unseen && unseen.length > 0 && <span className="rounded-full bg-amber-300 px-2 py-0.5 text-xs font-bold text-amber-950">未確認 {unseen.length}件</span>}
          {requests && requests.length > 0 && <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-purple-700">リクエスト {requests.length}件</span>}
        </div>
      )}
    </>
  );
  const tileClass = (m: MenuItem) =>
    `flex h-full flex-col items-center justify-center rounded-xl border p-4 text-center shadow-sm ${m.color ?? "border-berry/30 bg-white"}`;

  return (
    <>
      {unseen && unseen.length > 0 && <UnseenNotice list={unseen} />}
      <Today requestCount={requests?.length ?? 0} />

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">メニュー</h2>
        {isAdmin && !arrange && (
          <button onClick={start} className="rounded-lg border bg-white px-3 py-1.5 text-sm text-gray-700">
            タイルの配置を変える
          </button>
        )}
      </div>

      {arrange && (
        <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm">
          <p>
            {picked ? "移したいマス（点線）か、入れ替えたいタイルを押してください。" : "動かしたいタイルを押してください。"}
            空いたマスも作れます。下に2段、空きマスを用意しています。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-gray-600">横のマス</span>
            {MENU_COLS.map((n) => (
              <button key={n} onClick={() => changeCols(n)} className={`rounded-lg border px-3 py-1 ${n === arrange.cols ? "border-sky-700 bg-sky-700 font-bold text-white" : "bg-white"}`}>
                {n}
              </button>
            ))}
            <span className="flex-1" />
            <button onClick={reset} className="rounded-lg border bg-white px-3 py-1.5">
              最初の並びに戻す
            </button>
            <button onClick={() => { setArrange(null); setPicked(null); }} className="rounded-lg border bg-white px-3 py-1.5">
              やめる
            </button>
            <button onClick={save} disabled={saving} className="rounded-lg bg-sky-700 px-4 py-1.5 font-bold text-white disabled:opacity-50">
              {saving ? "保存中…" : "配置を保存"}
            </button>
          </div>
          {error && <p className="mt-2 text-red-600">{error}</p>}
        </div>
      )}

      {saved === undefined && !arrange ? (
        <p className="mt-3 text-gray-500">読み込み中…</p>
      ) : (
        <>
          {/* 広い画面（並べ替え中はどの画面でも）：マス目に置く。空いたマスもそのまま */}
          <div
            className={`mt-3 gap-3 ${arrange ? "grid" : "hidden sm:grid"}`}
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(5.5rem, auto)" }}
          >
            {shown.map((m) => {
              const k = keyOf(m);
              const slot = slots.get(k) ?? 0;
              if (!arrange)
                return (
                  <Link key={k} href={m.href} style={pos(slot, k)} className={`${tileClass(m)} ${m.color ? "active:opacity-80" : "active:bg-berry/5"}`}>
                    {tileBody(m)}
                  </Link>
                );
              return (
                <button
                  key={k}
                  onClick={() => tapTile(k)}
                  style={pos(slot, k)}
                  className={`${tileClass(m)} ${picked === k ? "ring-4 ring-sky-500" : picked ? "opacity-80" : ""}`}
                >
                  {tileBody(m)}
                  {m.adminOnly && <div className="mt-1 text-xs text-gray-500">管理者だけ</div>}
                  {m.big && <div className="mt-1 text-xs opacity-80">横2マス</div>}
                </button>
              );
            })}
            {empties.map((slot) => (
              <button
                key={`empty-${slot}`}
                onClick={() => moveTo(slot)}
                style={pos(slot)}
                className={`rounded-xl border-2 border-dashed text-xs text-gray-400 ${picked ? "border-sky-400 bg-white" : "border-gray-300"}`}
                aria-label={`空きマス ${slot + 1}`}
              >
                {picked ? "ここへ" : ""}
              </button>
            ))}
          </div>
          {/* 狭い画面（スマホ）：空いたマスは詰めて、同じ順番で2列に並べる */}
          {!arrange && (
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:hidden">
              {[...items]
                .sort((x, y) => (slots.get(keyOf(x)) ?? 0) - (slots.get(keyOf(y)) ?? 0))
                .map((m) => (
                  <li key={keyOf(m)} className={m.big ? "col-span-2" : ""}>
                    <Link href={m.href} className={`${tileClass(m)} min-h-[5.5rem] ${m.color ? "active:opacity-80" : "active:bg-berry/5"}`}>
                      {tileBody(m)}
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/** まだ確認していない新しい予約（Web予約）のお知らせ */
function UnseenNotice({ list }: { list: Reservation[] }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  async function mark(ids: string[] | "all") {
    setBusy(ids === "all" ? "all" : ids[0]);
    setError("");
    try {
      await callFunction("markReservationsSeen", ids === "all" ? { all: true } : { ids });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  const shown = open ? list : list.slice(0, 5);
  const received = (r: Reservation) => {
    const ms = r.createdAt?.toMillis();
    if (!ms) return "";
    const d = new Date(ms + 9 * 3600_000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}受付`;
  };
  return (
    <section className="mb-6 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-amber-950">🔔 新しい予約があります（未確認 {list.length}件）</h2>
        <button onClick={() => mark("all")} disabled={!!busy} className="rounded-lg border border-amber-600 bg-white px-3 py-1.5 text-sm font-bold text-amber-900 disabled:opacity-50">
          {busy === "all" ? "…" : "すべて確認した"}
        </button>
      </div>
      <ul className="mt-2 divide-y divide-amber-200">
        {shown.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
            <Link href={`/staff/reservations/?date=${r.date}`} className="font-semibold underline">
              {formatJa(r.date)} {r.slotTime}
            </Link>
            <span>
              {r.customerName} 様 {r.people}人
            </span>
            <span className="text-sm text-gray-600">{r.planName}</span>
            <span className="text-xs text-gray-500">{received(r)}</span>
            <button onClick={() => mark([r.id])} disabled={!!busy} className="ml-auto rounded-lg bg-amber-600 px-3 py-1 text-sm font-bold text-white disabled:opacity-50">
              {busy === r.id ? "…" : "確認した"}
            </button>
          </li>
        ))}
      </ul>
      {list.length > 5 && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-sm text-amber-900 underline">
          {open ? "少なく表示" : `ほか${list.length - 5}件も見る`}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
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
