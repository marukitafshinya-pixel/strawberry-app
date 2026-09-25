"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { formatJa, todayJST } from "@/lib/date";
import { yen } from "@/lib/reservations";
import { useReceivables, type Receivable } from "@/lib/sales";

type Tab = "open" | "collected";

export default function ReceivablesPage() {
  const [tab, setTab] = useState<Tab>("open");
  const { value: list, error } = useReceivables(tab);
  const [adding, setAdding] = useState(false);
  const today = todayJST();

  const openTotal = tab === "open" ? (list ?? []).reduce((n, r) => n + r.amount, 0) : null;
  // 回収予定日が近い順（予定日なしは最後）。回収済は新しい順
  const sorted = [...(list ?? [])].sort((a, b) =>
    tab === "open"
      ? (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.date.localeCompare(b.date)
      : (b.collectedDate ?? "").localeCompare(a.collectedDate ?? ""),
  );

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">売掛管理</h1>
        <button onClick={() => setAdding(true)} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
          ＋ 売掛を手入力
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1">
        {(["open", "collected"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg py-2 ${tab === t ? "bg-white font-bold shadow-sm" : "text-gray-600"}`}>
            {t === "open" ? "未回収" : "回収済"}
          </button>
        ))}
      </div>

      {openTotal !== null && (
        <div className="mt-3 rounded-2xl bg-amber-50 p-4">
          <div className="text-sm text-amber-800">未回収の合計</div>
          <div className="text-2xl font-bold text-amber-900">
            {yen(openTotal)}
            <span className="ml-2 text-sm font-normal">（{list?.length ?? 0}件）</span>
          </div>
        </div>
      )}

      {adding && <AddForm onClose={() => setAdding(false)} />}

      {error ? <p className="mt-4 text-red-600">{errorText(error)}</p> : null}
      {!list && !error && <p className="mt-4 text-gray-500">読み込み中…</p>}
      {list && list.length === 0 && <p className="mt-4 text-sm text-gray-400">{tab === "open" ? "未回収の売掛はありません" : "回収済の売掛はありません"}</p>}
      <ul className="mt-3 space-y-2">
        {sorted.map((r) => (
          <ReceivableRow key={r.id} r={r} today={today} />
        ))}
      </ul>
    </>
  );
}

function AddForm({ onClose }: { onClose: () => void }) {
  const [customerName, setCustomerName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayJST());
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await callFunction("saveReceivable", { customerName, amount: Number(amount), date, dueDate: dueDate || null, memo });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-2xl bg-white p-4 shadow-sm sm:max-w-md">
      <h2 className="font-bold">売掛を手入力</h2>
      <label className="block text-sm">
        <span className="text-gray-600">お客様名（必須）</span>
        <input required maxLength={50} value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
      </label>
      <label className="block text-sm">
        <span className="text-gray-600">金額（円）</span>
        <input
          required
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, ""))}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-right text-base"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="text-gray-600">発生日</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">回収予定日</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-gray-600">メモ</span>
        <input maxLength={200} value={memo} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-berry py-2 font-bold text-white disabled:opacity-50">
          {saving ? "保存中…" : "追加する"}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg border px-4 py-2">
          やめる
        </button>
      </div>
    </form>
  );
}

function ReceivableRow({ r, today }: { r: Receivable; today: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingDue, setEditingDue] = useState(false);
  const [due, setDue] = useState(r.dueDate ?? "");
  const overdue = r.status === "open" && r.dueDate !== null && r.dueDate < today;

  async function run(data: Record<string, unknown>, fn = "saveReceivable") {
    setBusy(true);
    setError("");
    try {
      await callFunction(fn, { id: r.id, ...data });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rounded-xl border bg-white p-3 ${overdue ? "border-red-300" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{r.customerName} 様</span>
        <span className="text-lg font-bold">{yen(r.amount)}</span>
        {r.source === "sale" ? (
          <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-600">会計から</span>
        ) : (
          <span className="rounded bg-gray-100 px-1.5 text-xs text-gray-600">手入力</span>
        )}
        <div className="ml-auto flex gap-2">
          {r.status === "open" ? (
            <button
              disabled={busy}
              onClick={() => window.confirm(`${r.customerName} 様の ${yen(r.amount)} を「回収済」にしますか？`) && run({ status: "collected", collectedDate: today })}
              className="rounded-lg bg-leaf px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
            >
              回収済にする
            </button>
          ) : (
            <button disabled={busy} onClick={() => run({ status: "open" })} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">
              未回収に戻す
            </button>
          )}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-600">
        <span>発生日 {formatJa(r.date)}</span>
        {r.status === "collected" && r.collectedDate && <span>回収日 {formatJa(r.collectedDate)}</span>}
        {r.status === "open" &&
          (editingDue ? (
            <span className="flex items-center gap-1">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded border px-2 py-1 text-base" />
              <button
                disabled={busy}
                onClick={async () => (await run({ dueDate: due || null })) && setEditingDue(false)}
                className="rounded border px-2 py-1"
              >
                保存
              </button>
            </span>
          ) : (
            <button onClick={() => setEditingDue(true)} className={`underline ${overdue ? "font-bold text-red-600" : ""}`}>
              回収予定日 {r.dueDate ? formatJa(r.dueDate) : "未定"}
              {overdue && "（過ぎています）"}
            </button>
          ))}
        {r.source === "manual" && (
          <button
            disabled={busy}
            onClick={() => window.confirm(`${r.customerName} 様の売掛（${yen(r.amount)}）を削除しますか？`) && run({}, "deleteReceivable")}
            className="text-red-700 underline"
          >
            削除
          </button>
        )}
      </div>
      {r.memo && <p className="mt-1 text-sm text-gray-500">📝 {r.memo}</p>}
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </li>
  );
}
