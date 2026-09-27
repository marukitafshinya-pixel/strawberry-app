"use client";

import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { CUSTOMER_PRICES, matchCustomer, useCustomers, type Customer } from "@/lib/customers";
import { formatJa, todayJST } from "@/lib/date";
import { loadPrinter, printReceipt, saleReceipt } from "@/lib/receiptPrinter";
import { getFirebase } from "@/lib/firebase";
import { peopleText, useSettings, yen, type Reservation } from "@/lib/reservations";
import { PAYMENT_LABEL, lineAmount, lineTaxRate, type PaymentMethod, type Sale, type SaleLine } from "@/lib/sales";
import { DEFAULT_PLAN_CATEGORY, DEFAULT_PLAN_TAX, DEFAULT_PRODUCT_TAX, SETTINGS_DOC, newId, type Settings, type TaxRate, type TileLayout } from "@/lib/settings";

type Line = Omit<SaleLine, "amount" | "taxRate"> & { key: string; taxRate: TaxRate };

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
  const editId = params.get("edit");
  const { value: settings } = useSettings();
  const [reservation, setReservation] = useState<Reservation | null | undefined>(reservationId ? undefined : null);
  const [editing, setEditing] = useState<Sale | null | undefined>(editId ? undefined : null);
  const [loadError, setLoadError] = useState("");

  // 取引の修正：元の会計を読み込む
  useEffect(() => {
    if (!editId) return;
    getFirebase()
      .then(({ db }) => getDoc(doc(db, `sales/${editId}`)))
      .then((snap) => {
        if (!snap.exists()) return setLoadError("会計が見つかりません");
        const sale = { id: snap.id, ...(snap.data() as Omit<Sale, "id">) };
        if (sale.status !== "completed") return setLoadError("この会計は取り消されているので、修正できません");
        setEditing(sale);
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [editId]);

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
  if (!settings || reservation === undefined || editing === undefined) return <p className="text-gray-500">読み込み中…</p>;
  // 画面を開き直したときに中身が混ざらないよう、予約・修正する会計ごとに作り直す
  return <Checkout key={editing?.id ?? reservation?.id ?? "walk-in"} settings={settings} reservation={reservation} editing={editing} />;
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
    taxRate: plan?.taxRate ?? DEFAULT_PLAN_TAX,
  }));
}

