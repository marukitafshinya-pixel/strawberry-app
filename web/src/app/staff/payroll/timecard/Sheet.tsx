"use client";

// 個人別タイムカード集計表（1人分）。画面と印刷で同じものを使う。edit があれば、行ごとに時刻を直せる
import { useState } from "react";
import { weekday } from "@/lib/date";
import { cardTime, hm, hours2, minToCard, parseCardTime, type DayResult, type PersonResult, type TimeFormat } from "@/lib/timecard";

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export function TimecardSheet({
  person,
  name,
  title,
  format: f,
  edit,
}: {
  person: PersonResult;
  name: string;
  title: string;
  format: TimeFormat;
  edit?: (date: string, e: { i: number | null; o: number | null } | null) => Promise<void>;
}) {
  const shown = person.days.filter((d) => d.raw || edit);
  return (
    <section className="timecard-sheet">
      <h2 className="flex flex-wrap items-baseline gap-x-6 text-lg font-bold">
        <span>個人別タイムカード集計表</span>
        <span>{title}</span>
        <span>
          カード {person.card}　{name}
        </span>
      </h2>
      <table className="mt-2 w-full border-collapse text-sm tabular-nums [&_td]:border [&_td]:border-gray-400 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-gray-400 [&_th]:bg-gray-100 [&_th]:px-2 [&_th]:py-1">
        <thead>
          <tr>
            <th>日付</th>
            <th>出勤</th>
            <th>退勤</th>
            <th>出勤（丸め後）</th>
            <th>退勤（丸め後）</th>
            <th>休憩</th>
            <th>労働時間{f === "dec" ? "（時間）" : ""}</th>
            <th>確認</th>
            {edit && <th className="print:hidden">直す</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => (
            <Row key={d.date} d={d} f={f} edit={edit} />
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td colSpan={2}>出勤日数　{person.workDays}日</td>
            <td colSpan={4} className="text-right">
              合計
            </td>
            <td className="text-right">{f === "dec" ? hours2(person.work) : hm(person.work)}</td>
            <td colSpan={edit ? 2 : 1} className="text-xs font-normal">
              {f === "dec" ? `${hm(person.work)}（時:分）` : `${hours2(person.work)}時間`}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function Row({ d, f, edit }: { d: DayResult; f: TimeFormat; edit?: (date: string, e: { i: number | null; o: number | null } | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState("");
  const [o, setO] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const w = weekday(d.date);
  const day = <span className={w === "日" ? "text-red-600" : w === "土" ? "text-blue-700" : ""}>{`${md(d.date)}（${w}）`}</span>;
  const startEdit = () => {
    setI(cardTime(d.i, f));
    setO(cardTime(d.o, f));
    setErr("");
    setOpen(true);
  };
  async function save(reset: boolean) {
    if (!edit) return;
    let e: { i: number | null; o: number | null } | null = null;
    if (!reset) {
      const ii = parseCardTime(i, f);
      const oo = parseCardTime(o, f);
      if (ii === undefined || oo === undefined) return setErr(f === "dec" ? "時刻はカードと同じ形（10.24 など）で入れてください" : "時刻は 8:30 のように入れてください");
      e = { i: ii, o: oo };
    }
    setBusy(true);
    try {
      await edit(d.date, e);
      setOpen(false);
    } catch {
      setErr("保存できませんでした");
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr className={d.problem ? "bg-red-50" : d.edited ? "bg-amber-50" : ""}>
      <td className="whitespace-nowrap">{day}</td>
      <td className="text-right">
        {cardTime(d.i, f)}
        {d.edited && d.raw?.i !== d.i && <span className="block text-[10px] text-gray-500 line-through">{cardTime(d.raw?.i, f)}</span>}
      </td>
      <td className="text-right">
        {cardTime(d.o, f)}
        {d.edited && d.raw?.o !== d.o && <span className="block text-[10px] text-gray-500 line-through">{cardTime(d.raw?.o, f)}</span>}
      </td>
      <td className="text-right">{minToCard(d.ri, f)}</td>
      <td className="text-right">{d.ro !== null && d.ro >= 1440 ? `翌${minToCard(d.ro - 1440, f)}` : minToCard(d.ro, f)}</td>
      <td className="text-right">{d.brk ? `${d.brk}分` : ""}</td>
      <td className="text-right font-bold">{d.work ? (f === "dec" ? hours2(d.work) : hm(d.work)) : ""}</td>
      <td className="text-xs">
        {d.problem && <span className="font-bold text-red-700">{d.problem}</span>}
        {d.edited && <span className="text-amber-800">{d.problem ? "・" : ""}直した時刻</span>}
      </td>
      {edit && (
        <td className="whitespace-nowrap print:hidden">
          {open ? (
            <span className="inline-flex flex-wrap items-center gap-1">
              <input value={i} onChange={(e) => setI(e.target.value)} placeholder={f === "dec" ? "3.38" : "3:38"} className="w-16 rounded border px-1 py-0.5" />
              〜
              <input value={o} onChange={(e) => setO(e.target.value)} placeholder={f === "dec" ? "10.24" : "10:24"} className="w-16 rounded border px-1 py-0.5" />
              <button disabled={busy} onClick={() => save(false)} className="rounded bg-berry px-2 py-0.5 text-white">
                保存
              </button>
              {d.edited && (
                <button disabled={busy} onClick={() => save(true)} className="rounded border px-2 py-0.5">
                  元の打刻に戻す
                </button>
              )}
              <button onClick={() => setOpen(false)} className="rounded border px-2 py-0.5">
                やめる
              </button>
              {err && <span className="block w-full text-xs text-red-600">{err}</span>}
            </span>
          ) : (
            <button onClick={startEdit} className="rounded border px-2 py-0.5 text-xs">
              直す
            </button>
          )}
        </td>
      )}
    </tr>
  );
}
