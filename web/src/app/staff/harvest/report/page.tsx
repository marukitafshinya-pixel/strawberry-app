"use client";

// 収穫の実績（管理者だけ）：期間を決めて、人別・ハウス別の収穫ケース数と1ケースあたりの時間、ハウスの使い方のカレンダーを見る
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { addDays, formatJa, todayJST, weekday } from "@/lib/date";
import { useHaichiTemplate } from "@/lib/haichi";
import {
  addHouse,
  clock,
  emptyTally,
  fmtCases,
  groupOf,
  harvestHouses,
  HOUSE_USES,
  houseUseOf,
  perCase,
  perCaseText,
  saveHouseGroups,
  useHarvestRange,
  useHarvestConfig,
  saveHarvestPlants,
  useHouseUseRange,
  type HarvestDoc,
  type ForecastHouses,
  type HarvestBreak,
  DEFAULT_BREAK,
  type HouseGroup,
  type HouseUseMap,
  type Tally,
} from "@/lib/harvest";
import { useHarvestEnds, useHarvestSpeeds, useHarvestYield, type HarvestSpeeds } from "@/lib/harvestForecast";
import { useShiftMembers } from "@/lib/shift";
import { ReviewTab } from "./Review";
import { callFunction } from "@/lib/callFunction";
import { useWeatherMonths, type WeatherDay } from "@/lib/weather";
import {
  dayStats,
  nightLow,
  pollGoveeNow,
  readingAt,
  READS_PER_DAY,
  saveGoveeHouses,
  saveGoveeKey,
  sensorFor,
  useGoveeConfig,
  useHouseTemps,
  type GoveeConfig,
} from "@/lib/govee";
import { LineChart, NEUTRAL, SERIES_COLORS, Legend, TimeScrollChart } from "@/components/charts";
import { errorText } from "@/lib/callFunction";

