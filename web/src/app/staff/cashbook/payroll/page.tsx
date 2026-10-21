"use client";

// 給与（見るだけ）：経理担当が月ごとの給与の一覧を見る。入力・修正はできない（管理者の「給与」の画面で行う）。
// 従業員は名前・社員番号・区分だけ。口座・タイムカード・従業員リスト（時給など）は見せない。サーバー（viewPayroll）から必要なものだけ受け取る
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { shiftMonth, todayJST } from "@/lib/date";
import { EMPLOYEE_KINDS, EMPLOYER_ITEMS, PAY_ITEMS, computeRow, reiwa, type PayRow } from "@/lib/payroll";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";

type View = {
  exists: boolean;
  paymentDate: string;
  rows: Record<string, PayRow>;
  employer: Record<string, number>;
  memo: string;
  people: { id: string; code: string; name: string; kind: string | null }[];
};

export default function PayrollViewPage() {
  const { role } = useAuth();
  // 給与はふつう前の月の分なので、最初は先月を開く
  const [month, setMonth] = useState(() => shiftMonth(todayJST().slice(0, 7), -1));
  const [data, setData] = useState<{ month: string; v: View | null; error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    callFunction<{ month: string }, View>("viewPayroll", { month })
      .then((v) => alive && setData({ month, v, error: "" }))
      .catch((e) => alive && setData({ month, v: null, error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [month]);

  if (role !== "accounting" && role !== "admin") return <p>この画面は経理担当と管理者だけが見られます。</p>;
  const [y, m] = month.split("-").map(Number);
  const view = data?.month === month ? data : null;
  const v = view?.v;
  const sum = (f: (r: PayRow) => number) => (v ? v.people.reduce((n, p) => n + f(v.rows[p.id] ?? {}), 0) : 0);
  const itemSum = (k: (typeof PAY_ITEMS)[number]["key"]) => sum((r) => r[k] ?? 0);

  function csv() {
    if (!v) return;
    const head = ["社員番号", "名前", ...PAY_ITEMS.map((x) => x.label), "支給合計", "社会保険料計", "差引支給額"];
    const body = v.people.map((p) => {
      const r = v.rows[p.id] ?? {};
      const t = computeRow(r);
      return [p.code, p.name, ...PAY_ITEMS.map((x) => r[x.key] ?? 0), t.pay, t.social, t.net];
    });
    const total = [
      "",
      "合計",
      ...PAY_ITEMS.map((x) => itemSum(x.key)),
      sum((r) => computeRow(r).pay),
      sum((r) => computeRow(r).social),
      sum((r) => computeRow(r).net),
    ];
    downloadCsv(`給与_${month}.csv`, [head, ...body, total], { shiftJis: true });
  }

  const th = "border-b px-2 py-1.5 text-right font-normal whitespace-nowrap";
  const td = "border-b px-2 py-1.5 text-right tabular-nums whitespace-nowrap";
  return (
    <div className="pb-24">
      <p className="text-sm print:hidden">
        <Link href="/staff/cashbook/" className="text-gray-500 underline">
          ← 現金出納帳
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">
        給与（見るだけ）{" "}
        <span className="text-base font-normal">
          {reiwa(y)} {m}月分
        </span>
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="text-lg font-bold">
          {reiwa(y)} {m}月分
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          次月 ›
        </button>
        {v?.exists && (
          <>
            <button onClick={() => window.print()} className="ml-auto rounded-lg border bg-white px-3 py-2">
              🖨 印刷
            </button>
            <button onClick={csv} className="rounded-lg border bg-white px-3 py-2">
              📄 CSVに書き出す
            </button>
          </>
        )}
      </div>
      {!view ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : view.error ? (
        <p className="mt-4 text-red-600">読み込めませんでした：{view.error}</p>
      ) : !v?.exists || v.people.length === 0 ? (
        <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">この月の給与はまだ入っていません。</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-gray-700">
            支給日：{v.paymentDate || "－"}
            {v.memo && <span className="ml-4">メモ：{v.memo}</span>}
          </p>
          <div className="mt-2 overflow-x-auto rounded-xl border bg-white">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600">
                <tr>
                  <th className="border-b px-2 py-1.5 text-left font-normal">名前</th>
                  {PAY_ITEMS.map((x) => (
                    <th key={x.key} className={th}>
                      {x.label}
                    </th>
                  ))}
                  <th className={`${th} font-bold`}>支給合計</th>
                  <th className={`${th} font-bold`}>社会保険料計</th>
                  <th className={`${th} font-bold`}>差引支給額</th>
                </tr>
              </thead>
              <tbody>
                {v.people.map((p) => {
                  const r = v.rows[p.id] ?? {};
                  const t = computeRow(r);
                  const kind = EMPLOYEE_KINDS.find((k) => k.key === p.kind);
                  return (
                    <tr key={p.id}>
                      <td className="border-b px-2 py-1.5 whitespace-nowrap">
                        <span className="mr-1 text-xs text-gray-500">{p.code}</span>
                        {p.name}
                        {kind && <span className={`ml-1 rounded px-1 text-[10px] ${kind.badge}`}>{kind.label}</span>}
                      </td>
                      {PAY_ITEMS.map((x) => (
                        <td key={x.key} className={td}>
                          {r[x.key] ? yen(r[x.key]!) : ""}
                        </td>
                      ))}
                      <td className={`${td} font-bold`}>{yen(t.pay)}</td>
                      <td className={`${td} font-bold`}>{yen(t.social)}</td>
                      <td className={`${td} font-bold text-berry`}>{yen(t.net)}</td>
                    </tr>
                  );
                })}
                <tr className="bg-gray-50 font-bold">
                  <td className="px-2 py-1.5">合計</td>
                  {PAY_ITEMS.map((x) => (
                    <td key={x.key} className={td}>
                      {itemSum(x.key) ? yen(itemSum(x.key)) : ""}
                    </td>
                  ))}
                  <td className={td}>{yen(sum((r) => computeRow(r).pay))}</td>
                  <td className={td}>{yen(sum((r) => computeRow(r).social))}</td>
                  <td className={td}>{yen(sum((r) => computeRow(r).net))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h2 className="mt-5 font-bold">事業所負担分</h2>
          <div className="mt-1 overflow-x-auto rounded-xl border bg-white">
            <table className="text-sm">
              <tbody>
                {EMPLOYER_ITEMS.map((x) => (
                  <tr key={x.key}>
                    <td className="border-b px-3 py-1.5">{x.label}</td>
                    <td className={td}>{yen(v.employer[x.key] ?? 0)}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50 font-bold">
                  <td className="px-3 py-1.5">合計</td>
                  <td className={td}>{yen(EMPLOYER_ITEMS.reduce((n, x) => n + (v.employer[x.key] ?? 0), 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-gray-500 print:hidden">
            この画面は見るだけです。入力・修正は管理者が行います。口座・タイムカード・従業員リストは出していません。
          </p>
        </>
      )}
    </div>
  );
}
