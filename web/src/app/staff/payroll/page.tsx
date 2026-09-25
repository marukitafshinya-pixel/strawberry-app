"use client";

import { doc, getDoc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { decodeCsv, parseCsv } from "@/lib/csv";
import { shiftMonth, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import {
  EMPLOYER_ITEMS,
  PAY_ITEMS,
  computeRow,
  parsePayrollCsv,
  reiwa,
  useEmployees,
  usePayroll,
  type Employee,
  type EmployerKey,
  type PayKey,
  type PayRow,
  type Payroll,
} from "@/lib/payroll";
import { downloadCsv } from "@/lib/report";
import { yen } from "@/lib/reservations";
import { newId } from "@/lib/settings";

export default function PayrollPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <PayrollView />
    </Suspense>
  );
}

function PayrollView() {
  const { role } = useAuth();
  const params = useSearchParams();
  const router = useRouter();
  // 給与はふつう前の月の分を打ち込むので、最初は先月を開く
  const q = params.get("month");
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : shiftMonth(todayJST().slice(0, 7), -1);
  const setMonth = (m: string) => router.replace(`/staff/payroll/?month=${m}`);
  const { value: employees } = useEmployees();
  const { value: saved, error } = usePayroll(month);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;

  const [y, m] = month.split("-").map(Number);
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
        <Link href="/staff/payroll/employees/" className="ml-4 text-gray-500 underline">
          従業員の登録
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">給与の打ち込み</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg border bg-white px-3 py-2">
          ‹ 前月
        </button>
        <span className="min-w-40 text-center text-lg font-bold">
          {reiwa(y)} {m}月度分
        </span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg border bg-white px-3 py-2">
          翌月 ›
        </button>
      </div>
      {error ? <p className="mt-3 text-red-600">{errorText(error)}</p> : null}
      {!saved || !employees ? (
        <p className="mt-3 text-gray-500">読み込み中…</p>
      ) : (
        // 月を切り替えたときに入力中の内容が混ざらないよう、月ごとに作り直す
        <Editor key={month} month={month} saved={saved} employees={employees} />
      )}
    </>
  );
}

