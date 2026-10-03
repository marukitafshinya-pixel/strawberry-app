"use client";

// 今使っている勤務表のExcelを取り込む（従業員・記号・予定）
// 形：A列に「日付」の行（日にち）、その上に「8月」などの月、「予定」の行、名前の行（空いた行でまとまりが分かれる）、「〜人数」の行で終わり
import { collection, doc, serverTimestamp, writeBatch } from "firebase/firestore";
import { useRef, useState } from "react";
import { errorText } from "@/lib/callFunction";
import { getFirebase } from "@/lib/firebase";
import type { ShiftConfig, ShiftMember } from "@/lib/shift";
import { openWorkbook } from "@/lib/xlsx";

type Parsed = {
  dates: { col: number; date: string }[];
  notes: Record<string, string>;
  people: { name: string; block: number; cells: Record<string, string> }[];
  unknown: string[];
};

const normName = (s: string) => s.replace(/[\s　]+/g, "");
const toHalf = (s: string) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

export function parseShiftSheet(table: string[][], year: number, cfg: ShiftConfig): Parsed | { error: string } {
  const cell = (r: number, c: number) => (table[r]?.[c] ?? "").trim();
  const dayRow = table.findIndex((row) => (row?.[0] ?? "").trim() === "日付");
  if (dayRow < 0) return { error: "A列に「日付」の行が見つかりません" };
  // 月：日付の行より上にある「8月」などから、最初の月を決める。日にちが小さくなったら次の月
  let month = 0;
  for (let r = 0; r < dayRow && !month; r++)
    for (let c = 1; c < (table[r]?.length ?? 0); c++) {
      const m = toHalf(cell(r, c)).match(/^(\d{1,2})\s*月/);
      if (m) {
        month = Number(m[1]);
        break;
      }
    }
  if (!month) return { error: "「8月」のような月の見出しが見つかりません" };
  let y = year;
  let prev = 0;
  const dates: Parsed["dates"] = [];
  for (let c = 1; c < (table[dayRow]?.length ?? 0); c++) {
    const d = Number(toHalf(cell(dayRow, c)));
    if (!Number.isInteger(d) || d < 1 || d > 31) continue;
    if (prev && d < prev) {
      month++;
      if (month > 12) {
        month = 1;
        y++;
      }
    }
    prev = d;
    dates.push({ col: c, date: `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  // 日付の列が少ないときは、右へ続く列にも同じ人の記号があるので、間を1日ずつ足して延ばす
  const maxCol = Math.max(...table.map((r) => r?.length ?? 0));
  if (dates.length) {
    let last = dates[dates.length - 1];
    for (let c = last.col + 1; c < maxCol; c++) {
      const next = new Date(Date.parse(`${last.date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
      last = { col: c, date: next };
      dates.push(last);
    }
  }
  const notes: Record<string, string> = {};
  const noteRow = table.findIndex((row) => (row?.[0] ?? "").trim() === "予定");
  if (noteRow >= 0) for (const { col, date } of dates) if (cell(noteRow, col)) notes[date] = cell(noteRow, col).slice(0, 50);

  const people: Parsed["people"] = [];
  const known = new Set(cfg.codes.map((c) => c.code));
  const unknown = new Set<string>();
  let block = 0;
  let started = false;
  for (let r = dayRow + 1; r < table.length; r++) {
    const a = cell(r, 0);
    if (/人数/.test(a)) break;
    if (!a) {
      if (started) block++;
      continue;
    }
    if (a === "予定" || a === "曜日" || /^列\d+$/.test(a) || /^列\d+$/.test(cell(r, 1))) continue;
    started = true;
    const cells: Record<string, string> = {};
    for (const { col, date } of dates) {
      const v = cell(r, col);
      if (!v) continue;
      cells[date] = v.slice(0, 10);
      if (!known.has(v)) unknown.add(v);
    }
    people.push({ name: a.replace(/\s+/g, " ").slice(0, 30), block, cells });
  }
  if (!people.length) return { error: "名前の行が見つかりません" };
  // まとまりの番号を 0,1,2… に詰める
  const blocks = [...new Set(people.map((p) => p.block))];
  for (const p of people) p.block = blocks.indexOf(p.block);
  return { dates, notes, people, unknown: [...unknown] };
}

export function ShiftImport({ cfg, members }: { cfg: ShiftConfig; members: ShiftMember[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [table, setTable] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function pick(f: File) {
    setMsg("");
    try {
      const book = await openWorkbook(await f.arrayBuffer());
      // 「日付」の行があるシートを使う
      for (const name of book.sheetNames) {
        const t = await book.readSheet(name);
        if (t.some((row) => (row?.[0] ?? "").trim() === "日付")) {
          setTable(t);
          setFileName(`${f.name}（${name}）`);
          return;
        }
      }
      setMsg("「日付」の行があるシートが見つかりません");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const parsed = table ? parseShiftSheet(table, year, cfg) : null;
  const byName = new Map(members.map((m) => [normName(m.name), m]));

  async function run() {
    if (!parsed || "error" in parsed) return;
    setBusy(true);
    setMsg("");
    try {
      const { db } = await getFirebase();
      let order = members.length ? Math.max(...members.map((m) => m.order)) + 1 : 0;
      const ids = new Map<string, string>();
      const batch = writeBatch(db);
      for (const p of parsed.people) {
        const ex = byName.get(normName(p.name));
        if (ex) ids.set(p.name, ex.id);
        else {
          const ref = doc(collection(db, "shiftMembers"));
          const group = cfg.groups[Math.min(p.block, cfg.groups.length - 1)] ?? "";
          batch.set(ref, { name: p.name, group, floor: group === "売り場担当可", order: order++, active: true, updatedAt: serverTimestamp() });
          ids.set(p.name, ref.id);
        }
      }
      await batch.commit();
      // 日ごとに書く（1回に400日まで）
      const byDate = new Map<string, Record<string, string>>();
      for (const p of parsed.people) for (const [d, v] of Object.entries(p.cells)) (byDate.get(d) ?? byDate.set(d, {}).get(d)!)[ids.get(p.name)!] = v;
      const dates = [...new Set([...byDate.keys(), ...Object.keys(parsed.notes)])].sort();
      for (let i = 0; i < dates.length; i += 400) {
        const b = writeBatch(db);
        for (const d of dates.slice(i, i + 400))
          b.set(doc(db, `shiftDays/${d}`), { ...(byDate.has(d) ? { cells: byDate.get(d) } : {}), ...(parsed.notes[d] ? { note: parsed.notes[d] } : {}), updatedAt: serverTimestamp() }, { merge: true });
        await b.commit();
      }
      setMsg(`取り込みました（${parsed.people.length}人・${dates.length}日分）`);
      setTable(null);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xlsb"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) pick(f);
        }}
      />
      <button onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-2.5 py-1.5 text-sm">
        Excelの勤務表から取り込む
      </button>
      {msg && <span className="text-sm text-gray-700">{msg}</span>}
      {parsed && (
        <div className="mt-3 w-full rounded-xl border border-berry/40 p-3 text-sm">
          <p className="font-bold">取り込みの確認（{fileName}）</p>
          {"error" in parsed ? (
            <p className="mt-1 text-red-600">{parsed.error}</p>
          ) : (
            <>
              <label className="mt-1 flex items-center gap-2">
                最初の月は何年ですか
                <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded border px-2 py-1">
                  {[year - 1, year, year + 1].map((y) => (
                    <option key={y} value={y}>
                      {y}年
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-1">
                期間：{parsed.dates[0]?.date} 〜 {parsed.dates[parsed.dates.length - 1]?.date}（{parsed.dates.length}日）・予定 {Object.keys(parsed.notes).length}件
              </p>
              <p className="mt-1">
                従業員 {parsed.people.length}人（新しく登録：{parsed.people.filter((p) => !byName.has(normName(p.name))).length}人）
              </p>
              <ul className="mt-1 flex flex-wrap gap-1">
                {parsed.people.map((p) => (
                  <li key={p.name} className={`rounded px-2 py-0.5 ${byName.has(normName(p.name)) ? "bg-gray-100" : "bg-emerald-50 text-emerald-900"}`}>
                    {p.name}
                    <span className="ml-1 text-xs text-gray-500">{cfg.groups[Math.min(p.block, cfg.groups.length - 1)]}</span>
                  </li>
                ))}
              </ul>
              {parsed.unknown.length > 0 && <p className="mt-1 text-amber-800">設定にない記号があります（そのまま入ります）：{parsed.unknown.join("、")}</p>}
              <p className="mt-1 text-xs text-gray-600">新しく登録する人のまとまりは、Excelの空いた行で分かれた順に「{cfg.groups.join("・")}」にします。違っていたら、あとで従業員リストで直してください。すでにある人は名前で見つけて、その人の行に入れます。</p>
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={run} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50">
                  {busy ? "取り込んでいます…" : "取り込む"}
                </button>
                <button onClick={() => setTable(null)} className="rounded-lg border px-4 py-2">
                  やめる
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
