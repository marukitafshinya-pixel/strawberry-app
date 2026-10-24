"use client";

// 収穫管理の入力（棟別出荷調査票）：ハウスが1行。使い方・収穫者・入った時刻・終わった時刻・確定数を入れる。
// 確定数は集荷のたびに「＋1」を押して数える（押すたびにすぐ保存。どの端末でも同じ数になる）。
// 収穫者と回る順は、作業配置表の名前と矢印から読む（矢印の先の名前のないハウスにも同じ人を入れる）。
// 最初のハウスの「入った」には収穫の開始時刻（管理者が変えられる）を入れておく。1ケースあたりの時間は管理者だけに見える
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { usePerms } from "@/lib/perms";
import { callFunction, errorText } from "@/lib/callFunction";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import {
  addCases,
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
  saveHarvestNoHelp,
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
import {
  forecastCases,
  forecastHarvest,
  refreshHarvestSpeeds,
  saveCasesForecast,
  saveHarvestForecast,
  useHarvestSpeeds,
  useHarvestYield,
  type Forecast,
} from "@/lib/harvestForecast";
import { useShiftMembers, type ShiftMember } from "@/lib/shift";
import { announce, SAY, unlockSound } from "@/lib/announce";
import { callBreak, nowMinJST, useBreakCall, useDayTaps, type DayTaps } from "@/lib/harvestTap";
import { TapList, TapPreview } from "./tap/TapScreen";
import { MessageButton } from "./MessageButton";

/** その日の収穫者・予定の開始時刻（保存していなければ作業配置表から） */
function helpersFor(rec: HarvestDoc, plan: HarvestPlan, startTime: number) {
  /** 作業配置表に収穫の割り振りがある日か（ない日は、記録した収穫者を使う） */
  const planActive = Object.keys(plan.members).length > 0;
  /**
   * そのハウスの収穫者：収穫管理の画面で手で変えたハウスはその人、それ以外は作業配置表の人
   * （作業配置表をあとから変えても、収穫管理に反映する）
   */
  const base = (h: string) => (rec[h]?.membersEdited ? (rec[h].members ?? []) : planActive ? (plan.members[h] ?? []) : (rec[h]?.members ?? []));
  // 収穫報告で応援として入った人も、そのハウスの収穫者に足す
  const who = (h: string) => {
    const b = base(h);
    const extra = (rec[h]?.helpers ?? []).filter((m) => !b.includes(m));
    return extra.length ? [...b, ...extra] : b;
  };
  /** だれかの最初のハウス（配置表の矢印から）なら、収穫の開始時刻。「入った」を消したハウス（null で保存）は入れない */
  const plannedStart = (h: string) => (rec[h]?.start === undefined && who(h).some((m) => plan.routes[m]?.[0] === h) ? startTime : null);
  /** そのハウスの「入った」（まだ入れていなければ、最初のハウスは開始時刻。消したら空のまま） */
  const startOf = (h: string) => (rec[h]?.start !== undefined ? rec[h].start : plannedStart(h));
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
  const { can } = usePerms();
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
  // 開いたときに、人ごとの速さとケース数の見込みを最近の記録から計算し直してもらう。
  // 管理者・スタッフは、その前に夜温・日照（気象庁）を集めてもらう（ケース数の見込みの天気の影響に使う）
  useEffect(() => {
    if (role === "admin" || role === "staff" || role === "accounting")
      void callFunction("refreshHarvestWeather", {})
        .catch(() => {})
        .finally(() => void refreshHarvestSpeeds());
    else void refreshHarvestSpeeds();
  }, [role]);
  const yld = useHarvestYield();
  /** 収穫する人が携帯で押した「入った」「終わった」（今いる場所の緑に使う） */
  const taps = useDayTaps(date);
  // 休憩の合図：この画面でも鳴らす（画面を一度押したあとから音が出せる）
  useEffect(() => {
    document.addEventListener("pointerdown", unlockSound, { once: true });
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, []);
  useBreakCall(date, date === todayJST(), () => announce(SAY.break, { sound: "break" }));
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
            dayStart: cfg.startTime,
            taps: taps ?? undefined,
            now: date === todayJST() ? nowMin : null,
            brk,
            // その日の集荷係が収穫にも入ったハウスは、集荷をしながらなので速さの実績に入れない
            skipRate: (x) => (h.who(x) ?? []).some((m) => pickup.includes(m)),
            // 応援を入れないハウス（病気など）には、予測でも応援を入れない
            noHelp: (x) => cfg.noHelp.includes(x),
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
  // 収穫ケース数の予測（朝の見込みと、終わったハウスの実際で直した予測）
  const cf =
    rec && use && cfg && yld !== undefined
      ? forecastCases({ houses, rec, usage: (x) => use.houses[x] ?? "harvest", plants: cfg.plants, groups: cfg.groups, yield: yld })
      : null;
  // 朝の見込みを残す（収穫の開始時刻までは更新し、それを過ぎたら固定。どこかのハウスが終わったあとは残さない）
  const cfMorning = cf?.morning ?? null;
  useEffect(() => {
    if (date !== todayJST() || cfMorning == null || !day || anyEnded) return;
    if (!beforeStart && day.casesForecast != null) return;
    if (day.casesForecast === cfMorning) return;
    saveCasesForecast(date, cfMorning).catch(() => {});
  }, [date, cfMorning, anyEnded, beforeStart, day]);
  /** 合計の横に出す、収穫ケース数の予測 */
  const casesBox = cf?.total != null && (
    <span className="text-xs leading-tight text-sky-800">
      予測
      <b className="block text-base">{fmtCases(cf.total)}</b>
    </span>
  );
  /** 携帯の画面で見るか（null＝画面の幅で決める）。パソコン・iPadでは携帯の大きさの枠に入れて見せる */
  const [phoneView, setPhoneView] = useState<boolean | null>(null);
  /** 携帯の画面で見ているもの：収穫管理の入力・収穫する人の「収穫報告」の画面・指示一覧 */
  const [tapView, setTapView] = useState<"sheet" | "tap" | "list">("sheet");
  const isWorker = role === "worker";
  // 従業員（勤務の画面のログイン）は、今日の作業配置表で「集荷係」に入っている日だけ、今日の分を使える。いつも携帯の画面。
  // 勤務管理表で「収穫管理を毎日使える」にした人（社員など）は、スタッフと同じく毎日（8日前〜明日の分）使える
  const phone = isWorker || (phoneView ?? narrow);
  const me = isWorker ? members?.find((m) => m.uid === user?.uid) : undefined;
  const everyDay = me?.harvestEntry === true;

  if (!can("harvest") && !isWorker) return <p>この画面は使えません。</p>;
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
  /** 休憩の合図：収穫報告を開いている全員の携帯で鳴らし、押した時刻を今日の休憩の始まりにする（長さはそのまま） */
  const breakCall = day && date === todayJST() && (
    <button
      onClick={() => {
        if (!confirm("休憩の合図を送りますか？（収穫報告を開いている全員の携帯で鳴ります。今の時刻を休憩の始まりにします）")) return;
        unlockSound();
        void callBreak(date).catch(() => alert("送れませんでした"));
        void saveBreak({ ...brk, start: nowMinJST() });
      }}
      className="rounded-lg border-2 border-amber-500 bg-amber-50 px-3 py-1.5 text-sm font-bold whitespace-nowrap text-amber-800"
    >
      ☕ 休憩の合図
    </button>
  );
  /** 個別の連絡：今日出勤している人を選んで、メッセージを相手の携帯で読み上げる（管理者・集荷係） */
  const messageButton = day && date === todayJST() && members && <MessageButton date={date} members={members} />;
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
      noHelp={cfg.noHelp}
      taps={taps}
    />
  );

  if (phone) {
    // 携帯の画面：上に日付と合計を小さくまとめ、ハウスはカードで縦に並べる（上の合計・切り替えボタンも、下の画面といっしょにスクロールする）
    const screen = (
      <div className="pb-6">
        <div className="-mx-3 border-b bg-white px-3 py-2 shadow-sm">
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
            {casesBox}
            {endBox}
          </div>
          {unassignedNote}
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="flex flex-wrap gap-1">
              {breakCall}
              {messageButton}
            </span>
            {breakBox}
          </div>
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
          {/* 収穫管理の入力と、収穫する人それぞれの「収穫報告」の画面を切り替える */}
          <div className="mt-1 grid grid-cols-3 gap-1 border-t pt-1 text-xs">
            {(
              [
                ["sheet", "🍓 収穫管理"],
                ["tap", "📱 収穫報告"],
                ["list", "📋 指示一覧"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setTapView(v)}
                className={`rounded-lg px-1 py-1.5 font-bold whitespace-nowrap ${tapView === v ? "bg-berry text-white" : "border bg-white text-gray-700"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tapView === "tap" && template && haichi && use && members ? (
          <TapPreview date={date} template={template} haichi={haichi} use={use.houses} members={members} rec={rec} />
        ) : tapView === "list" && template && haichi && use && members && rec && hp ? (
          <TapList date={date} template={template} haichi={haichi} use={use.houses} members={members} rec={rec} houseEnd={fc?.houseEnd ?? {}} />
        ) : (
          content
        )}
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
        {casesBox}
        {endBox}
        {cfg && <StartTime value={cfg.startTime} isAdmin={isAdmin} />}
        {breakBox}
        {breakCall}
        {messageButton}
        {toggle}
        {isAdmin && (
          <Link href="/staff/harvest/report/" className="rounded-lg border border-berry bg-white px-3 py-2 text-sm font-bold text-berry">
            📊 収穫の実績
          </Link>
        )}
      </div>
      {unassignedNote}
      {/* パソコンの表の画面でも、収穫する人それぞれの「収穫報告」の画面と指示一覧を切り替えて見られる */}
      <div className="mt-3 flex gap-1 border-b">
        {(
          [
            ["sheet", "🍓 収穫管理"],
            ["tap", "📱 収穫報告"],
            ["list", "📋 指示一覧"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTapView(v)}
            className={`rounded-t-lg px-4 py-2 text-sm font-bold whitespace-nowrap ${tapView === v ? "border border-b-white bg-white text-berry" : "text-gray-500"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tapView === "tap" && template && haichi && use && members ? (
        <div className="max-w-md">
          <TapPreview date={date} template={template} haichi={haichi} use={use.houses} members={members} rec={rec ?? undefined} />
        </div>
      ) : tapView === "list" && template && haichi && use && members && rec && hp ? (
        <div className="max-w-3xl">
          <TapList date={date} template={template} haichi={haichi} use={use.houses} members={members} rec={rec} houseEnd={fc?.houseEnd ?? {}} />
        </div>
      ) : (
        content
      )}
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
  noHelp,
  taps,
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
  /** 応援を入れないハウス（病気などで、決めた人しか入れない） */
  noHelp: string[];
  /** 収穫する人が携帯で押した「入った」「終わった」 */
  taps: DayTaps | null;
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
    ...(rec[h]?.start === undefined && plannedStart(h) != null ? { start: plannedStart(h), startAuto: true } : {}),
  });
  /**
   * その人が「入った」を押したか：本人が携帯で「入った」を押したか、管理者・集荷係が収穫管理の「入った」の欄に時刻を入れた。
   * 収穫の開始時刻・前のハウスの終わった時刻を画面が自動で入れた（startAuto）だけなら、まだ（押し忘れがわかるように、名前は緑のまま。押したら水色）
   */
  const entered = (h: string, id: string) => taps?.[id]?.[h]?.start != null || (rec[h]?.start != null && rec[h].startAuto !== true);
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
        await save(next, { start: end, startAuto: true }, true);
      }
    }
  }
  const setUse = async (h: string, k: HouseUse) => {
    await saveHouseUse(date, Object.fromEntries(houses.map((x) => [x, x === h ? k : usageOf(x)])));
    logHarvest(date, { house: h, use: k });
  };

  // 作業配置表の収穫の枠と同じ並び（1・6・8・4・5・9・10・17〜27）
  const rows = houses;
  /**
   * 応援なしの印：病気などで決めた人しか入れないハウス。応援の指示・収穫報告の「ほかのハウスに行く」に出さない。
   * 管理者は押して付け外しする（外すまで続く）。ほかの人には、付いているときだけ出す
   */
  const noHelpMark = (h: string) => {
    const on = noHelp.includes(h);
    if (!isAdmin) return on ? <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold whitespace-nowrap text-white">🚫応援なし</span> : null;
    return (
      <button
        onClick={() => {
          if (
            !confirm(
              on ? `No.${h} の「応援なし」を外しますか？` : `No.${h} を「応援なし」にしますか？（病気などで、決めた人しか入れないハウス。外すまで続きます）`,
            )
          )
            return;
          run(saveHarvestNoHelp(on ? noHelp.filter((x) => x !== h) : [...noHelp, h]));
        }}
        title="応援なし：応援の指示や「ほかのハウスに行く」に出さない（外すまで続く）"
        className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${on ? "bg-red-600 font-bold text-white" : "border border-gray-300 text-gray-400"}`}
      >
        🚫{on ? "応援なし" : ""}
      </button>
    );
  };

  /**
   * 🏁ここで終了：このハウスを終えた人は、その日の収穫をここまでにする（次のハウス・応援を出さない）。
   * 収穫管理を使う人（管理者・集荷係）が押して付け外しする。その日だけ
   */
  const stopMark = (h: string) => {
    const on = rec[h]?.stopHere === true;
    return (
      <button
        onClick={() => {
          if (
            !confirm(
              on
                ? `No.${h} の「ここで終了」を外しますか？（このハウスを終えた人に、次のハウスを知らせます）`
                : `No.${h} を「ここで終了」にしますか？（このハウスを終えた人は、今日の収穫をここまでにします）`,
            )
          )
            return;
          run(save(h, { stopHere: !on }));
        }}
        title="ここで終了：このハウスを終えた人は、今日の収穫をここまでにする（次のハウス・応援を出さない）"
        className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${on ? "bg-emerald-700 font-bold text-white" : "border border-gray-300 text-gray-400"}`}
      >
        🏁{on ? "終了" : ""}
      </button>
    );
  };

  /** 名前を別のハウスへ入れる（元のハウスにも残す）。入ったが空なら、元のハウスの終わった時刻を入れる */
  function dropTo(id: string, from: string, to: string) {
    if (to === from || NO_HARVEST.includes(usageOf(to))) return;
    const cur = who(to);
    const startAt = rec[to]?.start == null && rec[from]?.end != null ? { start: rec[from].end, startAuto: true } : {};
    run(
      (async () => {
        await save(to, {
          members: cur.includes(id) ? cur : [...cur, id],
          membersEdited: true,
          left: (rec[to]?.left ?? []).filter((x) => x !== id),
          ...startAt,
        });
        await moveHere(id, to, startAt.start ?? startOf(to));
      })(),
    );
  }
  /** いま収穫しているハウスか（「入った」があって「終わった」がまだ） */
  const inProgress = (h: string) => startOf(h) != null && rec[h]?.end == null && !NO_HARVEST.includes(usageOf(h));
  /**
   * 収穫しているハウスに人を入れたら、その人がいるほかの「収穫中」のハウスでは「移った人」にする（名前は記録として残す）。
   * 今いる場所（緑）が1人1か所になるように
   */
  async function moveHere(id: string, to: string, toStart: number | null | undefined) {
    if (toStart == null || rec[to]?.end != null) return;
    // 移ったことにするのは、元のハウスに入ったあとで次のハウスに入ったときだけ。
    // 同じ時刻（収穫の始まる前に、最初のハウスを並べ直しているとき）は、元のハウスを「収穫済み」にしない
    for (const h of rows)
      if (h !== to && inProgress(h) && startOf(h)! < toStart && who(h).includes(id) && !(rec[h]?.left ?? []).includes(id))
        await save(h, { left: [...(rec[h]?.left ?? []), id] });
  }
  /**
   * その人が今いるハウスか：収穫中のハウスのうち、移った人になっていなくて、予定の順でいちばん先のハウス。
   * 予定の順：作業配置表で回る順 → 配置表に名前のあるハウス → 収穫管理で足したハウス（同じなら表の上のほう）。
   * 同じ人が2つのハウスで同時に緑にならないようにする
   */
  const hereOf = (id: string): string | null => {
    // 本人が携帯で「入った」を押して、まだ「終わった」を押していないハウスがあれば、そこ
    const mine = taps?.[id] ?? {};
    const byTap = rows.find((h) => mine[h]?.start != null && mine[h]?.end == null && rec[h]?.end == null);
    if (byTap) return byTap;
    // なければ収穫管理の時刻から（携帯で「終わった」を押したハウスは除く）：収穫中のハウスのうち、その人の予定の順でいちばん先のハウス。
    // あとの予定のハウスにほかの人が先に入っても、今のハウスが終わる（または名前を引っぱって移す）までは動かさない
    /** 配置した順：作業配置表の回る順 → 作業配置表に名前のあるハウス → 収穫管理で足したハウス（小さいほど先） */
    const route = plan.routes[id] ?? [];
    const placed = (h: string) => (route.includes(h) ? route.indexOf(h) : (plan.members[h] ?? []).includes(id) ? 100 : 200);
    let best: string | null = null;
    for (const h of rows)
      if (inProgress(h) && who(h).includes(id) && !(rec[h]?.left ?? []).includes(id) && mine[h]?.end == null && (best == null || placed(h) < placed(best)))
        best = h;
    return best;
  };
  /** そのハウスを終えた・離れた人か（ハウスはまだ収穫中）：ほかへ移った人と、携帯で「終わった」を押した人。名前を灰色の✓にする */
  const leftHouse = (h: string, id: string) => rec[h]?.end == null && ((rec[h]?.left ?? []).includes(id) || taps?.[id]?.[h]?.end != null);
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
      here={(id) => hereOf(id) === h}
      tapped={(id) => entered(h, id)}
      stopped={(id) => !!rec[h]?.stopFor?.includes(id)}
      moved={(id) => leftHouse(h, id) && hereOf(id) !== h}
      finished={rec[h]?.end != null}
      names={names}
      members={members}
      onChange={(next) =>
        run(
          (async () => {
            const added = next.filter((x) => !who(h).includes(x));
            await save(h, { members: next, membersEdited: true, ...(added.length ? { left: (rec[h]?.left ?? []).filter((x) => !added.includes(x)) } : {}) });
            for (const id of added) await moveHere(id, h, startOf(h));
          })(),
        )
      }
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
        // 自動で入った時刻と同じ時刻を打ち込んでも「入った」にする
        commitSame={rec[h]?.start == null || rec[h]?.startAuto === true}
        placeholder="600"
        small={small}
        parse={parseClock}
        onCommit={(v) => run(save(h, { start: v, startAuto: false }))}
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
                  {/* 応援なし・ここで終了の印は、縦に並べる（携帯の幅に収める） */}
                  <span className="flex flex-col items-start gap-0.5">
                    {noHelpMark(h)}
                    {stopMark(h)}
                  </span>
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
                <td className="px-2 py-1.5 text-base font-bold whitespace-nowrap">
                  No.{h}
                  <span className="ml-1 align-middle">{noHelpMark(h)}</span>
                  <span className="ml-1 align-middle">{stopMark(h)}</span>
                </td>
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
 * here＝その人がいま収穫しているハウス（「入った」があって「終わった」がまだ。1人1か所）。名前を緑にして、だれがどこにいるかを一目でわかるようにする
 * finished＝もう終わったハウス、moved＝終わる前にほかのハウスへ移った人。名前を灰色にして「✓」を付ける（これから入るハウスの名前と見分けるため）
 */
function Members({
  ids,
  planned,
  here,
  tapped,
  stopped,
  moved,
  finished,
  names,
  members,
  onChange,
  onPick,
}: {
  ids: string[];
  planned: boolean;
  here: (id: string) => boolean;
  /** その人が「入った」を押した（または管理者・集荷係が時刻を入れた）。今いるハウスの名前を水色にする（押すまでは緑） */
  tapped: (id: string) => boolean;
  /** その人だけ、このハウスで終了（🏁を付ける） */
  stopped: (id: string) => boolean;
  moved: (id: string) => boolean;
  finished: boolean;
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
            here(id) && tapped(id)
              ? "border-sky-600 bg-sky-300 font-bold text-sky-950"
              : here(id)
                ? `border-emerald-700 bg-emerald-600 font-bold text-white ${planned ? "border-dashed" : ""}`
                : finished || moved(id)
                  ? "border-gray-400 bg-gray-300 text-gray-600"
                  : planned
                    ? "border-dashed border-sky-400 bg-sky-50 text-sky-900"
                    : "bg-amber-50"
          }`}
        >
          {(finished || moved(id)) && !here(id) ? "✓ " : ""}
          {stopped(id) ? "🏁" : ""}
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
  commitSame,
}: {
  value: string;
  placeholder: string;
  /** 同じ値を打ち込んでも保存する（自動で入った値を、手で入れたことにする） */
  commitSame?: boolean;
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
  const [typed, setTyped] = useState(false);
  const commit = () => {
    // 打ち込んでいなければ（押して離れただけ）保存しない
    if (text === value && !(commitSame && typed && text !== "")) return setBad(false);
    setTyped(false);
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
      onChange={(e) => {
        setText(e.target.value);
        setTyped(true);
      }}
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
