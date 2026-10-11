"use client";

// 個人別タイムカード集計表（1人分）。画面と印刷で同じものを使う。
// edit があれば、「出勤」「退勤」（打刻）と「休憩」のマスを押すと小さな入力欄が出て、テンキーで入れてエンターで直せる（すぐに計算し直す）
import { useEffect, useRef, useState } from "react";
import { weekday } from "@/lib/date";
import { hm, hours2, type DayResult, type PersonResult } from "@/lib/timecard";

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

/** 直す処理。時刻（null＝元の打刻に戻す）と休憩（分。null＝自動に戻す） */
export type SheetEdit = {
  time: (date: string, e: { i: number | null; o: number | null } | null) => Promise<void>;
  brk: (date: string, minutes: number | null) => Promise<void>;
};
type Which = "i" | "o" | "b";

export function TimecardSheet({ person, name, title, edit }: { person: PersonResult; name: string; title: string; edit?: SheetEdit }) {
  const shown = person.days.filter((d) => d.raw || edit);
  const tap = edit && <span className="block text-[10px] font-normal text-gray-500 print:hidden">押して直す</span>;
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
            <th>出勤{tap}</th>
            <th>退勤{tap}</th>
            <th>休憩{tap}</th>
            <th>出勤（計算）</th>
            <th>退勤（計算）</th>
            <th>労働時間</th>
            <th>うち残業</th>
            <th>確認</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => (
            <Row key={d.date} d={d} edit={edit} />
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td colSpan={2}>出勤日数　{person.workDays}日</td>
            <td colSpan={4} className="text-right">
              合計
            </td>
            <td className="text-right">{hm(person.work)}</td>
            <td className="text-right">{person.over ? hm(person.over) : ""}</td>
            <td className="text-xs font-normal">
              {hours2(person.work)}時間（うち残業 {hours2(person.over)}時間・残業でない分 {hours2(person.work - person.over)}時間）
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/**
 * テンキーで入れた時刻を分にする。「1730」「17:30」「17.30」→ 17:30、「600」→ 6:00、「6」→ 6:00。
 * 空なら null（打刻なし）。読めなければ undefined
 */
function parseKeyed(s: string): number | null | undefined {
  const t = s.trim().replace("：", ":").replace(/[．.]/, ":");
  if (t === "") return null;
  let h: number;
  let m: number;
  const sep = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (sep) {
    h = Number(sep[1]);
    m = Number(sep[2]);
  } else if (/^\d{1,4}$/.test(t)) {
    const n = Number(t);
    if (t.length <= 2) {
      h = n;
      m = 0;
    } else {
      h = Math.floor(n / 100);
      m = n % 100;
    }
  } else return undefined;
  if (h >= 48 || m >= 60) return undefined;
  return h * 60 + m;
}

/** 休憩：数字だけなら分（「30」＝30分、「90」＝1時間30分）、「1:30」も読む。空なら null（自動に戻す） */
function parseBreak(s: string): number | null | undefined {
  const t = s.trim().replace("：", ":").replace(/[．.]/, ":");
  if (t === "") return null;
  const sep = /^(\d{1,2}):(\d{2})$/.exec(t);
  const n = sep ? Number(sep[1]) * 60 + Number(sep[2]) : /^\d{1,3}$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) && n <= 600 && (!sep || Number(sep[2]) < 60) ? n : undefined;
}

function Row({ d, edit }: { d: DayResult; edit?: SheetEdit }) {
  /** 直しているマス（出勤 i・退勤 o・休憩 b）と、その場所 */
  const [pop, setPop] = useState<{ which: Which; x: number; y: number } | null>(null);
  const w = weekday(d.date);
  const day = <span className={w === "日" ? "text-red-600" : w === "土" ? "text-blue-700" : ""}>{`${md(d.date)}（${w}）`}</span>;
  const openAt = (which: Which) => (ev: React.MouseEvent<HTMLTableCellElement>) => {
    if (!edit) return;
    const r = ev.currentTarget.getBoundingClientRect();
    setPop({ which, x: r.left, y: r.bottom });
  };
  const tapCell = (changed: boolean) =>
    `text-right ${edit ? "cursor-pointer hover:bg-sky-100 hover:outline hover:outline-2 hover:outline-sky-500" : ""} ${changed ? "font-bold text-amber-800" : ""}`;
  const timeEdited = !!d.raw?.e;
  return (
    <tr className={d.problem ? "bg-red-50" : d.edited ? "bg-amber-50" : ""}>
      <td className="whitespace-nowrap">{day}</td>
      <td className={tapCell(timeEdited && d.raw?.i !== d.i)} onClick={openAt("i")} title={edit ? "押すと出勤の打刻を直せます" : undefined}>
        {hm(d.i)}
      </td>
      <td className={tapCell(timeEdited && d.raw?.o !== d.o)} onClick={openAt("o")} title={edit ? "押すと退勤の打刻を直せます" : undefined}>
        {hm(d.o)}
      </td>
      <td className={tapCell(d.brkEdited)} onClick={openAt("b")} title={edit ? "押すと休憩を直せます" : undefined}>
        {d.brk || d.brkEdited ? `${d.brk}分` : ""}
      </td>
      <td className="text-right">{hm(d.ri)}</td>
      <td className="text-right">{d.ro !== null && d.ro >= 1440 ? `翌${hm(d.ro - 1440)}` : hm(d.ro)}</td>
      <td className="text-right font-bold">{d.work ? hm(d.work) : ""}</td>
      <td className="text-right">{d.over ? hm(d.over) : ""}</td>
      <td className="text-xs">
        {d.problem && <span className="font-bold text-red-700">{d.problem}</span>}
        {d.edited && <EditedNote d={d} sep={!!d.problem} />}
        {pop && edit && <EditPop d={d} which={pop.which} x={pop.x} y={pop.y} edit={edit} onClose={() => setPop(null)} />}
      </td>
    </tr>
  );
}

/** 確認欄に出す、直す前と後（例「退勤 17:04→18:04」「休憩 60分→30分」） */
function EditedNote({ d, sep }: { d: DayResult; sep: boolean }) {
  const parts = d.raw?.e ? (["i", "o"] as const).filter((k) => d.raw?.[k] !== d[k]).map((k) => `${k === "i" ? "出勤" : "退勤"} ${hm(d.raw?.[k]) || "なし"}→${hm(d[k]) || "なし"}`) : [];
  if (d.brkEdited) parts.push(`休憩 ${d.autoBrk}分→${d.brk}分`);
  return (
    <span className="text-amber-800">
      {sep ? "・" : ""}直した{parts.length ? `：${parts.join("、")}` : ""}
    </span>
  );
}

/** 直す小さな入力欄。開いたらすぐテンキーで打てる。エンターで確定、Esc でやめる */
function EditPop({ d, which, x, y, edit, onClose }: { d: DayResult; which: Which; x: number; y: number; edit: SheetEdit; onClose: () => void }) {
  const isBrk = which === "b";
  const label = which === "i" ? "出勤" : which === "o" ? "退勤" : "休憩";
  const cur = which === "i" ? hm(d.i) : which === "o" ? hm(d.o) : `${d.brk}分${d.brkEdited ? `（自動なら${d.autoBrk}分）` : ""}`;
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const fail = () => alert("保存できませんでした。もう一度やり直してください");
  function commit() {
    if (isBrk) {
      const b = parseBreak(v);
      if (b === undefined) return setErr("休憩は分で入れてください（30＝30分、90＝1時間30分）");
      onClose();
      edit.brk(d.date, b).catch(fail);
      return;
    }
    const t = parseKeyed(v);
    if (t === undefined) return setErr("時刻は 1730 や 17:30 のように入れてください");
    onClose();
    edit.time(d.date, { i: which === "i" ? t : d.i, o: which === "o" ? t : d.o }).catch(fail);
  }
  function reset() {
    onClose();
    (isBrk ? edit.brk(d.date, null) : edit.time(d.date, null)).catch(fail);
  }
  const canReset = isBrk ? d.brkEdited : !!d.raw?.e;
  return (
    <>
      <div className="fixed inset-0 z-40 print:hidden" onClick={onClose} />
      <div
        className="fixed z-50 w-64 rounded-xl border-2 border-sky-600 bg-white p-3 text-sm shadow-xl print:hidden"
        style={{ left: Math.max(8, Math.min(x, window.innerWidth - 272)), top: Math.min(y + 4, window.innerHeight - 200) }}
      >
        <p className="font-bold">
          {md(d.date)}の{label}
          <span className="ml-2 font-normal text-gray-500">今：{cur || "なし"}</span>
        </p>
        <input
          ref={ref}
          value={v}
          inputMode="numeric"
          placeholder={isBrk ? "例 30（分）" : which === "i" ? "例 600" : "例 1730"}
          onChange={(e) => {
            setV(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") onClose();
          }}
          className="mt-2 w-full rounded-lg border-2 px-3 py-2 text-center text-2xl tabular-nums"
        />
        {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
        <p className="mt-1 text-xs text-gray-500">
          {isBrk
            ? "分を打ってエンターで確定（30＝30分、0＝休憩なし）。空のままエンターで自動の休憩に戻す。Escでやめる"
            : "数字を打ってエンターで確定（1730＝17:30）。空のままエンターで打刻なし。Escでやめる"}
        </p>
        {canReset && (
          <button onClick={reset} className="mt-2 w-full rounded-lg border px-2 py-1">
            {isBrk ? `自動の休憩（${d.autoBrk}分）に戻す` : "元の打刻に戻す"}
          </button>
        )}
      </div>
    </>
  );
}
