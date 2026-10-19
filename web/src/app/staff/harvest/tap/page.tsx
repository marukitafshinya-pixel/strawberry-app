"use client";

// 収穫報告（収穫する人の携帯の画面）：今のハウスの番号と「入った」「終わった」だけを出す。
// 回るハウスと順番は、今日の作業配置表（名前と矢印）から読む。「終わった」を押すと、次のハウスを知らせる。
// 自分の予定が全部終わった人には、応援に行くハウス（まだ誰も入っていないハウスのうち、いちばん遅く終わりそうなハウス）を知らせる
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate, type HaichiDay, type HaichiTemplate } from "@/lib/haichi";
import { clock, harvestHouses, logHarvest, planHarvest, useHouseUse, type HouseUseMap } from "@/lib/harvest";
import { refreshHarvestSpeeds } from "@/lib/harvestForecast";
import { fetchDayTaps, fetchHelpHouse, NO_HARVEST, nowMinJST, saveTap, saveTapToHouse, useDayTaps, type DayTaps } from "@/lib/harvestTap";
import { useShiftMembers, type ShiftMember } from "@/lib/shift";

const back = (
  <Link href="/staff/shift/me/" className="text-sm text-gray-600 underline">
    ← 勤務の画面
  </Link>
);

export default function HarvestTapPage() {
  const { role, user } = useAuth();
  const date = todayJST();
  const template = useHaichiTemplate();
  const haichi = useHaichiDay(date);
  const use = useHouseUse(date);
  const members = useShiftMembers();
  const taps = useDayTaps(date);

  if (role !== "worker") return <p className="p-4">この画面は、従業員のログインで使います。{back}</p>;
  if (!template || haichi === null || !use || !members || !taps) return <p className="p-4 text-gray-500">読み込み中…</p>;
  const me = members.find((m) => m.uid === user?.uid);
  if (!me) return <p className="p-4 text-gray-500">従業員リストに名前が見つかりません。{back}</p>;
  return <Tap date={date} template={template} haichi={haichi} use={use.houses} members={members} taps={taps} me={me} />;
}

