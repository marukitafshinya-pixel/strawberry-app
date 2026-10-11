"use client";

// 個人別タイムカード集計表（1人分）。画面と印刷で同じものを使う。
// edit があれば、「出勤」「退勤」（打刻）のマスを押すと小さな入力欄が出て、テンキーで時刻を入れてエンターで直せる（すぐに計算し直す）
import { useEffect, useRef, useState } from "react";
import { weekday } from "@/lib/date";
import { hm, hours2, type DayResult, type PersonResult } from "@/lib/timecard";

const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export function TimecardSheet({
  person,
  name,
  title,
  edit,
}: {
  person: PersonResult;
  name: string;
  title: string;
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
            <th>出勤{edit && <span className="block text-[10px] font-normal text-gray-500 print:hidden">押して直す</span>}</th>
            <th>退勤{edit && <span className="block text-[10px] font-normal text-gray-500 print:hidden">押して直す</span>}</th>
            <th>出勤（計算）</th>
            <th>退勤（計算）</th>
            <th>休憩</th>
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

type Edit = (date: string, e: { i: number | null; o: number | null } | null) => Promise<void>;

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

function Row({ d, edit }: { d: DayResult; edit?: Edit }) {
  /** 直しているマス（出勤 i・退勤 o）と、その場所 */
  const [pop, setPop] = useState<{ which: "i" | "o"; x: number; y: number } | null>(null);
  const w = weekday(d.date);
  const day = <span className={w === "日" ? "text-red-600" : w === "土" ? "text-blue-700" : ""}>{`${md(d.date)}（${w}）`}</span>;
  const openAt = (which: "i" | "o") => (ev: React.MouseEvent<HTMLTableCellElement>) => {
    if (!edit) return;
    const r = ev.currentTarget.getBoundingClientRect();
    setPop({ which, x: r.left, y: r.bottom });
  };
  const punchCell = edit ? "cursor-pointer text-right hover:bg-sky-100 hover:outline hover:outline-2 hover:outline-sky-500" : "text-right";
  return (
    <tr className={d.problem ? "bg-red-50" : d.edited ? "bg-amber-50" : ""}>
      <td className="whitespace-nowrap">{day}</td>
      <td className={`${punchCell} ${d.edited && d.raw?.i !== d.i ? "font-bold text-amber-800" : ""}`} onClick={openAt("i")} title={edit ? "押すと出勤の打刻を直せます" : undefined}>
        {hm(d.i)}
      </td>
      <td className={`${punchCell} ${d.edited && d.raw?.o !== d.o ? "font-bold text-amber-800" : ""}`} onClick={openAt("o")} title={edit ? "押すと退勤の打刻を直せます" : undefined}>
        {hm(d.o)}
      </td>
      <td className="text-right">{hm(d.ri)}</td>
      <td className="text-right">{d.ro !== null && d.ro >= 1440 ? `翌${hm(d.ro - 1440)}` : hm(d.ro)}</td>
      <td className="text-right">{d.brk ? `${d.brk}分` : ""}</td>
      <td className="text-right font-bold">{d.work ? hm(d.work) : ""}</td>
      <td className="text-right">{d.over ? hm(d.over) : ""}</td>
      <td className="text-xs">
        {d.problem && <span className="font-bold text-red-700">{d.problem}</span>}
        {d.edited && <EditedNote d={d} sep={!!d.problem} />}
        {pop && edit && <TimePop d={d} which={pop.which} x={pop.x} y={pop.y} edit={edit} onClose={() => setPop(null)} />}
      </td>
    </tr>
  );
}

/** 確認欄に出す、直す前と後の打刻（例「退勤 17:04→18:04」） */
function EditedNote({ d, sep }: { d: DayResult; sep: boolean }) {
  const parts = (["i", "o"] as const)
    .filter((k) => d.raw?.[k] !== d[k])
    .map((k) => `${k === "i" ? "出勤" : "退勤"} ${hm(d.raw?.[k]) || "なし"}→${hm(d[k]) || "なし"}`);
  return (
    <span className="text-amber-800">
      {sep ? "・" : ""}直した時刻{parts.length ? `：${parts.join("、")}` : ""}
    </span>
  );
}

/** 打刻を直す小さな入力欄。開いたらすぐテンキーで打てる。エンターで確定、Esc でやめる */
function TimePop({ d, which, x, y, edit, onClose }: { d: DayResult; which: "i" | "o"; x: number; y: number; edit: Edit; onClose: () => void }) {
  const cur = which === "i" ? d.i : d.o;
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  function commit() {
    const t = parseKeyed(v);
    if (t === undefined) return setErr("時刻は 1730 や 17:30 のように入れてください");
    const e = { i: which === "i" ? t : d.i, o: which === "o" ? t : d.o };
    onClose();
    edit(d.date, e).catch(() => alert("保存できませんでした。もう一度やり直してください"));
  }
  function reset() {
    onClose();
    edit(d.date, null).catch(() => alert("保存できませんでした。もう一度やり直してください"));
  }
  return (
    <>
      <div className="fixed inset-0 z-40 print:hidden" onClick={onClose} />
      <div
        className="fixed z-50 w-64 rounded-xl border-2 border-sky-600 bg-white p-3 text-sm shadow-xl print:hidden"
        style={{ left: Math.max(8, Math.min(x, window.innerWidth - 272)), top: Math.min(y + 4, window.innerHeight - 190) }}
      >
        <p className="font-bold">
          {md(d.date)}の{which === "i" ? "出勤" : "退勤"}
          <span className="ml-2 font-normal text-gray-500">今：{hm(cur) || "なし"}</span>
        </p>
        <input
          ref={ref}
          value={v}
          inputMode="numeric"
          placeholder={which === "i" ? "例 600" : "例 1730"}
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
        <p className="mt-1 text-xs text-gray-500">数字を打ってエンターで確定（1730＝17:30）。空のままエンターで打刻なし。Escでやめる</p>
        {d.edited && (
          <button onClick={reset} className="mt-2 w-full rounded-lg border px-2 py-1">
            元の打刻に戻す
          </button>
        )}
      </div>
    </>
  );
}
