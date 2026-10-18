"use client";

// 収穫管理の入力（棟別出荷調査票）：ハウスが1行。使い方・収穫者・入った時刻・終わった時刻・確定数を入れる。
// 確定数は集荷のたびに「＋1」を押して数える（押すたびにすぐ保存。どの端末でも同じ数になる）。
// 収穫者と回る順は、作業配置表の名前と矢印から読む（矢印の先の名前のないハウスにも同じ人を入れる）。
// 最初のハウスの「入った」には収穫の開始時刻（管理者が変えられる）を入れておく。1ケースあたりの時間は管理者だけに見える
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import {
  addCases,
  noteActiveOn,
  useHarvestNotes,
  logHarvest,
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
  saveHarvestEnd,
  saveHarvestBreak,
  DEFAULT_BREAK,
  type HarvestBreak,
  useHouseUse,
  type HarvestDoc,
  type HarvestPlan,
  type HouseHarvest,
  type HouseUse,
  type HouseUseMap,
} from "@/lib/harvest";
import { forecastHarvest, refreshHarvestSpeeds, saveHarvestForecast, useHarvestSpeeds, type Forecast } from "@/lib/harvestForecast";
import { useShiftMembers, type ShiftMember } from "@/lib/shift";

/** その日の収穫者・予定の開始時刻（保存していなければ作業配置表から） */
function helpersFor(rec: HarvestDoc, plan: HarvestPlan, startTime: number) {
  /** 作業配置表に収穫の割り振りがある日か（ない日は、記録した収穫者を使う） */
  const planActive = Object.keys(plan.members).length > 0;
  /**
   * そのハウスの収穫者：収穫管理の画面で手で変えたハウスはその人、それ以外は作業配置表の人
   * （作業配置表をあとから変えても、収穫管理に反映する）
   */
  const who = (h: string) => (rec[h]?.membersEdited ? (rec[h].members ?? []) : planActive ? (plan.members[h] ?? []) : (rec[h]?.members ?? []));
  /** だれかの最初のハウス（配置表の矢印から）なら、収穫の開始時刻 */
  const plannedStart = (h: string) => (who(h).some((m) => plan.routes[m]?.[0] === h) ? startTime : null);
  /** そのハウスの「入った」（保存していなければ、最初のハウスは開始時刻） */
  const startOf = (h: string) => rec[h]?.start ?? plannedStart(h);
  return { who, plannedStart, startOf };
}

/** 収穫者の並びが同じか（順番はちがってもよい） */
const sameMembers = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** 作業配置表の「集荷係」の枠のID */
const PICKUP_SLOT = "pickup";
/** スタッフが入力できるのは、この日数前まで（それより前は管理者だけ） */
const STAFF_DAYS = 7;
/** 収穫しない使い方（この行は収穫の欄を使わない）。いちご狩り前・後ろは、残りの半分を収穫するので入力できる */
const NO_HARVEST: HouseUse[] = ["picking", "reserve", "off"];

