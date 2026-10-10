"use client";

// タイムカード：MAXのタイムレコーダーのUSBデータ（CSV）を取り込んで、個人別タイムカード集計表を作る（管理者だけ）
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv } from "@/lib/csv";
import { shiftMonth, todayJST } from "@/lib/date";
import { reiwa, useEmployees } from "@/lib/payroll";
import {
  CLOSE_DAY_CHOICES,
  ROUND_CHOICES,
  cardsIn,
  computePerson,
  employeeForCard,
  guessFormat,
  hm,
  hours2,
  importTimecard,
  parseMaxTimecardCsv,
  periodDays,
  periodMonths,
  saveTimecardConfig,
  saveTimecardEdit,
  useTimecardConfig,
  useTimecardMonths,
  workText,
  type BreakRule,
  type ParsedTimecard,
  type TimecardConfig,
  type TimeFormat,
} from "@/lib/timecard";
import { TimecardSheet } from "./Sheet";

const mdOf = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export default function TimecardPage() {
  const { role } = useAuth();
  // 給与の月（ふつうは先月分を計算する）
  const [month, setMonth] = useState(() => shiftMonth(todayJST().slice(0, 7), -1));
  const { value: cfg, error: cfgError } = useTimecardConfig();
  const { value: employees } = useEmployees();
  const months = periodMonths(month, cfg?.closeDay ?? 31);
  const data = useTimecardMonths(months);
  const [card, setCard] = useState<string | null>(null);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (cfgError) return <p className="text-red-600">{cfgError}</p>;

  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const days = cfg ? periodDays(month, cfg.closeDay) : [];
  const people = cfg && data && employees ? cardsIn(month, data, cfg).map((c) => ({ p: computePerson(c, month, data, cfg), e: employeeForCard(c, cfg, employees) })) : null;
  const nameOf = (c: string) => (cfg && employees ? (employeeForCard(c, cfg, employees)?.name ?? `（カード${c}・従業員が未設定）`) : "");
  const selected = card && cfg && data ? computePerson(card, month, data, cfg) : null;
  const f: TimeFormat = cfg?.format ?? "dec";

  return (
    <>
      <p className="text-sm print:hidden">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        <Link href="/staff/payroll/" className="ml-4 text-gray-500 underline">
          給与の打ち込み
        </Link>
        <Link href="/staff/payroll/employees/" className="ml-4 text-gray-500 underline">
          従業員の登録
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">タイムカード</h1>

      <ImportBox cfg={cfg} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-40 text-center text-lg font-bold">{title}</span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          次月 ›
        </button>
        {days.length > 0 && (
          <span className="text-sm text-gray-600">
            {mdOf(days[0])}〜{mdOf(days[days.length - 1])}
          </span>
        )}
        <Link href={`/staff/payroll/timecard/print/?month=${month}`} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm">
          🖨 全員の集計表を印刷
        </Link>
      </div>

      {cfg && <Rules cfg={cfg} />}

      {!people ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : people.length === 0 ? (
        <p className="mt-4 rounded-lg border bg-white p-4 text-gray-600">この月のタイムカードはまだありません。上の「CSVを選ぶ」から、タイムレコーダーのUSBのデータを取り込んでください。</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">カード</th>
                <th className="px-3 py-2">氏名</th>
                <th className="px-3 py-2 text-right">出勤日数</th>
                <th className="px-3 py-2 text-right">労働時間</th>
                <th className="px-3 py-2">確認</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {people.map(({ p, e }) => (
                <tr key={p.card} className={`border-t ${card === p.card ? "bg-berry/10" : ""}`}>
                  <td className="px-3 py-2">{p.card}</td>
                  <td className="px-3 py-2">
                    <select
                      value={cfg?.cards[p.card] ?? e?.id ?? ""}
                      onChange={(ev) => void saveTimecardConfig({ cards: { ...(cfg?.cards ?? {}), [p.card]: ev.target.value } })}
                      className={`rounded border px-2 py-1 ${e ? "" : "border-red-400 text-red-700"}`}
                    >
                      <option value="">（従業員を選ぶ）</option>
                      {employees?.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.code} {x.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">{p.workDays}日</td>
                  <td className="px-3 py-2 text-right font-bold">
                    {workText(p.work, f)}
                    <span className="ml-1 text-xs font-normal text-gray-500">（{f === "dec" ? hm(p.work) : `${hours2(p.work)}h`}）</span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {p.problems > 0 && <span className="mr-2 font-bold text-red-700">要確認 {p.problems}件</span>}
                    {p.edited > 0 && <span className="text-amber-800">直した {p.edited}件</span>}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => setCard(card === p.card ? null : p.card)} className="rounded-lg border px-3 py-1">
                      {card === p.card ? "閉じる" : "個人表を見る"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 bg-gray-50 font-bold">
              <tr>
                <td className="px-3 py-2" colSpan={2}>
                  合計 {people.length}人
                </td>
                <td className="px-3 py-2 text-right">{people.reduce((a, x) => a + x.p.workDays, 0)}日</td>
                <td className="px-3 py-2 text-right">{workText(people.reduce((a, x) => a + x.p.work, 0), f)}</td>
                <td className="px-3 py-2 text-xs text-red-700">
                  {people.some((x) => x.p.problems) ? `要確認 ${people.reduce((a, x) => a + x.p.problems, 0)}件` : ""}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {selected && card && (
        <div className="mt-4 rounded-xl border bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-sm text-gray-600">赤い行は打刻もれなどです。「直す」で時刻を入れてください（元の打刻は残ります）。打刻のない日も「直す」で入れられます。</p>
            <Link href={`/staff/payroll/timecard/print/?month=${month}&card=${card}`} className="ml-auto rounded-lg border bg-white px-3 py-1.5 text-sm">
              🖨 この人の集計表を印刷
            </Link>
          </div>
          <TimecardSheet person={selected} name={nameOf(card)} title={title} format={f} edit={(date, e) => saveTimecardEdit(date, card, e)} />
        </div>
      )}
    </>
  );
}

/** USBのCSVを選んで、中身を確かめてから取り込む */
function ImportBox({ cfg }: { cfg: TimecardConfig | null }) {
  const [parsed, setParsed] = useState<{ data: ParsedTimecard; name: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function pick(file: File) {
    setMsg(null);
    setParsed(null);
    const { text } = decodeCsv(await file.arrayBuffer());
    const r = parseMaxTimecardCsv(text);
    if (r.error || !r.data) return setMsg({ ok: false, text: r.error ?? "読めませんでした" });
    setParsed({ data: r.data, name: file.name });
  }
  async function run() {
    if (!parsed) return;
    setBusy(true);
    try {
      await importTimecard(parsed.data, parsed.name);
      // はじめて取り込んだときに、時刻の形（10進法・60進法）を数字から決めておく
      if (cfg && !cfg.format) await saveTimecardConfig({ format: guessFormat(parsed.data) });
      setMsg({ ok: true, text: `取り込みました（${parsed.data.count}件）。画面で直した時刻はそのまま残っています` });
      setParsed(null);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 rounded-xl border-2 border-dashed border-gray-300 bg-white p-3">
      <p className="text-sm">
        タイムレコーダーのUSBの中の <b>ER201001.csv</b> などを選んでください。何回取り込んでも、同じ日の打刻は新しいもので置き換わります（画面で直した時刻は残ります）。
      </p>
      <label className="mt-2 inline-block cursor-pointer rounded-lg bg-berry px-4 py-2 font-bold text-white">
        CSVを選ぶ
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
      </label>
      {parsed && (
        <div className="mt-2 rounded-lg bg-gray-50 p-3 text-sm">
          <p className="font-bold">{parsed.name} の中身</p>
          <ul className="mt-1 list-disc pl-5">
            {Object.entries(parsed.data.months)
              .sort()
              .map(([ym, cards]) => (
                <li key={ym}>
                  {Number(ym.slice(0, 4))}年{Number(ym.slice(5))}月：{Object.keys(cards).length}人・
                  {Object.values(cards).reduce((a, d) => a + Object.keys(d).length, 0)}日分
                </li>
              ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button disabled={busy} onClick={run} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50">
              {busy ? "取り込み中…" : "取り込む"}
            </button>
            <button onClick={() => setParsed(null)} className="rounded-lg border px-4 py-2">
              やめる
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}

/** 計算のルール（丸め・休憩・締め日） */
function Rules({ cfg }: { cfg: TimecardConfig }) {
  const [open, setOpen] = useState(false);
  const [roundIn, setRoundIn] = useState(cfg.roundIn);
  const [roundOut, setRoundOut] = useState(cfg.roundOut);
  const [closeDay, setCloseDay] = useState(cfg.closeDay);
  const [format, setFormat] = useState<TimeFormat>(cfg.format ?? "dec");
  const [breaks, setBreaks] = useState<{ over: string; minutes: string }[]>(cfg.breaks.map((b) => ({ over: hm(b.over), minutes: String(b.minutes) })));
  const [msg, setMsg] = useState("");
  const summary = `時刻 ${(cfg.format ?? "dec") === "dec" ? "10進法（10.50＝10時30分）" : "60進法（10:30）"}・出勤 ${cfg.roundIn === 1 ? "丸めない" : `${cfg.roundIn}分単位で切り上げ`}・退勤 ${cfg.roundOut === 1 ? "丸めない" : `${cfg.roundOut}分単位で切り捨て`}・休憩 ${
    cfg.breaks.length ? cfg.breaks.map((b) => `${hm(b.over)}をこえたら${b.minutes}分`).join("、") : "引かない"
  }・締め日 ${cfg.closeDay >= 28 ? "月末" : `${cfg.closeDay}日`}`;
  async function save() {
    const list: BreakRule[] = [];
    for (const b of breaks) {
      if (b.over.trim() === "" && b.minutes.trim() === "") continue;
      const [h, mm] = b.over.split(/[:：]/).map(Number);
      const over = h * 60 + (mm || 0);
      const minutes = Number(b.minutes);
      if (!Number.isFinite(over) || over <= 0 || !Number.isInteger(minutes) || minutes <= 0 || minutes > 180) return setMsg("休憩は「6:00 をこえたら 45 分」のように入れてください");
      list.push({ over, minutes });
    }
    list.sort((a, b) => a.over - b.over);
    await saveTimecardConfig({ format, roundIn, roundOut, closeDay, breaks: list });
    setMsg("保存しました");
  }
  if (!open)
    return (
      <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm">
        計算のルール：{summary}
        <button
          onClick={() => {
            setRoundIn(cfg.roundIn);
            setRoundOut(cfg.roundOut);
            setCloseDay(cfg.closeDay);
            setFormat(cfg.format ?? "dec");
            setBreaks(cfg.breaks.map((b) => ({ over: hm(b.over), minutes: String(b.minutes) })));
            setMsg("");
            setOpen(true);
          }}
          className="ml-2 rounded border bg-white px-2 py-0.5"
        >
          変える
        </button>
      </p>
    );
  const sel = (v: number, set: (n: number) => void, label: (n: number) => string) => (
    <select value={v} onChange={(e) => set(Number(e.target.value))} className="rounded border px-2 py-1">
      {ROUND_CHOICES.map((n) => (
        <option key={n} value={n}>
          {label(n)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="mt-3 space-y-2 rounded-xl border bg-white p-3 text-sm">
      <p className="font-bold">計算のルール</p>
      <p>
        タイムカードの時刻の形：
        <select value={format} onChange={(e) => setFormat(e.target.value as TimeFormat)} className="rounded border px-2 py-1">
          <option value="dec">10進法（10.50＝10時30分。1時間＝100）</option>
          <option value="hm">60進法（10:30＝10時30分）</option>
        </select>
      </p>
      <p>
        出勤の時刻：{sel(roundIn, setRoundIn, (n) => (n === 1 ? "丸めない" : `${n}分単位で切り上げ`))}
        <span className="ml-4">退勤の時刻：{sel(roundOut, setRoundOut, (n) => (n === 1 ? "丸めない" : `${n}分単位で切り捨て`))}</span>
      </p>
      <div>
        休憩（働いた時間が○○をこえたら△分引く。当てはまるうち長いほう）：
        {breaks.map((b, i) => (
          <span key={i} className="ml-2 inline-flex items-center gap-1">
            <input value={b.over} onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, over: e.target.value } : x)))} placeholder="6:00" className="w-16 rounded border px-1 py-0.5" />
            をこえたら
            <input value={b.minutes} onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, minutes: e.target.value } : x)))} placeholder="45" className="w-12 rounded border px-1 py-0.5" />分
            <button onClick={() => setBreaks(breaks.filter((_, j) => j !== i))} className="rounded border px-1.5">
              ✕
            </button>
          </span>
        ))}
        <button onClick={() => setBreaks([...breaks, { over: "", minutes: "" }])} className="ml-2 rounded border px-2 py-0.5">
          ＋ 追加
        </button>
      </div>
      <p>
        締め日：
        <select value={closeDay} onChange={(e) => setCloseDay(Number(e.target.value))} className="rounded border px-2 py-1">
          {CLOSE_DAY_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n >= 28 ? "月末" : `${n}日`}
            </option>
          ))}
        </select>
      </p>
      <div className="flex items-center gap-2">
        <button onClick={save} className="rounded-lg bg-berry px-4 py-1.5 font-bold text-white">
          保存
        </button>
        <button onClick={() => setOpen(false)} className="rounded-lg border px-4 py-1.5">
          閉じる
        </button>
        {msg && <span className={msg === "保存しました" ? "text-green-700" : "text-red-600"}>{msg}</span>}
      </div>
    </div>
  );
}