function Checkout({ settings, reservation: r, editing }: { settings: Settings; reservation: Reservation | null; editing: Sale | null }) {
  const [lines, setLines] = useState<Line[]>(() =>
    editing
      ? editing.lines.map((l) => ({
          key: newId(),
          kind: l.kind,
          refId: l.refId,
          name: l.name,
          category: l.category,
          unitPrice: l.unitPrice,
          qty: l.qty,
          discountRate: l.discountRate,
          taxRate: lineTaxRate(l, settings),
        }))
      : initialLines(settings, r),
  );
  const [customerName, setCustomerName] = useState(editing?.customerName ?? r?.customerName ?? "");
  const [payment, setPayment] = useState<PaymentMethod>(editing?.payment ?? "cash");
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState(editing?.memo ?? "");
  const [received, setReceived] = useState("");
  const [allRate, setAllRate] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ id: string; total: number } | null>(null);
  /** 印刷用に、確定した会計の中身を控えておく */
  const [doneSale, setDoneSale] = useState<Sale | null>(null);
  const [printError] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("printError"));
  const [custom, setCustom] = useState({ name: "", price: "" });
  const [customTax, setCustomTax] = useState<TaxRate>(10);
  const [step, setStep] = useState<"order" | "pay">("order");
  const [tab, setTab] = useState<"tile" | "list" | "search" | "custom">("tile");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ tile: Tile; amount: string } | null>(null);
  const { role } = useAuth();
  /** タイルの並べ替え中の並び（null なら並べ替えしていない） */
  const [arrange, setArrange] = useState<TileLayout | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [arrangeSaving, setArrangeSaving] = useState(false);
  /** 選んだ顧客（顧客ごとの単価のタイルを出す） */
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [customerQ, setCustomerQ] = useState("");
  const { value: customers } = useCustomers();

  const alreadyPaid = !editing && !!r?.saleId;
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const total = lines.reduce((n, l) => n + lineAmount(l.unitPrice, l.qty, l.discountRate), 0);
  const change = received === "" ? null : Number(received) - total;

  const update = (key: string, patch: Partial<Line>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (key: string) => setLines(lines.filter((l) => l.key !== key));

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
        date: editing?.date ?? todayJST(),
        replaceSaleId: editing?.id ?? null,
        customerName,
        payment,
        dueDate: payment === "credit" ? dueDate || null : null,
        memo,
        lines: lines.map(({ kind, refId, name, category, unitPrice, qty, discountRate, taxRate }) => ({
          taxRate,
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
      const sale: Sale = {
        id: res.id,
        date: editing?.date ?? todayJST(),
        reservationId: r?.id ?? null,
        customerName,
        lines: lines.map((l) => ({ ...l, amount: lineAmount(l.unitPrice, l.qty, l.discountRate) })),
        subtotal,
        discountTotal: subtotal - total,
        total,
        payment,
        status: "completed",
        receivableId: null,
        memo,
      };
      setDoneSale(sale);
      window.scrollTo(0, 0);
      // 設定で「すぐに印刷」にしていれば、そのままレシートを出す
      if (loadPrinter().autoPrint) printReceipt(saleReceipt(settings, sale, { received: received === "" ? null : Number(received) }), "/staff/checkout/", sale.payment === "cash" ? "sale-cash" : "other");
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
          <p className="text-lg font-bold">{editing ? "会計を修正しました" : "会計が完了しました"}</p>
          <p className="mt-2 text-3xl font-bold">{yen(done.total)}</p>
          <p className="mt-1 text-sm">{PAYMENT_LABEL[payment]}</p>
          {payment === "cash" && change !== null && change >= 0 && <p className="mt-2 text-lg">おつり {yen(change)}</p>}
          {payment === "credit" && <p className="mt-2 text-sm">売掛一覧に「{customerName}」様の分を追加しました。</p>}
        </div>
        <div className="mt-4 grid gap-2">
          {doneSale && (
            <button
              onClick={() =>
                printReceipt(saleReceipt(settings, doneSale, { received: received === "" ? null : Number(received) }), "/staff/checkout/", doneSale.payment === "cash" ? "sale-cash" : "other")
              }
              className="rounded-lg bg-emerald-700 py-3 text-center font-bold text-white"
            >
              レシートを印刷
            </button>
          )}
          <Link href={`/staff/receipt/?sale=${done.id}`} className="rounded-lg bg-gray-800 py-3 text-center font-bold text-white">
            領収書（宛名つき）・A4で出す
          </Link>
          <Link href={`/staff/checkout/history/?date=${editing?.date ?? todayJST()}`} className="rounded-lg border bg-white py-3 text-center">
            取引履歴を見る
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

  const tiles = buildTiles(settings, arrange ?? settings.tileLayout);
  const groups = orderGroups(tiles, (arrange ?? settings.tileLayout)?.groups);
  const colorOf = (g: string) => GROUP_COLORS[groups.indexOf(g) % GROUP_COLORS.length];
  const layout = arrange ?? settings.tileLayout;
  const cols = layout?.cols ?? 6;
  const slots = assignSlots(tiles, layout?.slots);
  const count = lines.reduce((n, l) => n + l.qty, 0);

  function startArrange() {
    setArrange({ groups, tiles: tiles.map((t) => t.key), slots: Object.fromEntries(slots), cols });
    setPicked(null);
    setTab("tile");
    setFilter("");
  }
  /** 選んだタイルを、押したマスへ移す（ほかのタイルがあれば入れ替える。同じ分類の中で） */
  function moveTo(group: string, slot: number) {
    if (!arrange || !picked) return;
    const from = tiles.find((t) => t.key === picked);
    if (!from || from.group !== group) return;
    const next = { ...(arrange.slots ?? {}) };
    const other = tiles.find((t) => t.group === group && t.key !== picked && slots.get(t.key) === slot);
    if (other) next[other.key] = slots.get(picked) ?? 0;
    next[picked] = slot;
    setArrange({ ...arrange, slots: next });
    setPicked(null);
  }
  function pickTile(t: Tile) {
    if (picked === t.key) return setPicked(null);
    const from = picked ? tiles.find((x) => x.key === picked) : null;
    // 選んでいるタイルと同じ分類のタイルを押したら入れ替え、それ以外は選び直し
    if (from && from.group === t.group) return moveTo(t.group, slots.get(t.key) ?? 0);
    setPicked(t.key);
  }
  function moveGroup(g: string, delta: number) {
    if (!arrange) return;
    const list = [...groups];
    const i = list.indexOf(g);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setArrange({ ...arrange, groups: list });
  }
  async function saveArrange() {
    if (!arrange) return;
    setArrangeSaving(true);
    try {
      const { db } = await getFirebase();
      const saved: TileLayout = { groups, tiles: tiles.map((t) => t.key), slots: Object.fromEntries(slots), cols };
      await updateDoc(doc(db, SETTINGS_DOC), { tileLayout: saved, updatedAt: serverTimestamp() });
      setArrange(null);
      setPicked(null);
    } catch (e) {
      window.alert(errorText(e));
    } finally {
      setArrangeSaving(false);
    }
  }

  function tap(t: Tile) {
    if (arrange) return pickTile(t);
    // 値段が0円の商品は、その場で金額を入れる（Airレジの「金額入力」と同じ）
    if (t.price === 0) return setAsk({ tile: t, amount: "" });
    addTile(t, t.price);
  }
  function addTile(t: Tile, price: number) {
    addLine({ kind: t.kind, refId: t.refId, name: t.name, category: t.group, unitPrice: price, taxRate: t.taxRate });
  }

  const q = search.trim();
  const shownTiles = tiles.filter((t) => (tab === "search" ? q !== "" && t.name.includes(q) : !filter || t.group === filter));

  return (
    <div className="pb-24 lg:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <Link href={r ? `/staff/reservations/?date=${r.date}` : "/staff/"} className="text-gray-500 underline">
            ← {r ? "予約管理" : "メニュー"}
          </Link>
          <span className="ml-3 text-lg font-bold text-gray-900">{step === "pay" ? "お支払い" : "注文入力"}</span>
        </p>
        <Link href={`/staff/checkout/history/?date=${todayJST()}`} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
          取引履歴
        </Link>
      </div>
      {r ? (
        <p className="mt-1 text-sm text-gray-600">
          予約：{formatJa(r.date)} {r.slotTime} {r.customerName}様（{peopleText(r)}）
        </p>
      ) : null}
      {printError && (
        <p className="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          レシートを印刷できませんでした。プリンターの電源・紙・Bluetooth を確かめてください（
          <Link href="/staff/checkout/settings/" className="underline">
            設定
          </Link>
          ）。
        </p>
      )}
      {editing && (
        <p className="mt-2 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">
          {formatJa(editing.date, true)} の会計（{yen(editing.total)}）を修正しています。確定すると、元の会計は取り消され、この内容に置き換わります。
          <Link href={`/staff/checkout/history/?date=${editing.date}`} className="ml-2 underline">
            やめて取引履歴に戻る
          </Link>
        </p>
      )}
      {alreadyPaid && (
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          この予約はすでに会計済みです。やり直す場合は、会計履歴から取り消してください。
        </p>
      )}

      <div className="mt-3 grid gap-4 lg:grid-cols-[24rem_1fr] 2xl:grid-cols-[30rem_1fr]">
        {/* 左：注文リスト */}
        <section className={`flex flex-col rounded-2xl bg-white shadow-sm lg:sticky lg:top-4 lg:h-[calc(100vh-7rem)] ${step === "pay" ? "hidden lg:flex" : ""}`}>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="font-bold">注文リスト</h2>
            {customer ? (
              <span className="flex items-center gap-1 text-sm">
                <span className="rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-800">{customer.name} 様</span>
                <button onClick={() => setPickingCustomer(true)} className="rounded border px-2 py-0.5 text-xs">
                  変更
                </button>
                <button onClick={() => setCustomer(null)} className="rounded border px-2 py-0.5 text-xs" aria-label="顧客を外す">
                  ×
                </button>
              </span>
            ) : (
              <button onClick={() => setPickingCustomer(true)} className="rounded-lg border px-3 py-1 text-sm">
                顧客を選ぶ
              </button>
            )}
          </div>
          <ul className="flex-1 divide-y overflow-y-auto">
            {lines.length === 0 && <li className="px-4 py-8 text-center text-sm text-gray-400">右の商品を押すと、ここに入ります</li>}
            {lines.map((l) => (
              <li key={l.key} className="px-4 py-2.5">
                <button onClick={() => setOpenLine(openLine === l.key ? null : l.key)} className="block w-full text-left font-semibold leading-snug break-words">
                  {l.name}
                </button>
                <div className="mt-1 flex items-center gap-2">
                  <button onClick={() => setOpenLine(openLine === l.key ? null : l.key)} className="min-w-0 flex-1 text-left" aria-label="割引・税率を変える">
                    <span className="text-xs text-gray-500">
                      {yen(l.unitPrice)} × {l.qty}
                      {l.discountRate > 0 && <span className="ml-1 text-red-700">{l.discountRate}%引</span>}
                      {l.taxRate === 8 && <span className="ml-1 text-amber-700">8%軽減</span>}
                    </span>
                  </button>
                  <button onClick={() => (l.qty > 1 ? update(l.key, { qty: l.qty - 1 }) : removeLine(l.key))} className="h-8 w-8 rounded border" aria-label="減らす">
                    −
                  </button>
                  <span className="w-6 text-center tabular-nums">{l.qty}</span>
                  <button onClick={() => update(l.key, { qty: Math.min(9999, l.qty + 1) })} className="h-8 w-8 rounded border" aria-label="増やす">
                    ＋
                  </button>
                  <span className="w-20 text-right font-semibold tabular-nums">{yen(lineAmount(l.unitPrice, l.qty, l.discountRate))}</span>
                  <button onClick={() => removeLine(l.key)} className="px-1 text-gray-400" aria-label="削除">
                    🗑
                  </button>
                </div>
                {openLine === l.key && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-gray-50 p-2 text-sm">
                    <label className="flex items-center gap-1">
                      単価
                      <input
                        inputMode="numeric"
                        value={String(l.unitPrice)}
                        onChange={(e) => update(l.key, { unitPrice: Math.min(10_000_000, Number(toDigits(e.target.value) || 0)) })}
                        className="w-24 rounded border px-1 py-1 text-right"
                        aria-label="単価"
                      />
                      円
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        inputMode="numeric"
                        value={l.discountRate || ""}
                        placeholder="0"
                        onChange={(e) => update(l.key, { discountRate: Math.min(100, Number(toDigits(e.target.value) || 0)) })}
                        className="w-14 rounded border px-1 py-1 text-right"
                        aria-label="割引率"
                      />
                      %引
                    </label>
                    <button
                      onClick={() => update(l.key, { taxRate: l.taxRate === 8 ? 10 : 8 })}
                      className={`rounded border px-2 py-1 text-xs ${l.taxRate === 8 ? "border-amber-400 bg-amber-50 text-amber-800" : "bg-white text-gray-600"}`}
                      aria-label={`税率 ${l.taxRate}%（押すと切り替え）`}
                    >
                      税率 {l.taxRate === 8 ? "8%軽減" : "10%"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">合計 {count}点</span>
              <span className="text-2xl font-bold text-berry tabular-nums">{yen(total)}</span>
            </div>
            {subtotal !== total && <p className="text-right text-xs text-red-700">値引き −{yen(subtotal - total)}</p>}
            <div className="mt-3 grid grid-cols-[1fr_1.6fr] gap-2">
              <button
                onClick={() => lines.length > 0 && window.confirm("注文リストを空にしますか？") && setLines([])}
                disabled={lines.length === 0}
                className="rounded-lg border py-3 disabled:opacity-40"
              >
                伝票を削除
              </button>
              <button
                onClick={() => setStep("pay")}
                disabled={lines.length === 0 || alreadyPaid}
                className="rounded-lg bg-emerald-700 py-3 font-bold text-white disabled:opacity-40"
              >
                支払いへ進む
              </button>
            </div>
          </div>
        </section>

        {/* 右：商品のタイル（またはお支払い） */}
        {step === "order" ? (
          <section className="rounded-2xl bg-white shadow-sm">
            <div className="grid grid-cols-4 border-b text-sm">
              {(
                [
                  ["tile", "▦ タイル"],
                  ["list", "☰ リスト"],
                  ["search", "🔍 検索"],
                  ["custom", "＋ カスタム商品"],
                ] as const
              ).map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)} className={`py-3 ${tab === t ? "border-b-2 border-emerald-700 font-bold text-emerald-800" : "text-gray-600"}`}>
                  {label}
                </button>
              ))}
            </div>

            {tab !== "custom" && (
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pt-3">
                {role !== "admin" ? null : arrange ? (
                  <>
                    <span className="mr-auto text-sm text-sky-800">
                      並べ替え中：タイルを押して選び、移したいマス（空いたマスも使えます）を押します。ほかのタイルを押すと入れ替わります。分類は ◀ ▶ で動かします。
                    </span>
                    <span className="flex items-center gap-1 text-sm">
                      横に
                      {[4, 5, 6].map((n) => (
                        <button
                          key={n}
                          onClick={() => setArrange({ ...arrange, cols: n })}
                          className={`rounded border px-2 py-1 ${cols === n ? "border-sky-700 bg-sky-700 text-white" : "bg-white"}`}
                        >
                          {n}
                        </button>
                      ))}
                      列
                    </span>
                    <button onClick={() => setArrange(null)} className="rounded-lg border px-3 py-2 text-sm">
                      やめる
                    </button>
                    <button onClick={saveArrange} disabled={arrangeSaving} className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                      {arrangeSaving ? "保存中…" : "配置を保存"}
                    </button>
                  </>
                ) : (
                  <button onClick={startArrange} className="hidden rounded-lg border px-3 py-2 text-sm lg:block">
                    タイルの配置
                  </button>
                )}
                {!arrange && (
                  <>
                    <Link href="/staff/checkout/settings/" className="rounded-lg border px-3 py-2 text-sm">
                      設定
                    </Link>
                    <Link href={`/staff/checkout/history/?date=${todayJST()}`} className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800">
                      取引履歴
                    </Link>
                    <Link href="/staff/checkout/settle/" className="rounded-lg border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-800">
                      精算
                    </Link>
                  </>
                )}
              </div>
            )}
            {tab === "custom" ? (
              <div className="space-y-3 p-4">
                <p className="text-sm text-gray-600">一覧にない商品を、名前と金額を入れて追加します。</p>
                <input
                  placeholder="商品名"
                  value={custom.name}
                  maxLength={50}
                  onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-base"
                />
                <input
                  placeholder="金額（税込）"
                  inputMode="numeric"
                  value={custom.price}
                  onChange={(e) => setCustom({ ...custom, price: toDigits(e.target.value) })}
                  className="w-full rounded-lg border px-3 py-2 text-right text-base"
                />
                <div className="flex gap-2 text-sm">
                  {([10, 8] as TaxRate[]).map((rate) => (
                    <button key={rate} onClick={() => setCustomTax(rate)} className={`rounded-lg border px-3 py-2 ${customTax === rate ? "border-gray-800 bg-gray-800 text-white" : ""}`}>
                      {rate === 8 ? "8%（軽減）" : "10%"}
                    </button>
                  ))}
                </div>
                <button
                  disabled={!custom.name.trim() || custom.price === ""}
                  onClick={() => {
                    addLine({ kind: "custom", refId: "", name: custom.name.trim(), category: "その他", unitPrice: Number(custom.price), taxRate: customTax });
                    setCustom({ name: "", price: "" });
                  }}
                  className="w-full rounded-lg bg-emerald-700 py-3 font-bold text-white disabled:opacity-40"
                >
                  注文リストに追加
                </button>
              </div>
            ) : (
              <div className="p-3">
                {tab === "search" ? (
                  <input
                    autoFocus
                    placeholder="商品名で探す"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="mb-3 w-full rounded-lg border px-3 py-2 text-base"
                  />
                ) : (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {["", ...groups].map((g) => {
                      const c = g ? colorOf(g) : null;
                      const on = filter === g;
                      return (
                        <button
                          key={g || "all"}
                          onClick={() => setFilter(g)}
                          className={`rounded-lg border px-4 py-2 font-semibold ${on ? "border-emerald-800 bg-emerald-800 text-white" : c ? `${c.bg} ${c.border} ${c.text}` : "bg-white"}`}
                        >
                          {g || "すべて"}
                        </button>
                      );
                    })}
                  </div>
                )}
                {customer && tab !== "search" && !arrange && (
                  <div className="mb-4 border-l-4 border-sky-400 pl-2">
                    <h3 className="mb-1 text-sm font-semibold text-sky-800">{customer.name} 様の料金</h3>
                    {CUSTOMER_PRICES.some((p) => customer.prices[p.key] !== undefined) ? (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                        {CUSTOMER_PRICES.filter((p) => customer.prices[p.key] !== undefined).map((p) => (
                          <button
                            key={p.key}
                            onClick={() =>
                              addLine({
                                kind: "custom",
                                refId: "",
                                name: `いちご狩り ${p.label}（${customer.name}）`,
                                category: DEFAULT_PLAN_CATEGORY,
                                unitPrice: customer.prices[p.key]!,
                                taxRate: DEFAULT_PLAN_TAX,
                              })
                            }
                            className="flex h-20 flex-col justify-between rounded-lg border border-sky-300 bg-sky-50 p-2 text-left text-sm active:brightness-95"
                          >
                            <span className="leading-tight">いちご狩り {p.label}</span>
                            <span className="self-end tabular-nums">{yen(customer.prices[p.key]!)}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500">この顧客の単価はまだ設定されていません（顧客リストの詳細で設定できます）</p>
                    )}
                  </div>
                )}
                {tab === "search" && q === "" && <p className="py-6 text-center text-sm text-gray-400">商品名の一部を入れてください</p>}
                {tab === "search" && q !== "" && shownTiles.length === 0 && <p className="py-6 text-center text-sm text-gray-400">見つかりません</p>}
                {groups
                  .filter((g) => shownTiles.some((t) => t.group === g))
                  .map((g) => {
                    const c = colorOf(g);
                    const items = shownTiles.filter((t) => t.group === g);
                    return (
                      <div key={g} className={`mb-4 border-l-4 pl-2 ${c.border}`}>
                        <h3 className={`mb-1 flex items-center gap-2 text-sm font-semibold ${c.text}`}>
                          {g} <span className="text-xs font-normal text-gray-500">{items.length}商品</span>
                          {arrange && (
                            <>
                              <button onClick={() => moveGroup(g, -1)} className="rounded border bg-white px-2 text-gray-700" aria-label={`${g}を前へ`}>
                                ◀
                              </button>
                              <button onClick={() => moveGroup(g, 1)} className="rounded border bg-white px-2 text-gray-700" aria-label={`${g}を後ろへ`}>
                                ▶
                              </button>
                            </>
                          )}
                        </h3>
                        {tab === "list" ? (
                          <ul className="divide-y rounded-lg border">
                            {items.map((t) => (
                              <li key={t.key}>
                                <button onClick={() => tap(t)} className="flex w-full items-center justify-between px-3 py-2.5 text-left active:bg-gray-100">
                                  <span>{t.name}</span>
                                  <span className="text-sm tabular-nums">{t.price === 0 ? "金額入力" : yen(t.price)}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <>
                            {/* 広い画面：マス目に置く（空いたマスもそのまま） */}
                            <div
                              className="hidden gap-2 lg:grid"
                              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "5rem" }}
                            >
                              {items.map((t) => {
                                const slot = slots.get(t.key) ?? 0;
                                return (
                                  <TileButton
                                    key={t.key}
                                    t={t}
                                    c={c}
                                    onClick={() => tap(t)}
                                    style={{ gridColumnStart: (slot % cols) + 1, gridRowStart: Math.floor(slot / cols) + 1 }}
                                    state={picked === t.key ? "picked" : arrange && picked ? "target" : undefined}
                                  />
                                );
                              })}
                              {arrange &&
                                emptySlots(items.map((t) => slots.get(t.key) ?? 0), cols).map((slot) => (
                                  <button
                                    key={`empty-${slot}`}
                                    onClick={() => moveTo(g, slot)}
                                    style={{ gridColumnStart: (slot % cols) + 1, gridRowStart: Math.floor(slot / cols) + 1 }}
                                    className={`rounded-lg border-2 border-dashed text-xs text-gray-400 ${picked ? "border-sky-300 bg-sky-50" : "border-gray-200"}`}
                                    aria-label={`空きマス ${slot + 1}`}
                                  >
                                    {picked ? "ここへ" : ""}
                                  </button>
                                ))}
                            </div>
                            {/* 狭い画面：空いたマスは詰めて、同じ順番で並べる */}
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:hidden">
                              {[...items]
                                .sort((x, y) => (slots.get(x.key) ?? 0) - (slots.get(y.key) ?? 0))
                                .map((t) => (
                                  <TileButton key={t.key} t={t} c={c} onClick={() => tap(t)} />
                                ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                {tiles.length === 0 && (
                  <p className="py-6 text-center text-sm text-gray-400">
                    商品がありません。管理者が「商品設定」で登録してください。「カスタム商品」から手入力もできます。
                  </p>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="space-y-4 rounded-2xl bg-white p-4 shadow-sm">
            <button onClick={() => setStep("order")} className="text-sm text-gray-600 underline">
              ← 注文入力に戻る
            </button>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt>小計（{count}点）</dt>
                <dd>{yen(subtotal)}</dd>
              </div>
              {subtotal !== total && (
                <div className="flex justify-between text-red-700">
                  <dt>値引き</dt>
                  <dd>−{yen(subtotal - total)}</dd>
                </div>
              )}
              <div className="flex justify-between text-2xl font-bold">
                <dt>合計（税込）</dt>
                <dd>{yen(total)}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              全部に
              <input
                inputMode="numeric"
                value={allRate}
                onChange={(e) => setAllRate(toDigits(e.target.value).slice(0, 3))}
                className="w-16 rounded border px-2 py-1 text-right"
                aria-label="全体の割引率"
              />
              %引きを
              <button onClick={() => setLines(lines.map((l) => ({ ...l, discountRate: Math.min(100, Number(allRate) || 0) })))} className="rounded border px-3 py-1">
                かける
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["cash", "credit"] as const).map((m) => (
                <button key={m} onClick={() => setPayment(m)} className={`rounded-lg border py-3 font-bold ${payment === m ? "border-berry bg-berry text-white" : ""}`}>
                  {PAYMENT_LABEL[m]}
                </button>
              ))}
            </div>
            <label className="block text-sm">
              <span className="text-gray-600">お客様名{payment === "credit" && <span className="text-red-600">（売掛は必須）</span>}</span>
              <input value={customerName} maxLength={50} onChange={(e) => setCustomerName(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
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
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={confirm}
              disabled={saving || alreadyPaid || lines.length === 0}
              className="w-full rounded-lg bg-berry py-4 text-lg font-bold text-white disabled:opacity-40"
            >
              {saving ? "処理中…" : `${PAYMENT_LABEL[payment]}で確定（${yen(total)}）`}
            </button>
          </section>
        )}
      </div>

      {/* スマホ：画面下に合計と「支払いへ進む」 */}
      {step === "order" && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <div>
              <div className="text-xs text-gray-500">合計 {count}点</div>
              <div className="text-xl font-bold text-berry">{yen(total)}</div>
            </div>
            <button
              onClick={() => {
                setStep("pay");
                window.scrollTo(0, 0);
              }}
              disabled={lines.length === 0 || alreadyPaid}
              className="ml-auto rounded-lg bg-emerald-700 px-6 py-3 font-bold text-white disabled:opacity-40"
            >
              支払いへ進む
            </button>
          </div>
        </div>
      )}

      {/* 顧客を選ぶ */}
      {pickingCustomer && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setPickingCustomer(false)}>
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-white p-4 shadow-lg">
            <p className="font-bold">顧客を選ぶ</p>
            <input
              autoFocus
              value={customerQ}
              onChange={(e) => setCustomerQ(e.target.value)}
              placeholder="名前・ふりがな・電話で探す"
              className="mt-2 w-full rounded-lg border px-3 py-2 text-base"
            />
            <ul className="mt-2 flex-1 divide-y overflow-y-auto">
              {!customers && <li className="py-3 text-sm text-gray-500">読み込み中…</li>}
              {customers?.filter((c) => c.active && matchCustomer(c, customerQ)).map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => {
                      setCustomer(c);
                      setCustomerName(c.name);
                      if (c.payment) setPayment(c.payment);
                      setPickingCustomer(false);
                      setCustomerQ("");
                    }}
                    className="flex w-full items-center justify-between px-2 py-2.5 text-left active:bg-gray-100"
                  >
                    <span>
                      <span className="font-semibold">{c.name}</span>
                      {c.phone && <span className="ml-2 text-xs text-gray-500">{c.phone}</span>}
                    </span>
                    <span className="text-xs text-gray-500">
                      {CUSTOMER_PRICES.filter((p) => c.prices[p.key] !== undefined)
                        .map((p) => `${p.label}${c.prices[p.key]!.toLocaleString("ja-JP")}`)
                        .join("・")}
                    </span>
                  </button>
                </li>
              ))}
              {customers && customers.filter((c) => c.active && matchCustomer(c, customerQ)).length === 0 && (
                <li className="py-3 text-sm text-gray-500">見つかりません（顧客は「顧客リスト」で登録します）</li>
              )}
            </ul>
            <button onClick={() => setPickingCustomer(false)} className="mt-2 rounded-lg border py-2">
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* 金額入力（値段が0円の商品） */}
      {ask && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setAsk(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.amount === "") return;
              addTile(ask.tile, Number(ask.amount));
              setAsk(null);
            }}
            className="w-full max-w-xs rounded-2xl bg-white p-4 shadow-lg"
          >
            <p className="font-bold">{ask.tile.name}</p>
            <label className="mt-2 block text-sm">
              <span className="text-gray-600">金額（税込）</span>
              <input
                autoFocus
                inputMode="numeric"
                value={ask.amount}
                onChange={(e) => setAsk({ ...ask, amount: toDigits(e.target.value).slice(0, 7) })}
                className="mt-1 w-full rounded-lg border px-3 py-3 text-right text-2xl"
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setAsk(null)} className="rounded-lg border py-3">
                やめる
              </button>
              <button type="submit" disabled={ask.amount === ""} className="rounded-lg bg-emerald-700 py-3 font-bold text-white disabled:opacity-40">
                追加
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function TileButton({
  t,
  c,
  onClick,
  style,
  state,
}: {
  t: Tile;
  c: (typeof GROUP_COLORS)[number];
  onClick: () => void;
  style?: React.CSSProperties;
  state?: "picked" | "target";
}) {
  return (
    <button
      onClick={onClick}
      style={style}
      className={`flex h-20 flex-col justify-between rounded-lg border p-2 text-left text-sm active:brightness-95 ${c.bg} ${c.border} ${
        state === "picked" ? "ring-4 ring-sky-500" : state === "target" ? "outline-dashed outline-2 outline-sky-300" : ""
      }`}
    >
      <span className="line-clamp-2 leading-tight">{t.name}</span>
      <span className="self-end text-sm tabular-nums">{t.price === 0 ? "金額入力" : yen(t.price)}</span>
    </button>
  );
}

/**
 * 分類ごとのマスの番号を決める。保存した番号を使い、ないタイル（新しい商品など）や
 * 重なったタイルは、その分類の空いている後ろのマスに置く。
 */
function assignSlots(tiles: Tile[], saved?: Record<string, number>): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Map<string, Set<number>>();
  const usedOf = (g: string) => used.get(g) ?? used.set(g, new Set()).get(g)!;
  const rest: Tile[] = [];
  for (const t of tiles) {
    const s = saved?.[t.key];
    const u = usedOf(t.group);
    if (typeof s === "number" && Number.isInteger(s) && s >= 0 && s < 500 && !u.has(s)) {
      result.set(t.key, s);
      u.add(s);
    } else rest.push(t);
  }
  for (const t of rest) {
    const u = usedOf(t.group);
    let s = u.size === 0 ? 0 : Math.max(...u) + 1;
    while (u.has(s)) s++;
    result.set(t.key, s);
    u.add(s);
  }
  return result;
}

/** 並べ替え中に見せる空きマス（使っている行と、その下の1行） */
function emptySlots(usedSlots: number[], cols: number): number[] {
  const rows = (usedSlots.length === 0 ? 0 : Math.floor(Math.max(...usedSlots) / cols) + 1) + 1;
  const used = new Set(usedSlots);
  return Array.from({ length: rows * cols }, (_, i) => i).filter((i) => !used.has(i));
}

type Tile = { key: string; kind: "plan" | "product"; refId: string; name: string; group: string; price: number; taxRate: TaxRate };

/** 分類ごとの色（Airレジのように、分類ごとにタイルの色を変える） */
const GROUP_COLORS = [
  { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-800" },
  { bg: "bg-pink-50", border: "border-pink-300", text: "text-pink-800" },
  { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-800" },
  { bg: "bg-sky-50", border: "border-sky-300", text: "text-sky-800" },
  { bg: "bg-violet-50", border: "border-violet-300", text: "text-violet-800" },
  { bg: "bg-lime-50", border: "border-lime-300", text: "text-lime-800" },
];

/** 会計画面に並べるもの：「商品設定」で販売中にした商品だけ（予約のプラン料金は、予約から会計したときに注文リストへ自動で入る） */
function buildTiles(settings: Settings, layout?: TileLayout): Tile[] {
  const tiles: Tile[] = settings.products
    .filter((p) => p.active)
    .map((p) => ({ key: `p-${p.id}`, kind: "product", refId: p.id, name: p.name, group: p.group || "その他", price: p.price, taxRate: p.taxRate ?? DEFAULT_PRODUCT_TAX }));
  // 保存した並びがあればその順に。新しく増えた商品は後ろに付ける
  if (!layout) return tiles;
  const pos = new Map(layout.tiles.map((k, i) => [k, i]));
  return tiles
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (pos.get(a.t.key) ?? 100000 + a.i) - (pos.get(b.t.key) ?? 100000 + b.i))
    .map((x) => x.t);
}

/** 分類の並び：保存した順、そのあとにまだ並びにない分類 */
function orderGroups(tiles: Tile[], saved?: string[]): string[] {
  const all = [...new Set(tiles.map((t) => t.group))];
  return [...(saved ?? []).filter((g) => all.includes(g)), ...all.filter((g) => !(saved ?? []).includes(g))];
}

/** 全角数字を半角にして、数字以外を取り除く */
function toDigits(v: string): string {
  return v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
}
