"use client";

import { doc, getDoc } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { callFunction, errorText } from "@/lib/callFunction";
import { formatJa, todayJST } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { peopleText, useSettings, yen, type Reservation } from "@/lib/reservations";
import { PAYMENT_LABEL, lineAmount, type PaymentMethod, type SaleLine } from "@/lib/sales";
import { DEFAULT_PLAN_CATEGORY, newId, type Settings } from "@/lib/settings";

type Line = Omit<SaleLine, "amount"> & { key: string };

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p className="text-gray-500">読み込み中…</p>}>
      <CheckoutLoader />
    </Suspense>
  );
}

/** 予約から開いたときは、その予約を読み込んでから画面を出す */
function CheckoutLoader() {
  const params = useSearchParams();
  const reservationId = params.get("reservation");
  const { value: settings } = useSettings();
  const [reservation, setReservation] = useState<Reservation | null | undefined>(reservationId ? undefined : null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!reservationId) return;
    getFirebase()
      .then(({ db }) => getDoc(doc(db, `reservations/${reservationId}`)))
      .then((snap) => {
        if (!snap.exists()) setLoadError("予約が見つかりません");
        else setReservation({ id: snap.id, ...(snap.data() as Omit<Reservation, "id">) });
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [reservationId]);

  if (loadError) return <p className="text-red-600">{loadError}</p>;
  if (!settings || reservation === undefined) return <p className="text-gray-500">読み込み中…</p>;
  // 画面を開き直したときに中身が混ざらないよう、予約ごとに作り直す
  return <Checkout key={reservation?.id ?? "walk-in"} settings={settings} reservation={reservation} />;
}

function initialLines(settings: Settings, r: Reservation | null): Line[] {
  if (!r) return [];
  const plan = settings.plans.find((p) => p.id === r.planId);
  const category = plan?.category ?? DEFAULT_PLAN_CATEGORY;
  // 予約のときに控えた単価をそのまま使う
  return r.lines.map((l) => ({
    key: newId(),
    kind: "plan",
    refId: r.planId,
    name: `${r.planName}（${l.name}）`,
    category,
    unitPrice: l.unitPrice,
    qty: l.qty,
    discountRate: 0,
  }));
}

function Checkout({ settings, reservation: r }: { settings: Settings; reservation: Reservation | null }) {
  const [lines, setLines] = useState<Line[]>(() => initialLines(settings, r));
  const [customerName, setCustomerName] = useState(r?.customerName ?? "");
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [received, setReceived] = useState("");
  const [allRate, setAllRate] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ id: string; total: number } | null>(null);
  const [custom, setCustom] = useState({ name: "", price: "" });

  const alreadyPaid = !!r?.saleId;
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const total = lines.reduce((n, l) => n + lineAmount(l.unitPrice, l.qty, l.discountRate), 0);
  const change = received === "" ? null : Number(received) - total;

  const update = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /** 同じ商品はまとめて数量を増やす */
  function addLine(line: Omit<Line, "key" | "qty" | "discountRate">) {
    const same = lines.find((l) => l.kind === line.kind && l.refId === line.refId && l.name === line.name && l.unitPrice === line.unitPrice);
    if (same) update(same.key, { qty: same.qty + 1 });
    else setLines([...lines, { ...line, key: newId(), qty: 1, discountRate: Number(allRate) || 0 }]);
  }

  async function confirm() {
    setError("");
    if (lines.length === 0) return setError("明細を1つ以上入れてください");
    if (payment === "credit" && !customerName.trim()) return setError("売掛のときは、お客様名を入れてください");
    setSaving(true);
    try {
      const res = await callFunction<Record<string, unknown>, { id: string; total: number }>("checkout", {
        reservationId: r?.id ?? null,
        date: todayJST(),
        customerName,
        payment,
        dueDate: payment === "credit" ? dueDate || null : null,
        memo,
        lines: lines.map(({ kind, refId, name, category, unitPrice, qty, discountRate }) => ({
          kind,
          refId,
          name,
          category,
          unitPrice,
          qty,
          discountRate,
        })),
      });
      setDone(res);
      window.scrollTo(0, 0);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md">
        <div className="rounded-2xl bg-green-50 p-6 text-center text-green-900">
          <p className="text-lg font-bold">会計が完了しました</p>
          <p className="mt-2 text-3xl font-bold">{yen(done.total)}</p>
          <p className="mt-1 text-sm">{PAYMENT_LABEL[payment]}</p>
          {payment === "cash" && change !== null && change >= 0 && <p className="mt-2 text-lg">おつり {yen(change)}</p>}
          {payment === "credit" && <p className="mt-2 text-sm">売掛一覧に「{customerName}」様の分を追加しました。</p>}
        </div>
        <div className="mt-4 grid gap-2">
          <Link href={`/staff/sales/?date=${todayJST()}`} className="rounded-lg border bg-white py-3 text-center">
            今日の会計履歴を見る
          </Link>
          {r && (
            <Link href={`/staff/reservations/?date=${r.date}`} className="rounded-lg border bg-white py-3 text-center">
              予約管理に戻る
            </Link>
          )}
          {/* 画面を読み込み直して、まっさらな会計画面にする */}
          <a href="/staff/checkout/" className="rounded-lg bg-berry py-3 text-center font-bold text-white">
            続けて別の会計をする
          </a>
        </div>
      </div>
    );
  }

  const products = settings.products.filter((p) => p.active);
  const groups = [...new Set(products.map((p) => p.group || "その他"))];

  return (
    <div className="pb-40">
      <p className="text-sm">
        <Link href={r ? `/staff/reservations/?date=${r.date}` : "/staff/"} className="text-gray-500 underline">
          ← {r ? "予約管理" : "メニュー"}
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">会計</h1>
      {r ? (
        <p className="mt-1 text-sm text-gray-600">
          予約：{formatJa(r.date)} {r.slotTime} {r.customerName}様（{peopleText(r)}）
        </p>
      ) : (
        <p className="mt-1 text-sm text-gray-600">予約なしの会計</p>
      )}
      {alreadyPaid && (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          この予約はすでに会計済みです。やり直す場合は、会計履歴から取り消してください。
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_22rem]">
        {/* 左：追加するもの */}
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g} className="rounded-2xl bg-white p-3 shadow-sm">
              <h2 className="text-sm font-bold text-gray-600">{g}</h2>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {products
                  .filter((p) => (p.group || "その他") === g)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => addLine({ kind: "product", refId: p.id, name: p.name, category: p.group || "その他", unitPrice: p.price })}
                      className="rounded-xl border p-3 text-left active:bg-berry/10"
                    >
                      <span className="block font-semibold">{p.name}</span>
                      <span className="text-sm text-gray-600">{yen(p.price)}</span>
                    </button>
                  ))}
              </div>
            </section>
          ))}

          <section className="rounded-2xl bg-white p-3 shadow-sm">
            <h2 className="text-sm font-bold text-gray-600">体験（プラン）</h2>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {settings.plans.flatMap((p) =>
                settings.priceCategories
                  .filter((c) => p.prices[c.id] !== undefined)
                  .map((c) => (
                    <button
                      key={`${p.id}-${c.id}`}
                      onClick={() =>
                        addLine({
                          kind: "plan",
                          refId: p.id,
                          name: `${p.name}（${c.name}）`,
                          category: p.category ?? DEFAULT_PLAN_CATEGORY,
                          unitPrice: p.prices[c.id],
                        })
                      }
                      className="rounded-xl border p-3 text-left active:bg-berry/10"
                    >
                      <span className="block font-semibold">
                        {p.name}（{c.name}）
                      </span>
                      <span className="text-sm text-gray-600">{yen(p.prices[c.id])}</span>
                    </button>
                  )),
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white p-3 shadow-sm">
            <h2 className="text-sm font-bold text-gray-600">その他（手入力）</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                placeholder="名前"
                value={custom.name}
                maxLength={50}
                onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                className="w-40 rounded-lg border px-3 py-2 text-base"
              />
              <input
                placeholder="金額"
                inputMode="numeric"
                value={custom.price}
                onChange={(e) => setCustom({ ...custom, price: toDigits(e.target.value) })}
                className="w-28 rounded-lg border px-3 py-2 text-right text-base"
              />
              <button
                disabled={!custom.name.trim() || custom.price === ""}
                onClick={() => {
                  addLine({ kind: "custom", refId: "", name: custom.name.trim(), category: "その他", unitPrice: Number(custom.price) });
                  setCustom({ name: "", price: "" });
                }}
                className="rounded-lg border px-4 py-2 disabled:opacity-40"
              >
                追加
              </button>
            </div>
          </section>
        </div>

        {/* 右：明細と支払い */}
        <div className="space-y-3">
          <section className="rounded-2xl bg-white p-3 shadow-sm">
            <h2 className="font-bold">明細</h2>
            {lines.length === 0 && <p className="mt-2 text-sm text-gray-400">左のボタンで追加してください</p>}
            <ul className="mt-2 divide-y">
              {lines.map((l) => (
                <li key={l.key} className="py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{l.name}</span>
                    <button onClick={() => setLines(lines.filter((x) => x.key !== l.key))} className="px-2 text-gray-400" aria-label="削除">
                      ×
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-gray-600">{yen(l.unitPrice)}</span>
                    <span className="flex items-center gap-1">
                      <button onClick={() => l.qty > 1 && update(l.key, { qty: l.qty - 1 })} className="h-8 w-8 rounded-full border" aria-label="減らす">
                        −
                      </button>
                      <span className="w-8 text-center font-bold">{l.qty}</span>
                      <button onClick={() => update(l.key, { qty: Math.min(9999, l.qty + 1) })} className="h-8 w-8 rounded-full border" aria-label="増やす">
                        ＋
                      </button>
                    </span>
                    <label className="flex items-center gap-1">
                      <input
                        inputMode="numeric"
                        value={l.discountRate || ""}
                        placeholder="0"
                        onChange={(e) => update(l.key, { discountRate: Math.min(100, Number(toDigits(e.target.value) || 0)) })}
                        className="w-12 rounded border px-1 py-1 text-right"
                        aria-label="割引率"
                      />
                      %引
                    </label>
                    <span className="ml-auto font-bold">{yen(lineAmount(l.unitPrice, l.qty, l.discountRate))}</span>
                  </div>
                </li>
              ))}
            </ul>
            {lines.length > 0 && (
              <div className="mt-2 flex items-center gap-2 border-t pt-2 text-sm">
                <span>全部に</span>
                <input
                  inputMode="numeric"
                  value={allRate}
                  onChange={(e) => setAllRate(toDigits(e.target.value))}
                  className="w-14 rounded border px-1 py-1 text-right"
                  aria-label="全体の割引率"
                />
                <span>%引きを</span>
                <button
                  onClick={() => setLines(lines.map((l) => ({ ...l, discountRate: Math.min(100, Number(allRate) || 0) })))}
                  className="rounded border px-2 py-1"
                >
                  かける
                </button>
              </div>
            )}
            <dl className="mt-3 space-y-1 border-t pt-2 text-sm">
              <div className="flex justify-between">
                <dt>小計</dt>
                <dd>{yen(subtotal)}</dd>
              </div>
              {subtotal !== total && (
                <div className="flex justify-between text-red-700">
                  <dt>値引き</dt>
                  <dd>−{yen(subtotal - total)}</dd>
                </div>
              )}
              <div className="flex justify-between text-xl font-bold">
                <dt>合計（税込）</dt>
                <dd>{yen(total)}</dd>
              </div>
            </dl>
          </section>

          <section className="space-y-3 rounded-2xl bg-white p-3 shadow-sm">
            <div className="grid grid-cols-2 gap-2">
              {(["cash", "credit"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPayment(m)}
                  className={`rounded-lg border py-3 font-bold ${payment === m ? "border-berry bg-berry text-white" : ""}`}
                >
                  {PAYMENT_LABEL[m]}
                </button>
              ))}
            </div>
            <label className="block text-sm">
              <span className="text-gray-600">お客様名{payment === "credit" && <span className="text-red-600">（売掛は必須）</span>}</span>
              <input
                value={customerName}
                maxLength={50}
                onChange={(e) => setCustomerName(e.target.value)}
                className="mt-1 w-full rounded-lg border px-3 py-2 text-base"
              />
            </label>
            {payment === "cash" ? (
              <label className="block text-sm">
                <span className="text-gray-600">お預かり（おつりの計算用・任意）</span>
                <input
                  inputMode="numeric"
                  value={received}
                  onChange={(e) => setReceived(toDigits(e.target.value))}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-right text-base"
                />
                {change !== null && (
                  <span className={`mt-1 block text-right text-lg font-bold ${change < 0 ? "text-red-600" : ""}`}>
                    {change < 0 ? `${yen(-change)} 足りません` : `おつり ${yen(change)}`}
                  </span>
                )}
              </label>
            ) : (
              <label className="block text-sm">
                <span className="text-gray-600">回収予定日（任意）</span>
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
              </label>
            )}
            <label className="block text-sm">
              <span className="text-gray-600">メモ（任意）</span>
              <input value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
            </label>
          </section>
        </div>
      </div>

      {/* 画面下に固定の確定ボタン */}
      <div className="fixed inset-x-0 bottom-0 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <div className="text-2xl font-bold">{yen(total)}</div>
          <button
            onClick={confirm}
            disabled={saving || alreadyPaid || lines.length === 0}
            className="ml-auto rounded-lg bg-berry px-8 py-3 text-lg font-bold text-white disabled:opacity-40"
          >
            {saving ? "処理中…" : `${PAYMENT_LABEL[payment]}で確定`}
          </button>
        </div>
        {error && <p className="mx-auto mt-2 max-w-5xl text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}

/** 全角数字を半角にして、数字以外を取り除く */
function toDigits(v: string): string {
  return v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
}