function Tap({
  date,
  template,
  haichi,
  use,
  members,
  taps,
  me,
}: {
  date: string;
  template: HaichiTemplate;
  haichi: HaichiDay;
  use: HouseUseMap;
  members: ShiftMember[];
  taps: DayTaps;
  me: ShiftMember;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [help, setHelp] = useState<{ house: string | null; forecast: boolean; n: number } | null>(null);
  /** 集荷係の指示で、ほかのハウスへ行くとき：選んだハウス */
  const [chosen, setChosen] = useState<string | null>(null);
  /** 「ほかのハウスに行く」の一覧（null＝閉じている、done＝もう終わったハウス。読み込み中は undefined） */
  const [others, setOthers] = useState<{ done: string[] | undefined } | null>(null);

  const plan = planHarvest(template, haichi);
  const usageOf = (h: string) => use[h] ?? "harvest";
  const mine = taps[me.id] ?? {};
  /** そのハウスで「入った」を押した人 */
  const tappedIn = (h: string) => Object.keys(taps).filter((id) => taps[id]?.[h]?.start != null);
  // 自分の回るハウス：配置表の矢印の順。そのあとに、名前だけ入っているハウス（配置表の並び）
  const route = plan.routes[me.id] ?? [];
  const named = harvestHouses(template).filter((h) => plan.members[h]?.includes(me.id) && !route.includes(h));
  const planned = [...route, ...named].filter((h) => !NO_HARVEST.includes(usageOf(h)));
  // 応援で入ったハウス（押した順）
  const helped = Object.keys(mine)
    .filter((h) => mine[h]?.start != null && !planned.includes(h))
    .sort((a, b) => mine[a].start! - mine[b].start!);
  const seq = [...planned, ...helped];
  /** 応援の人が先に入ったハウス（自分がまだ入っていなければ、飛ばす） */
  const takenByHelper = (h: string) => mine[h]?.start == null && tappedIn(h).some((id) => !(plan.members[h] ?? []).includes(id));
  // 今のハウス：「入った」を押してまだ「終わった」がないハウス。なければ、予定の順で次のハウス
  const current = seq.find((h) => mine[h]?.start != null && mine[h]?.end == null) ?? seq.find((h) => mine[h]?.end == null && !takenByHelper(h)) ?? null;
  const pos = current ? seq.indexOf(current) : seq.length;
  const inNow = current != null && mine[current]?.start != null;
  /** 予定が全部終わって、応援に行けるか */
  const free = planned.length > 0 && current == null;
  const doneCount = seq.filter((h) => mine[h]?.end != null).length;
  /** 取り消せる最後の操作：今のハウスの「入った」か、その前に「終わった」を押したハウス */
  const lastOut = Object.keys(mine)
    .filter((h) => mine[h]?.end != null)
    .sort((a, b) => mine[b].end! - mine[a].end!)[0];
  const last = inNow ? { house: current!, kind: "in" as const } : lastOut ? { house: lastOut, kind: "out" as const } : null;

  // 予定が終わったら、応援のハウスを聞く（1分ごとに聞き直す）
  useEffect(() => {
    if (!free) return;
    let alive = true;
    const ask = () =>
      fetchHelpHouse()
        .then((r) => alive && setHelp({ ...r, n: doneCount }))
        .catch(() => alive && setHelp({ house: null, forecast: true, n: doneCount }));
    void ask();
    const t = setInterval(ask, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [free, doneCount]);

  /** そのハウスが終わるのに「終わった」が要る人：予定の収穫者（ログインのある人）と、入ったを押した人。応援で入ったハウスは、入った人だけ */
  const crewOf = (h: string, all: DayTaps) => {
    const ins = Object.keys(all).filter((id) => all[id]?.[h]?.start != null);
    const planCrew = (plan.members[h] ?? []).filter((id) => members.some((m) => m.id === id && m.uid));
    return [...new Set([...(planCrew.includes(me.id) ? planCrew : []), ...ins, me.id])];
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  async function tapIn(h: string) {
    const now = nowMinJST();
    await saveTap(date, me.id, h, { start: now });
    logHarvest(date, { house: h, start: now, tap: "in" });
    // ハウスの「入った」は、最初に押した人の時刻
    const all = await fetchDayTaps(date);
    const earlier = Object.keys(all).some((id) => id !== me.id && all[id]?.[h]?.start != null && all[id][h].start! <= now);
    if (!earlier) await saveTapToHouse(date, h, { start: now });
  }
  async function tapOut(h: string) {
    const now = nowMinJST();
    await saveTap(date, me.id, h, { end: now });
    logHarvest(date, { house: h, end: now, tap: "out" });
    // 同じハウスの人が全員押したら、ハウスの「終わった」（最後の人の時刻）
    const all = await fetchDayTaps(date);
    const ends = crewOf(h, all).map((id) => (id === me.id ? now : all[id]?.[h]?.end));
    if (ends.every((e) => e != null)) {
      await saveTapToHouse(date, h, { end: Math.max(now, ...(ends as number[])) });
      void refreshHarvestSpeeds();
    }
  }
  async function undo() {
    if (!last || !confirm(`${last.house}番の「${last.kind === "in" ? "入った" : "終わった"}」を取り消しますか？`)) return;
    const h = last.house;
    if (last.kind === "in") {
      await saveTap(date, me.id, h, { start: null });
      logHarvest(date, { house: h, start: null, tap: "undoIn" });
      const all = await fetchDayTaps(date);
      const others = Object.keys(all)
        .filter((id) => id !== me.id)
        .map((id) => all[id]?.[h]?.start)
        .filter((s): s is number => s != null);
      await saveTapToHouse(date, h, { start: others.length ? Math.min(...others) : null });
    } else {
      await saveTap(date, me.id, h, { end: null });
      logHarvest(date, { house: h, end: null, tap: "undoOut" });
      await saveTapToHouse(date, h, { end: null });
    }
  }

  // 聞いたあとに「終わった」を押していたら、聞き直すまで使わない
  const helpNow = help && help.n === doneCount ? help : null;
  /** 指示するハウス：今のハウスか、応援のハウス。ほかのハウスを選んだら、そのハウス */
  const target = inNow ? current : (chosen ?? current ?? (free ? (helpNow?.house ?? null) : null));
  const isChosen = !inNow && chosen != null;
  const isHelp = !isChosen && current == null && target != null;
  /** 「ほかのハウスに行く」を開く（もう終わったハウスをサーバーに聞く） */
  function openOthers() {
    setOthers({ done: undefined });
    fetchHelpHouse()
      .then((r) => setOthers((o) => (o ? { done: r.done } : o)))
      .catch(() => setOthers((o) => (o ? { done: [] } : o)));
  }
  /** 選べるハウス：収穫するハウスのうち、まだ終わっていないハウス（今の指示のハウスは除く） */
  const choices = harvestHouses(template).filter(
    (h) => !NO_HARVEST.includes(usageOf(h)) && h !== target && mine[h]?.end == null && !(others?.done ?? []).includes(h),
  );
  const othersBox = !inNow && (planned.length > 0 || helped.length > 0) && (
    <div className="text-center">
      {others == null ? (
        <button onClick={openOthers} className="rounded-2xl border-2 border-gray-400 bg-white px-5 py-3 text-lg font-bold text-gray-700">
          ほかのハウスに行く
        </button>
      ) : (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-gray-600">集荷係の指示で行くハウスを選んでください</p>
          {others.done === undefined ? (
            <p className="mt-2 text-gray-500">読み込み中…</p>
          ) : (
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setChosen(e.target.value);
                setOthers(null);
              }}
              className="mt-2 w-full rounded-xl border-2 bg-white px-3 py-3 text-2xl"
              aria-label="行くハウス"
            >
              <option value="">ハウスを選ぶ</option>
              {choices.map((h) => (
                <option key={h} value={h}>
                  {h}番
                </option>
              ))}
            </select>
          )}
          <button onClick={() => setOthers(null)} className="mt-2 text-sm text-gray-500 underline">
            やめる
          </button>
        </div>
      )}
    </div>
  );
  const big = "w-full rounded-3xl py-8 text-4xl font-bold shadow disabled:opacity-40";
  return (
    <div className="mx-auto max-w-md space-y-5 pb-10">
      <div className="flex items-center justify-between">
        {back}
        <span className="text-sm text-gray-500">{me.name} さん</span>
      </div>
      <h1 className="text-xl font-bold">🍓 収穫報告</h1>

      {planned.length === 0 && helped.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-lg text-gray-700">今日の収穫の予定はまだありません。作業配置表に名前が入ると、ここに出ます。</p>
      ) : target == null ? (
        <>
          {free && helpNow == null ? (
            <p className="rounded-2xl bg-white p-5 text-center text-lg text-gray-500">次のハウスをさがしています…</p>
          ) : (
            <p className="rounded-2xl bg-green-50 p-6 text-center text-2xl font-bold text-green-800">
              今日の収穫はおわりです。おつかれさまでした
              {free && helpNow && !helpNow.forecast && (
                <span className="mt-2 block text-base font-normal">ほかに手伝うハウスは、集荷係の人に聞いてください。</span>
              )}
            </p>
          )}
          {othersBox}
        </>
      ) : (
        <>
          <div className={`rounded-3xl p-6 text-center shadow-sm ${isHelp ? "bg-amber-50" : isChosen ? "bg-sky-50" : "bg-white"}`}>
            <p className="text-lg text-gray-600">
              {inNow
                ? "いま収穫しているハウス"
                : isChosen
                  ? "集荷係の指示で、次は"
                  : isHelp
                    ? "応援をお願いします。次は"
                    : pos === 0 && doneCount === 0
                      ? "今日はここから収穫をお願いします"
                      : "次は"}
            </p>
            <p className="my-1 text-7xl font-bold text-berry tabular-nums">{target}番</p>
            {!inNow && (isHelp || isChosen || pos > 0 || doneCount > 0) && <p className="text-lg text-gray-600">の収穫をお願いします</p>}
            {isChosen && (
              <button onClick={() => setChosen(null)} className="mt-2 text-sm text-gray-500 underline">
                もとの指示にもどす
              </button>
            )}
          </div>
          {othersBox}
          <button
            disabled={busy || inNow}
            onClick={() =>
              void run(async () => {
                await tapIn(target);
                setChosen(null);
              })
            }
            className={`${big} bg-sky-600 text-white`}
          >
            入った{inNow && <span className="block text-lg font-normal">{clock(mine[target]?.start)}</span>}
          </button>
          <button disabled={busy || (!inNow && (isHelp || isChosen))} onClick={() => void run(() => tapOut(target))} className={`${big} bg-berry text-white`}>
            終わった
          </button>
        </>
      )}
      {error && <p className="text-red-600">保存できませんでした：{error}</p>}
      {last && (
        <button disabled={busy} onClick={() => void run(undo)} className="block w-full text-center text-sm text-gray-500 underline">
          まちがえて押したとき（{last.house}番の「{last.kind === "in" ? "入った" : "終わった"}」を取り消す）
        </button>
      )}
    </div>
  );
}