function Editor({ month, saved, employees }: { month: string; saved: Payroll; employees: Employee[] }) {
  const [data, setData] = useState<Payroll>(saved);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 保存せずに閉じようとしたら確認する
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // 在籍中の人と、この月に金額が入っている人を表に出す
  const people = employees.filter((e) => e.active || data.rows[e.id]);
  const update = (patch: Partial<Payroll>) => {
    setData({ ...data, ...patch });
    setDirty(true);
    setMessage("");
  };
  const setCell = (empId: string, key: PayKey, v: number | undefined) => {
    const row = { ...(data.rows[empId] ?? {}) };
    if (v === undefined) delete row[key];
    else row[key] = v;
    update({ rows: { ...data.rows, [empId]: row } });
  };

  const totals = PAY_ITEMS.reduce(
    (acc, it) => ({ ...acc, [it.key]: people.reduce((n, e) => n + (data.rows[e.id]?.[it.key] ?? 0), 0) }),
    {} as Record<PayKey, number>,
  );
  const sums = people.map((e) => computeRow(data.rows[e.id] ?? {}));
  const totalPay = sums.reduce((n, s) => n + s.pay, 0);
  const totalSocial = sums.reduce((n, s) => n + s.social, 0);
  const totalNet = sums.reduce((n, s) => n + s.net, 0);
  const transferTotal = people.reduce((n, e, i) => n + (e.payMethod === "transfer" ? sums[i].net : 0), 0);
  const cashTotal = totalNet - transferTotal;
  const employerTotal = EMPLOYER_ITEMS.reduce((n, it) => n + (data.employer[it.key] ?? 0), 0);

  async function save() {
    setError("");
    setSaving(true);
    try {
      const { db } = await getFirebase();
      // 空の行は保存しない
      const rows = Object.fromEntries(Object.entries(data.rows).filter(([, r]) => Object.keys(r).length > 0));
      await setDoc(doc(db, `payrolls/${month}`), { ...data, rows, updatedAt: serverTimestamp() });
      setDirty(false);
      setMessage("保存しました");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function copyPrev() {
    const prev = shiftMonth(month, -1);
    if (!window.confirm(`${prev.replace("-", "年")}月の金額を写します。今入っている金額は上書きされます。`)) return;
    try {
      const { db } = await getFirebase();
      const snap = await getDoc(doc(db, `payrolls/${prev}`));
      if (!snap.exists()) return setError("前の月の給与がまだ保存されていません");
      const p = snap.data() as Payroll;
      update({ rows: p.rows ?? {}, employer: p.employer ?? {} });
    } catch (e) {
      setError(errorText(e));
    }
  }

  /** CSVの金額を表に入れる。社員番号で従業員を探し、いない人は新しく登録する */
  async function importCsv(file: File) {
    setError("");
    setMessage("");
    try {
      const { entries, error } = parsePayrollCsv(parseCsv(decodeCsv(await file.arrayBuffer()).text));
      if (error) return setError(`取り込めませんでした：${error}`);
      const byCode = new Map(employees.map((e) => [e.code, e]));
      const added = entries.filter((x) => !byCode.has(x.code));
      const text = [
        `${entries.length}人分の金額を ${month.replace("-", "年")}月度 の表に入れます。`,
        "表に入っている同じ人の金額は上書きされます。",
        added.length > 0 ? `\n新しく従業員として登録する人：${added.length}人\n（${added.map((x) => x.name).join("、")}）` : "",
      ].join("\n");
      if (!window.confirm(text)) return;

      const { db } = await getFirebase();
      const batch = writeBatch(db);
      const rows = { ...data.rows };
      for (const x of entries) {
        const found = byCode.get(x.code);
        const id = found?.id ?? newId();
        const bank = x.bank ?? { payMethod: "transfer" as const, bankName: "", branchName: "", accountType: "普通" as const, accountNumber: "" };
        if (!found) {
          batch.set(doc(db, `employees/${id}`), { code: x.code, name: x.name, ...bank, active: true, updatedAt: serverTimestamp() });
        } else if (x.bank && !found.bankName && !found.accountNumber && (x.bank.bankName || x.bank.accountNumber)) {
          // 登録済みの人は、振込先がまだ空のときだけCSVの振込先を入れる（直した内容を消さないように）
          batch.set(doc(db, `employees/${id}`), { ...x.bank, updatedAt: serverTimestamp() }, { merge: true });
        }
        rows[id] = x.row;
      }
      await batch.commit();
      update({ rows });
      setMessage(`${entries.length}人分を読み込みました。確かめてから「保存する」を押してください`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function exportCsv() {
    const header = ["社員番号", "氏名", ...PAY_ITEMS.map((i) => i.label), "支給合計", "社会保険料計", "差引支給額", "支払方法", "銀行名", "支店名", "種別", "口座番号"];
    const body = people.map((e, i) => [
      e.code,
      e.name,
      ...PAY_ITEMS.map((it) => data.rows[e.id]?.[it.key] ?? 0),
      sums[i].pay,
      sums[i].social,
      sums[i].net,
      e.payMethod === "cash" ? "現金" : "振込",
      e.bankName,
      e.branchName,
      e.accountType,
      e.accountNumber,
    ]);
    const total = ["", "合計", ...PAY_ITEMS.map((it) => totals[it.key]), totalPay, totalSocial, totalNet, "", "", "", "", ""];
    downloadCsv(`payroll_${month}.csv`, [header, ...body, total]);
  }

  const col = (label: string, cls = "") => <th key={label} className={`whitespace-nowrap px-2 py-2 text-right text-xs font-semibold ${cls}`}>{label}</th>;

  return (
    <div className="pb-24">
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block text-sm">
          <span className="text-gray-600">振込日（支給日）</span>
          <input type="date" value={data.paymentDate} onChange={(e) => update({ paymentDate: e.target.value })} className="mt-1 block rounded-lg border px-3 py-2 text-base" />
        </label>
        <button onClick={copyPrev} className="rounded-lg border bg-white px-3 py-2 text-sm">
          前の月の金額を写す
        </button>
        <Link href={`/staff/payroll/print/?month=${month}`} className="rounded-lg border bg-white px-3 py-2 text-sm">
          集計表・振込一覧を印刷
        </Link>
        <button onClick={exportCsv} className="rounded-lg border bg-white px-3 py-2 text-sm">
          CSVで書き出す
        </button>
        <button onClick={() => fileRef.current?.click()} className="rounded-lg border bg-white px-3 py-2 text-sm">
          CSVから取り込む
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCsv(f);
          }}
        />
      </div>

      {people.length === 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-800">
          まだ従業員が登録されていません。「CSVから取り込む」でまとめて登録するか、
          <Link href="/staff/payroll/employees/" className="underline">従業員の登録</Link> から1人ずつ追加してください。
        </p>
      )}

      {/* 打ち込みの表（横に長いので、左右にスクロールできる） */}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="min-w-max text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="sticky left-0 z-10 bg-gray-50 px-2 py-2 text-left text-xs">番号・氏名</th>
              {PAY_ITEMS.map((i) => col(i.label))}
              {col("支給合計", "border-l-2 border-berry/40 bg-berry/10")}
              {col("社会保険料計", "bg-berry/10")}
              {col("差引支給額", "bg-berry/20")}
              {col("支払")}
            </tr>
          </thead>
          <tbody>
            {people.map((e, idx) => {
              const r: PayRow = data.rows[e.id] ?? {};
              const s = sums[idx];
              const cell = (k: PayKey, signed?: boolean) => (
                <td key={k} className="px-1 py-1">
                  <NumCell value={r[k]} signed={signed} onChange={(v) => setCell(e.id, k, v)} label={`${e.name} ${PAY_ITEMS.find((i) => i.key === k)?.label}`} />
                </td>
              );
              return (
                <tr key={e.id} className="border-t">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1">
                    <span className="mr-1 text-xs text-gray-500 tabular-nums">{e.code}</span>
                    <span className="font-semibold">{e.name}</span>
                  </td>
                  {PAY_ITEMS.map((i) => cell(i.key, "signed" in i && i.signed))}
                  <td className="border-l-2 border-berry/40 bg-berry/5 px-2 text-right font-semibold tabular-nums">{s.pay.toLocaleString("ja-JP")}</td>
                  <td className="bg-berry/5 px-2 text-right font-semibold tabular-nums">{s.social.toLocaleString("ja-JP")}</td>
                  <td className={`bg-berry/10 px-2 text-right font-bold tabular-nums ${s.net < 0 ? "text-red-600" : ""}`}>{s.net.toLocaleString("ja-JP")}</td>
                  <td className="px-2 text-xs">{e.payMethod === "cash" ? "現金" : "振込"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50 font-bold">
            <tr className="border-t-2">
              <td className="sticky left-0 z-10 bg-gray-50 px-2 py-2">合計</td>
              {PAY_ITEMS.map((i) => (
                <td key={i.key} className="px-2 text-right tabular-nums">
                  {totals[i.key].toLocaleString("ja-JP")}
                </td>
              ))}
              <td className="border-l-2 border-berry/40 px-2 text-right tabular-nums">{totalPay.toLocaleString("ja-JP")}</td>
              <td className="px-2 text-right tabular-nums">{totalSocial.toLocaleString("ja-JP")}</td>
              <td className="px-2 text-right tabular-nums">{totalNet.toLocaleString("ja-JP")}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        左側の白い欄に金額を入れると、右側の色の付いた列（支給合計・社会保険料計・差引支給額）が自動で計算されます。
        <br />
        差引支給額 ＝ 支給合計 − 社会保険料計 − 所得税 − 住民税 ＋ 年末調整（還付はプラス、徴収はマイナスで入力）
      </p>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-bold">支払いの合計</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="支給合計（総支給）" value={yen(totalPay)} />
            <Row label="差引支給額の合計" value={yen(totalNet)} strong />
            <Row label="　うち振込" value={yen(transferTotal)} />
            <Row label="　うち現金" value={yen(cashTotal)} />
            <Row label="源泉所得税（預り）" value={yen(totals.incomeTax)} />
            <Row label="住民税（預り）" value={yen(totals.residentTax)} />
          </dl>
        </section>
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="font-bold">事業所負担分</h2>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {EMPLOYER_ITEMS.map((it) => (
              <label key={it.key} className="block text-sm">
                <span className="text-gray-600">{it.label}</span>
                <NumCell
                  value={data.employer[it.key]}
                  onChange={(v) => {
                    const employer = { ...data.employer };
                    if (v === undefined) delete employer[it.key as EmployerKey];
                    else employer[it.key as EmployerKey] = v;
                    update({ employer });
                  }}
                  label={it.label}
                  wide
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-sm">
            事業所負担の合計 <b>{yen(employerTotal)}</b>
          </p>
          <p className="text-sm">
            会社の負担（総支給＋事業所負担） <b>{yen(totalPay + employerTotal)}</b>
          </p>
        </section>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-gray-600">メモ</span>
        <textarea value={data.memo} maxLength={500} rows={2} onChange={(e) => update({ memo: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
      </label>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <button onClick={save} disabled={saving} className="rounded-lg bg-berry px-6 py-3 font-bold text-white disabled:opacity-50">
            {saving ? "保存中…" : "保存する"}
          </button>
          {message && <span className="text-sm text-green-700">{message}</span>}
          {dirty && !message && <span className="text-sm text-gray-500">まだ保存していない変更があります</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
          <span className="ml-auto text-sm">
            差引支給 <b className="text-lg">{yen(totalNet)}</b>
          </span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "text-base font-bold" : ""}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** 金額の入力欄（全角数字・カンマもOK。signed ならマイナスも入れられる） */
function NumCell({
  value,
  onChange,
  signed,
  label,
  wide,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  signed?: boolean;
  label: string;
  wide?: boolean;
}) {
  const fmt = (v: number | undefined) => (v === undefined ? "" : String(v));
  const [text, setText] = useState(fmt(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setText(fmt(value));
  }
  return (
    <input
      inputMode={signed ? "text" : "numeric"}
      aria-label={label}
      value={text}
      onChange={(e) => {
        let t = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[−ー－▲]/g, "-");
        t = t.replace(signed ? /[^0-9-]/g : /[^0-9]/g, "").replace(/(?!^)-/g, "");
        setText(t);
        if (t === "" || t === "-") onChange(undefined);
        else onChange(Math.max(-99_999_999, Math.min(99_999_999, Number(t))));
      }}
      onBlur={() => setText(value === undefined ? "" : value.toLocaleString("ja-JP"))}
      onFocus={() => setText(fmt(value))}
      className={`rounded border px-2 py-1 text-right text-base tabular-nums ${wide ? "mt-1 w-full" : "w-24"}`}
    />
  );
}
