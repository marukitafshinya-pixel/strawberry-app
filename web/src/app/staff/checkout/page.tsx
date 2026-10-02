"use client";

import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { CUSTOMER_PRICES, matchCustomer, useCustomers, type Customer } from "@/lib/customers";
import { formatJa, todayJST } from "@/lib/date";
import { isHomeScreenApp, loadPrinter, openDrawerWithSii, printReceipt, saleReceipt } from "@/lib/receiptPrinter";
import { loadLastHandler, saveLastHandler, useHandlers } from "@/lib/register";
import { getFirebase } from "@/lib/firebase";
import { STATUS_LABEL, STATUS_STYLE, peopleText, useReservations, useSettings, yen, type Reservation } from "@/lib/reservations";
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
  // 予約名簿から選びなおしたときに古い予約が残らないよう、読み込んだ予約のIDと照らし合わせる
  const [loaded, setLoaded] = useState<Reservation | null>(null);
  const reservation: Reservation | null | undefined = reservationId ? (loaded?.id === reservationId ? loaded : undefined) : null;
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
        else setLoaded({ id: snap.id, ...(snap.data() as Omit<Reservation, "id">) });
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

/**
 * プリンターのアプリ（SII URL Print Agent）に切り替える会計は、ボタンを押したその場で切り替える
 * （サーバーの返事を待ってから切り替えると、iPad が「開きますか？」と聞いてくるため）。
 * そのため会計の中身をこの端末に控えておき、戻ってきたら同じ番号でもう一度送って確定を確かめる。
 * サーバーは同じ番号の会計を2回記録しない。
 */
