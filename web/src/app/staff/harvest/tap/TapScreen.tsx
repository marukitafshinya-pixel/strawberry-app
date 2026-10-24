"use client";

// 収穫報告の画面の中身。収穫する人の画面（page.tsx）と、収穫管理の「収穫報告の画面を見る」（preview＝見るだけ）で使う
import { MessageAlert } from "./MessageAlert";
import { PhonePanel, usePhoneSync } from "./PhoneRemote";
import { reportChosen, usePhoneState } from "@/lib/phoneRemote";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { announce, DimScreen, SAY, unlockSound, useIdleDim, useWakeLock, VoiceSettings, voiceTest } from "@/lib/announce";
import { errorText } from "@/lib/callFunction";
import type { HaichiDay, HaichiTemplate } from "@/lib/haichi";
import { clock, harvestHouses, logHarvest, planHarvest, useHarvestConfig, type HarvestDoc, type HarvestPlan, type HouseUseMap } from "@/lib/harvest";
import { refreshHarvestSpeeds } from "@/lib/harvestForecast";
import {
  useBreakCall,
  fetchDayTaps,
  fetchHelpHouse,
  NO_HARVEST,
  nowMinJST,
  saveTap,
  saveTapToHouse,
  setTapHelper,
  useDayTaps,
  type DayTaps,
  type HelpInfo,
} from "@/lib/harvestTap";
import type { ShiftMember } from "@/lib/shift";

export const back = (
  <Link href="/staff/shift/me/" className="text-sm text-gray-600 underline">
    ← 勤務の画面
  </Link>
);

/**
 * 収穫報告の画面の状態（だれが、いまどのハウスの指示を見ているか）。収穫報告の画面と、収穫管理の「指示一覧」で使う。
 * edited＝集荷係が収穫管理で入れ直したハウスの収穫者（作業配置表より優先する）
 */
export function tapStateOf(a: {
  plan: HarvestPlan;
  template: HaichiTemplate;
  use: HouseUseMap;
  taps: DayTaps;
  meId: string;
  edited?: Record<string, string[]>;
  /** 収穫管理で「終わった」が入っているハウス */
  houseDone?: string[];
  /** 収穫管理で「入った」が入っていて「終わった」がまだのハウス（入った時刻・移った人） */
  houseStarted?: Record<string, { start: number; left: string[] }>;
  /** 🏁ここで終了のハウス */
  stops?: string[];
}) {
  const { plan, template, use, taps, meId } = a;
  /** そのハウスの収穫者：集荷係が収穫管理で入れ直したハウスはその人、それ以外は作業配置表の人 */
  const who = (h: string) => a.edited?.[h] ?? plan.members[h] ?? [];
  const usageOf = (h: string) => use[h] ?? "harvest";
  const mine = taps[meId] ?? {};
  /** そのハウスで「入った」を押した人 */
  const tappedIn = (h: string) => Object.keys(taps).filter((id) => taps[id]?.[h]?.start != null);
  // 自分の回るハウス：配置表の矢印の順。そのあとに、名前だけ入っているハウス（配置表の並び）。
  // 集荷係が収穫管理で名前を足したハウスも入れ、外したハウスは入れない
  const route = (plan.routes[meId] ?? []).filter((h) => who(h).includes(meId));
  const named = harvestHouses(template).filter((h) => who(h).includes(meId) && !route.includes(h));
  const planned = [...route, ...named].filter((h) => !NO_HARVEST.includes(usageOf(h)));
  // 応援で入ったハウス（押した順）
  const helped = Object.keys(mine)
    .filter((h) => mine[h]?.start != null && !planned.includes(h))
    .sort((x, y) => mine[x].start! - mine[y].start!);
  const seq = [...planned, ...helped];
  /** 自分にとって終わったハウス：自分で「終わった」を押したか、収穫管理で「終わった」が入っている */
  const isDone = (h: string) => mine[h]?.end != null || !!a.houseDone?.includes(h);
  /** 応援の人が先に入ったハウス（自分がまだ入っていなければ、飛ばす） */
  const takenByHelper = (h: string) => mine[h]?.start == null && tappedIn(h).some((id) => !who(h).includes(id));
  // 今のハウス：① 自分で「入った」を押してまだ終わっていないハウス
  // ② 集荷係が収穫管理に「入った」を入れたハウス（携帯を忘れた人など。移った人は除く）
  // ③ なければ、予定の順で次のハウス
  const byTap = seq.find((h) => mine[h]?.start != null && !isDone(h)) ?? null;
  // （予定の順でいちばん先のハウス。あとの予定のハウスにほかの人が先に入っても、今のハウスが終わるまでは動かさない）
  const byRec = seq.find((h) => !isDone(h) && a.houseStarted?.[h] && !a.houseStarted[h].left.includes(meId)) ?? null;
  // 🏁ここで終了のハウスで終えた（そのあとほかのハウスに入っていない）なら、今日の収穫はここまで
  const later = (h: string, x: string) =>
    mine[h]?.end != null ? mine[x]?.start != null && mine[x].start! >= mine[h].end! : mine[x]?.start != null && seq.indexOf(x) > seq.indexOf(h);
  const stopped =
    byTap || byRec
      ? null
      : ((a.stops ?? []).find(
          (h) => isDone(h) && (mine[h]?.start != null || who(h).includes(meId)) && !Object.keys(mine).some((x) => x !== h && later(h, x)),
        ) ?? null);
  const current = stopped ? null : (byTap ?? byRec ?? seq.find((h) => !isDone(h) && !takenByHelper(h)) ?? null);
  const pos = current ? seq.indexOf(current) : seq.length;
  /** 自分で「入った」を押して収穫中か（「入った」のボタンを押せなくする） */
  const inByTap = current != null && current === byTap;
  /** 収穫中か（自分で押したか、収穫管理に入っている） */
  const inNow = current != null && (inByTap || current === byRec);
  /** 収穫中のハウスに入った時刻 */
  const startAt = current == null ? null : (mine[current]?.start ?? a.houseStarted?.[current]?.start ?? null);
  /** 予定が全部終わって、応援に行けるか */
  const free = planned.length > 0 && current == null && stopped == null;
  const doneCount = seq.filter((h) => isDone(h)).length;
  return { who, usageOf, mine, planned, helped, seq, current, pos, inNow, inByTap, startAt, free, doneCount, isDone, stopped };
}