export default function HarvestPage() {
  const { role, user } = useAuth();
  const [date, setDate] = useState(todayJST());
  const template = useHaichiTemplate();
  const haichi = useHaichiDay(date);
  /** その日の集荷係 */
  const pickup = haichi?.cells[PICKUP_SLOT]?.members ?? [];
  const day = useHarvestDay(date);
  const rec = day?.houses;
  /** その日の休憩（保存していなければ、ふだんの 9:00〜15分） */
  const brk = day?.brk ?? DEFAULT_BREAK;
  const use = useHouseUse(date);
  const members = useShiftMembers();
  const cfg = useHarvestConfig();
  const speeds = useHarvestSpeeds();
  const narrow = useNarrow();
  // 予測のために、今の時刻を1分ごとに進める
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // 開いたときに、人ごとの速さを最近の記録から計算し直してもらう
  useEffect(() => {
    void refreshHarvestSpeeds();
  }, []);
  const plan = template && haichi ? planHarvest(template, haichi) : null;
  const houses = template ? harvestHouses(template) : [];
  const jst = new Date(tick + 9 * 3600e3);
  const nowMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const hp = plan && rec && cfg ? helpersFor(rec, plan, cfg.startTime) : null;
  const fc =
    plan && rec && use && cfg && speeds && hp
      ? (() => {
          const h = hp;
          return forecastHarvest({
            houses,
            routes: plan.routes,
            who: h.who,
            rec,
            usage: (x) => use.houses[x] ?? "harvest",
            plants: cfg.plants,
            groups: cfg.groups,
            speed: speeds,
            startOf: h.startOf,
            now: date === todayJST() ? nowMin : null,
            brk,
            // その日の集荷係が収穫にも入ったハウスは、集荷をしながらなので速さの実績に入れない
            skipRate: (x) => (h.who(x) ?? []).some((m) => pickup.includes(m)),
          });
        })()
      : null;
  // 朝の予測を残す（実際と比べて、どこでずれたかを見るため）：収穫終了と、ハウスごとの入る・終わる予測。
  // 収穫の開始時刻までは更新し、それを過ぎたら固定する（開始時刻を過ぎてから初めて開いた日は、最初の予測で固定）。
  // どこかのハウスが終わったあとは残さない
  const fcEnd = fc?.end ?? null;
  const fcHouses =
    fc && hp && rec
      ? Object.fromEntries(
          Object.entries(fc.houseEnd).map(([h, e]) => [h, { start: rec[h]?.start ?? hp.startOf(h) ?? fc.houseStart[h] ?? null, end: e, members: hp.who(h) }]),
        )
      : null;
  const fcKey = fcHouses ? JSON.stringify(fcHouses) : "";
  const anyEnded = !!rec && Object.values(rec).some((x) => x.end != null);
  const beforeStart = !!cfg && nowMin < cfg.startTime;
  useEffect(() => {
    if (date !== todayJST() || fcEnd == null || !fcHouses || !day || anyEnded) return;
    if (!beforeStart && day.forecast != null) return;
    if (day.forecast === fcEnd && JSON.stringify(day.forecastHouses ?? {}) === fcKey) return;
    saveHarvestForecast(date, fcEnd, fcHouses).catch(() => {});
    // fcKey が変わったときだけ書く
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, fcEnd, fcKey, anyEnded, beforeStart, day?.forecast]);
  /** 携帯の画面で見るか（null＝画面の幅で決める）。パソコン・iPadでは携帯の大きさの枠に入れて見せる */
  const [phoneView, setPhoneView] = useState<boolean | null>(null);
  const isWorker = role === "worker";
  // 従業員（勤務の画面のログイン）は、今日の作業配置表で「集荷係」に入っている日だけ、今日の分を使える。いつも携帯の画面。
  // 勤務管理表で「収穫管理を毎日使える」にした人（社員など）は、スタッフと同じく毎日（8日前〜明日の分）使える
  const phone = isWorker || (phoneView ?? narrow);
  const me = isWorker ? members?.find((m) => m.uid === user?.uid) : undefined;
  const everyDay = me?.harvestEntry === true;
  const notes = useHarvestNotes(role === "admin");

  if (role !== "admin" && role !== "staff" && !isWorker) return <p>この画面はスタッフだけが使えます。</p>;
  if (isWorker) {
    if (!members || haichi === null) return <p className="text-gray-500">読み込み中…</p>;
    if (!me || (!everyDay && (date !== todayJST() || !haichi.cells[PICKUP_SLOT]?.members.includes(me.id))))
      return (
        <div className="rounded-xl bg-white p-4 text-gray-700">
          <p>収穫管理は、その日の作業配置表で「集荷係」に入っている人だけが使えます。今日は集荷係に入っていません。</p>
          <p className="mt-1 text-sm text-gray-500">毎日使う人は、管理者が勤務管理表の従業員リストで「収穫管理 毎日使える」にチェックを入れてください。</p>
          <Link href="/staff/shift/me/" className="mt-3 inline-block rounded-lg border px-4 py-2">
            ← 勤務の画面
          </Link>
        </div>
      );
  }
  const isAdmin = role === "admin";
  // 管理者の助言（次の日から考えること）：管理者のログインだけに出す
  const todayNotes = (notes ?? []).filter((n) => noteActiveOn(n, date));
  const notesBox = isAdmin && todayNotes.length > 0 && (
    <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-bold">
        📝 今日気をつけること<span className="ml-2 text-xs font-normal text-gray-500">管理者のログインだけに出ています</span>
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {todayNotes.map((n) => (
          <li key={n.id} className="whitespace-pre-wrap">
            {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
  const tooOld = !isAdmin && date < addDays(todayJST(), -STAFF_DAYS);
  const total = rec ? Object.values(rec).reduce((n, h) => n + (h.cases ?? 0), 0) : 0;
  // 収穫終了：入れていなければ、ハウスの「終わった」のいちばん遅い時刻（点線）
  const lastEnd = rec ? Object.values(rec).reduce<number | null>((m, h) => (h.end != null && (m == null || h.end > m) ? h.end : m), null) : null;
  const endShown = day?.endTime ?? lastEnd;
  /** 休憩：押すと、その日の休憩の始まり・長さを変えられる */
  const saveBreak = (b: HarvestBreak) =>
    saveHarvestBreak(date, b)
      .then(() => logHarvest(date, { break: b }))
      .catch(() => alert("保存できませんでした"));
  const breakBox = day && (
    <span className="flex items-center gap-1 text-sm whitespace-nowrap text-gray-600">
      休憩
      <TextCell
        key={`brk${brk.start}`}
        value={clock(brk.start)}
        placeholder="900"
        small
        parse={parseClock}
        onCommit={(v) => v != null && void saveBreak({ ...brk, start: v })}
      />
      から
      <select
        value={brk.minutes}
        onChange={(e) => void saveBreak({ ...brk, minutes: Number(e.target.value) })}
        className="rounded-lg border bg-white px-1 py-2 text-base"
        aria-label="休憩の長さ"
      >
        {[0, 5, 10, 15, 20, 30, 45, 60].map((n) => (
          <option key={n} value={n}>
            {n ? `${n}分` : "なし"}
          </option>
        ))}
      </select>
    </span>
  );
  const endBox = day && (
    <span className="flex items-center gap-1 text-sm whitespace-nowrap text-gray-600">
      収穫終了
      <TextCell
        key={`end${endShown}`}
        value={clock(endShown)}
        planned={day.endTime == null && lastEnd != null}
        placeholder="930"
        small
        parse={parseClock}
        onCommit={(v) =>
          void saveHarvestEnd(date, v)
            .then(() => logHarvest(date, { dayEnd: v }))
            .catch(() => alert("保存できませんでした"))
        }
      />
      {day.endTime == null && fc && (
        <span className="text-xs leading-tight text-sky-800">
          {fc.end != null ? (
            <>
              予測
              <b className="block text-base">{clock(fc.end)}</b>
            </>
          ) : speeds && speeds.avg == null ? (
            "予測は記録がたまると出ます"
          ) : null}
        </span>
      )}
    </span>
  );
  /** 収穫者が決まっていないハウス（予測に入らない）。合計の行の下に出す */
  const unassignedNote = day?.endTime == null && fc && fc.unassigned.length > 0 && (
    <p className="mt-1 text-xs text-amber-700">収穫者なし（予測に入りません）：No.{fc.unassigned.join("・")}</p>
  );

  const toggle = !narrow && (
    <button onClick={() => setPhoneView(!phone)} className="rounded-lg border bg-white px-3 py-2 text-sm">
      {phone ? "🖥 表の画面にもどす" : "📱 携帯の画面で見る"}
    </button>
  );
  const content = tooOld ? (
    <p className="mt-4 rounded-lg border bg-white p-4 text-gray-600">{STAFF_DAYS}日より前の記録は、管理者だけが見たり直したりできます。</p>
  ) : !template || haichi === null || !rec || !use || !members || !cfg ? (
    <p className="mt-4 text-gray-500">読み込み中…</p>
  ) : (
    <Sheet
      date={date}
      houses={harvestHouses(template)}
      plan={plan!}
      forecast={fc}
      brk={brk}
      startTime={cfg.startTime}
      rec={rec}
      endTime={day?.endTime ?? null}
      use={use}
      members={members}
      isAdmin={isAdmin}
      phone={phone}
    />
  );

  if (phone) {
    // 携帯の画面：上に日付と合計を小さくまとめ、ハウスはカードで縦に並べる
    const screen = (
      <div className="pb-6">
        <div className="sticky top-0 z-20 -mx-3 border-b bg-white px-3 py-2 shadow-sm">
          <div className="flex items-center gap-1">
            {(!isWorker || everyDay) && (
              <button onClick={() => setDate(addDays(date, -1))} className="rounded-lg border px-2 py-1.5">
                ◀
              </button>
            )}
            <span className="flex-1 text-center font-bold">{formatJa(date)}</span>
            {(!isWorker || everyDay) && (
              <button onClick={() => setDate(addDays(date, 1))} className="rounded-lg border px-2 py-1.5">
                ▶
              </button>
            )}
            {(!isWorker || everyDay) && date !== todayJST() && (
              <button onClick={() => setDate(todayJST())} className="rounded-lg border px-2 py-1.5 text-sm">
                今日
              </button>
            )}
          </div>
          {/* 合計ケースと、その横に収穫終了 */}
          <div className="mt-1 flex items-center justify-between">
            <span className="tabular-nums">
              合計 <b className="text-2xl text-berry">{fmtCases(total)}</b> ケース
            </span>
            {endBox}
          </div>
          {unassignedNote}
          {notesBox}
          <div className="mt-1 flex justify-end">{breakBox}</div>
          <div className="mt-1 flex items-center justify-between gap-2 border-t pt-1">
            <Link href={isWorker ? "/staff/shift/me/" : "/staff/"} className="text-sm text-gray-600 underline">
              {isWorker ? "← 勤務の画面" : "← メニュー"}
            </Link>
            {!isWorker && (
              <Link href="/staff/shift/" className="text-sm text-gray-600 underline">
                勤務管理表へ
              </Link>
            )}
            {isAdmin && (
              // 管理者だけ：収穫の開始時刻の設定と、実績の画面へ
              <>
                {cfg && <StartTime value={cfg.startTime} isAdmin />}
                <Link href="/staff/harvest/report/" className="rounded-lg border border-berry px-2 py-1 text-sm font-bold text-berry">
                  📊 実績
                </Link>
              </>
            )}
          </div>
        </div>
        {content}
      </div>
    );
    if (narrow || isWorker) return screen;
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">🍓 収穫管理（携帯の画面）</h1>
          <span className="text-sm text-gray-500">携帯で開くと、この形になります。ここでもそのまま入力できます。</span>
          <span className="ml-auto">{toggle}</span>
        </div>
        <div className="mx-auto mt-3 h-[760px] w-[390px] overflow-hidden rounded-[2.5rem] border-[10px] border-gray-800 bg-[#fdf6f4] shadow-2xl">
          <div className="h-full overflow-y-auto px-3">{screen}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        <Link href="/staff/shift/" className="ml-4 text-gray-500 underline">
          📅 勤務管理表へ
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
        {endBox}
        {cfg && <StartTime value={cfg.startTime} isAdmin={isAdmin} />}
        {breakBox}
        {toggle}
        {isAdmin && (
          <Link href="/staff/harvest/report/" className="rounded-lg border border-berry bg-white px-3 py-2 text-sm font-bold text-berry">
            📊 収穫の実績
          </Link>
        )}
      </div>
      {unassignedNote}
      {notesBox}
      {content}
    </>
  );
}

function Sheet({
  date,
  houses,
  plan,
  forecast,
  brk,
  startTime,
  rec,
  endTime,
  use,
  members,
  isAdmin,
  phone,
}: {
  date: string;
  /** 携帯の画面（ハウスをカードで縦に並べる） */
  phone: boolean;
  /** 作業配置表の収穫の枠の順 */
  houses: string[];
  /** 作業配置表から読んだ、収穫者と回る順 */
  plan: HarvestPlan;
  /** 収穫終了の予測（ハウスごとの終わる予測） */
  forecast: Forecast | null;
  /** その日の休憩（収穫の時間から抜く） */
  brk: HarvestBreak;
  /** 収穫の開始時刻（分） */
  startTime: number;
  rec: HarvestDoc;
  /** 保存した収穫終了（まだなら null） */
  endTime: number | null;
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
  const { who, plannedStart, startOf } = helpersFor(rec, plan, startTime);
  /** まだ保存していない予定（収穫者・開始時刻）。そのハウスを初めて保存するときに一緒に保存する */
  const pending = (h: string): HouseHarvest => ({
    ...(rec[h]?.members && (rec[h].membersEdited || sameMembers(rec[h].members!, who(h))) ? {} : { members: who(h) }),
    ...(rec[h]?.start == null && plannedStart(h) != null ? { start: plannedStart(h) } : {}),
  });
  const run = (p: Promise<unknown>) => {
    setError("");
    p.catch((e) => setError(errorText(e)));
  };
  // 作業配置表を変えたら、記録してある収穫者も合わせる（収穫管理の画面で手で変えたハウスはそのまま）
  const outOfSync = houses.filter((h) => rec[h]?.members && !rec[h].membersEdited && !sameMembers(rec[h].members!, who(h)));
  const syncKey = outOfSync.map((h) => `${h}:${who(h).join(",")}`).join("|");
  useEffect(() => {
    if (!syncKey) return;
    for (const h of outOfSync)
      saveHouseHarvest(date, h, { members: who(h) })
        .then(() => logHarvest(date, { house: h, members: who(h), auto: true }))
        .catch(() => {});
    // syncKey が変わったときだけ（同じ書き直しを何度もしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey, date]);
  /** 1つのハウスを保存する。まだ保存していない予定（収穫者・開始時刻）も一緒に保存する。入れたものは入力の記録にも残す（auto＝画面が自動で入れた） */
  const save = async (h: string, patch: HouseHarvest, auto = false) => {
    await saveHouseHarvest(date, h, { ...pending(h), ...patch });
    const { start, end, members, cases } = patch;
    logHarvest(date, { house: h, start, end, members, cases, ...(auto ? { auto } : {}) });
  };
  /** ケースを足す（＋1・−1・＋0.1）。入力の記録にも残す */
  const add = async (h: string, delta: number) => {
    await addCases(date, h, delta, pending(h));
    logHarvest(date, { house: h, delta });
  };

  /** 終わった時刻を入れたら、その人の次のハウス（配置表の矢印の順）の「入った」が空なら同じ時刻を入れる */
  async function setEnd(h: string, end: number | null) {
    await save(h, { end });
    // 終わったハウスが増えたので、人ごとの速さを計算し直してもらう
    void refreshHarvestSpeeds();
    if (end == null) return;
    const done = new Set<string>();
    for (const m of who(h)) {
      const route = plan.routes[m] ?? [];
      const next = route.slice(route.indexOf(h) + 1).find((x) => route.includes(h) && !NO_HARVEST.includes(usageOf(x)));
      if (next && !done.has(next) && rec[next]?.start == null) {
        done.add(next);
        await save(next, { start: end }, true);
      }
    }
  }
  const setUse = async (h: string, k: HouseUse) => {
    await saveHouseUse(date, Object.fromEntries(houses.map((x) => [x, x === h ? k : usageOf(x)])));
    logHarvest(date, { house: h, use: k });
  };

  // 作業配置表の収穫の枠と同じ並び（1・6・8・4・5・9・10・17〜27）
  const rows = houses;

  /** 名前を別のハウスへ入れる（元のハウスにも残す）。入ったが空なら、元のハウスの終わった時刻を入れる */
  function dropTo(id: string, from: string, to: string) {
    if (to === from || NO_HARVEST.includes(usageOf(to))) return;
    const cur = who(to);
    const startAt = rec[to]?.start == null && rec[from]?.end != null ? { start: rec[from].end } : {};
    run(save(to, { members: cur.includes(id) ? cur : [...cur, id], membersEdited: true, ...startAt }));
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
      if (!s.moved) return void run(save(s.from, { members: who(s.from).filter((x) => x !== s.id), membersEdited: true }));
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop]");
      if (target?.dataset.drop) dropTo(s.id, s.from, target.dataset.drop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  // ---- 1つのハウスの部品（表の画面と携帯の画面で同じものを使う）
  const usageSelect = (h: string, cls = "") => {
    const u = houseUseOf(usageOf(h));
    return (
      <select value={u.key} onChange={(e) => run(setUse(h, e.target.value as HouseUse))} className={`rounded-lg border px-1 py-2 font-bold ${u.cls} ${cls}`}>
        {HOUSE_USES.map((x) => (
          <option key={x.key} value={x.key}>
            {x.label.replace(/（.*）/, "")}
          </option>
        ))}
      </select>
    );
  };
  const membersOf = (h: string) => (
    <Members
      ids={who(h)}
      planned={!rec[h]?.members && who(h).length > 0}
      here={startOf(h) != null && rec[h]?.end == null && !NO_HARVEST.includes(usageOf(h))}
      names={names}
      members={members}
      onChange={(next) => run(save(h, { members: next, membersEdited: true }))}
      onPick={(id, e) => onPick(id, h, e)}
    />
  );
  /** 「入った」の欄：入れた時刻か開始時刻（最初のハウス）。まだなければ、前のハウスの終わる予測を欄の下に小さく出す（保存しない） */
  const startCell = (h: string, small?: boolean) => (
    <span className="inline-flex flex-col items-center">
      <TextCell
        key={`s${startOf(h)}`}
        value={clock(startOf(h))}
        planned={rec[h]?.start == null && startOf(h) != null}
        placeholder="600"
        small={small}
        parse={parseClock}
        onCommit={(v) => run(save(h, { start: v }))}
      />
      {startOf(h) == null && forecast?.houseStart[h] != null && (
        <span className="text-[11px] leading-tight text-sky-700">予測 {clock(forecast.houseStart[h])}</span>
      )}
    </span>
  );
  const endCell = (h: string, small?: boolean) => (
    <span className="inline-flex flex-col items-center">
      <TextCell key={`e${rec[h]?.end}`} value={clock(rec[h]?.end)} placeholder="710" small={small} parse={parseClock} onCommit={(v) => run(setEnd(h, v))} />
      {rec[h]?.end == null && forecast?.houseEnd[h] != null && (
        <span className="text-[11px] leading-tight text-sky-700">予測 {clock(forecast.houseEnd[h])}</span>
      )}
    </span>
  );
  const casesCell = (h: string) => (
    <TextCell
      key={`c${rec[h]?.cases}`}
      value={rec[h]?.cases ? round1(rec[h].cases!).toFixed(1) : ""}
      placeholder="0.0"
      decimal
      big
      parse={parseCases}
      onCommit={(v) => run(save(h, { cases: v ?? 0 }))}
    />
  );
  const minus = (h: string, cls = "") => (
    <button
      onClick={() => run(add(h, -1))}
      disabled={!rec[h]?.cases || rec[h].cases! < 1}
      className={`rounded-lg border px-3 py-2 text-gray-600 disabled:opacity-30 ${cls}`}
      aria-label={`No.${h} を1ケース減らす`}
    >
      −1
    </button>
  );
  const plus = (h: string, cls = "") => (
    <button onClick={() => run(add(h, 1))} className={`rounded-lg bg-berry font-bold text-white active:scale-95 ${cls}`} aria-label={`No.${h} に1ケース足す`}>
      ＋1
    </button>
  );
  /** 端数を足す（＋0.1） */
  const plusTenth = (h: string, cls = "") => (
    <button
      onClick={() => run(add(h, 0.1))}
      className={`rounded-lg border-2 border-berry bg-white font-bold text-berry active:scale-95 ${cls}`}
      aria-label={`No.${h} に0.1ケース足す`}
    >
      ＋0.1
    </button>
  );
  const rateOf = (h: string) => {
    const ms = who(h);
    if (ms.length > 1) return <span className="text-xs text-gray-500">共同</span>;
    return perCaseText(solePerCase({ ...rec[h], start: startOf(h), members: ms }, brk));
  };
  const offNote = (h: string) => {
    const u = houseUseOf(usageOf(h));
    return (
      <>
        {u.label}
        {rec[h]?.cases ? `（確定数 ${fmtCases(rec[h].cases!)} が入っています）` : ""}
      </>
    );
  };
  const isOff = (h: string) => NO_HARVEST.includes(usageOf(h));

  // その日に収穫するハウス（収穫者がいるか、ケースが入っている。いちご狩り全・予備・休みは除く）が全部「終わった」になったら、
  // いちばん遅い時刻を収穫終了として保存する（確定）。あとから手で直せる
  const targets = rows.filter((h) => !isOff(h) && (who(h).length > 0 || (rec[h]?.cases ?? 0) > 0));
  const allDone = targets.length > 0 && targets.every((h) => rec[h]?.end != null);
  const latest = allDone ? Math.max(...targets.map((h) => rec[h].end!)) : null;
  useEffect(() => {
    if (endTime == null && latest != null)
      saveHarvestEnd(date, latest)
        .then(() => logHarvest(date, { dayEnd: latest, auto: true }))
        .catch(() => {});
  }, [endTime, latest, date]);

  const help = (
    <>
      集荷のたびに「＋1」を押します（押すとすぐ保存）。端数は「＋0.1」で足すか、確定数の欄を押して直接打てます。名前を引っぱって次のハウスに落とすと、そのハウスにも名前が入ります（名前を押すだけなら外れます）。いま収穫しているハウス（「入った」があって「終わった」がまだ）の名前は
      <b className="text-emerald-700">緑</b>になります。時刻は「710」で
      7:10。「終わった」を入れると、その人の次のハウスの「入った」に同じ時刻が入ります。収穫者は、作業配置表の名前と、矢印でたどれるハウスまで入れています。最初のハウスの「入った」には開始時刻が入ります（点線＝まだ保存していない予定）。矢印のないハウスへは、名前を引っぱって入れてください。
      {use.from !== date &&
        (use.from ? `　ハウスの使い方は${formatJa(use.from)}の状態を引きついでいます。` : "　ハウスの使い方はまだ記録がありません（全部「収穫」）。")}
    </>
  );
  const legend = (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      {HOUSE_USES.map((u) => (
        <span key={u.key} className={`rounded border px-2 py-0.5 ${u.cls}`}>
          {u.short}＝{u.label}
        </span>
      ))}
    </div>
  );
  const dragChip = drag && (
    <div
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-500 bg-amber-100 px-3 py-1 font-bold shadow-lg"
      style={{ left: drag.x, top: drag.y }}
    >
      {names.get(drag.id)}
    </div>
  );

  if (phone)
    return (
      <>
        <details className="mt-2 text-sm text-gray-600">
          <summary className="cursor-pointer">使い方</summary>
          <p className="mt-1">{help}</p>
          {legend}
        </details>
        {error && <p className="mt-2 font-bold text-red-600">{error}</p>}
        <div className="mt-2 space-y-2">
          {rows.map((h) =>
            isOff(h) ? (
              <div key={h} data-drop={h} className="flex items-center gap-2 rounded-xl border bg-gray-50 px-3 py-2">
                <span className="w-14 text-lg font-bold">No.{h}</span>
                {usageSelect(h, "py-1 text-sm")}
                <span className="truncate text-sm text-gray-500">{offNote(h)}</span>
              </div>
            ) : (
              <div key={h} data-drop={h} className="rounded-xl border bg-white p-2.5 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="w-14 text-lg font-bold">No.{h}</span>
                  {usageSelect(h, "py-1 text-sm")}
                  {isAdmin && <span className="text-xs text-sky-800">{rateOf(h)}</span>}
                  {/* 確定数：押すと直接打てる（5.3 など） */}
                  <span className="ml-auto">{casesCell(h)}</span>
                </div>
                <div className="mt-1.5">{membersOf(h)}</div>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">入</span>
                  {startCell(h, true)}
                  <span className="text-xs text-gray-500">終</span>
                  {endCell(h, true)}
                </div>
                <div className="mt-2 grid grid-cols-[1fr_2fr_1.3fr] gap-1.5">
                  {minus(h, "py-3")}
                  {plus(h, "py-3 text-xl")}
                  {plusTenth(h, "py-3 text-lg")}
                </div>
              </div>
            ),
          )}
        </div>
        {dragChip}
      </>
    );

  return (
    <>
      <p className="mt-2 text-sm text-gray-600">{help}</p>
      {legend}
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
            {rows.map((h) => (
              <tr key={h} data-drop={h} className={`border-t ${isOff(h) ? "bg-gray-50" : ""}`}>
                <td className="px-2 py-1.5 text-base font-bold whitespace-nowrap">No.{h}</td>
                <td className="px-2 py-1.5">{usageSelect(h)}</td>
                {isOff(h) ? (
                  <td colSpan={isAdmin ? 6 : 5} className="px-2 py-1.5 text-gray-500">
                    {offNote(h)}
                  </td>
                ) : (
                  <>
                    <td className="px-2 py-1.5">{membersOf(h)}</td>
                    <td className="px-2 py-1.5">{startCell(h)}</td>
                    <td className="px-2 py-1.5">{endCell(h)}</td>
                    <td className="px-2 py-1.5">{casesCell(h)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {minus(h, "mr-1")}
                      {plus(h, "mr-1 px-5 py-2 text-lg")}
                      {plusTenth(h, "px-3 py-2")}
                    </td>
                    {isAdmin && <td className="px-2 py-1.5 text-right text-sky-800">{rateOf(h)}</td>}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dragChip}
      {isAdmin && (
        <p className="mt-1 text-xs text-gray-500">「1ケース」は1人だけで収穫したハウスで計算します。応援が入ったハウス（共同）は、ケース数だけ数えます。</p>
      )}
    </>
  );
}

/**
 * 収穫者：名前を押すと外せる。名前を引っぱって別のハウスの行に落とすと、そのハウスにも入る。「＋」で足す。配置表から入れた人は点線で出す（まだ保存していない）。
 * here＝いま収穫しているハウス（「入った」があって「終わった」がまだ）。名前を緑にして、だれがどこにいるかを一目でわかるようにする
 */
function Members({
  ids,
  planned,
  here,
  names,
  members,
  onChange,
  onPick,
}: {
  ids: string[];
  planned: boolean;
  here: boolean;
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
          className={`touch-none select-none rounded-full border px-2 py-1 ${
            here
              ? `border-emerald-700 bg-emerald-600 font-bold text-white ${planned ? "border-dashed" : ""}`
              : planned
                ? "border-dashed border-sky-400 bg-sky-50 text-sky-900"
                : "bg-amber-50"
          }`}
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
  small,
  decimal,
  big,
  parse,
  onCommit,
}: {
  value: string;
  placeholder: string;
  /** 作業配置表から入れた値（まだ保存していない）。点線で出す */
  planned?: boolean;
  /** 携帯の画面用の小さい欄 */
  small?: boolean;
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
    // いったん今の値の形（9:30 など）に戻す。値が変われば、欄ごと作り直されて新しい値が出る
    setText(value);
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
      className={`rounded-lg border px-2 py-2 text-center ${big ? "w-20 text-xl font-bold" : small ? "w-16 px-1 text-base" : "w-20 text-base"} ${bad ? "border-red-500 bg-red-50" : planned ? "border-dashed border-sky-400 bg-sky-50 text-sky-900" : ""}`}
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

/** 画面の幅が携帯くらい（640px より狭い）か */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
