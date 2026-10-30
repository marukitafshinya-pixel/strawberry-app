"use client";

// 日ごとの出勤記入用紙（1日1枚・A4縦）：勤務管理表の従業員全員の名前と、出勤・退勤・休憩を手で書きこむマス。
// タイムレコーダーを使わない日に記録をとって、あとでタイムカードの画面で時刻を入れるため
import Link from "next/link";
import { useState } from "react";
import { sortMembers } from "@/app/staff/shift/ShiftTable";
import { useAuth } from "@/lib/auth";
import { addDays, todayJST } from "@/lib/date";
import { useShiftConfig, useShiftDays, useShiftMembers } from "@/lib/shift";

const WD = "日月火水木金土";
const dayLabel = (d: string) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日（${WD[wd]}）`;
};

export default function DailySheetPage() {
  const { role } = useAuth();
  const [from, setFrom] = useState(() => addDays(todayJST(), 1));
  const [to, setTo] = useState(() => addDays(todayJST(), 2));
  const members = useShiftMembers();
  const cfg = useShiftConfig();
  const days = useShiftDays(from, to);
  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  if (!members || !cfg) return <p className="text-gray-500">読み込み中…</p>;

  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 31; d = addDays(d, 1)) dates.push(d);
  // 勤務管理表の並び（まとまりの順、その中は並び順）で、表に出している人
  const people = sortMembers(
    members.filter((m) => m.active),
    cfg,
  );

  return (
    <>
      <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } .daily-sheet { break-after: page; } .daily-sheet:last-child { break-after: auto; } }`}</style>
      <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
        <Link href="/staff/payroll/timecard/" className="text-gray-500 underline">
          ← タイムカード
        </Link>
        <label className="ml-4 text-sm">
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="rounded border px-2 py-1" />
        </label>
        <span>〜</span>
        <label className="text-sm">
          <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="rounded border px-2 py-1" />
        </label>
        <button onClick={() => window.print()} className="ml-auto rounded-lg bg-berry px-4 py-2 font-bold text-white">
          🖨 印刷する（{dates.length}日分）
        </button>
      </div>
      <p className="mb-3 text-sm text-gray-600 print:hidden">
        勤務管理表の従業員全員を、1日1枚に出します。「勤務表」の欄は、その日の勤務管理表の記号です（休みの人も名前は出します）。
      </p>
      <div className="space-y-8 bg-white print:space-y-0">
        {dates.map((d) => {
          const cells = days?.[d]?.cells ?? {};
          return (
            <section key={d} className="daily-sheet">
              <div className="mb-2 flex items-end justify-between">
                <h2 className="text-xl font-bold">出勤記録　{dayLabel(d)}</h2>
                <span className="text-sm text-gray-600">記入者：＿＿＿＿＿＿</span>
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-gray-100">
                    <th className="w-8 border border-gray-500 px-1 py-1">No</th>
                    <th className="border border-gray-500 px-2 py-1 text-left">氏名</th>
                    <th className="w-14 border border-gray-500 px-1 py-1">勤務表</th>
                    <th className="w-24 border border-gray-500 px-1 py-1">出勤</th>
                    <th className="w-24 border border-gray-500 px-1 py-1">退勤</th>
                    <th className="w-20 border border-gray-500 px-1 py-1">休憩（分）</th>
                    <th className="w-32 border border-gray-500 px-1 py-1">備考</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((m, i) => (
                    <tr key={m.id} className="h-9">
                      <td className="border border-gray-500 text-center">{i + 1}</td>
                      <td className="border border-gray-500 px-2">{m.name}</td>
                      <td className="border border-gray-500 text-center text-xs text-gray-600">{cells[m.id] ?? ""}</td>
                      <td className="border border-gray-500 text-center text-gray-300">：</td>
                      <td className="border border-gray-500 text-center text-gray-300">：</td>
                      <td className="border border-gray-500" />
                      <td className="border border-gray-500" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
      </div>
    </>
  );
}
