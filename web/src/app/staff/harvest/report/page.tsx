"use client";

// 収穫の実績（管理者だけ）：期間を決めて、人別・ハウス別の収穫ケース数と1ケースあたりの時間、ハウスの使い方のカレンダーを見る
import Link from "next/link";
import { Fragment, useState } from "react";
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
import { useHarvestEnds, useHarvestSpeeds, type HarvestSpeeds } from "@/lib/harvestForecast";
import { useShiftMembers } from "@/lib/shift";

type Tab = "people" | "houses" | "calendar" | "forecast";

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
      <div className="mt-3 flex gap-1 border-b">
        {(
          [
            ["people", "人別"],
            ["houses", "ハウス別"],
            ["calendar", "ハウスの使い方カレンダー"],
            ["forecast", "予測と実際"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-t-lg px-4 py-2 ${tab === k ? "border border-b-white bg-white font-bold" : "text-gray-500"}`}
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
      ) : tab === "houses" ? (
        <Houses data={data} breaks={breaks} houses={harvestHouses(template)} />
      ) : (
        <Calendar from={from} to={to} data={data} use={use} houses={harvestHouses(template)} />
      )}
      {ready && <GroupSetting groups={groups} houses={harvestHouses(template)} />}
      {ready && cfg && <PlantsSetting plants={cfg.plants} houses={harvestHouses(template)} />}
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
  if (!ends || !speeds) return <p className="mt-4 text-gray-500">読み込み中…</p>;
  const days = Object.entries(ends)
    .filter(([, v]) => v.forecast != null || v.endTime != null)
    .sort((a, b) => b[0].localeCompare(a[0]));
  const diffs = days.filter(([, v]) => v.forecast != null && v.endTime != null).map(([, v]) => v.endTime! - v.forecast!);
  const avgAbs = diffs.length ? diffs.reduce((n, d) => n + Math.abs(d), 0) / diffs.length : null;
  const sign = (d: number) => (d === 0 ? "ぴったり" : d > 0 ? `${d}分おそい` : `${-d}分はやい`);
  return (
    <>
      <p className="mt-3 text-sm text-gray-600">
        「朝の予測」は、収穫の開始時刻までの予測です（開始時刻を過ぎてから開いた日は、最初の予測）。日付を押すと、ハウスごとの予測と実際が見られます。人ごとの速さは、最近の記録（1人で収穫したハウス）から毎日計算し直すので、記録がたまるほど予測が合ってきます。
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <div className="rounded-xl border bg-white p-3">
          <p className="text-xs text-gray-500">予測と実際の差（平均）</p>
          <p className="text-2xl font-bold text-sky-800">{avgAbs == null ? "－" : `${Math.round(avgAbs)}分`}</p>
          <p className="text-xs text-gray-500">{diffs.length}日分</p>
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
                </tr>
                {open === d && (
                  <tr>
                    <td colSpan={4} className="bg-sky-50/40 px-3 py-2">
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
                <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
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