type Tab = "people" | "houses" | "calendar" | "forecast" | "temp" | "review";

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => addDays(`${addDays(`${d.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);

export default function HarvestReportPage() {
  const { role } = useAuth();
  const today = todayJST();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<Tab>("people");
  const data = useHarvestRange(from, to);
  // 日ごとの休憩（収穫の時間から抜く）
  const meta = useHarvestEnds(from, to);
  const breaks = Object.fromEntries(Object.entries(meta ?? {}).map(([d, v]) => [d, v.brk ?? DEFAULT_BREAK]));
  const use = useHouseUseRange(from, to);
  const members = useShiftMembers();
  const cfg = useHarvestConfig();
  const groups = cfg?.groups ?? null;
  const template = useHaichiTemplate();

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  const lastMonth = addDays(monthStart(today), -1);
  const presets: [string, string, string][] = [
    ["今月", monthStart(today), today],
    ["先月", monthStart(lastMonth), monthEnd(lastMonth)],
    ["今年", `${today.slice(0, 4)}-01-01`, today],
  ];
  const ready = data && meta && use && members && groups && template;

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        <span className="mx-2 text-gray-300">|</span>
        <Link href="/staff/harvest/" className="text-gray-500 underline">
          ← 収穫管理（入力）
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">📊 収穫の実績</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="rounded-lg border px-3 py-2" />
        〜
        <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="rounded-lg border px-3 py-2" />
        {presets.map(([label, f, t]) => (
          <button
            key={label}
            onClick={() => {
              setFrom(f);
              setTo(t);
            }}
            className={`rounded-lg border px-3 py-2 text-sm ${from === f && to === t ? "border-berry bg-rose-50 font-bold text-berry" : "bg-white"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-1 overflow-x-auto border-b">
        {(
          [
            ["people", "人別"],
            ["houses", "ハウス別"],
            ["calendar", "ハウスの使い方カレンダー"],
            ["forecast", "予測と実際"],
            ["temp", "ハウスの温度"],
            ["review", "振り返り"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`shrink-0 whitespace-nowrap rounded-t-lg px-4 py-2 ${tab === k ? "border border-b-white bg-white font-bold" : "text-gray-500"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {from > to ? (
        <p className="mt-4 text-red-600">期間のはじめと終わりが逆になっています</p>
      ) : !ready ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : tab === "people" ? (
        <People data={data} breaks={breaks} names={new Map(members.map((m) => [m.id, m.name]))} groups={groups} />
      ) : tab === "forecast" ? (
        <ForecastTab from={from} to={to} data={data} houses={harvestHouses(template)} names={new Map(members.map((m) => [m.id, m.name]))} />
      ) : tab === "review" ? (
        <ReviewTab data={data} meta={meta} houses={harvestHouses(template)} groups={groups} members={members} use={use} />
      ) : tab === "temp" ? (
        <HouseTempTab from={from} to={to} houses={harvestHouses(template)} groups={groups} />
      ) : tab === "houses" ? (
        <Houses data={data} breaks={breaks} houses={harvestHouses(template)} />
      ) : (
        <Calendar from={from} to={to} data={data} use={use} houses={harvestHouses(template)} />
      )}
      {ready && <GroupSetting groups={groups} houses={harvestHouses(template)} />}
      {ready && cfg && <PlantsSetting plants={cfg.plants} houses={harvestHouses(template)} />}
      {ready && <GoveeSetting houses={harvestHouses(template)} />}
    </>
  );
}

const rate = (t: Tally) => perCaseText(perCase(t));
const hours = (min: number) => (min ? clock(Math.round(min)) : "");

/** 人別：合計と、ハウスのまとまりごとの1ケースあたりの分 */
function People({
  data,
  breaks,
  names,
  groups,
}: {
  data: Record<string, HarvestDoc>;
  breaks: Record<string, HarvestBreak>;
  names: Map<string, string>;
  groups: HouseGroup[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const all = new Map<string, Tally>();
  const byGroup = new Map<string, Map<string, Tally>>();
  const byHouse = new Map<string, Map<string, Tally>>();
  const at = <K,>(m: Map<K, Tally>, k: K) => {
    if (!m.has(k)) m.set(k, emptyTally());
    return m.get(k)!;
  };
  for (const [date, day] of Object.entries(data))
    for (const [house, h] of Object.entries(day)) {
      const ms = h.members ?? [];
      // ケースは1人だけで収穫したハウスの分だけ、その人に数える（共同のハウスは数だけ数える）
      const cases = ms.length === 1 ? (h.cases ?? 0) : 0;
      for (const m of ms) {
        addHouse(at(all, m), h, date, cases, breaks[date]);
        const mg = byGroup.get(m) ?? new Map<string, Tally>();
        byGroup.set(m, mg);
        addHouse(at(mg, groupOf(groups, house)), h, date, cases, breaks[date]);
        const mh = byHouse.get(m) ?? new Map<string, Tally>();
        byHouse.set(m, mh);
        addHouse(at(mh, house), h, date, cases, breaks[date]);
      }
    }
  const groupNames = [...groups.map((g) => g.name), "その他"].filter((g) => [...byGroup.values()].some((m) => m.has(g)));
  const list = [...all].sort((a, b) => b[1].cases - a[1].cases);
  if (!list.length) return <p className="mt-4 text-gray-500">この期間の収穫の記録はありません。</p>;
  return (
    <>
      <p className="mt-3 text-sm text-gray-600">
        「ケース」「時間」「1ケース」は、1人だけで収穫したハウスの分です（途中で応援が入ったハウスは「共同」の数だけ数えます）。名前を押すと、ハウスごとに見られます。
      </p>
      <div className="mt-2 overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2">名前</th>
              <th className="px-3 py-2 text-right">日数</th>
              <th className="px-3 py-2 text-right">ケース</th>
              <th className="px-3 py-2 text-right">時間</th>
              <th className="px-3 py-2 text-right">1ケース</th>
              <th className="px-3 py-2 text-right">共同</th>
              {groupNames.map((g) => (
                <th key={g} className="px-3 py-2 text-right">
                  {g}
                  <span className="block font-normal">ケース／1ケース</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(([id, t]) => (
              <Fragment key={id}>
                <tr className="cursor-pointer border-t hover:bg-sky-50" onClick={() => setOpen(open === id ? null : id)}>
                  <td className="px-3 py-2 font-bold">
                    {open === id ? "▼" : "▶"} {names.get(id) ?? "（いない人）"}
                  </td>
                  <td className="px-3 py-2 text-right">{t.days.size}日</td>
                  <td className="px-3 py-2 text-right font-bold">{fmtCases(t.cases)}</td>
                  <td className="px-3 py-2 text-right">{hours(t.minutes)}</td>
                  <td className="px-3 py-2 text-right font-bold text-sky-800">{rate(t)}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{t.shared ? `${t.shared}棟` : ""}</td>
                  {groupNames.map((g) => {
                    const x = byGroup.get(id)?.get(g);
                    return (
                      <td key={g} className="px-3 py-2 text-right">
                        {x ? `${fmtCases(x.cases)}／${rate(x) || "－"}` : ""}
                      </td>
                    );
                  })}
                </tr>
                {open === id &&
                  [...(byHouse.get(id) ?? [])]
                    .sort((a, b) => a[0].localeCompare(b[0], "ja", { numeric: true }))
                    .map(([h, x]) => (
                      <tr key={h} className="bg-sky-50/50 text-gray-700">
                        <td className="px-3 py-1 pl-8">No.{h}</td>
                        <td className="px-3 py-1 text-right">{x.days.size}日</td>
                        <td className="px-3 py-1 text-right">{fmtCases(x.cases)}</td>
                        <td className="px-3 py-1 text-right">{hours(x.minutes)}</td>
                        <td className="px-3 py-1 text-right">{rate(x)}</td>
                        <td className="px-3 py-1 text-right text-gray-500">{x.shared ? `${x.shared}棟` : ""}</td>
                        <td colSpan={groupNames.length} />
                      </tr>
                    ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** ハウス別：まとまりごとの小計つき */
function Houses({ data, breaks, houses }: { data: Record<string, HarvestDoc>; breaks: Record<string, HarvestBreak>; houses: string[] }) {
  const byHouse = new Map<string, Tally>();
  for (const [date, day] of Object.entries(data))
    for (const [house, h] of Object.entries(day)) {
      if (!h.cases) continue;
      if (!byHouse.has(house)) byHouse.set(house, emptyTally());
      addHouse(byHouse.get(house)!, h, date, undefined, breaks[date]);
    }
  const all = [...new Set([...houses, ...byHouse.keys()])];
  const total = emptyTally();
  for (const t of byHouse.values()) {
    total.cases += t.cases;
    total.minutes += t.minutes;
    total.timedCases += t.timedCases;
    t.days.forEach((d) => total.days.add(d));
  }
  const line = (label: string, t: Tally | undefined, cls = "") => (
    <tr key={label} className={`border-t ${cls}`}>
      <td className="px-3 py-2">{label}</td>
      <td className="px-3 py-2 text-right">{t?.days.size ? `${t.days.size}日` : ""}</td>
      <td className="px-3 py-2 text-right font-bold">{t ? fmtCases(t.cases) : ""}</td>
      <td className="px-3 py-2 text-right">{t ? hours(t.minutes) : ""}</td>
      <td className="px-3 py-2 text-right text-sky-800">{t ? rate(t) : ""}</td>
    </tr>
  );
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border bg-white">
      <table className="w-full min-w-max text-sm tabular-nums">
        <thead className="bg-gray-50 text-left text-xs text-gray-600">
          <tr>
            <th className="px-3 py-2">ハウス</th>
            <th className="px-3 py-2 text-right">収穫した日数</th>
            <th className="px-3 py-2 text-right">ケース</th>
            <th className="px-3 py-2 text-right">時間（1人で収穫した分）</th>
            <th className="px-3 py-2 text-right">1ケース</th>
          </tr>
        </thead>
        <tbody>
          {/* 収穫管理の画面と同じ並び（作業配置表の収穫の枠の順）。まとまりごとの小計は出さない */}
          {all.map((h) => line(`No.${h}`, byHouse.get(h)))}
          {line("合計", total, "border-t-2 bg-rose-50 font-bold")}
        </tbody>
      </table>
    </div>
  );
}

/** ハウス × 日付：色はハウスの使い方、数字はその日の収穫ケース */
function Calendar({
  from,
  to,
  data,
  use,
  houses,
}: {
  from: string;
  to: string;
  data: Record<string, HarvestDoc>;
  use: { days: Record<string, HouseUseMap>; before: HouseUseMap };
  houses: string[];
}) {
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  // その日の使い方（記録がない日は前の日の状態のまま）
  const state: Record<string, HouseUseMap> = {};
  let cur = use.before;
  for (const d of dates) {
    cur = use.days[d] ?? cur;
    state[d] = cur;
  }
  const cases = (d: string, h: string) => data[d]?.[h]?.cases ?? 0;
  /** いちご狩り（半分も）に使った日数 */
  const pickingDays = (h: string) => dates.filter((d) => ["picking", "half", "halfBack", "reserve"].includes(state[d][h] ?? "harvest")).length;
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {HOUSE_USES.map((u) => (
          <span key={u.key} className={`rounded border px-2 py-0.5 ${u.cls}`}>
            {u.short}＝{u.label}
          </span>
        ))}
        <span className="text-gray-500">マスの数字はその日の収穫ケース。記録がない日は前の日の使い方のまま。</span>
      </div>
      <div className="mt-2 overflow-x-auto rounded-xl border bg-white">
        <table className="border-collapse text-xs tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white px-2 py-1 text-left">ハウス</th>
              <th className="px-2 py-1">狩りの日数</th>
              {dates.map((d) => (
                <th key={d} className={`min-w-9 px-1 py-1 font-normal ${weekday(d) === "日" ? "text-red-600" : weekday(d) === "土" ? "text-blue-700" : ""}`}>
                  {Number(d.slice(8))}
                  <span className="block">{weekday(d)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 収穫管理の画面と同じ並び（作業配置表の収穫の枠の順） */}
            {houses.map((h) => (
              <tr key={h}>
                <td className="sticky left-0 z-10 bg-white px-2 py-1 font-bold">No.{h}</td>
                <td className="px-2 py-1 text-center">{pickingDays(h) || ""}</td>
                {dates.map((d) => {
                  const u = houseUseOf(state[d][h]);
                  const c = cases(d, h);
                  return (
                    <td
                      key={d}
                      title={`${formatJa(d)} No.${h}：${u.label}${c ? `・${fmtCases(c)}ケース` : ""}`}
                      className={`border border-white px-1 py-1 text-center ${u.cls}`}
                    >
                      {c ? fmtCases(c) : u.key === "harvest" ? "" : u.short}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** ハウスのまとまりの設定（1行に1つ：「名前：ハウス,ハウス」） */
function GroupSetting({ groups, houses }: { groups: HouseGroup[]; houses: string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const toText = (gs: HouseGroup[]) => gs.map((g) => `${g.name}：${g.houses.join(",")}`).join("\n");
  async function save() {
    const gs: HouseGroup[] = [];
    for (const line of text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      const m = /^(.+?)[：:](.*)$/.exec(line);
      if (!m) return setMsg(`「${line}」は「名前：1,6,8」の形で書いてください`);
      gs.push({
        name: m[1].trim().slice(0, 20),
        houses: m[2]
          .split(/[,、\s]+/)
          .map((h) => h.trim())
          .filter(Boolean),
      });
    }
    try {
      await saveHouseGroups(gs.slice(0, 20));
      setMsg("保存しました");
      setOpen(false);
    } catch {
      setMsg("保存できませんでした");
    }
  }
  return (
    <div className="mt-8 rounded-xl border bg-white p-3 text-sm">
      <button
        onClick={() => {
          setText(toText(groups));
          setOpen(!open);
          setMsg("");
        }}
        className="font-bold text-gray-700"
      >
        {open ? "▼" : "▶"} ハウスのまとまりを変える
      </button>
      {msg && <span className="ml-3">{msg}</span>}
      {open && (
        <div className="mt-2">
          <p className="text-gray-600">
            1行に1つ、「名前：ハウスの番号をカンマで区切る」の形で書きます。ハウスは作業配置表の収穫の枠と同じ番号です（今の枠：{houses.join(",")}）。
          </p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="mt-2 w-full rounded-lg border p-2 font-mono" />
          <button onClick={() => void save()} className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white">
            保存する
          </button>
        </div>
      )}
    </div>
  );
}

/** 予測と実際：日ごとの朝の予測と実際の収穫終了、その差。人ごとの速さ（1,000株あたりの分） */
function ForecastTab({
  from,
  to,
  data,
  houses,
  names,
}: {
  from: string;
  to: string;
  data: Record<string, HarvestDoc>;
  houses: string[];
  names: Map<string, string>;
}) {
  const ends = useHarvestEnds(from, to);
  const [open, setOpen] = useState<string | null>(null);
  const speeds = useHarvestSpeeds();
  const yld = useHarvestYield();
  // 振り返りに使う気象データ（日照時間・夜温）を集めてもらう（足りない分だけ。気象庁のサイトに負担をかけないよう少しずつ）
  useEffect(() => {
    callFunction("refreshHarvestWeather", {}).catch(() => {});
  }, []);
  const weather = useWeatherMonths(addDays(from, -1).slice(0, 7), to.slice(0, 7));
  const temps = useHouseTemps(from, to);
  /** ハウスの中の夜温：その夜にいちばん低かったハウスの温度 */
  const houseLow = (d: string) => {
    let best: { house: string; temp: number; at: string } | null = null;
    for (const [house, list] of Object.entries(temps?.[d] ?? {})) {
      const m = nightLow(list);
      if (m && (best == null || m.temp < best.temp)) best = { house, ...m };
    }
    return best;
  };
  if (!ends || !speeds) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  const wOf = (d: string): WeatherDay | undefined => weather?.find((m) => m.month === d.slice(0, 7))?.days[d.slice(8, 10)];
  const total = (d: string) => Object.values(data[d] ?? {}).reduce((n, h) => n + (h.cases ?? 0), 0);
  const days = Object.entries(ends)
    .filter(([d, v]) => v.forecast != null || v.endTime != null || v.casesForecast != null || total(d) > 0)
    .sort((a, b) => b[0].localeCompare(a[0]));
  const diffs = days.filter(([, v]) => v.forecast != null && v.endTime != null).map(([, v]) => v.endTime! - v.forecast!);
  const avgAbs = diffs.length ? diffs.reduce((n, d) => n + Math.abs(d), 0) / diffs.length : null;
  const sign = (d: number) => (d === 0 ? "ぴったり" : d > 0 ? `${d}分おそい` : `${-d}分はやい`);
  // 収穫ケース数：朝の見込みと実際の差（割合）
  /** 収穫が終わった日か（今日は収穫終了を入れるまで、ケース数がまだ増える） */
  const closed = (d: string, v: { endTime: number | null }) => d < todayJST() || v.endTime != null;
  const caseDiffs = days.filter(([d, v]) => v.casesForecast != null && total(d) > 0 && closed(d, v)).map(([d, v]) => (total(d) - v.casesForecast!) / total(d));
  const caseAvg = caseDiffs.length ? (caseDiffs.reduce((n, d) => n + Math.abs(d), 0) / caseDiffs.length) * 100 : null;
  const caseSign = (d: string, f: number) => {
    const x = Math.round(total(d) - f);
    return x === 0 ? "ぴったり" : x > 0 ? `${x}ケース多い` : `${-x}ケース少ない`;
  };
  return (
    <>
      <p className="mt-3 text-sm text-gray-600">
        「夜温（外）」は、その日の朝までの夜（前の日の18時〜9時）でいちばん低かった外の気温、「夜温（ハウス）」は温度計（Govee）のあるハウスでいちばん低かった温度、「前日の日照」は前の日の日照時間です（気象庁のアメダス「美瑛」）。
        「ケースの朝の見込み」は、最近7日のまとまりごとの「1,000株あたりのケース数」×その日に収穫する株数です。記録が14日分たまると、夜温と前の日の日照の影響（ふだんより多い・少ない）も計算に入ります。収穫が始まると、収穫管理の画面の予測は、終わったハウスの実際のケース数で直していきます。
      </p>
      <p className="mt-1 text-sm text-gray-600">
        「朝の予測」は、収穫の開始時刻までの予測です（開始時刻を過ぎてから開いた日は、最初の予測）。日付を押すと、ハウスごとの予測と実際が見られます。人ごとの速さは、最近の記録（1人で収穫したハウス）から毎日計算し直すので、記録がたまるほど予測が合ってきます。
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <div className="rounded-xl border bg-white p-3">
          <p className="text-xs text-gray-500">予測と実際の差（平均）</p>
          <p className="text-2xl font-bold text-sky-800">{avgAbs == null ? "－" : `${Math.round(avgAbs)}分`}</p>
          <p className="text-xs text-gray-500">{diffs.length}日分</p>
        </div>
        <div className="rounded-xl border bg-white p-3">
          <p className="text-xs text-gray-500">ケース数の朝の見込みと実際の差（平均）</p>
          <p className="text-2xl font-bold text-sky-800">{caseAvg == null ? "－" : `${Math.round(caseAvg)}%`}</p>
          <p className="text-xs text-gray-500">{caseDiffs.length}日分</p>
        </div>
        <div className="rounded-xl border bg-white p-3">
          <p className="text-xs text-gray-500">今日の見込みの天気の影響</p>
          {yld?.model ? (
            <>
              <p className="text-2xl font-bold text-sky-800">ふだんの×{yld.factor.toFixed(2)}</p>
              <p className="text-xs text-gray-500">
                夜温 {yld.nightMin != null ? `${yld.nightMin.toFixed(1)}℃` : "－"}・前日の日照 {yld.sun != null ? `${yld.sun.toFixed(1)}時間` : "－"}（
                {yld.prior ? `去年（${yld.prior.season}）の出荷${yld.prior.n}回分と、今年の${yld.model.n}日分から` : `${yld.model.n}日分の記録から`}）
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-bold text-gray-400">まだ計算していません</p>
              <p className="text-xs text-gray-500">夜温・日照のそろった収穫の記録が14日分たまると入ります</p>
            </>
          )}
          <Link href="/staff/harvest/past/" className="mt-1 inline-block text-xs text-sky-700 underline">
            去年の出荷実績から天気の影響を出す
          </Link>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-xl border bg-white">
        <table className="w-full min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2">日付</th>
              <th className="px-3 py-2 text-right">朝の予測</th>
              <th className="px-3 py-2 text-right">実際の収穫終了</th>
              <th className="px-3 py-2 text-right">差</th>
              <th className="px-3 py-2 text-right">ケースの朝の見込み</th>
              <th className="px-3 py-2 text-right">収穫ケース</th>
              <th className="px-3 py-2 text-right">ケースの差</th>
              <th className="px-3 py-2 text-right">夜温（外）</th>
              <th className="px-3 py-2 text-right">夜温（ハウス）</th>
              <th className="px-3 py-2 text-right">前日の日照</th>
            </tr>
          </thead>
          <tbody>
            {days.map(([d, v]) => (
              <Fragment key={d}>
                <tr className="cursor-pointer border-t hover:bg-sky-50" onClick={() => setOpen(open === d ? null : d)}>
                  <td className="px-3 py-2">
                    {v.forecastHouses ? (open === d ? "▼ " : "▶ ") : ""}
                    {formatJa(d)}
                  </td>
                  <td className="px-3 py-2 text-right">{clock(v.forecast)}</td>
                  <td className="px-3 py-2 text-right font-bold">{clock(v.endTime)}</td>
                  <td className="px-3 py-2 text-right">{v.forecast != null && v.endTime != null ? sign(v.endTime - v.forecast) : ""}</td>
                  <td className="px-3 py-2 text-right">{v.casesForecast != null ? fmtCases(v.casesForecast) : ""}</td>
                  <td className="px-3 py-2 text-right font-bold">{total(d) > 0 ? fmtCases(total(d)) : ""}</td>
                  <td className="px-3 py-2 text-right">{v.casesForecast != null && total(d) > 0 && closed(d, v) ? caseSign(d, v.casesForecast) : ""}</td>
                  <td className="px-3 py-2 text-right">
                    {wOf(d)?.nightMin != null ? (
                      <>
                        {wOf(d)!.nightMin!.toFixed(1)}℃<span className="ml-1 text-xs text-gray-500">{wOf(d)!.nightMinAt}</span>
                      </>
                    ) : (
                      "－"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {houseLow(d) ? (
                      <>
                        {houseLow(d)!.temp.toFixed(1)}℃
                        <span className="ml-1 text-xs text-gray-500">
                          No.{houseLow(d)!.house} {houseLow(d)!.at}
                        </span>
                      </>
                    ) : (
                      "－"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{wOf(addDays(d, -1))?.sun != null ? `${wOf(addDays(d, -1))!.sun!.toFixed(1)}時間` : "－"}</td>
                </tr>
                {open === d && (
                  <tr>
                    <td colSpan={10} className="bg-sky-50/40 px-3 py-2">
                      {temps?.[d] && Object.keys(temps[d]).length > 0 && (
                        <p className="mb-2 text-xs text-gray-700">
                          ハウスの中の夜温（いちばん低かった温度）：
                          {houses
                            .filter((h) => temps[d][h])
                            .map((h) => {
                              const m = nightLow(temps[d][h]);
                              return m ? `No.${h} ${m.temp.toFixed(1)}℃（${m.at}）` : "";
                            })
                            .filter(Boolean)
                            .join("、")}
                        </p>
                      )}
                      {v.forecastHouses ? (
                        <HouseForecastTable fh={v.forecastHouses} rec={data[d] ?? {}} houses={houses} names={names} />
                      ) : (
                        <p className="text-xs text-gray-500">この日は、ハウスごとの予測の記録がありません（記録を始める前の日です）。</p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!days.length && (
              <tr>
                <td colSpan={10} className="px-3 py-4 text-center text-gray-500">
                  この期間の予測の記録はまだありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <SpeedTable speeds={speeds} names={names} />
    </>
  );
}

/** その日のハウスごとの、朝の予測と実際（どのハウス・だれの所でずれたかを見る） */
function HouseForecastTable({ fh, rec, houses, names }: { fh: ForecastHouses; rec: HarvestDoc; houses: string[]; names: Map<string, string> }) {
  const list = [...houses.filter((h) => fh[h] || rec[h]?.end != null), ...Object.keys(fh).filter((h) => !houses.includes(h))];
  const diff = (d: number | null) => (d == null ? "" : d === 0 ? "±0" : d > 0 ? `＋${d}分` : `−${-d}分`);
  const color = (d: number | null) => (d == null ? "" : d >= 15 ? "font-bold text-red-700" : d <= -15 ? "font-bold text-sky-700" : "");
  return (
    <table className="w-full min-w-max text-xs tabular-nums">
      <thead className="text-left text-gray-500">
        <tr>
          <th className="px-2 py-1">ハウス</th>
          <th className="px-2 py-1">収穫者</th>
          <th className="px-2 py-1">朝の予測</th>
          <th className="px-2 py-1">実際</th>
          <th className="px-2 py-1 text-right">終わりの差</th>
          <th className="px-2 py-1 text-right">かかった時間の差</th>
        </tr>
      </thead>
      <tbody>
        {list.map((h) => {
          const p = fh[h];
          const r = rec[h] ?? {};
          const endDiff = p && r.end != null ? r.end - p.end : null;
          const durDiff = p && p.start != null && r.start != null && r.end != null ? r.end - r.start - (p.end - p.start) : null;
          return (
            <tr key={h} className="border-t border-sky-100">
              <td className="px-2 py-1 font-bold">No.{h}</td>
              <td className="px-2 py-1">{(r.members ?? p?.members ?? []).map((m) => names.get(m) ?? "？").join("・")}</td>
              <td className="px-2 py-1">{p ? `${clock(p.start)}〜${clock(p.end)}` : "－"}</td>
              <td className="px-2 py-1">{r.start != null || r.end != null ? `${clock(r.start)}〜${clock(r.end)}` : "－"}</td>
              <td className={`px-2 py-1 text-right ${color(endDiff)}`}>{diff(endDiff)}</td>
              <td className={`px-2 py-1 text-right ${color(durDiff)}`}>{diff(durDiff)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 人ごとの速さ（最近の記録から） */
function SpeedTable({ speeds, names }: { speeds: HarvestSpeeds; names: Map<string, string> }) {
  const list = Object.entries(speeds.speeds).sort((a, b) => a[1] - b[1]);
  return (
    <div className="mt-4 rounded-xl border bg-white p-3 text-sm">
      <h3 className="font-bold">人ごとの速さ（1,000株あたりの分・最近の記録から）</h3>
      <p className="text-xs text-gray-500">全員の平均：{speeds.avg == null ? "まだ記録がありません" : `${speeds.avg}分`}。数字が小さいほど速い人です。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {list.map(([id, v]) => (
          <span key={id} className="rounded-lg border px-2 py-1 tabular-nums">
            {names.get(id) ?? "（いない人）"} <b>{v}分</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** ハウスの株数（ハウスの大きさ。予測に使う） */
/** 温度の動き：1画面の長さ・まとめる間隔・読む日数・目盛りの間隔 */
const TREND = {
  day: { label: "24時間", windowMs: 24 * 3600_000, bucketMs: 20 * 60_000, days: 14, tickMs: 3 * 3600_000 },
  week: { label: "1週間", windowMs: 7 * 86400_000, bucketMs: 3600_000, days: 56, tickMs: 86400_000 },
  month: { label: "1か月", windowMs: 30 * 86400_000, bucketMs: 6 * 3600_000, days: 120, tickMs: 5 * 86400_000 },
} as const;
type TrendMode = keyof typeof TREND;
const jstOf = (t: number) => new Date(t + 9 * 3600_000);
const md = (t: number) => `${jstOf(t).getUTCMonth() + 1}/${jstOf(t).getUTCDate()}`;
const hm = (t: number) => jstOf(t).toISOString().slice(11, 16);

/** 温度の動き（右はしが今。左へ動かすと過去）。24時間・1週間・1か月を切り替える。長い表示はまとめて平均する */
function TempTrend({ series }: { series: { key: string; label: string; color: string }[] }) {
  const [mode, setMode] = useState<TrendMode>("day");
  const m = TREND[mode];
  const today = todayJST();
  const temps = useHouseTemps(addDays(today, -m.days), addDays(today, 1));
  const [now] = useState(() => Date.now());
  const from = now - m.days * 86400_000;
  // 温度計ごとに、まとめる間隔で平均する
  const buckets = new Map<number, Record<string, { sum: number; n: number }>>();
  for (const [date, doc] of Object.entries(temps ?? {}))
    for (const s of series)
      for (const x of doc[s.key] ?? []) {
        const at = readingAt(date, x.t);
        if (at < from) continue;
        const b = Math.floor(at / m.bucketMs) * m.bucketMs + (m.bucketMs > 20 * 60_000 ? m.bucketMs / 2 : 0);
        const cell = (buckets.get(b) ?? buckets.set(b, {}).get(b)!)[s.key] ?? { sum: 0, n: 0 };
        cell.sum += x.temp;
        cell.n += 1;
        buckets.get(b)![s.key] = cell;
      }
  const rows = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, values: Object.fromEntries(Object.entries(v).map(([k, c]) => [k, Math.round((c.sum / c.n) * 10) / 10])) }));
  return (
    <section className="mt-3 rounded-xl border bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold">温度の動き</h2>
        <div className="flex overflow-hidden rounded-lg border text-sm">
          {(Object.keys(TREND) as TrendMode[]).map((k) => (
            <button key={k} onClick={() => setMode(k)} className={`px-3 py-1 ${mode === k ? "bg-berry font-bold text-white" : "bg-white"}`}>
              {TREND[k].label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">
          右はしが今です。左へ動かすと前の日が見られます{mode !== "day" ? `（${mode === "week" ? "1時間" : "6時間"}ごとの平均）` : ""}。
        </span>
      </div>
      <div className="mt-1">
        <Legend series={series} />
      </div>
      {temps === null ? (
        <p className="py-10 text-center text-gray-500">読み込み中…</p>
      ) : (
        <TimeScrollChart
          rows={rows}
          series={series}
          from={from}
          to={now}
          windowMs={m.windowMs}
          bucketMs={m.bucketMs}
          tickMs={m.tickMs}
          tickLabel={(t) => (mode === "day" ? (hm(t) === "00:00" ? md(t) : hm(t)) : md(t))}
          pointLabel={(t) => (mode === "month" ? `${md(t)} ${hm(t - m.bucketMs / 2)}〜${hm(t + m.bucketMs / 2)}` : `${md(t)} ${hm(t)}`)}
          unit="℃"
        />
      )}
    </section>
  );
}

type TempKind = "min" | "avg" | "max";
const TEMP_KINDS: { key: TempKind; label: string }[] = [
  { key: "min", label: "最低" },
  { key: "avg", label: "平均" },
  { key: "max", label: "最高" },
];
/** 平均・最高を出すのに足りる読めた回数（24時間の4分の3） */
const ENOUGH = Math.round(READS_PER_DAY * 0.75);

/** ハウスの温度：温度計ごとの温度のグラフと、ハウスごとに使う温度計・その日の最低・平均・最高 */
function HouseTempTab({ from, to, houses, groups }: { from: string; to: string; houses: string[]; groups: HouseGroup[] }) {
  const temps = useHouseTemps(from, to);
  const weather = useWeatherMonths(addDays(from, -1).slice(0, 7), to.slice(0, 7));
  const [pick, setPick] = useState<string | null>(null);
  const [kind, setKind] = useState<TempKind>("min");
  if (!temps) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  const days = Object.keys(temps)
    .filter((d) => Object.keys(temps[d]).length > 0)
    .sort();
  if (!days.length) return <p className="mt-4 text-gray-500">この期間のハウスの温度の記録はまだありません（温度計の記録は20分ごとです）。</p>;
  const day = pick && days.includes(pick) ? pick : days[days.length - 1];
  // 温度計のあるハウス（作業配置表の順）。色はハウスごとに固定
  const sensorHouses = [...new Set(days.flatMap((d) => Object.keys(temps[d])))].sort((a, b) => houses.indexOf(a) - houses.indexOf(b));
  const series = sensorHouses.slice(0, SERIES_COLORS.length).map((h, i) => ({ key: h, label: `No.${h}`, color: SERIES_COLORS[i] }));
  const wOf = (d: string) => weather?.find((m) => m.month === d.slice(0, 7))?.days[d.slice(8, 10)];
  // 外の気温：最低＝その朝までの夜温、平均・最高＝前の日の値（気象庁アメダス「美瑛」）
  const outside = { key: "out", label: kind === "min" ? "外（夜温）" : "外（前日）", color: NEUTRAL };
  const outOf = (d: string) => (kind === "min" ? wOf(d)?.nightMin : kind === "avg" ? wOf(addDays(d, -1))?.tAvg : wOf(addDays(d, -1))?.tMax) ?? null;
  const pickOf = (st: ReturnType<typeof dayStats>) => {
    if (!st) return null;
    if (kind === "min") return st.min.temp;
    if (st.n < ENOUGH) return null; // 読めた回数が少ない日は、平均・最高を出さない
    return kind === "avg" ? st.avg : st.max.temp;
  };
  const g = (h: string) => groupOf(groups, h);

  const dailyRows = days.map((d) => ({
    key: d,
    label: `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`,
    values: { ...Object.fromEntries(series.map((s) => [s.key, pickOf(dayStats(temps[d][s.key]))])), out: outOf(d) },
  }));
  const available = Object.keys(temps[day]).filter((h) => (temps[day][h] ?? []).length > 0);
  return (
    <>
      <p className="mt-3 text-sm text-gray-600">
        日付ごとに、<b>前の日の9時すぎ〜その日の朝9時の24時間</b>（その日の収穫の前の24時間）の温度を、最低・平均・最高で出します。温度計のないハウスは、
        <b>同じまとまりの中で番号がいちばん近い温度計</b>の温度を使います（まとまりに温度計がない・その日に読めなかったときは、全体でいちばん近い温度計）。
      </p>
      <section className="mt-3 rounded-xl border bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold">日ごとの温度</h2>
          <div className="flex overflow-hidden rounded-lg border text-sm">
            {TEMP_KINDS.map((k) => (
              <button key={k.key} onClick={() => setKind(k.key)} className={`px-3 py-1 ${kind === k.key ? "bg-berry font-bold text-white" : "bg-white"}`}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-1">
          <Legend series={[...series, outside]} />
        </div>
        <LineChart rows={dailyRows} series={[...series, outside]} unit="℃" />
        {kind !== "min" && (
          <p className="text-xs text-gray-500">平均・最高は、24時間のうち4分の3以上読めた日だけ出します（読めない時間が長いと、平均・最高がずれるため）。</p>
        )}
      </section>
      <TempTrend series={series} />
      <section className="mt-3 overflow-x-auto rounded-xl border bg-white">
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          <h2 className="font-bold">ハウスごとの温度</h2>
          <select value={day} onChange={(e) => setPick(e.target.value)} className="rounded border px-2 py-1 text-sm">
            {[...days].reverse().map((d) => (
              <option key={d} value={d}>
                {formatJa(d)} の朝までの24時間
              </option>
            ))}
          </select>
        </div>
        <table className="mt-2 w-full min-w-max text-sm tabular-nums">
          <thead className="bg-gray-50 text-left text-xs text-gray-600">
            <tr>
              <th className="px-3 py-2">まとまり</th>
              <th className="px-3 py-2">ハウス</th>
              <th className="px-3 py-2">使う温度計</th>
              <th className="px-3 py-2 text-right">最低</th>
              <th className="px-3 py-2 text-right">平均</th>
              <th className="px-3 py-2 text-right">最高</th>
              <th className="px-3 py-2 text-right">読めた回数</th>
            </tr>
          </thead>
          <tbody>
            {houses.map((h) => {
              const s = sensorFor(h, available, g);
              const st = s ? dayStats(temps[day][s]) : null;
              const few = !!st && st.n < ENOUGH;
              return (
                <tr key={h} className="border-t">
                  <td className="px-3 py-1.5 text-gray-500">{g(h)}</td>
                  <td className="px-3 py-1.5 font-bold">No.{h}</td>
                  <td className="px-3 py-1.5">{s == null ? "－" : s === h ? "このハウス" : `No.${s}`}</td>
                  <td className="px-3 py-1.5 text-right">
                    {st ? (
                      <>
                        {st.min.temp.toFixed(1)}℃<span className="ml-1 text-xs text-gray-500">{st.min.at}</span>
                      </>
                    ) : (
                      "－"
                    )}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${few ? "text-gray-400" : ""}`}>{st ? `${st.avg.toFixed(1)}℃` : "－"}</td>
                  <td className={`px-3 py-1.5 text-right ${few ? "text-gray-400" : ""}`}>
                    {st ? (
                      <>
                        {st.max.temp.toFixed(1)}℃<span className="ml-1 text-xs text-gray-500">{st.max.at}</span>
                      </>
                    ) : (
                      "－"
                    )}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${few ? "text-amber-700" : "text-gray-500"}`}>{st ? `${st.n}/${READS_PER_DAY}` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-3 py-2 text-xs text-gray-500">読めた回数が少ない日（うすい字）は、平均・最高があてになりません（夜だけ記録していた日など）。</p>
      </section>
    </>
  );
}

/** ハウスの中の温度計（Govee）：API キーの登録と、どの温度計がどのハウスか（管理者） */
function GoveeSetting({ houses }: { houses: string[] }) {
  const cfg = useGoveeConfig();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState<Record<string, number | null>>({});
  const [houseOf, setHouseOf] = useState<Record<string, string> | null>(null);
  const cur = houseOf ?? cfg?.houseOf ?? {};
  async function check() {
    setBusy(true);
    setMsg("");
    try {
      const r = await saveGoveeKey(key);
      setKey("");
      setNow(r.now);
      setMsg(`Govee につながりました（温度計 ${r.devices.length}台）`);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(c: GoveeConfig | null | undefined) {
    if (!c) return;
    try {
      await saveGoveeHouses(Object.fromEntries(Object.entries(cur).filter(([d, h]) => h && c.devices.some((x) => x.device === d))));
      setHouseOf(null);
      const r = await pollGoveeNow();
      setMsg(r.saved ? `保存しました。今の温度が ${r.saved}台分 読めました` : "保存しました（今の温度は読めませんでした）");
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  const named = Object.values(cfg?.houseOf ?? {}).filter(Boolean).length;
  return (
    <div className="mt-3 rounded-xl border bg-white p-3 text-sm">
      <button onClick={() => setOpen(!open)} className="font-bold text-gray-700">
        {open ? "▼" : "▶"} ハウスの中の温度計（Govee）{cfg?.keySet ? `（${named}台を記録中）` : "（未登録）"}
      </button>
      {msg && <span className="ml-3">{msg}</span>}
      {open && (
        <div className="mt-2 space-y-3">
          <p className="text-gray-600">
            1日じゅう20分ごとに、温度計の今の温度を読んで残します。API キーは Govee Home アプリの「プロフィール → 設定 → API
            キーを申請」でメールに届きます。キーはサーバーだけが使い、この画面からも読み出せません。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={cfg?.keySet ? "登録ずみ（変えるときだけ入れる）" : "API キーを貼り付け"}
              className="w-72 rounded border px-2 py-1"
            />
            <button
              disabled={busy || (!key && !cfg?.keySet)}
              onClick={() => void check()}
              className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40"
            >
              {busy ? "確認中…" : key ? "登録して確かめる" : "つながるか確かめる"}
            </button>
          </div>
          {cfg && cfg.devices.length > 0 && (
            <div>
              <p className="text-gray-600">温度計ごとに、置いているハウスを選んでください（選ばない温度計は記録しません）。</p>
              <table className="mt-1 text-sm">
                <tbody>
                  {cfg.devices.map((d) => (
                    <tr key={d.device} className="border-t">
                      <td className="py-1 pr-3">
                        {d.name}
                        <span className="ml-1 text-xs text-gray-400">{d.sku}</span>
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        {d.device in now ? (now[d.device] == null ? "読めません" : `${now[d.device]!.toFixed(1)}℃`) : ""}
                      </td>
                      <td className="py-1">
                        <select
                          value={cur[d.device] ?? ""}
                          onChange={(e) => setHouseOf({ ...cur, [d.device]: e.target.value })}
                          className="rounded border px-2 py-1"
                        >
                          <option value="">使わない</option>
                          {houses.map((h) => (
                            <option key={h} value={h}>
                              No.{h}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={() => void save(cfg)} className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white">
                保存する
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlantsSetting({ plants, houses }: { plants: Record<string, number>; houses: string[] }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const total = houses.reduce((n, h) => n + (plants[h] ?? 0), 0);
  async function save() {
    const next: Record<string, number> = {};
    for (const h of houses) {
      const v = Number((edit[h] ?? String(plants[h] ?? "")).replace(/[^0-9]/g, ""));
      if (v > 0) next[h] = v;
    }
    try {
      await saveHarvestPlants(next);
      setMsg("保存しました");
      setOpen(false);
    } catch {
      setMsg("保存できませんでした");
    }
  }
  return (
    <div className="mt-3 rounded-xl border bg-white p-3 text-sm">
      <button
        onClick={() => {
          setEdit({});
          setOpen(!open);
          setMsg("");
        }}
        className="font-bold text-gray-700"
      >
        {open ? "▼" : "▶"} ハウスの株数（合計 {total.toLocaleString("ja-JP")}株）
      </button>
      {msg && <span className="ml-3">{msg}</span>}
      {open && (
        <div className="mt-2">
          <p className="text-gray-600">収穫終了の予測で、ハウスの大きさとして使います。いちご狩り前・後ろの日は、半分の株数で計算します。</p>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {houses.map((h) => (
              <label key={h} className="flex items-center gap-1">
                <span className="w-12 font-bold">No.{h}</span>
                <input
                  value={edit[h] ?? String(plants[h] ?? "")}
                  inputMode="numeric"
                  onChange={(e) => setEdit({ ...edit, [h]: e.target.value })}
                  className="w-20 rounded border px-2 py-1 text-right tabular-nums"
                />
              </label>
            ))}
          </div>
          <button onClick={() => void save()} className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white">
            保存する
          </button>
        </div>
      )}
    </div>
  );
}
