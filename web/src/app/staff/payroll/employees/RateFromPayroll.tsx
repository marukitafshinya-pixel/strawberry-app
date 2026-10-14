"use client";

// 時給を、もう入っている給与（基本給（時給））とタイムカードから逆算して、まとめて入れる。
// 時給 ×（残業でない時間 ＋ 残業 × 1.25）が支給額とぴったり合う人だけを、はじめから選んでおく
import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { useState } from "react";
import { errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { hourlyBasePay, paysOvertime, rateFromPay, reiwa, usePayroll, type Employee } from "@/lib/payroll";
import { cardsIn, computePerson, employeeForCard, hm, periodMonths, useTimecardConfig, useTimecardMonths } from "@/lib/timecard";

type Cand = { e: Employee; amount: number; work: number; over: number; rate: number | null; exact: boolean };

export function RateFromPayroll({ employees }: { employees: Employee[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded-2xl border border-sky-300 bg-sky-50 p-3 text-sm">
      <button onClick={() => setOpen(!open)} className="font-bold text-sky-900">
        {open ? "▼" : "▶"} 時給を、給与とタイムカードから計算して入れる
      </button>
      {open && <Panel employees={employees} />}
    </div>
  );
}

function Panel({ employees }: { employees: Employee[] }) {
  const [month, setMonth] = useState(() => shiftMonth(todayJST().slice(0, 7), -1));
  const { value: cfg } = useTimecardConfig();
  const data = useTimecardMonths(periodMonths(month, cfg?.closeDay ?? 31));
  const { value: payroll } = usePayroll(month);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  let cands: Cand[] | null = null;
  if (cfg && data && payroll) {
    cands = [];
    for (const card of cardsIn(month, data, cfg)) {
      const e = employeeForCard(card, cfg, employees);
      const amount = e ? (payroll.rows[e.id]?.hourly ?? 0) : 0;
      if (!e || !amount) continue;
      const p = computePerson(card, month, data, cfg, { noOvertime: e.manager });
      const ot = paysOvertime(e);
      const rate = rateFromPay(amount, p.work, p.over, ot);
      cands.push({ e, amount, work: p.work, over: ot ? p.over : 0, rate, exact: rate !== null && hourlyBasePay(rate, p.work, p.over, ot) === amount });
    }
  }
  /** はじめは、ぴったり合って、今の時給と違う人を選んでおく */
  const isPicked = (c: Cand) => picked[c.e.id] ?? (c.exact && c.rate !== c.e.hourlyRate);
  const [y, m] = month.split("-").map(Number);

  async function save() {
    if (!cands) return;
    const list = cands.filter((c) => isPicked(c) && c.rate);
    if (!list.length) return;
    setSaving(true);
    setMsg("");
    try {
      const { db } = await getFirebase();
      for (const c of list) await updateDoc(doc(db, `employees/${c.e.id}`), { hourlyRate: c.rate, updatedAt: serverTimestamp() });
      setMsg(`${list.length}人の時給を入れました`);
      setPicked({});
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2">
      <p className="text-gray-700">
        給与の「基本給（時給）」とタイムカードの時間から、時給を逆算します。アルバイトは 時給 ×（残業でない時間 ＋ 残業 × 1.25）で計算します。
        計算し直した金額が支給額とぴったり合う人だけ、はじめからチェックが付いています。
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-1">
          ◀
        </button>
        <span className="font-bold">
          {reiwa(y)} {m}月度分
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-1">
          ▶
        </button>
      </div>
      {!cands ? (
        <p className="mt-2 text-gray-500">読み込み中…</p>
      ) : cands.length === 0 ? (
        <p className="mt-2 text-gray-600">この月は、給与の「基本給（時給）」とタイムカードの両方がある人がいません。</p>
      ) : (
        <>
          <div className="mt-2 overflow-x-auto rounded-xl bg-white">
            <table className="w-full min-w-max tabular-nums">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="px-2 py-1" />
                  <th className="px-2 py-1">氏名</th>
                  <th className="px-2 py-1 text-right">支給した基本給（時給）</th>
                  <th className="px-2 py-1 text-right">労働時間</th>
                  <th className="px-2 py-1 text-right">うち残業（1.25倍）</th>
                  <th className="px-2 py-1 text-right">計算した時給</th>
                  <th className="px-2 py-1 text-right">今の時給</th>
                  <th className="px-2 py-1">確認</th>
                </tr>
              </thead>
              <tbody>
                {cands.map((c) => (
                  <tr key={c.e.id} className="border-t">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        disabled={!c.rate}
                        checked={!!c.rate && isPicked(c)}
                        onChange={(x) => setPicked({ ...picked, [c.e.id]: x.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1">
                      {c.e.code} {c.e.name}
                    </td>
                    <td className="px-2 py-1 text-right">{c.amount.toLocaleString("ja-JP")}円</td>
                    <td className="px-2 py-1 text-right">{hm(c.work)}</td>
                    <td className="px-2 py-1 text-right">{c.over ? hm(c.over) : ""}</td>
                    <td className="px-2 py-1 text-right font-bold">{c.rate ? `${c.rate.toLocaleString("ja-JP")}円` : ""}</td>
                    <td className="px-2 py-1 text-right">{c.e.hourlyRate ? `${c.e.hourlyRate.toLocaleString("ja-JP")}円` : ""}</td>
                    <td className="px-2 py-1 text-xs">
                      {c.exact ? (
                        <span className="text-emerald-700">ぴったり</span>
                      ) : (
                        <span className="font-bold text-red-700">
                          合いません
                          {c.rate ? `（この時給だと ${hourlyBasePay(c.rate, c.work, c.over, true).toLocaleString("ja-JP")}円）` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            「合いません」の人は、タイムカードを直した分が給与と違うか、時給が途中で変わった人です。時給は「編集」から手で入れてください。
          </p>
          <button
            onClick={() => void save()}
            disabled={saving || !cands.some((c) => c.rate && isPicked(c))}
            className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40"
          >
            {saving ? "保存中…" : `チェックした${cands.filter((c) => c.rate && isPicked(c)).length}人の時給を入れる`}
          </button>
        </>
      )}
      {msg && <p className="mt-2">{msg}</p>}
    </div>
  );
}
