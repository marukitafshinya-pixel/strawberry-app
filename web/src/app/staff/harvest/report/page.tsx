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
  useHouseGroups,
  useHouseUseRange,
  type HarvestDoc,
  type HouseGroup,
  type HouseUseMap,
  type Tally,
} from "@/lib/harvest";
import { useShiftMembers } from "@/lib/shift";

type Tab = "people" | "houses" | "calendar";

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => addDays(`${addDays(`${d.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);

export default function HarvestReportPage() {
  const { role } = useAuth();
  const today = todayJST();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<Tab>("people");
  const data = useHarvestRange(from, to);
  const use = useHouseUseRange(from, to);
  const members = useShiftMembers();
  const groups = useHouseGroups();
  const template = useHaichiTemplate();

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  const lastMonth = addDays(monthStart(today), -1);
  const presets: [string, string, string][] = [
    ["今月", monthStart(today), today],
    ["先月", monthStart(lastMonth), monthEnd(lastMonth)],
    ["今年", `${today.slice(0, 4)}-01-01`, today],
  ];
  const ready = data && use && members && groups && template;

  return (
    <>
      <p className="text-sm">
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
        <People data={data} names={new Map(members.map((m) => [m.id, m.name]))} groups={groups} />
      ) : tab === "houses" ? (
        <Houses data={data} groups={groups} houses={harvestHouses(template)} />
      ) : (
        <Calendar from={from} to={to} data={data} use={use} groups={groups} houses={harvestHouses(template)} />
      )}
      {ready && <GroupSetting groups={groups} houses={harvestHouses(template)} />}
    </>
  );
}

const rate = (t: Tally) => perCaseText(perCase(t));
const hours = (min: number) => (min ? clock(Math.round(min)) : "");

/** 人別：合計と、ハウスのまとまりごとの1ケースあたりの分 */
function People({ data, names, groups }: { data: Record<string, HarvestDoc>; names: Map<string, string>; groups: HouseGroup[] }) {
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
        addHouse(at(all, m), h, date, cases);
        const mg = byGroup.get(m) ?? new Map<string, Tally>();
        byGroup.set(m, mg);
        addHouse(at(mg, groupOf(groups, house)), h, date, cases);
        const mh = byHouse.get(m) ?? new Map<string, Tally>();
        byHouse.set(m, mh);
        addHouse(at(mh, house), h, date, cases);
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
function Houses({ data, groups, houses }: { data: Record<string, HarvestDoc>; groups: HouseGroup[]; houses: string[] }) {
  const byHouse = new Map<string, Tally>();
  for (const [date, day] of Object.entries(data))
    for (const [house, h] of Object.entries(day)) {
      if (!h.cases) continue;
      if (!byHouse.has(house)) byHouse.set(house, emptyTally());
      addHouse(byHouse.get(house)!, h, date);
    }
  const all = [...new Set([...houses, ...byHouse.keys()])];
  const order = [...groups.map((g) => g.name), "その他"];
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
          {order.map((g) => {
            const list = all.filter((h) => groupOf(groups, h) === g);
            if (!list.length) return null;
            const sub = emptyTally();
            for (const h of list) {
              const t = byHouse.get(h);
              if (!t) continue;
              sub.cases += t.cases;
              sub.minutes += t.minutes;
              sub.timedCases += t.timedCases;
              t.days.forEach((d) => sub.days.add(d));
            }
            return (
              <Fragment key={g}>
                {list.map((h) => line(`No.${h}`, byHouse.get(h)))}
                {line(`${g} 小計`, sub, "bg-gray-50 font-bold")}
              </Fragment>
            );
          })}
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
  groups,
  houses,
}: {
  from: string;
  to: string;
  data: Record<string, HarvestDoc>;
  use: { days: Record<string, HouseUseMap>; before: HouseUseMap };
  groups: HouseGroup[];
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
  const order = [...groups.map((g) => g.name), "その他"];
  /** いちご狩り（半分も）に使った日数 */
  const pickingDays = (h: string) => dates.filter((d) => ["picking", "half"].includes(state[d][h] ?? "harvest")).length;
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
            {order.map((g) => {
              const list = houses.filter((h) => groupOf(groups, h) === g);
              if (!list.length) return null;
              return (
                <Fragment key={g}>
                  <tr>
                    <td colSpan={dates.length + 2} className="sticky left-0 bg-gray-50 px-2 py-1 font-bold">
                      {g}
                    </td>
                  </tr>
                  {list.map((h) => (
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
                </Fragment>
              );
            })}
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
