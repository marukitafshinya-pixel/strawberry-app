"use client";

// 収穫管理の入力：その日に、だれがどのハウスに何時から何時まで入って何ケース取ったかと、ハウスの使い方を入れる。
// はじめは作業配置表（収穫の枠）から、人ごとに入ったハウスを並べておく。実績（集計）は管理者だけが見られる
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { addDays, formatJa, todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import {
  clock,
  groupOf,
  harvestHouses,
  HOUSE_USES,
  houseUseOf,
  newRowId,
  parseCases,
  parseClock,
  rowMinutes,
  rowsFromHaichi,
  saveHarvestDay,
  saveHouseUse,
  useHarvestDay,
  useHouseGroups,
  useHouseUse,
  type HarvestRow,
  type HouseGroup,
  type HouseUse,
} from "@/lib/harvest";
import { useShiftMembers, type ShiftMember } from "@/lib/shift";

/** スタッフが入力できるのは、この日数前まで（それより前は管理者だけ） */
const STAFF_DAYS = 7;

export default function HarvestPage() {
  const { role } = useAuth();
  const [date, setDate] = useState(todayJST());
  const [dirty, setDirty] = useState(false);
  const template = useHaichiTemplate();
  const haichi = useHaichiDay(date);
  const saved = useHarvestDay(date);
  const members = useShiftMembers();
  const groups = useHouseGroups();

  if (role !== "admin" && role !== "staff") return <p>この画面はスタッフだけが使えます。</p>;
  const isAdmin = role === "admin";
  const tooOld = !isAdmin && date < addDays(todayJST(), -STAFF_DAYS);
  const go = (d: string) => {
    if (dirty && !window.confirm("保存していない入力があります。保存せずに日付を変えますか？")) return;
    setDirty(false);
    setDate(d);
  };
  const houses = template ? harvestHouses(template) : [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">🍓 収穫管理</h1>
        <button onClick={() => go(addDays(date, -1))} className="ml-2 rounded-lg border bg-white px-3 py-2">
          ◀
        </button>
        <input type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="rounded-lg border px-3 py-2" />
        <button onClick={() => go(addDays(date, 1))} className="rounded-lg border bg-white px-3 py-2">
          ▶
        </button>
        <span className="font-bold">{formatJa(date)}</span>
        {date !== todayJST() && (
          <button onClick={() => go(todayJST())} className="rounded-lg border bg-white px-3 py-2 text-sm">
            今日
          </button>
        )}
        {isAdmin && (
          <Link href="/staff/harvest/report/" className="ml-auto rounded-lg border border-berry bg-white px-3 py-2 text-sm font-bold text-berry">
            📊 収穫の実績
          </Link>
        )}
      </div>

      {tooOld ? (
        <p className="mt-4 rounded-lg border bg-white p-4 text-gray-600">{STAFF_DAYS}日より前の記録は、管理者だけが見たり直したりできます。</p>
      ) : !template || haichi === null || saved === undefined || !members || !groups ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : (
        <>
          <Entry
            key={`${date}_${saved ? "saved" : "draft"}`}
            date={date}
            initial={saved ?? rowsFromHaichi(template, haichi)}
            fromHaichi={!saved}
            houses={houses}
            members={members}
            onDirty={setDirty}
          />
          <HouseUseBox date={date} houses={houses} groups={groups} />
        </>
      )}
    </>
  );
}

/** 人ごとの収穫の入力 */
function Entry({
  date,
  initial,
  fromHaichi,
  houses,
  members,
  onDirty,
}: {
  date: string;
  initial: HarvestRow[];
  fromHaichi: boolean;
  houses: string[];
  members: ShiftMember[];
  onDirty: (d: boolean) => void;
}) {
  const [rows, setRowsRaw] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirtyRaw] = useState(false);
  const setDirty = (d: boolean) => {
    setDirtyRaw(d);
    onDirty(d);
  };
  const setRows = (f: (rs: HarvestRow[]) => HarvestRow[]) => {
    setRowsRaw(f);
    setDirty(true);
    setMsg(null);
  };
  const names = new Map(members.map((m) => [m.id, m.name]));
  /** 人の並び（入力した順） */
  const people = [...new Set(rows.map((r) => r.member))];

  const patch = (id: string, p: Partial<HarvestRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  /** 終わった時刻を入れたら、その人の次の行の「入った」が空なら同じ時刻を入れる */
  const setEnd = (id: string, end: number | null) =>
    setRows((rs) => {
      const i = rs.findIndex((r) => r.id === id);
      const out = rs.map((r) => (r.id === id ? { ...r, end } : r));
      const next = out.findIndex((r, j) => j > i && r.member === rs[i].member);
      if (end != null && next >= 0 && out[next].start == null) out[next] = { ...out[next], start: end };
      return out;
    });
  const addRow = (member: string) =>
    setRows((rs) => {
      const last = rs
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.member === member)
        .pop();
      const row: HarvestRow = { id: newRowId(), member, house: "", start: last?.[0].end ?? null, end: null, cases: null };
      if (!last) return [...rs, row];
      return [...rs.slice(0, last[1] + 1), row, ...rs.slice(last[1] + 1)];
    });
  const removeRow = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));

  async function save() {
    if (rows.some((r) => !r.house)) return setMsg({ ok: false, text: "ハウスを選んでいない行があります" });
    if (rows.some((r) => r.start != null && r.end != null && r.end <= r.start))
      return setMsg({ ok: false, text: "「終わった」が「入った」より前になっている行があります" });
    setSaving(true);
    try {
      await saveHarvestDay(date, rows);
      setDirty(false);
      setMsg({ ok: true, text: "保存しました" });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  const candidates = members.filter((m) => m.active && !people.includes(m.id)).sort((a, b) => Number(!!b.harvest) - Number(!!a.harvest) || a.order - b.order);
  const total = rows.reduce((n, r) => n + (r.cases ?? 0), 0);

  return (
    <section className="mt-4">
      <h2 className="text-lg font-bold">① 収穫した人とケース</h2>
      <p className="mt-1 text-sm text-gray-600">
        時刻は「710」のように打つと 7:10 になります。「終わった」を入れると、その人の次のハウスの「入った」に同じ時刻が入ります。ケースは 5.3
        のように0.1枚単位で入れます。
      </p>
      {fromHaichi && rows.length > 0 && (
        <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">作業配置表から、収穫に入る人とハウスを並べました。まだ保存していません。</p>
      )}
      {rows.length === 0 && (
        <p className="mt-2 rounded-lg border bg-white p-3 text-sm text-gray-600">
          この日の作業配置表に収穫の人がいません。下の「人を足す」から入れてください。
        </p>
      )}

      <div className="mt-3 space-y-3">
        {people.map((member) => {
          const mine = rows.filter((r) => r.member === member);
          return (
            <div key={member} className="rounded-xl border bg-white p-3">
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold">{names.get(member) ?? "（いない人）"}</span>
                <span className="text-sm text-gray-500 tabular-nums">
                  計 {(Math.round(mine.reduce((n, r) => n + (r.cases ?? 0), 0) * 10) / 10).toFixed(1)}ケース
                </span>
                <button onClick={() => addRow(member)} className="ml-auto rounded-lg border px-3 py-1 text-sm">
                  ＋ ハウスを足す
                </button>
              </div>
              <table className="mt-2 w-full text-sm tabular-nums">
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th className="py-1 pr-2">ハウス</th>
                    <th className="px-1 py-1">入った</th>
                    <th className="px-1 py-1">終わった</th>
                    <th className="px-1 py-1 text-right">時間</th>
                    <th className="px-1 py-1">ケース</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => {
                    const m = rowMinutes(r);
                    return (
                      <tr key={r.id} className="border-t">
                        <td className="py-1 pr-2">
                          <select
                            value={r.house}
                            onChange={(e) => patch(r.id, { house: e.target.value })}
                            className={`rounded-lg border px-2 py-2 text-base ${r.house ? "" : "border-red-400"}`}
                          >
                            <option value="">（選ぶ）</option>
                            {(houses.includes(r.house) || !r.house ? houses : [...houses, r.house]).map((h) => (
                              <option key={h} value={h}>
                                No.{h}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-1 py-1">
                          <TextCell
                            key={`s${r.start}`}
                            value={clock(r.start)}
                            placeholder="600"
                            parse={parseClock}
                            onCommit={(v) => patch(r.id, { start: v })}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <TextCell key={`e${r.end}`} value={clock(r.end)} placeholder="710" parse={parseClock} onCommit={(v) => setEnd(r.id, v)} />
                        </td>
                        <td className="px-1 py-1 text-right text-gray-600">{m != null ? clock(m) : ""}</td>
                        <td className="px-1 py-1">
                          <TextCell
                            key={`c${r.cases}`}
                            value={r.cases == null ? "" : r.cases.toFixed(1)}
                            placeholder="5.3"
                            decimal
                            parse={parseCases}
                            onCommit={(v) => patch(r.id, { cases: v })}
                          />
                        </td>
                        <td className="py-1 text-right">
                          <button onClick={() => removeRow(r.id)} className="rounded px-2 py-1 text-gray-400 hover:text-red-600" aria-label="この行を消す">
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const id = e.target.value;
            setRows((rs) => [...rs, { id: newRowId(), member: id, house: "", start: null, end: null, cases: null }]);
          }}
          className="rounded-lg border bg-white px-3 py-2"
        >
          <option value="">＋ 人を足す</option>
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.harvest ? "" : "（収穫可でない）"}
            </option>
          ))}
        </select>
      </div>

      <div className="sticky bottom-0 z-10 mt-3 flex items-center gap-3 rounded-xl border bg-white/95 p-3 shadow">
        <span className="tabular-nums">
          合計 <b>{(Math.round(total * 10) / 10).toFixed(1)}</b> ケース・{people.length}人
        </span>
        {msg && <span className={msg.ok ? "text-emerald-700" : "text-red-600"}>{msg.text}</span>}
        <button
          onClick={() => void save()}
          disabled={saving || (!dirty && !fromHaichi)}
          className="ml-auto rounded-lg bg-berry px-6 py-2 font-bold text-white disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存する"}
        </button>
      </div>
    </section>
  );
}

/** テンキーで打って、エンターかほかを押したときに読む入力欄 */
function TextCell<T>({
  value,
  placeholder,
  decimal,
  parse,
  onCommit,
}: {
  value: string;
  placeholder: string;
  decimal?: boolean;
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
      className={`w-20 rounded-lg border px-2 py-2 text-center text-base ${bad ? "border-red-500 bg-red-50" : ""}`}
    />
  );
}

/** ハウスの使い方（押すとすぐ保存。記録がない日は、前の日の状態を引きつぐ） */
function HouseUseBox({ date, houses, groups }: { date: string; houses: string[]; groups: HouseGroup[] }) {
  const use = useHouseUse(date);
  const [error, setError] = useState("");
  if (!use) return <p className="mt-6 text-gray-500">ハウスの使い方を読み込み中…</p>;
  const current = (h: string) => use.houses[h] ?? "harvest";
  const set = async (h: string, k: HouseUse) => {
    setError("");
    const next = Object.fromEntries(houses.map((x) => [x, x === h ? k : current(x)]));
    try {
      await saveHouseUse(date, next);
    } catch (e) {
      setError(errorText(e));
    }
  };
  // まとまりごとに並べる（まとまりに入っていないハウスは「その他」）
  const order = [...groups.map((g) => g.name), "その他"];
  const byGroup = order.map((name) => ({ name, list: houses.filter((h) => groupOf(groups, h) === name) })).filter((g) => g.list.length);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-bold">② ハウスの使い方</h2>
      <p className="mt-1 text-sm text-gray-600">
        {use.from === date
          ? "この日の使い方です。変わったハウスだけ押して直してください（押すとすぐ保存します）。"
          : use.from
            ? `${formatJa(use.from)}の状態を引きついでいます。変わったハウスを押すと、この日の記録になります。`
            : "まだ記録がありません。押すと、この日の記録になります（何も押さなければ全部「収穫」です）。"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {HOUSE_USES.map((u) => (
          <span key={u.key} className={`rounded border px-2 py-0.5 ${u.cls}`}>
            {u.short}＝{u.label}
          </span>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 space-y-4">
        {byGroup.map((g) => (
          <div key={g.name}>
            <h3 className="text-sm font-bold text-gray-700">{g.name}</h3>
            <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {g.list.map((h) => (
                <div key={h} className="flex items-center gap-2 rounded-xl border bg-white p-2">
                  <span className={`w-16 rounded-lg border px-2 py-1 text-center font-bold ${houseUseOf(current(h)).cls}`}>No.{h}</span>
                  <div className="flex flex-1 gap-1">
                    {HOUSE_USES.map((u) => (
                      <button
                        key={u.key}
                        onClick={() => void set(h, u.key)}
                        title={u.label}
                        className={`flex-1 rounded-lg border py-1.5 font-bold ${current(h) === u.key ? `${u.cls} ring-2 ring-gray-700` : "bg-white text-gray-400"}`}
                      >
                        {u.short}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