/** preview＝収穫管理から見るだけ（押せない） */
export function TapScreen({
  date,
  template,
  haichi,
  use,
  members,
  taps,
  me,
  preview = false,
}: {
  date: string;
  template: HaichiTemplate;
  haichi: HaichiDay;
  use: HouseUseMap;
  members: ShiftMember[];
  taps: DayTaps;
  me: ShiftMember;
  preview?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 押し終わるたびに増やす（ハウスの「終わった」が入ってから、応援先を聞き直すため） */
  const [pressed, setPressed] = useState(0);
  /** 画面を黒くしているか（電池の節約：その間は応援先を聞く間隔を2分にする） */
  const dimRef = useRef(false);
  /** サーバーから聞いたこと（応援の行き先・入れ直した収穫者など）。n＝聞いたときの「終わった」の数 */
  const [help, setHelp] = useState<(HelpInfo & { n: number }) | null>(null);
  /** 集荷係の指示で、ほかのハウスへ行くとき：選んだハウス */
  const [chosen, setChosen] = useState<string | null>(null);
  /** 行き先を決めたのはだれか（self＝本人が「ほかのハウスに行く」で選んだ、admin＝収穫管理から決めた） */
  const [chosenBy, setChosenBy] = useState<"self" | "admin">("self");
  // 収穫管理から見るときは、その人の携帯で選んでいる行き先を出す
  const phone = usePhoneState(preview ? me.id : null);
  const phoneChosen = phone?.chosen && phone.chosen.date === date ? phone.chosen : null;
  /** いま決まっている行き先（収穫管理から見るときは、その人の携帯で選んでいるもの） */
  const chosenNow = preview ? (phoneChosen?.house ?? null) : chosen;
  const chosenByNow = preview ? (phoneChosen?.by ?? "self") : chosenBy;
  /** 「ほかのハウスに行く」の一覧（null＝閉じている、done＝もう終わったハウス。読み込み中は undefined） */
  const [others, setOthers] = useState<{ done: string[] | undefined } | null>(null);

  const plan = planHarvest(template, haichi);
  const cfg = useHarvestConfig();
  /** 「終わった」を押したときに聞き直した🏁ここで終了のハウス（1分ごとに聞くのを待たずに使う） */
  const [freshStops, setFreshStops] = useState<string[]>([]);
  const { who, usageOf, mine, planned, helped, current, pos, inNow, inByTap, startAt, free, doneCount, stopped } = tapStateOf({
    plan,
    template,
    use,
    taps,
    meId: me.id,
    edited: help?.members,
    houseDone: help?.done,
    houseStarted: help?.started,
    stops: [...new Set([...(help?.stops ?? []), ...freshStops])],
  });
  /** 取り消せる最後の操作：今のハウスの「入った」か、その前に「終わった」を押したハウス */
  const lastOut = Object.keys(mine)
    .filter((h) => mine[h]?.end != null)
    .sort((a, b) => mine[b].end! - mine[a].end!)[0];
  const last = inByTap ? { house: current!, kind: "in" as const } : lastOut ? { house: lastOut, kind: "out" as const } : null;

  // 集荷係が入れ直した収穫者と応援の行き先を聞く（開いたとき・押したとき・1分ごと）。
  // 自分の予定が終わったら（free）、応援先を割り当ててもらう（見るだけの画面では割り当てない）
  const askFree = free && !preview;
  // 手があいて応援先を待っている・向かっている間は、だれかが押すたびに聞き直す（応援先をその場で見直すため）
  const tapKey = JSON.stringify(askFree ? taps : mine);
  useEffect(() => {
    let alive = true;
    const ask = () =>
      fetchHelpHouse(askFree)
        .then((r) => alive && setHelp({ ...r, n: doneCount }))
        .catch(
          () =>
            alive && setHelp((h) => ({ house: null, assign: h?.assign ?? {}, open: true, forecast: true, done: [], members: h?.members ?? {}, n: doneCount })),
        );
    void ask();
    // ほかの人の「終わった」は、本人の記録のあとにハウスの「終わった」が入るので、少しあとにもう一度聞く
    const again = setTimeout(ask, 4000);
    // 1分ごとに聞き直す。画面を黒くしている間は2分ごと（だれかが押したときは、黒い画面でもすぐ聞く）
    let tick = 0;
    const t = setInterval(() => {
      tick++;
      if (dimRef.current && tick % 2 === 1) return;
      void ask();
    }, 60_000);
    return () => {
      alive = false;
      clearTimeout(again);
      clearInterval(t);
    };
  }, [doneCount, tapKey, askFree, pressed]);

  /** そのハウスが終わるのに「終わった」が要る人：予定の収穫者（ログインのある人）と、入ったを押した人。応援で入ったハウスは、入った人だけ */
  const crewOf = (h: string, all: DayTaps) => {
    const ins = Object.keys(all).filter((id) => all[id]?.[h]?.start != null);
    const planCrew = who(h).filter((id) => members.some((m) => m.id === id && m.uid));
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
      setPressed((n) => n + 1);
    }
  };

  async function tapIn(h: string) {
    const now = nowMinJST();
    await saveTap(date, me.id, h, { start: now });
    logHarvest(date, { house: h, start: now, tap: "in" });
    // 予定の人でなければ、応援の人として名前を足す（収穫管理の画面に出る）
    if (!who(h).includes(me.id)) await setTapHelper(date, h, me.id, true);
    // ハウスの「入った」は、最初に入った人の時刻（ほかの人が押したか、収穫管理にもう入っていれば、そのまま）
    const [all, info] = await Promise.all([fetchDayTaps(date), fetchHelpHouse().catch(() => null)]);
    const earlier = Object.keys(all).some((id) => id !== me.id && all[id]?.[h]?.start != null && all[id][h].start! <= now);
    const recorded = info?.started?.[h] != null && info.started[h].start <= now;
    if (!earlier && !recorded) await saveTapToHouse(date, h, { start: now });
  }
  async function tapOut(h: string) {
    const now = nowMinJST();
    await saveTap(date, me.id, h, { end: now });
    logHarvest(date, { house: h, end: now, tap: "out" });
    // 同じハウスの人が全員押したら、ハウスの「終わった」（最後の人の時刻）
    const [all, info] = await Promise.all([fetchDayTaps(date), fetchHelpHouse().catch(() => null)]);
    if (info?.stops) setFreshStops(info.stops);
    const ends = crewOf(h, all).map((id) => (id === me.id ? now : all[id]?.[h]?.end));
    // 応援で入ったハウスで、自分より前からほかの人が入っていた（収穫管理に「入った」がある）ときは、ハウスの「終わった」は入れない（ほかの人がまだ収穫している）
    const othersBefore = !who(h).includes(me.id) && info?.started?.[h] != null && info.started[h].start < (mine[h]?.start ?? now);
    if (!othersBefore && ends.every((e) => e != null)) {
      await saveTapToHouse(date, h, { end: Math.max(now, ...(ends as number[])) });
      void refreshHarvestSpeeds();
    }
  }
  async function undo() {
    if (!last || !confirm(`${last.house}番の「${last.kind === "in" ? "入った" : "終わった"}」を取り消しますか？`)) return;
    const h = last.house;
    if (last.kind === "in") {
      const myStart = mine[h]?.start ?? null;
      await saveTap(date, me.id, h, { start: null });
      logHarvest(date, { house: h, start: null, tap: "undoIn" });
      if (!who(h).includes(me.id)) await setTapHelper(date, h, me.id, false);
      // ハウスの「入った」が自分の時刻のときだけ、ほかの人の時刻（なければ空）に戻す
      const [all, info] = await Promise.all([fetchDayTaps(date), fetchHelpHouse().catch(() => null)]);
      if (info?.started?.[h]?.start === myStart) {
        const others = Object.keys(all)
          .filter((id) => id !== me.id)
          .map((id) => all[id]?.[h]?.start)
          .filter((s): s is number => s != null);
        await saveTapToHouse(date, h, { start: others.length ? Math.min(...others) : null });
      }
    } else {
      await saveTap(date, me.id, h, { end: null });
      logHarvest(date, { house: h, end: null, tap: "undoOut" });
      await saveTapToHouse(date, h, { end: null });
    }
  }

  // 聞いたあとに「終わった」を押していたら、聞き直すまで使わない
  const helpNow = help && help.n === doneCount ? help : null;
  /** 指示するハウス：今のハウスか、応援のハウス。ほかのハウスを選んだら、そのハウス */
  /** 自分の応援先（見るだけの画面では、その人に割り当てられている応援先） */
  const helpHouse = helpNow ? (helpNow.assign[me.id] ?? null) : null;
  const target = inNow ? current : (chosenNow ?? current ?? (free ? helpHouse : null));
  const isChosen = !inNow && chosenNow != null;
  const isHelp = !isChosen && current == null && target != null;

  // ---------- 音声案内と、画面を消さない（本人の携帯だけ。見るだけの画面ではしない） ----------
  /** 自分の収穫も、ほかのハウスも全部終わった */
  const allDone = (planned.length > 0 || helped.length > 0) && target == null && free && helpNow != null && !helpNow.open;
  // 収穫報告を開いている間は画面を消さない（全部終わったら元に戻す）
  const keepAwake = !preview && (planned.length > 0 || helped.length > 0) && !allDone && stopped == null;
  useWakeLock(keepAwake);
  // 画面を一度押したら、音と声を出せるようにしておく
  useEffect(() => {
    if (preview) return;
    document.addEventListener("pointerdown", unlockSound, { once: true });
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, [preview]);
  /** 画面いっぱいに出す知らせ（「わかった」で消す） */
  const [notice, setNotice] = useState<string | null>(null);
  // 収穫管理からの操作を受けとる（声の設定・音声テスト・行き先）。本人の携帯だけ
  const sync = usePhoneSync({
    date,
    memberId: me.id,
    enabled: !preview,
    onGoto: (h) => {
      setChosen(h);
      setChosenBy("admin");
      unlockSound();
      announce(SAY.goto(h), { sound: "change", vibrate: true });
      setNotice(`管理者の指示で、次は${h}番ハウスです`);
    },
    onTest: () => voiceTest(setNotice),
  });
  // 選んでいる行き先を、収穫管理から見えるように知らせる
  useEffect(() => {
    if (preview) return;
    void reportChosen(me.id, chosen ? { date, house: chosen, by: chosenBy } : null).catch(() => {});
  }, [preview, me.id, date, chosen, chosenBy]);
  // 休憩の合図：管理者・集荷係が押したら、効果音と声と画面で知らせる（見るだけの画面では鳴らさない）
  useBreakCall(date, !preview, () => {
    announce(SAY.break, { sound: "break", vibrate: true });
    setNotice("☕ おつかれさまです！ただいまから休憩の時間です。");
  });
  // 30秒触らないと画面を黒くする（電池の節約）。知らせが出ているときは黒くしない
  const { dim, wake } = useIdleDim(keepAwake && !notice, 30_000);
  useEffect(() => {
    dimRef.current = dim;
  }, [dim]);
  /** 「終わった」を押したあと、次のハウスがわかったら読み上げる（押したハウス） */
  const afterOut = useRef<string | null>(null);
  /** 最後に読み上げた行き先（同じ行き先を2回言わない） */
  const spoken = useRef<string | null>(null);
  /** 「すべて終わりました」を言ったか */
  const doneSaid = useRef(false);
  useEffect(() => {
    if (preview) return;
    if (allDone) {
      // 全部のハウスが終わった（自分で最後に押したときも、ほかの人が最後に終えたときも）
      if (!doneSaid.current) announce(SAY.done, { sound: "done" });
      doneSaid.current = true;
      afterOut.current = null;
      return;
    }
    doneSaid.current = false;
    const out = afterOut.current;
    if (out != null && stopped === out) {
      // 🏁ここで終了のハウスを終えた
      announce(SAY.stop(out), { sound: "done" });
      afterOut.current = null;
      spoken.current = null;
      return;
    }
    if (out != null) {
      // 「終わった」のあと：次のハウス（予定・応援先）がわかったら読み上げる
      if (target != null && target !== out && (!free || helpNow != null)) {
        announce(SAY.out(out, target), { sound: "out" });
        afterOut.current = null;
        spoken.current = target;
      } else if (free && helpNow != null && helpHouse == null) {
        announce(SAY.outOnly(out), { sound: "out" });
        afterOut.current = null;
        spoken.current = null;
      }
      return;
    }
    if (!free || inNow || isChosen || helpHouse == null || helpHouse === spoken.current) return;
    // 向かっている途中で応援先が変わった・待っている間に応援先が決まった
    const text = spoken.current ? SAY.change(helpHouse) : SAY.help(helpHouse);
    announce(text, { sound: "change", vibrate: true });
    spoken.current = helpHouse;
    setTimeout(() => setNotice(spoken.current === helpHouse ? text : null), 0);
  }, [preview, allDone, target, free, helpNow, helpHouse, inNow, isChosen, stopped]);
  /** 「ほかのハウスに行く」を開く（もう終わったハウスをサーバーに聞く） */
  function openOthers() {
    setOthers({ done: undefined });
    fetchHelpHouse()
      .then((r) => setOthers((o) => (o ? { done: r.done } : o)))
      .catch(() => setOthers((o) => (o ? { done: [] } : o)));
  }
  /** 選べるハウス：収穫するハウスのうち、まだ終わっていないハウス（今の指示のハウスと、自分の入っていない「応援なし」のハウスは除く） */
  const choices = harvestHouses(template).filter(
    (h) =>
      !NO_HARVEST.includes(usageOf(h)) &&
      h !== target &&
      mine[h]?.end == null &&
      !(others?.done ?? []).includes(h) &&
      !((cfg?.noHelp ?? []).includes(h) && !who(h).includes(me.id)),
  );
  // 収穫管理から見るときは出さない（下の「携帯の設定」から行き先を送る）
  const othersBox = !preview && !inNow && (planned.length > 0 || helped.length > 0) && (
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
                setChosenBy("self");
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
      {/* 収穫管理からの個別の連絡（本人の携帯だけ） */}
      {!preview && <MessageAlert date={date} me={me} slow={dim} />}
      {dim && <DimScreen text={target ? (inNow ? `${target}番 収穫中` : `次は ${target}番`) : ""} onWake={wake} />}
      {notice && (
        // 応援先の知らせ：画面いっぱいに出す（「わかった」で消す）
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-amber-400 p-6 text-center">
          <p className="text-3xl leading-snug font-bold text-gray-900">{notice}</p>
          <button onClick={() => setNotice(null)} className="rounded-2xl bg-white px-10 py-5 text-3xl font-bold shadow">
            わかった
          </button>
        </div>
      )}
      {preview ? (
        <p className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-600">
          {me.name} さんの携帯に出ている画面です（「入った」「終わった」はここでは押せません。取り消しと、下の携帯の設定はここから操作できます）
        </p>
      ) : (
        <div className="flex items-center justify-between">
          {back}
          <span className="text-sm text-gray-500">{me.name} さん</span>
        </div>
      )}
      <h1 className="text-xl font-bold">🍓 収穫報告</h1>

      {help == null ? (
        <p className="rounded-2xl bg-white p-5 text-center text-lg text-gray-500">読み込み中…</p>
      ) : planned.length === 0 && helped.length === 0 ? (
        <p className="rounded-2xl bg-white p-5 text-lg text-gray-700">今日の収穫の予定はまだありません。作業配置表に名前が入ると、ここに出ます。</p>
      ) : target == null ? (
        <>
          {stopped ? (
            <p className="rounded-2xl bg-green-50 p-6 text-center text-2xl font-bold text-green-800">
              🏁 {stopped}番で、今日の収穫はここまでです。おつかれさまでした
            </p>
          ) : free && (helpNow == null || helpNow.open) ? (
            // 終わっていないハウスがあるうちは、応援先が決まるまで待つ（1分ごとに聞き直す）
            <p className="rounded-2xl bg-white p-5 text-center text-lg text-gray-500">
              次の応援先をさがしています…
              {preview && <span className="mt-1 block text-sm">（その人の携帯で開くと決まります）</span>}
            </p>
          ) : (
            <p className="rounded-2xl bg-green-50 p-6 text-center text-2xl font-bold text-green-800">今日の収穫はおわりです。おつかれさまでした</p>
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
                  ? chosenByNow === "admin"
                    ? "管理者の指示で、次は"
                    : "集荷係の指示で、次は"
                  : isHelp
                    ? "応援をお願いします。次は"
                    : pos === 0 && doneCount === 0
                      ? "今日はここから収穫をお願いします"
                      : "次は"}
            </p>
            <p className="my-1 text-7xl font-bold text-berry tabular-nums">{target}番</p>
            {!inNow && (isHelp || isChosen || pos > 0 || doneCount > 0) && <p className="text-lg text-gray-600">の収穫をお願いします</p>}
            {isChosen && !preview && (
              <button onClick={() => setChosen(null)} className="mt-2 text-sm text-gray-500 underline">
                もとの指示にもどす
              </button>
            )}
          </div>
          {othersBox}
          <button
            disabled={preview || busy || inByTap}
            onClick={() =>
              void run(async () => {
                await tapIn(target);
                setChosen(null);
                if (!preview) {
                  announce(SAY.in(target), { sound: "in" });
                  spoken.current = null;
                }
              })
            }
            className={`${big} bg-sky-600 text-white`}
          >
            入った{inNow && startAt != null && <span className="block text-lg font-normal">{clock(startAt)}</span>}
          </button>
          <button
            disabled={preview || busy || (!inNow && (isHelp || isChosen))}
            onClick={() =>
              void run(async () => {
                // 次のハウスがわかったら読み上げる（下の音声案内）。押している間に画面が変わることがあるので、先に覚えておく
                if (!preview) afterOut.current = target;
                try {
                  await tapOut(target);
                } catch (e) {
                  afterOut.current = null;
                  throw e;
                }
              })
            }
            className={`${big} bg-berry text-white`}
          >
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
      {!preview && (
        // 音声案内を試す（記録は変えない）・練習モード
        <div className="flex flex-wrap justify-center gap-3 border-t pt-4">
          <button onClick={() => voiceTest(setNotice)} className="rounded-xl border bg-white px-4 py-2 text-sm text-gray-700">
            🔊 音声案内のテスト
          </button>
          <Link href="/staff/harvest/tap/practice/" className="rounded-xl border bg-white px-4 py-2 text-sm text-gray-700">
            🎓 練習モード
          </Link>
          <VoiceSettings key={sync.version} onChange={(v, o) => sync.report(v, o)} />
        </div>
      )}
      {preview && (
        // 収穫管理から：その人の携帯の声の設定・音声テスト・行き先（「入った」「終わった」以外）
        <PhonePanel
          date={date}
          memberId={me.id}
          name={me.name}
          choices={harvestHouses(template).filter((h) => !NO_HARVEST.includes(usageOf(h)) && mine[h]?.end == null && !(help?.done ?? []).includes(h))}
        />
      )}
    </div>
  );
}

/** 収穫管理から、収穫する人それぞれの携帯に出ている収穫報告の画面を見る（名前を選ぶ。見るだけ） */
export function TapPreview({
  date,
  template,
  haichi,
  use,
  members,
  rec,
}: {
  date: string;
  template: HaichiTemplate;
  haichi: HaichiDay;
  use: HouseUseMap;
  members: ShiftMember[];
  /** 収穫管理の記録（集荷係が名前を足した人も選べるように） */
  rec?: HarvestDoc;
}) {
  const taps = useDayTaps(date);
  const plan = planHarvest(template, haichi);
  // 選べるのは、その日の作業配置表で収穫に名前が入っている人（勤務管理表の順）
  const people = members
    .filter((m) => Object.values(plan.members).some((ms) => ms.includes(m.id)) || Object.values(rec ?? {}).some((r) => r.members?.includes(m.id)))
    .sort((a, b) => a.order - b.order);
  const [pick, setPick] = useState("");
  const me = people.find((m) => m.id === pick) ?? people[0];
  if (!taps) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  if (!me) return <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">この日の作業配置表に、収穫の名前が入っていません。</p>;
  return (
    <div className="mt-3 space-y-3">
      <select
        value={me.id}
        onChange={(e) => setPick(e.target.value)}
        className="w-full rounded-xl border-2 bg-white px-3 py-2 text-lg"
        aria-label="だれの画面を見るか"
      >
        {people.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} さんの画面{m.uid ? "" : "（ログインなし）"}
          </option>
        ))}
      </select>
      <TapScreen key={me.id} date={date} template={template} haichi={haichi} use={use} members={members} taps={taps} me={me} preview />
    </div>
  );
}

/**
 * 収穫管理の「指示一覧」：収穫する人ごとに、いま携帯に出ている指示、いま収穫しているハウスの入った時刻と終わる予測を並べる。
 * 「ほかのハウスに行く」で選んだだけ（まだ「入った」を押していない）ハウスは、その人の携帯の中だけなので、ここには出ない
 */
export function TapList({
  date,
  template,
  haichi,
  use,
  members,
  rec,
  houseEnd,
}: {
  date: string;
  template: HaichiTemplate;
  haichi: HaichiDay;
  use: HouseUseMap;
  members: ShiftMember[];
  rec: HarvestDoc;
  /** ハウス → 終わる予測（分。収穫終了の予測から） */
  houseEnd: Record<string, number>;
}) {
  const taps = useDayTaps(date);
  const [help, setHelp] = useState<HelpInfo | null>(null);
  // 応援の行き先と応援が必要な順を聞く（1分ごと。だれかが押したときと、収穫管理の入力が変わったときはすぐ）
  const changeKey =
    JSON.stringify(taps) +
    JSON.stringify(
      Object.entries(rec).map(([h, r]) => [h, r.start ?? null, r.end ?? null, r.members ?? null, r.helpers ?? null, r.left ?? null, r.stopHere ?? false]),
    );
  useEffect(() => {
    let alive = true;
    const ask = () =>
      fetchHelpHouse()
        .then((r) => alive && setHelp(r))
        .catch(() => {});
    void ask();
    const t = setInterval(ask, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [changeKey]);
  const plan = planHarvest(template, haichi);
  // 集荷係が収穫管理で入れ直したハウスの収穫者
  const edited = Object.fromEntries(
    Object.entries(rec)
      .filter(([, r]) => r.membersEdited && r.members)
      .map(([h, r]) => [h, r.members!]),
  );
  const people = members
    .filter((m) => Object.values(plan.members).some((ms) => ms.includes(m.id)) || Object.values(edited).some((ms) => ms.includes(m.id)))
    .sort((a, b) => a.order - b.order);
  if (!taps) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  if (!people.length) return <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">この日の作業配置表に、収穫の名前が入っていません。</p>;

  // 収穫管理の「終わった」「入った」（集荷係が入れた分）も、その人の今いるハウスに使う
  const houseDone = Object.keys(rec).filter((h) => rec[h]?.end != null);
  const houseStarted = Object.fromEntries(
    Object.entries(rec)
      .filter(([, r]) => r.start != null && r.end == null)
      .map(([h, r]) => [h, { start: r.start!, left: r.left ?? [] }]),
  );
  const stops = Object.keys(rec).filter((h) => rec[h]?.stopHere);
  const rows = people.map((m) => {
    const st = tapStateOf({ plan, template, use, taps, meId: m.id, edited, houseDone, houseStarted, stops });
    const h = st.current;
    const text = st.stopped
      ? `🏁 終了（${st.stopped}番まで）`
      : st.inNow
        ? `${h}番を収穫中`
        : h
          ? st.pos === 0 && st.doneCount === 0
            ? `今日は${h}番から`
            : `次は${h}番`
          : st.free
            ? m.uid && help?.assign[m.id]
              ? `応援：${help.assign[m.id]}番`
              : help?.open === false
                ? "おわり"
                : m.uid
                  ? "応援先待ち（携帯を開くと決まります）"
                  : "おわり"
            : "予定なし";
    return {
      m,
      text: m.uid ? text : `${text}（ログインなし）`,
      help: !st.inNow && !h && st.free && !!(m.uid && help?.assign[m.id]),
      house: st.inNow ? h : null,
      start: st.inNow ? st.startAt : null,
    };
  });
  return (
    <div className="mt-3">
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-2 py-2">名前</th>
              <th className="px-2 py-2">いまの指示</th>
              <th className="px-2 py-2 text-right">入った</th>
              <th className="px-2 py-2 text-right">終わる予測</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m.id} className="border-t">
                <td className="px-2 py-2 font-bold whitespace-nowrap">{r.m.name}</td>
                <td className={`px-2 py-2 ${r.house ? "font-bold text-emerald-700" : r.help ? "font-bold text-amber-700" : ""}`}>{r.text}</td>
                <td className="px-2 py-2 text-right">{r.start != null ? clock(r.start) : "－"}</td>
                <td className="px-2 py-2 text-right text-sky-800">{r.house && houseEnd[r.house] != null ? clock(houseEnd[r.house]) : "－"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 rounded-xl border bg-white p-3">
        <h3 className="font-bold">🆘 応援が必要な順</h3>
        {help == null ? (
          <p className="mt-1 text-sm text-gray-500">読み込み中…</p>
        ) : !help.ranking?.length ? (
          <p className="mt-1 text-sm text-gray-500">終わっていないハウスはありません。</p>
        ) : (
          <ol className="mt-1 space-y-1 text-sm tabular-nums">
            {help.ranking.map((r, i) => (
              <li key={r.house} className={`flex items-baseline gap-2 ${i === 0 ? "font-bold text-red-700" : ""}`}>
                <span className="w-8 shrink-0">{i + 1}位</span>
                <span className="w-12 shrink-0">{r.house}番</span>
                <span>
                  終わる見込み {clock(r.finish)}
                  <span className="ml-1 text-xs font-normal text-gray-500">
                    （{r.started ? `いま${r.crew}人` : r.crew > 0 ? `${r.crew}人が向かっている` : "まだだれも入っていない・朝の予測"}）
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-1 text-xs text-gray-500">
          まだだれも入っていないハウス（向かっている人もいない）を先に、そのあとは、いまの人数のままだと終わるのがおそいハウスから順に並べています（応援に向かっている人も人数に数えます。「🚫応援なし」のハウスは出しません）。手のあいた人には1位のハウスから応援を出します。ただし、1位が別の地区（1〜10番・17〜20番・21〜27番）で、2位がその人のいまいる地区にあるときは、移動が少ないよう2位に出します。
        </p>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        「いまの指示」は、その人の収穫報告の画面に出ている指示です（1分ごとに読み直します）。「終わる予測」は、いま収穫しているハウスが、いまの人数のままで終わる予測です。
        「ほかのハウスに行く」で選んで、まだ「入った」を押していないときは、元の指示のまま出ます。
      </p>
    </div>
  );
}