const PENDING_KEY = "ichigo.pendingCheckout";
/** 直前の会計（次の会計の画面から、レシートを出せるように） */
const LAST_SALE_KEY = "ichigo.lastSale";
type Pending = {
  requestId: string;
  payload: Record<string, unknown>;
  sale: Sale;
  lines: Line[];
  payment: PaymentMethod;
  received: string;
  customerName: string;
  memo: string;
};
function loadPending(): Pending | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
    return v && typeof v.requestId === "string" ? v : null;
  } catch {
    return null;
  }
}
function savePending(p: Pending | null) {
  try {
    if (p) window.localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // 保存できなくても会計は進める（戻ったときに確かめられないだけ）
  }
}
function newRequestId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function Checkout({ settings, reservation: r, editing }: { settings: Settings; reservation: Reservation | null; editing: Sale | null }) {
  // プリンターのアプリから戻ってきたところなら、控えておいた会計を使う
  const [resume] = useState<Pending | null>(() => (typeof window !== "undefined" && !editing ? loadPending() : null));
  const [lines, setLines] = useState<Line[]>(() =>
    resume
      ? resume.lines
      : editing
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
  const [customerName, setCustomerName] = useState(resume?.customerName ?? editing?.customerName ?? r?.customerName ?? "");
  const [payment, setPayment] = useState<PaymentMethod>(resume?.payment ?? editing?.payment ?? "cash");
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState(resume?.memo ?? editing?.memo ?? "");
  const [received, setReceived] = useState(resume?.received ?? "");
  const [allRate, setAllRate] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(!!resume);
  /** 戻ってきたときに確定を確かめられなかった会計（もう一度送る） */
  const [retry, setRetry] = useState<Pending | null>(null);
  const [done, setDone] = useState<{ id: string; total: number } | null>(null);
  /** 印刷用に、確定した会計の中身を控えておく */
  const [doneSale, setDoneSale] = useState<Sale | null>(null);
  const [printError] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("printError"));
  /** プリンターのアプリから戻ってきたとき、直前の会計（合計・おつり）を見せる */
  const [lastPaid] = useState(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const id = q.get("lastId");
    return q.has("lastTotal")
      ? {
          total: Number(q.get("lastTotal")) || 0,
          received: q.has("lastReceived") ? Number(q.get("lastReceived")) || 0 : null,
          change: q.has("lastChange") ? Number(q.get("lastChange")) || 0 : null,
          id: id && /^[A-Za-z0-9]{1,40}$/.test(id) ? id : null,
        }
      : null;
  });
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
  /** 予約名簿（今日の予約）を開いているか */
  const [pickingReservation, setPickingReservation] = useState(false);
  const router = useRouter();
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

  /** サーバーに送る会計の中身 */
  const payloadNow = () => ({
    reservationId: r?.id ?? null,
    date: editing?.date ?? todayJST(),
    replaceSaleId: editing?.id ?? null,
    customerName,
    payment,
    dueDate: payment === "credit" ? dueDate || null : null,
    memo,
    // レジで選んでいる取扱者を、会計の担当として記録する
    handler: loadLastHandler(),
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
  const saleNow = (id: string): Sale => ({
    id,
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
    handler: loadLastHandler(),
  });

  /** 控えておいた会計を送り、確定したら完了の画面にする（同じ番号なので2回送っても1回分） */
  async function submitPending(p: Pending, thenNew = false) {
    setSaving(true);
    setError("");
    try {
      const res = await callFunction<Record<string, unknown>, { id: string; total: number }>("checkout", { ...p.payload, requestId: p.requestId });
      savePending(null);
      setRetry(null);
      if (thenNew) {
        // すぐ次の会計の画面にする。前回の会計はレシートを後から出せるよう控えておく
        const change = p.payment === "cash" && p.received !== "" ? Number(p.received) - p.sale.total : null;
        try {
          window.localStorage.setItem(LAST_SALE_KEY, JSON.stringify({ sale: { ...p.sale, id: res.id }, received: p.received }));
        } catch {
          // 控えられなくても会計は確定している
        }
        window.location.replace(
          `/staff/checkout/?lastTotal=${p.sale.total}${change !== null && change >= 0 ? `&lastReceived=${Number(p.received)}&lastChange=${change}` : ""}&lastId=${res.id}`,
        );
        return;
      }
      setDone(res);
      setDoneSale({ ...p.sale, id: res.id });
      window.scrollTo(0, 0);
    } catch (e) {
      setRetry(p);
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  // プリンターのアプリから戻ってきたら、控えておいた会計を確かめる
  useEffect(() => {
    // 画面を出してから送る
    if (resume) queueMicrotask(() => submitPending(resume));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    setError("");
    if (lines.length === 0) return setError("明細を1つ以上入れてください");
    if (payment === "credit" && !customerName.trim()) return setError("売掛のときは、お客様名を入れてください");
    const pc = loadPrinter();
    const useAgent = pc.method === "sii" && !editing && (pc.autoPrint || (payment === "cash" && pc.drawerOnCashConfirm));
    if (useAgent) {
      // 押したその場でプリンターのアプリに切り替える（iPad の「開きますか？」を出さないため）
      const requestId = newRequestId();
      const pending: Pending = { requestId, payload: payloadNow(), sale: saleNow(requestId), lines, payment, received, customerName, memo };
      savePending(pending);
      setSaving(true);
      // 先に送っておく（戻ってきたときに同じ番号で送り直して、確定を確かめる）
      callFunction("checkout", { ...pending.payload, requestId }).catch(() => {});
      const back = "/staff/checkout/?resume=1";
      if (pc.autoPrint) printReceipt(saleReceipt(settings, pending.sale, { received: received === "" ? null : Number(received) }), back, payment === "cash" ? "sale-cash" : "other");
      else openDrawerWithSii(pc, back);
      // ホーム画面のアプリのときは、この画面のまま戻ってくるので、ここで確定を確かめる
      // 確定したら、そのまま次の会計の画面にする（「続けて別の会計をする」を押さなくてよいように）
      if (isHomeScreenApp()) void submitPending(pending, true);
      return;
    }
    setSaving(true);
    try {
      const res = await callFunction<Record<string, unknown>, { id: string; total: number }>("checkout", payloadNow());
      setDone(res);
      const sale = saleNow(res.id);
      setDoneSale(sale);
      window.scrollTo(0, 0);
      // 設定で「すぐに印刷」にしていれば、そのままレシートを出す（ふつうの印刷のとき）
      if (pc.autoPrint) printReceipt(saleReceipt(settings, sale, { received: received === "" ? null : Number(received) }), "/staff/checkout/", "other");
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
                printReceipt(saleReceipt(settings, doneSale, { received: received === "" ? null : Number(received) }), "/staff/checkout/")
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

  // 顧客を選んでいるときは、その顧客だけの値段にする（並べ替え中は元の値段のまま）
  const special = !arrange ? (customer?.products ?? {}) : {};
  const tiles = buildTiles(settings, arrange ?? settings.tileLayout).map((t) =>
    t.kind === "product" && special[t.refId] !== undefined ? { ...t, price: special[t.refId], special: true } : t,
  );
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
        <div className="flex items-center gap-2">
          <HandlerPicker />
          <Link href={`/staff/checkout/history/?date=${todayJST()}`} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            取引履歴
          </Link>
        </div>
      </div>
      {r ? (
        <p className="mt-1 text-sm text-gray-600">
          予約：{formatJa(r.date)} {r.slotTime} {r.customerName}様（{peopleText(r)}）
        </p>
      ) : null}
      {resume && !done && !retry && (
        <p className="mt-2 rounded-lg bg-sky-50 p-3 text-sky-900">会計を確定しています…</p>
      )}
      {retry && !done && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-bold">
            {yen(retry.sale.total)}（{PAYMENT_LABEL[retry.payment]}）の会計の確定を確かめられませんでした。
          </p>
          <p className="mt-1">電波を確かめて「もう一度送る」を押してください。同じ会計が2回記録されることはありません。（{error}）</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={saving} onClick={() => submitPending(retry)} className="rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50">
              {saving ? "送信中…" : "もう一度送る"}
            </button>
            <button
              disabled={saving}
              onClick={() => {
                if (!window.confirm("この会計を記録せずにやめますか？（すでに記録されていた場合は、取引履歴から取り消してください）")) return;
                savePending(null);
                setRetry(null);
                setError("");
              }}
              className="rounded-lg border bg-white px-4 py-2"
            >
              この会計をやめる
            </button>
          </div>
        </div>
      )}
      {lastPaid && step === "order" && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-green-50 p-3 text-green-900">
          <span className="text-sm font-bold">前回の会計</span>
          <span className="flex flex-wrap items-baseline gap-x-5 gap-y-1 tabular-nums">
            <span>
              金額 <b className="text-3xl">{yen(lastPaid.total)}</b>
            </span>
            {lastPaid.received !== null && (
              <span>
                お預かり <b className="text-3xl">{yen(lastPaid.received)}</b>
              </span>
            )}
            {lastPaid.change !== null && (
              <span>
                おつり <b className="text-3xl text-green-800">{yen(lastPaid.change)}</b>
              </span>
            )}
          </span>
          <button
            onClick={() => {
              try {
                const v = JSON.parse(window.localStorage.getItem(LAST_SALE_KEY) ?? "null") as { sale: Sale; received: string } | null;
                if (!v) return setError("前回の会計が見つかりません。取引履歴から印刷してください");
                printReceipt(saleReceipt(settings, v.sale, { received: v.received === "" ? null : Number(v.received) }), "/staff/checkout/");
              } catch {
                setError("前回の会計が見つかりません。取引履歴から印刷してください");
              }
            }}
            className="rounded-lg border border-green-700 bg-white px-3 py-1.5 text-sm font-bold text-green-800"
          >
            このレシートを印刷
          </button>
          {lastPaid.id && (
            <Link href={`/staff/receipt/?sale=${lastPaid.id}&from=checkout&kind=invoice`} className="rounded-lg border border-green-700 bg-white px-3 py-1.5 text-sm font-bold text-green-800">
              領収書（宛名つき）
            </Link>
          )}
        </div>
      )}
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

      <div className={`mt-3 grid gap-4 ${step === "pay" ? "" : "lg:grid-cols-[24rem_1fr] 2xl:grid-cols-[30rem_1fr]"}`}>
        {/* 左：注文リスト */}
        <section className={`flex flex-col rounded-2xl bg-white shadow-sm lg:sticky lg:top-4 lg:h-[calc(100dvh-9.5rem)] ${step === "pay" ? "hidden" : ""}`}>
          <div className="relative flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="font-bold">注文リスト</h2>
            {!editing && (
              <button
                onClick={() => setPickingReservation(!pickingReservation)}
                className={`rounded-lg border px-3 py-1 text-sm font-semibold ${pickingReservation ? "border-berry bg-berry text-white" : "border-berry text-berry"}`}
                aria-expanded={pickingReservation}
              >
                予約名簿 ▾
              </button>
            )}
            {pickingReservation && (
              <ReservationRoster
                current={r}
                onPick={(id) => {
                  setPickingReservation(false);
                  if (id === r?.id) return;
                  if (lines.length > 0 && !window.confirm("いまの注文リストを、この予約の内容に入れ替えますか？")) return;
                  router.replace(`/staff/checkout/?reservation=${id}`);
                }}
                onClear={
                  r
                    ? () => {
                        setPickingReservation(false);
                        if (lines.length > 0 && !window.confirm("予約を外して、注文リストを空にしますか？")) return;
                        router.replace("/staff/checkout/");
                      }
                    : null
                }
              />
            )}
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
                    {CUSTOMER_PRICES.some((p) => customer.prices[p.key] !== undefined) || tiles.some((t) => t.special) ? (
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
                        {tiles
                          .filter((t) => t.special)
                          .map((t) => (
                            <TileButton key={`sp-${t.key}`} t={t} c={{ bg: "bg-sky-50", border: "border-sky-300", text: "text-sky-800" }} onClick={() => tap(t)} />
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
          // 1画面に収まるよう、左に合計・支払い方法・確定、右にお預かり・テンキー・おつりを並べる
          <section className="mx-auto grid w-full max-w-6xl gap-6 rounded-2xl bg-white p-5 shadow-sm md:grid-cols-2">
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <button onClick={() => setStep("order")} className="text-gray-600 underline">
                  ← 注文入力に戻る
                </button>
                <span className="text-gray-600">
                  小計（{count}点）{yen(subtotal)}
                  {subtotal !== total && <span className="ml-2 text-red-700">値引き −{yen(subtotal - total)}</span>}
                </span>
              </div>
              {/* お客様に見せる合計 */}
              <div className="rounded-2xl border-2 border-berry bg-berry/5 px-3 py-3 text-center">
                <div className="text-base font-bold text-gray-700">お会計（税込）</div>
                <div className="text-6xl font-bold tabular-nums text-berry-dark xl:text-7xl">{yen(total)}</div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(["cash", "credit"] as const).map((m) => (
                  <button key={m} onClick={() => setPayment(m)} className={`rounded-lg border py-2.5 font-bold ${payment === m ? "border-berry bg-berry text-white" : ""}`}>
                    {PAYMENT_LABEL[m]}
                  </button>
                ))}
              </div>
              <label className="block text-sm">
                <span className="text-gray-600">お客様名{payment === "credit" && <span className="text-red-600">（売掛は必須）</span>}</span>
                <input value={customerName} maxLength={50} onChange={(e) => setCustomerName(e.target.value)} className="mt-0.5 w-full rounded-lg border px-3 py-1.5 text-base" />
              </label>
              {payment === "credit" && (
                <label className="block text-sm">
                  <span className="text-gray-600">回収予定日（任意）</span>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-0.5 w-full rounded-lg border px-3 py-1.5 text-base" />
                </label>
              )}
              <label className="block text-sm">
                <span className="text-gray-600">メモ（任意）</span>
                <input value={memo} maxLength={200} onChange={(e) => setMemo(e.target.value)} className="mt-0.5 w-full rounded-lg border px-3 py-1.5 text-base" />
              </label>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                全部に
                <input
                  inputMode="numeric"
                  value={allRate}
                  onChange={(e) => setAllRate(toDigits(e.target.value).slice(0, 3))}
                  className="w-14 rounded border px-2 py-1 text-right"
                  aria-label="全体の割引率"
                />
                %引きを
                <button onClick={() => setLines(lines.map((l) => ({ ...l, discountRate: Math.min(100, Number(allRate) || 0) })))} className="rounded border px-3 py-1">
                  かける
                </button>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              {payment === "cash" && (
                <div
                  className={`mt-auto rounded-2xl px-3 py-2 text-center ${change === null ? "bg-gray-50 text-gray-400" : change < 0 ? "bg-red-50 text-red-700" : "bg-green-50 text-green-900"}`}
                >
                  <div className="text-base font-bold">{change !== null && change < 0 ? "足りません" : "おつり"}</div>
                  <div className="text-6xl font-bold tabular-nums xl:text-7xl">{change === null ? "－" : yen(Math.abs(change))}</div>
                </div>
              )}
            </div>
            {payment === "cash" ? (
              <div className="flex flex-col">
                <label className="block">
                  <span className="text-base font-bold text-gray-700">お預かり</span>
                  <span className="ml-2 text-xs text-gray-500">（おつりの計算用・任意）</span>
                  {/* iPadではキーボードを出さず、下のテンキーで入れる（つないだキーボードでも打てる） */}
                  <input
                    inputMode="none"
                    value={received === "" ? "" : Number(received).toLocaleString("ja-JP")}
                    onChange={(e) => setReceived(toDigits(e.target.value).slice(0, 9))}
                    placeholder="0"
                    className="mt-0.5 w-full rounded-xl border-2 px-3 py-1.5 text-right text-4xl font-bold tabular-nums"
                  />
                </label>
                <Keypad
                  onKey={(k) => {
                    if (k === "C") return setReceived("");
                    if (k === "⌫") return setReceived(received.slice(0, -1));
                    const next = (received + k).replace(/^0+(?=\d)/, "");
                    if (next.length <= 9) setReceived(next);
                  }}
                  quick={[
                    { label: "ちょうど", v: total },
                    { label: "1,000円", v: 1000 },
                    { label: "5,000円", v: 5000 },
                    { label: "10,000円", v: 10000 },
                  ]}
                  onQuick={(v) => setReceived(String(v))}
                />
                <button
                  onClick={confirm}
                  disabled={saving || alreadyPaid || lines.length === 0}
                  className="mt-auto w-full rounded-lg bg-berry py-4 text-lg font-bold text-white disabled:opacity-40"
                >
                  {saving ? "処理中…" : `${PAYMENT_LABEL[payment]}で確定（${yen(total)}）`}
                </button>
              </div>
            ) : (
              <div className="flex flex-col">
                <div className="hidden rounded-2xl bg-gray-50 p-4 text-sm text-gray-500 md:block">売掛のときは、お預かりの入力はいりません。</div>
                <button
                  onClick={confirm}
                  disabled={saving || alreadyPaid || lines.length === 0}
                  className="mt-auto w-full rounded-lg bg-berry py-4 text-lg font-bold text-white disabled:opacity-40"
                >
                  {saving ? "処理中…" : `${PAYMENT_LABEL[payment]}で確定（${yen(total)}）`}
                </button>
              </div>
            )}
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
      <span className="flex items-end justify-between gap-1">
        {t.special ? <span className="rounded bg-sky-600 px-1 text-[10px] font-bold text-white">顧客価格</span> : <span />}
        <span className={`text-sm tabular-nums ${t.special ? "font-bold text-sky-800" : ""}`}>{t.price === 0 ? "金額入力" : yen(t.price)}</span>
      </span>
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

type Tile = { key: string; kind: "plan" | "product"; refId: string; name: string; group: string; price: number; taxRate: TaxRate; special?: boolean };

/** 分類ごとの色（Airレジのように、分類ごとにタイルの色を変える） */
const GROUP_COLORS = [
  { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-800" },
  { bg: "bg-pink-50", border: "border-pink-300", text: "text-pink-800" },
  { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-800" },
  { bg: "bg-sky-50", border: "border-sky-300", text: "text-sky-800" },
  { bg: "bg-violet-50", border: "border-violet-300", text: "text-violet-800" },
  { bg: "bg-lime-50", border: "border-lime-300", text: "text-lime-800" },
];

/** 予約名簿：今日の、まだ会計していない予約を時間順に出す（会計すると消える） */
function ReservationRoster({ current, onPick, onClear }: { current: Reservation | null; onPick: (id: string) => void; onClear: (() => void) | null }) {
  const today = todayJST();
  const { value, error } = useReservations(today);
  const list = (value ?? [])
    .filter((x) => x.status !== "cancelled" && x.status !== "request" && !x.saleId)
    .sort((a, b) => a.slotTime.localeCompare(b.slotTime) || a.customerName.localeCompare(b.customerName, "ja"));
  return (
    <div className="absolute left-2 right-2 top-full z-30 mt-1 max-h-[60dvh] overflow-y-auto rounded-xl border bg-white shadow-lg">
      <p className="sticky top-0 border-b bg-white px-3 py-2 text-xs text-gray-500">{formatJa(today)} の予約（会計がまだのもの・時間順）</p>
      {error ? (
        <p className="px-3 py-4 text-sm text-red-600">予約を読み込めませんでした</p>
      ) : !value ? (
        <p className="px-3 py-4 text-sm text-gray-500">読み込み中…</p>
      ) : list.length === 0 ? (
        <p className="px-3 py-4 text-sm text-gray-500">会計がまだの予約はありません</p>
      ) : (
        <ul className="divide-y">
          {list.map((x) => (
            <li key={x.id}>
              <button onClick={() => onPick(x.id)} className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${x.id === current?.id ? "bg-pink-50" : "hover:bg-gray-50"}`}>
                <span className="w-12 shrink-0 text-lg font-bold tabular-nums">{x.slotTime}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{x.customerName || "（名前なし）"} 様</span>
                  <span className="block truncate text-xs text-gray-500">
                    {x.planName}・{peopleText(x)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums">{x.people}名</span>
                  <span className={`rounded px-1.5 text-xs ${STATUS_STYLE[x.status]}`}>{STATUS_LABEL[x.status]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onClear && (
        <button onClick={onClear} className="sticky bottom-0 w-full border-t bg-white px-3 py-2 text-sm text-gray-600">
          予約を外す（予約なしの会計にする）
        </button>
      )}
    </div>
  );
}

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

/** お預かりを入れるテンキー（右の列はよく使う金額） */
function Keypad({ onKey, quick, onQuick }: { onKey: (k: string) => void; quick: { label: string; v: number }[]; onQuick: (v: number) => void }) {
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00", "⌫"];
  const btn = "rounded-xl border bg-white text-3xl font-bold tabular-nums shadow-sm active:bg-gray-200 select-none";
  return (
    <div className="mt-2 mb-3 grid grid-cols-4 gap-1.5" style={{ gridAutoRows: "3.8rem" }}>
      {keys.map((k, i) => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          style={{ gridColumnStart: (i % 3) + 1, gridRowStart: Math.floor(i / 3) + 1 }}
          className={`${btn} ${k === "⌫" ? "text-2xl text-gray-600" : ""}`}
          aria-label={k === "⌫" ? "1文字消す" : k}
        >
          {k}
        </button>
      ))}
      {quick.map((q, i) => (
        <button
          key={q.label}
          type="button"
          onClick={() => onQuick(q.v)}
          style={{ gridColumnStart: 4, gridRowStart: i + 1 }}
          className="rounded-xl border border-sky-300 bg-sky-50 text-base font-bold text-sky-900 shadow-sm active:bg-sky-100"
        >
          {q.label}
        </button>
      ))}
      <button type="button" onClick={() => onKey("C")} className="col-span-4 h-10 self-end rounded-xl border bg-gray-50 text-base font-bold text-gray-700 active:bg-gray-200" style={{ gridRowStart: 5 }}>
        クリア
      </button>
    </div>
  );
}

/** 全角数字を半角にして、数字以外を取り除く */
function toDigits(v: string): string {
  return v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
}

/** レジの取扱者（この端末で選んだ人。領収書の「扱者」に最初から入る） */
function HandlerPicker() {
  const handlers = useHandlers();
  const [handler, setHandler] = useState(() => (typeof window !== "undefined" ? loadLastHandler() : ""));
  if (!handlers) return null;
  if (handlers.length === 0)
    return (
      <Link href="/staff/checkout/settings/" className="text-xs text-gray-500 underline">
        取扱者を登録
      </Link>
    );
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-gray-600">取扱者</span>
      <select
        value={handler}
        onChange={(e) => {
          setHandler(e.target.value);
          saveLastHandler(e.target.value);
        }}
        className={`rounded-lg border px-2 py-1.5 text-base ${handler ? "border-emerald-700 font-semibold" : "border-amber-500 bg-amber-50"}`}
      >
        <option value="">（選ぶ）</option>
        {handlers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
        {handler && !handlers.includes(handler) && <option value={handler}>{handler}</option>}
      </select>
    </label>
  );
}
