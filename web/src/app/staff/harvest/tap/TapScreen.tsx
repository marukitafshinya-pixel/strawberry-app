"use client";

// 収穫報告の画面の中身。収穫する人の画面（page.tsx）と、収穫管理の「収穫報告の画面を見る」（preview＝見るだけ）で使う
import Link from "next/link";
import { useEffect, useState } from "react";
import { errorText } from "@/lib/callFunction";
import type { HaichiDay, HaichiTemplate } from "@/lib/haichi";
import { clock, harvestHouses, logHarvest, planHarvest, useHarvestConfig, type HarvestDoc, type HarvestPlan, type HouseUseMap } from "@/lib/harvest";
import { refreshHarvestSpeeds } from "@/lib/harvestForecast";
import { fetchDayTaps, fetchHelpHouse, NO_HARVEST, nowMinJST, saveTap, saveTapToHouse, useDayTaps, type DayTaps, type HelpInfo } from "@/lib/harvestTap";
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
  /** 応援の人が先に入ったハウス（自分がまだ入っていなければ、飛ばす） */
  const takenByHelper = (h: string) => mine[h]?.start == null && tappedIn(h).some((id) => !who(h).includes(id));
  // 今のハウス：「入った」を押してまだ「終わった」がないハウス。なければ、予定の順で次のハウス
  const current = seq.find((h) => mine[h]?.start != null && mine[h]?.end == null) ?? seq.find((h) => mine[h]?.end == null && !takenByHelper(h)) ?? null;
  const pos = current ? seq.indexOf(current) : seq.length;
  const inNow = current != null && mine[current]?.start != null;
  /** 予定が全部終わって、応援に行けるか */
  const free = planned.length > 0 && current == null;
  const doneCount = seq.filter((h) => mine[h]?.end != null).length;
  return { who, usageOf, mine, planned, helped, seq, current, pos, inNow, free, doneCount };
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
  /** サーバーから聞いたこと（応援の行き先・入れ直した収穫者など）。n＝聞いたときの「終わった」の数 */
  const [help, setHelp] = useState<(HelpInfo & { n: number }) | null>(null);
  /** 集荷係の指示で、ほかのハウスへ行くとき：選んだハウス */
  const [chosen, setChosen] = useState<string | null>(null);
  /** 「ほかのハウスに行く」の一覧（null＝閉じている、done＝もう終わったハウス。読み込み中は undefined） */
  const [others, setOthers] = useState<{ done: string[] | undefined } | null>(null);

  const plan = planHarvest(template, haichi);
  const cfg = useHarvestConfig();
  const { who, usageOf, mine, planned, helped, current, pos, inNow, free, doneCount } = tapStateOf({
    plan,
    template,
    use,
    taps,
    meId: me.id,
    edited: help?.members,
  });
  /** 取り消せる最後の操作：今のハウスの「入った」か、その前に「終わった」を押したハウス */
  const lastOut = Object.keys(mine)
    .filter((h) => mine[h]?.end != null)
    .sort((a, b) => mine[b].end! - mine[a].end!)[0];
  const last = inNow ? { house: current!, kind: "in" as const } : lastOut ? { house: lastOut, kind: "out" as const } : null;

  // 集荷係が入れ直した収穫者と応援の行き先を聞く（開いたとき・押したとき・1分ごと）
  const tapKey = JSON.stringify(mine);
  useEffect(() => {
    let alive = true;
    const ask = () =>
      fetchHelpHouse()
        .then((r) => alive && setHelp({ ...r, n: doneCount }))
        .catch(() => alive && setHelp((h) => ({ house: null, forecast: true, done: [], members: h?.members ?? {}, n: doneCount })));
    void ask();
    const t = setInterval(ask, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [doneCount, tapKey]);

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
  /** 選べるハウス：収穫するハウスのうち、まだ終わっていないハウス（今の指示のハウスと、自分の入っていない「応援なし」のハウスは除く） */
  const choices = harvestHouses(template).filter(
    (h) =>
      !NO_HARVEST.includes(usageOf(h)) &&
      h !== target &&
      mine[h]?.end == null &&
      !(others?.done ?? []).includes(h) &&
      !((cfg?.noHelp ?? []).includes(h) && !who(h).includes(me.id)),
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
      {preview ? (
        <p className="rounded-xl bg-gray-100 px-3 py-2 text-sm text-gray-600">{me.name} さんの携帯に出ている画面です（ここでは見るだけで、押せません）</p>
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
            disabled={preview || busy || inNow}
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
          <button
            disabled={preview || busy || (!inNow && (isHelp || isChosen))}
            onClick={() => void run(() => tapOut(target))}
            className={`${big} bg-berry text-white`}
          >
            終わった
          </button>
        </>
      )}
      {error && <p className="text-red-600">保存できませんでした：{error}</p>}
      {last && (
        <button disabled={preview || busy} onClick={() => void run(undo)} className="block w-full text-center text-sm text-gray-500 underline">
          まちがえて押したとき（{last.house}番の「{last.kind === "in" ? "入った" : "終わった"}」を取り消す）
        </button>
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
  startOf,
}: {
  date: string;
  template: HaichiTemplate;
  haichi: HaichiDay;
  use: HouseUseMap;
  members: ShiftMember[];
  rec: HarvestDoc;
  /** ハウス → 終わる予測（分。収穫終了の予測から） */
  houseEnd: Record<string, number>;
  /** そのハウスの「入った」（予定の開始時刻もふくむ） */
  startOf: (h: string) => number | null;
}) {
  const taps = useDayTaps(date);
  const [help, setHelp] = useState<HelpInfo | null>(null);
  // 応援の行き先を聞く（1分ごと）
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
  }, []);
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

  const rows = people.map((m) => {
    if (m.uid) {
      // ログインのある人：携帯の画面と同じ決め方
      const st = tapStateOf({ plan, template, use, taps, meId: m.id, edited });
      const h = st.current;
      const text = st.inNow
        ? `${h}番を収穫中`
        : h
          ? st.pos === 0 && st.doneCount === 0
            ? `今日は${h}番から`
            : `次は${h}番`
          : st.free
            ? help?.house
              ? `応援：${help.house}番`
              : "おわり"
            : "予定なし";
      return { m, text, help: !st.inNow && !h && st.free && !!help?.house, house: st.inNow ? h : null, start: st.inNow ? (st.mine[h!]?.start ?? null) : null };
    }
    // ログインのない人：収穫管理の記録から（集荷係が入れた時刻）
    const st = tapStateOf({ plan, template, use, taps: {}, meId: m.id, edited });
    const h = st.planned.find((x) => rec[x]?.end == null) ?? null;
    const inNow = h != null && rec[h]?.start != null;
    const text = h ? (inNow ? `${h}番を収穫中` : `次は${h}番`) : "おわり";
    return { m, text: `${text}（ログインなし）`, help: false, house: inNow ? h : null, start: inNow ? (rec[h!]?.start ?? startOf(h!)) : null };
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
      <p className="mt-2 text-xs text-gray-500">
        「いまの指示」は、その人の収穫報告の画面に出ている指示です（1分ごとに読み直します）。「終わる予測」は、いま収穫しているハウスが、いまの人数のままで終わる予測です。
        「ほかのハウスに行く」で選んで、まだ「入った」を押していないときは、元の指示のまま出ます。
      </p>
    </div>
  );
}
