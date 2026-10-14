"use client";

// 収穫管理の入力（棟別出荷調査票）：ハウスが1行。使い方・収穫者・入った時刻・終わった時刻・確定数を入れる。
// 確定数は集荷のたびに「＋1」を押して数える（押すたびにすぐ保存。どの端末でも同じ数になる）。
// 収穫者と回る順は、作業配置表の名前と矢印から読む（矢印の先の名前のないハウスにも同じ人を入れる）。
// 最初のハウスの「入った」には収穫の開始時刻（管理者が変えられる）を入れておく。1ケースあたりの時間は管理者だけに見える
import Link from "next/link";
import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import {
  addCases,
  clock,
  fmtCases,
  planHarvest,
  harvestHouses,
  HOUSE_USES,
  houseUseOf,
  parseCases,
  parseClock,
  perCaseText,
  round1,
  saveHarvestStart,
  saveHouseHarvest,
  saveHouseUse,
  solePerCase,
  useHarvestConfig,
  useHarvestDay,
  useHouseUse,
  type HarvestDoc,
  type HarvestPlan,
  type HouseHarvest,
  type HouseUse,
  type HouseUseMap,
} from "@/lib/harvest";
import { useShiftMembers, type ShiftMember } from "@/lib/shift";

/** スタッフが入力できるのは、この日数前まで（それより前は管理者だけ） */
const STAFF_DAYS = 7;
/** 収穫しない使い方（この行は収穫の欄を使わない） */
const NO_HARVEST: HouseUse[] = ["picking", "reserve", "off"];

export default function HarvestPage() {
  const { role } = useAuth();
  const [date, setDate] = useState(todayJST());
  const template = useHaichiTemplate();
  const haichi = useHaichiDay(date);
  const rec = useHarvestDay(date);
  const use = useHouseUse(date);
  const members = useShiftMembers();
  const cfg = useHarvestConfig();

  if (role !== "admin" && role !== "staff") return <p>この画面はスタッフだけが使えます。</p>;
  const isAdmin = role === "admin";
  const tooOld = !isAdmin && date < addDays(todayJST(), -STAFF_DAYS);
  const total = rec ? Object.values(rec).reduce((n, h) => n + (h.cases ?? 0), 0) : 0;

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">🍓 収穫管理</h1>
        <button onClick={() => setDate(addDays(date, -1))} className="ml-2 rounded-lg border bg-white px-3 py-2">
          ◀
        </button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="rounded-lg border px-3 py-2" />
        <button onClick={() => setDate(addDays(date, 1))} className="rounded-lg border bg-white px-3 py-2">
          ▶
        </button>
        <span className="font-bold">{formatJa(date)}</span>
        {date !== todayJST() && (
          <button onClick={() => setDate(todayJST())} className="rounded-lg border bg-white px-3 py-2 text-sm">
            今日
          </button>
        )}
        <span className="ml-auto rounded-lg bg-rose-50 px-3 py-2 text-lg tabular-nums">
          合計 <b className="text-2xl text-berry">{fmtCases(total)}</b> ケース
        </span>
        {cfg && <StartTime value={cfg.startTime} isAdmin={isAdmin} />}
        {isAdmin && (
          <Link href="/staff/harvest/report/" className="rounded-lg border border-berry bg-white px-3 py-2 text-sm font-bold text-berry">
            📊 収穫の実績
          </Link>
        )}
      </div>

      {tooOld ? (
        <p className="mt-4 rounded-lg border bg-white p-4 text-gray-600">{STAFF_DAYS}日より前の記録は、管理者だけが見たり直したりできます。</p>
      ) : !template || haichi === null || !rec || !use || !members || !cfg ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <Sheet
          date={date}
          houses={harvestHouses(template)}
          plan={planHarvest(template, haichi)}
          startTime={cfg.startTime}
          rec={rec}
          use={use}
          members={members}
          isAdmin={isAdmin}
        />
      )}
    </>
  );
}

