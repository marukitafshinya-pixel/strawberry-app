"use client";

// タイムカード：MAXのタイムレコーダーのUSBデータ（CSV）を取り込んで、個人別タイムカード集計表を作る（管理者だけ）
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv } from "@/lib/csv";
import { isValidYmd, shiftMonth, todayJST } from "@/lib/date";
import { reiwa, useEmployees } from "@/lib/payroll";
import { downloadCsv } from "@/lib/report";
import {
  CLOSE_DAY_CHOICES,
  ROUND_CHOICES,
  cardsIn,
  computePerson,
  employeeForCard,
  hm,
  hours2,
  importFixed,
  importTimecard,
  parseMaxTimecardCsv,
  parseRakurakuDat,
  periodDays,
  parseHm,
  periodMonths,
  saveTimecardConfig,
  saveTimecardBreak,
  saveTimecardEdit,
  startTimeOn,
  useTimecardConfig,
  useTimecardMonths,
  type BreakWindow,
  type RoundDir,
  type StartTime,
  type FixedPeople,
  type ParsedTimecard,
  type TimecardConfig,
} from "@/lib/timecard";
import { TimecardSheet } from "./Sheet";

const mdOf = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export default function TimecardPage() {
  const { role } = useAuth();
  // 給与の月（ふつうは先月分を計算する）
  const [month, setMonth] = useState(() => shiftMonth(todayJST().slice(0, 7), -1));
  const { value: cfg, error: cfgError } = useTimecardConfig();
  // 一度だけ：はじめの版で保存した丸めの向き（出勤は切り捨て・退勤は切り上げ）が逆だったので直す
  useEffect(() => {
    if (role !== "admin" || !cfg || cfg.rulesVersion === 2) return;
    void saveTimecardConfig({ inDir: "up", outDir: "down", rulesVersion: 2 });
  }, [role, cfg]);
  const { value: employees } = useEmployees();
  const months = periodMonths(month, cfg?.closeDay ?? 31);
  const data = useTimecardMonths(months);
  /** 個人別タイムカード集計表の小窓で見ているカード（null＝閉じている） */
  const [card, setCard] = useState<string | null>(null);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (cfgError) return <p className="text-red-600">{cfgError}</p>;

  const [y, m] = month.split("-").map(Number);
  const title = `${reiwa(y)} ${m}月度分`;
  const days = cfg ? periodDays(month, cfg.closeDay) : [];
  const people =
    cfg && data && employees
      ? cardsIn(month, data, cfg).map((c) => {
          const e = employeeForCard(c, cfg, employees);
          return { p: computePerson(c, month, data, cfg, { noOvertime: e?.manager }), e };
        })
      : null;
  const nameOf = (c: string) => (cfg && employees ? (employeeForCard(c, cfg, employees)?.name ?? `（カード${c}・従業員が未設定）`) : "");
  const selected =
    card && cfg && data ? computePerson(card, month, data, cfg, { noOvertime: !!employees && employeeForCard(card, cfg, employees)?.manager }) : null;
  const cardList = people?.map((x) => x.p.card) ?? [];
  const at = card ? cardList.indexOf(card) : -1;

  return (
    <>
      <p className="text-sm print:hidden">
        <Link href="/staff/payroll/" className="text-gray-500 underline">
          ← 給与の打ち込み
        </Link>
        <Link href="/staff/payroll/employees/" className="ml-4 text-gray-500 underline">
          従業員の登録
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">タイムカード</h1>
      {/* 給与のしくみができあがるまではテスト。ここの数字は、給与の打ち込み（payrolls）には書き込まない */}
      <p className="mt-2 rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
        テスト中：この画面の数字は、「給与の打ち込み」や給与集計表には反映されません（確定した給与はそのままです）。
      </p>

      <ImportBox cfg={cfg} employees={employees ?? []} />

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
        {people && people.length > 0 && (
          // 見比べ用：1人1行で、出勤日数・労働時間・残業を書き出す（弥生への取り込み用の形は、弥生の見本がそろってから）
          <button
            onClick={() =>
              downloadCsv(`timecard_${month}.csv`, [
                [
                  "カード番号",
                  "社員番号",
                  "氏名",
                  "出勤日数",
                  "労働時間（時:分）",
                  "労働時間（時間）",
                  "残業でない分（時間）",
                  "残業（時:分）",
                  "残業（時間）",
                  "要確認の日数",
                ],
                ...people.map(({ p, e }) => [
                  p.card,
                  e?.code ?? "",
                  e?.name ?? "",
                  p.workDays,
                  hm(p.work),
                  hours2(p.work),
                  hours2(p.work - p.over),
                  hm(p.over),
                  hours2(p.over),
                  p.problems,
                ]),
              ])
            }
            className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm"
          >
            ⬇ 集計をCSVで書き出す
          </button>
        )}
        {people && people.length > 0 && (
          // 弥生給与の「明細データのインポート」用：1人1行（従業員コード・氏名・出勤日数・実働時間・普通残業時間）。Shift_JIS
          <button
            onClick={() => {
              const missing = people.filter((x) => !x.e).map((x) => `カード${x.p.card}`);
              if (missing.length && !window.confirm(`従業員とひも付いていないカードは書き出しません：${missing.join("、")}\nこのまま書き出しますか？`)) return;
              downloadCsv(
                `yayoi_kintai_${month}.csv`,
                [
                  ["従業員コード", "氏名", "出勤日数", "実働時間", "普通残業時間"],
                  ...people
                    .filter((x) => x.e)
                    .map(({ p, e }) => [
                      e!.code,
                      e!.name,
                      p.workDays.toFixed(2),
                      hm(p.work),
                      // 残業代を払うのはアルバイト（区分を決めていない人も含む）だけ。社員・役員・管理職は空欄
                      !e!.manager && (!e!.kind || e!.kind === "part") && p.over ? hm(p.over) : "",
                    ]),
                ],
                { shiftJis: true },
              );
            }}
            className="rounded-lg border border-emerald-600 bg-white px-3 py-2 text-sm text-emerald-800"
            title="弥生給与の「明細データのインポート」で読み込むファイル（Shift_JIS）"
          >
            ⬇ 弥生に取り込むファイル
          </button>
        )}
        {people && people.length > 0 && (
          <button onClick={() => setCard(cardList[0])} className="rounded-lg bg-berry px-4 py-2 text-sm font-bold text-white">
            📝 個人別タイムカード集計表（見る・直す）
          </button>
        )}
        <Link
          href={`/staff/payroll/timecard/print/?month=${month}`}
          className={`${people && people.length > 0 ? "" : "ml-auto "}rounded-lg border bg-white px-3 py-2 text-sm`}
        >
          🖨 全員の集計表を印刷
        </Link>
      </div>

      {cfg && <Rules cfg={cfg} />}

      {!people ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : people.length === 0 ? (
        <p className="mt-4 rounded-lg border bg-white p-4 text-gray-600">
          この月のタイムカードはまだありません。上の「ファイルを選ぶ」から、タイムレコーダーのUSBのデータを取り込んでください。
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">カード</th>
                <th className="px-3 py-2">氏名</th>
                <th className="px-3 py-2 text-right">出勤日数</th>
                <th className="px-3 py-2 text-right">労働時間</th>
                <th className="px-3 py-2 text-right">うち残業</th>
                <th className="px-3 py-2">確認</th>
              </tr>
            </thead>
            <tbody>
              {people.map(({ p, e }) => (
                <tr key={p.card} className="border-t">
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
                    {hm(p.work)}
                    <span className="ml-1 text-xs font-normal text-gray-500">（{hours2(p.work)}h）</span>
                  </td>
                  <td className="px-3 py-2 text-right">{e?.manager ? <span className="text-xs text-gray-500">管理職</span> : p.over ? hm(p.over) : ""}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.problems > 0 && <span className="mr-2 font-bold text-red-700">要確認 {p.problems}件</span>}
                    {p.edited > 0 && <span className="text-amber-800">直した {p.edited}件</span>}
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
                <td className="px-3 py-2 text-right">{hm(people.reduce((a, x) => a + x.p.work, 0))}</td>
                <td className="px-3 py-2 text-right">{hm(people.reduce((a, x) => a + x.p.over, 0))}</td>
                <td className="px-3 py-2 text-xs text-red-700">
                  {people.some((x) => x.p.problems) ? `要確認 ${people.reduce((a, x) => a + x.p.problems, 0)}件` : ""}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {selected && card && (
        // 個人別タイムカード集計表の小窓。名前のプルダウンと「前・次」で、カード番号の順に見ていける
        <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-3" onClick={() => setCard(null)}>
          <div className="my-2 w-full max-w-5xl rounded-2xl bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button disabled={at <= 0} onClick={() => setCard(cardList[at - 1])} className="rounded-lg border px-3 py-2 disabled:opacity-30">
                ‹ 前へ
              </button>
              <select value={card} onChange={(e) => setCard(e.target.value)} className="min-w-56 rounded-lg border-2 border-berry px-3 py-2 text-lg font-bold">
                {people?.map(({ p }) => (
                  <option key={p.card} value={p.card}>
                    {p.card}　{nameOf(p.card)}
                    {p.problems ? `（要確認${p.problems}）` : ""}
                  </option>
                ))}
              </select>
              <button
                disabled={at < 0 || at >= cardList.length - 1}
                onClick={() => setCard(cardList[at + 1])}
                className="rounded-lg border px-3 py-2 disabled:opacity-30"
              >
                次へ ›
              </button>
              <span className="text-sm text-gray-500">
                {at + 1} / {cardList.length}人
              </span>
              <Link href={`/staff/payroll/timecard/print/?month=${month}&card=${card}`} className="ml-auto rounded-lg border bg-white px-3 py-2 text-sm">
                🖨 この人の集計表を印刷
              </Link>
              <button onClick={() => setCard(null)} className="rounded-lg border px-4 py-2 font-bold">
                ✕ 閉じる
              </button>
            </div>
            <p className="mb-2 text-sm text-gray-600">
              赤い行は打刻もれなどです。「出勤」「退勤」（打刻）のマスを押すと、テンキーで時刻を入れてエンターで直せます（1730＝17:30）。「休憩」のマスも同じように分で直せます（30＝30分）。直す前は確認欄に「退勤
              17:04→18:04」のように残ります。
            </p>
            <TimecardSheet
              person={selected}
              name={nameOf(card)}
              title={title}
              edit={{ time: (date, e) => saveTimecardEdit(date, card, e), brk: (date, m) => saveTimecardBreak(date, card, m) }}
            />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * USBのCSV、または楽々勤怠の統合用ファイル（修正後の打刻）を選んで、中身を確かめてから取り込む。
 * 楽々勤怠のファイルは、USBの元の打刻に「直した時刻」として重ねる（元の打刻 → 直した時刻 が確認欄に出る）
 */
function ImportBox({ cfg, employees }: { cfg: TimecardConfig | null; employees: { id: string; code: string; name: string }[] }) {
  const [parsed, setParsed] = useState<{ data: ParsedTimecard; name: string; people?: FixedPeople } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function pick(file: File) {
    setMsg(null);
    setParsed(null);
    const { text } = decodeCsv(await file.arrayBuffer());
    // 楽々勤怠の統合用ファイルは、日付が「2026/09/01」の4けたの年で書いてある
    if (/"?\d{4}\/\d{2}\/\d{2}"?/.test(text.slice(0, 5000))) {
      const r = parseRakurakuDat(text);
      if (r.error || !r.data) return setMsg({ ok: false, text: r.error ?? "読めませんでした" });
      return setParsed({ data: r.data, name: file.name, people: r.people });
    }
    const r = parseMaxTimecardCsv(text);
    if (r.error || !r.data) return setMsg({ ok: false, text: r.error ?? "読めませんでした" });
    setParsed({ data: r.data, name: file.name });
  }
  /** 楽々勤怠の社員コードで、まだ従業員とひも付いていないカードをひも付ける */
  async function linkCards(people: FixedPeople): Promise<number> {
    if (!cfg) return 0;
    const cards = { ...cfg.cards };
    let n = 0;
    for (const [card, p] of Object.entries(people)) {
      if (cards[card]) continue;
      const e = employees.find((x) => x.code.trim() === p.code);
      if (!e) continue;
      cards[card] = e.id;
      n++;
    }
    if (n) await saveTimecardConfig({ cards });
    return n;
  }
  async function run() {
    if (!parsed) return;
    setBusy(true);
    try {
      if (parsed.people) {
        const changed = await importFixed(parsed.data);
        const linked = await linkCards(parsed.people);
        setMsg({
          ok: true,
          text: `楽々勤怠の修正後の打刻を重ねました。USBの打刻と違った ${changed} 日分を「直した時刻」にしました（確認欄に 元の時刻→直した時刻 が出ます）。${linked ? `カード${linked}枚を、社員コードで従業員とひも付けました。` : ""}`,
        });
      } else {
        await importTimecard(parsed.data, parsed.name);
        setMsg({ ok: true, text: `取り込みました（${parsed.data.count}件）。画面で直した時刻はそのまま残っています` });
      }
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
        タイムレコーダーのUSBの中の <b>ER201001.csv</b>{" "}
        などを選んでください。何回取り込んでも、同じ日の打刻は新しいもので置き換わります（画面で直した時刻は残ります）。
        <br />
        楽々勤怠で直した月は、楽々勤怠から書き出したファイル（「データ処理 → 統合用ファイル作成」の <b>.dat</b>、または「修正／参照」の <b>CSV</b>
        ）も選べます。USBの打刻を先に取り込んでから選ぶと、楽々勤怠で直した時刻が「直した時刻」として入ります。
      </p>
      <label className="mt-2 inline-block cursor-pointer rounded-lg bg-berry px-4 py-2 font-bold text-white">
        ファイルを選ぶ
        <input
          type="file"
          accept=".csv,text/csv,.dat"
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
          <p className="font-bold">
            {parsed.name} の中身{parsed.people && "（楽々勤怠の修正後の打刻）"}
          </p>
          {parsed.people && (
            <p className="mt-1 text-amber-800">
              USBの元の打刻と違う日は、楽々勤怠の時刻を「直した時刻」として入れます。この画面で前に直した時刻は、楽々勤怠の時刻に置き換わります。
            </p>
          )}
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

const dirText = (unit: number, dir: RoundDir) => (unit <= 1 ? "丸めない" : `${unit}分単位で${dir === "up" ? "切り上げ" : "切り捨て"}`);

/** 計算のルール（会社の出勤時刻・丸め・休憩・残業・締め日） */
function Rules({ cfg }: { cfg: TimecardConfig }) {
  const [open, setOpen] = useState(false);
  const [roundIn, setRoundIn] = useState(cfg.roundIn);
  const [inDir, setInDir] = useState<RoundDir>(cfg.inDir);
  const [roundOut, setRoundOut] = useState(cfg.roundOut);
  const [outDir, setOutDir] = useState<RoundDir>(cfg.outDir);
  const [closeDay, setCloseDay] = useState(cfg.closeDay);
  const [overtime, setOvertime] = useState(hm(cfg.overtimeOver));
  const [starts, setStarts] = useState<{ from: string; time: string }[]>([]);
  const [breaks, setBreaks] = useState<{ start: string; end: string }[]>([]);
  const [msg, setMsg] = useState("");
  const today = todayJST();
  const nowStart = startTimeOn(today, cfg);
  const summary = [
    `会社の出勤時刻 ${nowStart === null ? "未設定" : `${hm(nowStart)}（今日）`}`,
    `出勤 ${dirText(cfg.roundIn, cfg.inDir)}`,
    `退勤 ${dirText(cfg.roundOut, cfg.outDir)}`,
    `休憩 ${cfg.breaks.length ? cfg.breaks.map((b) => `${hm(b.start)}〜${hm(b.end)}`).join("、") : "なし"}`,
    `残業 1日${hm(cfg.overtimeOver)}をこえた分`,
    `締め日 ${cfg.closeDay >= 28 ? "月末" : `${cfg.closeDay}日`}`,
  ].join("・");
  function start() {
    setRoundIn(cfg.roundIn);
    setInDir(cfg.inDir);
    setRoundOut(cfg.roundOut);
    setOutDir(cfg.outDir);
    setCloseDay(cfg.closeDay);
    setOvertime(hm(cfg.overtimeOver));
    setStarts([...cfg.startTimes].sort((a, b) => a.from.localeCompare(b.from)).map((s) => ({ from: s.from, time: hm(s.time) })));
    setBreaks(cfg.breaks.map((b) => ({ start: hm(b.start), end: hm(b.end) })));
    setMsg("");
    setOpen(true);
  }
  async function save() {
    const startTimes: StartTime[] = [];
    for (const s of starts) {
      if (!s.from && !s.time.trim()) continue;
      const t = parseHm(s.time);
      if (!isValidYmd(s.from) || t === null || t === undefined) return setMsg("会社の出勤時刻は、使い始める日と時刻（6:00 など）を入れてください");
      startTimes.push({ from: s.from, time: t });
    }
    const list: BreakWindow[] = [];
    for (const b of breaks) {
      if (!b.start.trim() && !b.end.trim()) continue;
      const st = parseHm(b.start);
      const en = parseHm(b.end);
      if (st === null || st === undefined || en === null || en === undefined || en <= st) return setMsg("休憩は「12:00〜13:00」のように入れてください");
      list.push({ start: st, end: en });
    }
    const ot = parseHm(overtime);
    if (ot === null || ot === undefined || ot <= 0) return setMsg("残業は「8:00」のように入れてください");
    startTimes.sort((a, b) => a.from.localeCompare(b.from));
    list.sort((a, b) => a.start - b.start);
    await saveTimecardConfig({ startTimes, roundIn, inDir, roundOut, outDir, breaks: list, overtimeOver: ot, closeDay, rulesVersion: 2 });
    setMsg("保存しました");
  }
  if (!open)
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border-2 border-sky-200 bg-sky-50 px-3 py-2 text-sm">
        <span className="font-bold">⚙ 計算のルール</span>
        <span className="min-w-0 flex-1 text-gray-700">{summary}</span>
        <button onClick={start} className="rounded-lg bg-sky-700 px-4 py-2 font-bold text-white">
          ルール（出勤時刻など）を変える
        </button>
      </div>
    );
  const roundSel = (unit: number, setUnit: (n: number) => void, dir: RoundDir, setDir: (d: RoundDir) => void) => (
    <>
      <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="rounded border px-2 py-1">
        {ROUND_CHOICES.map((n) => (
          <option key={n} value={n}>
            {n === 1 ? "丸めない" : `${n}分単位で`}
          </option>
        ))}
      </select>
      {unit > 1 && (
        <select value={dir} onChange={(e) => setDir(e.target.value as RoundDir)} className="ml-1 rounded border px-2 py-1">
          <option value="down">切り捨て</option>
          <option value="up">切り上げ</option>
        </select>
      )}
    </>
  );
  const input = "rounded border px-1 py-0.5";
  return (
    <div className="mt-3 space-y-3 rounded-xl border bg-white p-3 text-sm">
      <p className="font-bold">計算のルール</p>
      <div>
        <p>
          会社の出勤時刻（時期によって変えるときは、使い始める日ごとに追加）。<b>この時刻より前に押した分は数えません</b>。
        </p>
        {starts.map((s, i) => (
          <p key={i} className="mt-1 flex items-center gap-1">
            <input
              type="date"
              value={s.from}
              onChange={(e) => setStarts(starts.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))}
              className={input}
            />
            から
            <input
              value={s.time}
              onChange={(e) => setStarts(starts.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
              placeholder="6:00"
              className={`${input} w-16`}
            />
            <button onClick={() => setStarts(starts.filter((_, j) => j !== i))} className="rounded border px-1.5">
              ✕
            </button>
          </p>
        ))}
        <button onClick={() => setStarts([...starts, { from: today, time: "" }])} className="mt-1 rounded border px-2 py-0.5">
          ＋ 出勤時刻を追加
        </button>
      </div>
      <p>
        出勤の時刻：{roundSel(roundIn, setRoundIn, inDir, setInDir)}
        <span className="ml-4">退勤の時刻：{roundSel(roundOut, setRoundOut, outDir, setOutDir)}</span>
      </p>
      <div>
        休憩の時間帯（働いた時間と重なる分だけ引きます）：
        {breaks.map((b, i) => (
          <span key={i} className="ml-2 inline-flex items-center gap-1">
            <input
              value={b.start}
              onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
              placeholder="12:00"
              className={`${input} w-16`}
            />
            〜
            <input
              value={b.end}
              onChange={(e) => setBreaks(breaks.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
              placeholder="13:00"
              className={`${input} w-16`}
            />
            <button onClick={() => setBreaks(breaks.filter((_, j) => j !== i))} className="rounded border px-1.5">
              ✕
            </button>
          </span>
        ))}
        <button onClick={() => setBreaks([...breaks, { start: "", end: "" }])} className="ml-2 rounded border px-2 py-0.5">
          ＋ 追加
        </button>
      </div>
      <p>
        残業：1日に
        <input value={overtime} onChange={(e) => setOvertime(e.target.value)} placeholder="8:00" className={`${input} mx-1 w-16`} />
        をこえて働いた分（時給25％増しの計算は、弥生給与で行います）
      </p>
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