function Sheet({
  date,
  houses,
  plan,
  startTime,
  rec,
  use,
  members,
  isAdmin,
}: {
  date: string;
  /** 作業配置表の収穫の枠の順 */
  houses: string[];
  /** 作業配置表から読んだ、収穫者と回る順 */
  plan: HarvestPlan;
  /** 収穫の開始時刻（分） */
  startTime: number;
  rec: HarvestDoc;
  use: { houses: HouseUseMap; from: string | null };
  members: ShiftMember[];
  isAdmin: boolean;
}) {
  const [error, setError] = useState("");
  /** ドラッグ中の名前と指の位置 */
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const start = useRef<{ id: string; from: string; x: number; y: number; moved: boolean } | null>(null);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const usageOf = (h: string) => use.houses[h] ?? "harvest";
  /** そのハウスの収穫者（保存していなければ作業配置表の人） */
  const who = (h: string) => rec[h]?.members ?? plan.members[h] ?? [];
  /** だれかの最初のハウス（配置表の矢印から）なら、収穫の開始時刻 */
  const plannedStart = (h: string) => (who(h).some((m) => plan.routes[m]?.[0] === h) ? startTime : null);
  /** そのハウスの「入った」（保存していなければ、最初のハウスは開始時刻） */
  const startOf = (h: string) => rec[h]?.start ?? plannedStart(h);
  /** まだ保存していない予定（収穫者・開始時刻）。そのハウスを初めて保存するときに一緒に保存する */
  const pending = (h: string): HouseHarvest => ({
    ...(rec[h]?.members ? {} : { members: who(h) }),
    ...(rec[h]?.start == null && plannedStart(h) != null ? { start: plannedStart(h) } : {}),
  });
  const run = (p: Promise<unknown>) => {
    setError("");
    p.catch((e) => setError(errorText(e)));
  };
  /** 1つのハウスを保存する。まだ保存していない予定（収穫者・開始時刻）も一緒に保存する */
  const save = (h: string, patch: HouseHarvest) => saveHouseHarvest(date, h, { ...pending(h), ...patch });

  /** 終わった時刻を入れたら、その人の次のハウス（配置表の矢印の順）の「入った」が空なら同じ時刻を入れる */
  async function setEnd(h: string, end: number | null) {
    await save(h, { end });
    if (end == null) return;
    const done = new Set<string>();
    for (const m of who(h)) {
      const route = plan.routes[m] ?? [];
      const next = route.slice(route.indexOf(h) + 1).find((x) => route.includes(h) && !NO_HARVEST.includes(usageOf(x)));
      if (next && !done.has(next) && rec[next]?.start == null) {
        done.add(next);
        await save(next, { start: end });
      }
    }
  }
  const setUse = (h: string, k: HouseUse) => saveHouseUse(date, Object.fromEntries(houses.map((x) => [x, x === h ? k : usageOf(x)])));

  // 作業配置表の収穫の枠と同じ並び（1・6・8・4・5・9・10・17〜27）
  const rows = houses;

  /** 名前を別のハウスへ入れる（元のハウスにも残す）。入ったが空なら、元のハウスの終わった時刻を入れる */
  function dropTo(id: string, from: string, to: string) {
    if (to === from || NO_HARVEST.includes(usageOf(to))) return;
    const cur = who(to);
    const startAt = rec[to]?.start == null && rec[from]?.end != null ? { start: rec[from].end } : {};
    run(save(to, { members: cur.includes(id) ? cur : [...cur, id], ...startAt }));
  }
  /** 名前を押したとき：少し動かせばドラッグ、動かさずに離せば外す */
  function onPick(id: string, from: string, e: React.PointerEvent) {
    e.preventDefault();
    start.current = { id, from, x: e.clientX, y: e.clientY, moved: false };
    const move = (ev: PointerEvent) => {
      const s = start.current;
      if (!s || (!s.moved && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < 8)) return;
      s.moved = true;
      setDrag({ id: s.id, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const s = start.current;
      start.current = null;
      setDrag(null);
      if (!s) return;
      if (!s.moved) return void run(save(s.from, { members: who(s.from).filter((x) => x !== s.id) }));
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop]");
      if (target?.dataset.drop) dropTo(s.id, s.from, target.dataset.drop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  return (
    <>
      <p className="mt-2 text-sm text-gray-600">
        集荷のたびに「＋1」を押します（押すとすぐ保存）。名前を引っぱって次のハウスの行に落とすと、そのハウスにも名前が入ります（名前を押すだけなら外れます）。端数は確定数の欄に
        5.3 のように打てます。時刻は「710」で
        7:10。「終わった」を入れると、その人の次のハウスの「入った」に同じ時刻が入ります。収穫者は、作業配置表の名前と、矢印でたどれるハウスまで入れています。最初のハウスの「入った」には開始時刻が入ります（点線＝まだ保存していない予定）。矢印のないハウスへは、名前を引っぱって入れてください。
        {use.from !== date &&
          (use.from ? `　ハウスの使い方は${formatJa(use.from)}の状態を引きついでいます。` : "　ハウスの使い方はまだ記録がありません（全部「収穫」）。")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {HOUSE_USES.map((u) => (
          <span key={u.key} className={`rounded border px-2 py-0.5 ${u.cls}`}>
            {u.short}＝{u.label}
          </span>
        ))}
      </div>
      {error && <p className="mt-2 font-bold text-red-600">{error}</p>}
      <div className="mt-2 overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-[900px] text-sm tabular-nums">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-2 py-2">ハウス</th>
              <th className="px-2 py-2">使い方</th>
              <th className="px-2 py-2">収穫者</th>
              <th className="px-2 py-2">入った</th>
              <th className="px-2 py-2">終わった</th>
              <th className="px-2 py-2">確定数</th>
              <th className="px-2 py-2" />
              {isAdmin && <th className="px-2 py-2 text-right">1ケース</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => {
              const u = houseUseOf(usageOf(h));
              const r = rec[h] ?? {};
              const off = NO_HARVEST.includes(u.key);
              const ms = who(h);
              const p = solePerCase({ ...r, start: startOf(h), members: ms });
              return (
                <tr key={h} data-drop={h} className={`border-t ${off ? "bg-gray-50" : ""}`}>
                  <td className="px-2 py-1.5 text-base font-bold whitespace-nowrap">No.{h}</td>
                  <td className="px-2 py-1.5">
                    <select
                      value={u.key}
                      onChange={(e) => run(setUse(h, e.target.value as HouseUse))}
                      className={`rounded-lg border px-1 py-2 font-bold ${u.cls}`}
                    >
                      {HOUSE_USES.map((x) => (
                        <option key={x.key} value={x.key}>
                          {x.short} {x.label.replace(/（.*）/, "")}
                        </option>
                      ))}
                    </select>
                  </td>
                  {off ? (
                    <td colSpan={isAdmin ? 6 : 5} className="px-2 py-1.5 text-gray-500">
                      {u.label}
                      {r.cases ? `（確定数 ${fmtCases(r.cases)} が入っています）` : ""}
                    </td>
                  ) : (
                    <>
                      <td className="px-2 py-1.5">
                        <Members
                          ids={ms}
                          planned={!r.members && ms.length > 0}
                          names={names}
                          members={members}
                          onChange={(next) => run(save(h, { members: next }))}
                          onPick={(id, e) => onPick(id, h, e)}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <TextCell
                          key={`s${startOf(h)}`}
                          value={clock(startOf(h))}
                          planned={r.start == null && startOf(h) != null}
                          placeholder="600"
                          parse={parseClock}
                          onCommit={(v) => run(save(h, { start: v }))}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <TextCell key={`e${r.end}`} value={clock(r.end)} placeholder="710" parse={parseClock} onCommit={(v) => run(setEnd(h, v))} />
                      </td>
                      <td className="px-2 py-1.5">
                        <TextCell
                          key={`c${r.cases}`}
                          value={r.cases ? round1(r.cases).toFixed(1) : ""}
                          placeholder="0.0"
                          decimal
                          big
                          parse={parseCases}
                          onCommit={(v) => run(save(h, { cases: v ?? 0 }))}
                        />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <button
                          onClick={() => run(addCases(date, h, -1, pending(h)))}
                          disabled={!r.cases || r.cases < 1}
                          className="mr-1 rounded-lg border px-3 py-2 text-gray-600 disabled:opacity-30"
                          aria-label={`No.${h} を1ケース減らす`}
                        >
                          −1
                        </button>
                        <button
                          onClick={() => run(addCases(date, h, 1, pending(h)))}
                          className="rounded-lg bg-berry px-5 py-2 text-lg font-bold text-white active:scale-95"
                          aria-label={`No.${h} に1ケース足す`}
                        >
                          ＋1
                        </button>
                      </td>
                      {isAdmin && (
                        <td className="px-2 py-1.5 text-right text-sky-800">
                          {ms.length > 1 ? <span className="text-xs text-gray-500">共同</span> : perCaseText(p)}
                        </td>
                      )}
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-500 bg-amber-100 px-3 py-1 font-bold shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          {names.get(drag.id)}
        </div>
      )}
      {isAdmin && (
        <p className="mt-1 text-xs text-gray-500">「1ケース」は1人だけで収穫したハウスで計算します。応援が入ったハウス（共同）は、ケース数だけ数えます。</p>
      )}
    </>
  );
}

/** 収穫者：名前を押すと外せる。名前を引っぱって別のハウスの行に落とすと、そのハウスにも入る。「＋」で足す。配置表から入れた人は点線で出す（まだ保存していない） */
function Members({
  ids,
  planned,
  names,
  members,
  onChange,
  onPick,
}: {
  ids: string[];
  planned: boolean;
  names: Map<string, string>;
  members: ShiftMember[];
  onChange: (ids: string[]) => void;
  onPick: (id: string, e: React.PointerEvent) => void;
}) {
  // 足せるのは、勤務管理表で「収穫可」にしている人だけ
  const candidates = members.filter((m) => m.active && m.harvest && !ids.includes(m.id)).sort((a, b) => a.order - b.order);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ids.map((id) => (
        <button
          key={id}
          onPointerDown={(e) => onPick(id, e)}
          title="押すと外せます。引っぱって別のハウスに落とすと、そのハウスにも入ります"
          className={`touch-none select-none rounded-full border px-2 py-1 ${planned ? "border-dashed border-sky-400 bg-sky-50 text-sky-900" : "bg-amber-50"}`}
        >
          {names.get(id) ?? "（いない人）"} ×
        </button>
      ))}
      <select
        value=""
        onChange={(e) => e.target.value && onChange([...ids, e.target.value])}
        className="w-12 rounded-lg border bg-white px-1 py-1"
        aria-label="収穫者を足す"
      >
        <option value="">＋</option>
        {candidates.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** テンキーで打って、エンターかほかを押したときに読む入力欄 */
function TextCell<T>({
  value,
  placeholder,
  planned,
  decimal,
  big,
  parse,
  onCommit,
}: {
  value: string;
  placeholder: string;
  /** 作業配置表から入れた値（まだ保存していない）。点線で出す */
  planned?: boolean;
  decimal?: boolean;
  big?: boolean;
  parse: (s: string) => T | undefined;
  onCommit: (v: T) => void;
}) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (text === value) return setBad(false);
    const v = parse(text);
    if (v === undefined) return setBad(true);
    setBad(false);
    onCommit(v);
  };
  return (
    <input
      value={text}
      inputMode={decimal ? "decimal" : "numeric"}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`rounded-lg border px-2 py-2 text-center ${big ? "w-20 text-xl font-bold" : "w-20 text-base"} ${bad ? "border-red-500 bg-red-50" : planned ? "border-dashed border-sky-400 bg-sky-50 text-sky-900" : ""}`}
    />
  );
}

/** 収穫の開始時刻（最初のハウスの「入った」に入る）。管理者は押して変えられる */
function StartTime({ value, isAdmin }: { value: number; isAdmin: boolean }) {
  const [error, setError] = useState("");
  return (
    <span className="flex items-center gap-1 text-sm text-gray-600">
      収穫の開始
      {isAdmin ? (
        <TextCell
          key={value}
          value={clock(value)}
          placeholder="600"
          parse={parseClock}
          onCommit={(v) => {
            setError("");
            if (v != null) saveHarvestStart(v).catch((e) => setError(errorText(e)));
          }}
        />
      ) : (
        <b>{clock(value)}</b>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}
