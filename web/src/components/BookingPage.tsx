"use client";

import { FirebaseError } from "firebase/app";
import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ensureAppCheck } from "@/lib/appCheck";
import { callFunction, cleanMessage } from "@/lib/callFunction";
import { addDays, formatJa, todayJST, weekday } from "@/lib/date";
import { getFirebase } from "@/lib/firebase";
import { useSettings, yen } from "@/lib/reservations";
import type { Settings } from "@/lib/settings";

type Step = "form" | "confirm" | "done";

/** 予約できる日付の範囲（締切〜何日先まで） */
function bookingRange(s: Settings) {
  const today = todayJST();
  return { first: addDays(today, s.bookingCutoffDays), last: addDays(today, s.bookingDaysAhead) };
}

function isOpenDay(date: string, s: Settings): boolean {
  const md = date.slice(5);
  const inSeason = s.seasonStart <= s.seasonEnd ? md >= s.seasonStart && md <= s.seasonEnd : md >= s.seasonStart || md <= s.seasonEnd;
  return inSeason && !s.closedDates.includes(date);
}

/**
 * 日付ごと・時間枠ごとの数字（誰でも読める情報だけ。個人情報は含まない）
 * - availability：予約人数
 * - dailyCapacity：この日だけの定員
 */
function useRange<T = number>(
  name: "availability" | "dailyCapacity",
  field: "slots" | "stopped",
  first: string | null,
  last: string | null,
) {
  const [data, setData] = useState<Record<string, Record<string, T>> | null>(null);
  useEffect(() => {
    if (!first || !last) return;
    let unsubscribe = () => {};
    let cancelled = false;
    getFirebase().then(({ db }) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        query(collection(db, name), where(documentId(), ">=", first), where(documentId(), "<=", last)),
        (snap) => setData(Object.fromEntries(snap.docs.map((d) => [d.id, (d.get(field) as Record<string, T>) ?? {}]))),
        () => setData({}),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name, field, first, last]);
  return data;
}

export function BookingPage() {
  const { value: settings, error } = useSettings();
  // ロボット対策を先に準備しておく
  useEffect(() => {
    ensureAppCheck();
  }, []);
  if (error) return <Shell>読み込めませんでした。時間をおいてもう一度お試しください。</Shell>;
  if (!settings) return <Shell>読み込み中…</Shell>;
  return <Booking settings={settings} />;
}

function Shell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-6">
      <h1 className="text-2xl font-bold text-berry">🍓 {title || "いちご狩り"} ご予約</h1>
      <div className="mt-4">{children}</div>
      <p className="mt-12 text-center text-xs">
        <Link href="/staff/" className="text-gray-400 underline">
          スタッフの方はこちら
        </Link>
      </p>
    </main>
  );
}

function Booking({ settings: s }: { settings: Settings }) {
  const plans = s.plans.filter((p) => p.public);
  const { first, last } = bookingRange(s);
  const booked = useRange("availability", "slots", first, last);
  const daily = useRange("dailyCapacity", "slots", first, last);
  const stopped = useRange<boolean>("dailyCapacity", "stopped", first, last);
  /** Web予約の受付を止めている時間 */
  const isStopped = (d: string, sid: string) => stopped?.[d]?.[sid] === true;

  const [step, setStep] = useState<Step>("form");
  const [planId, setPlanId] = useState(plans.length === 1 ? plans[0].id : "");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [date, setDate] = useState("");
  const [slotId, setSlotId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [memo, setMemo] = useState("");
  const [website, setWebsite] = useState(""); // ロボット対策の見えない欄
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState("");
  const [resultStatus, setResultStatus] = useState<"confirmed" | "request">("confirmed");

  const plan = plans.find((p) => p.id === planId);
  const categories = s.priceCategories.filter((c) => plan?.prices[c.id] !== undefined);
  const people = categories.reduce((n, c) => n + (counts[c.id] ?? 0), 0);
  const amount = categories.reduce((n, c) => n + (counts[c.id] ?? 0) * (plan?.prices[c.id] ?? 0), 0);
  const slot = s.timeSlots.find((t) => t.id === slotId);

  const remaining = (d: string, sid: string) => {
    const cap = daily?.[d]?.[sid] ?? s.timeSlots.find((t) => t.id === sid)?.capacity ?? 0;
    return cap - (booked?.[d]?.[sid] ?? 0);
  };
  const bookable = (d: string) => d >= first && d <= last && isOpenDay(d, s);
  const need = Math.max(1, people);

  const slotOk = !!date && !!slotId && !isStopped(date, slotId);
  /** 定員を超えるので「リクエスト」になる */
  const isRequest = slotOk && remaining(date, slotId) < need;

  if (plans.length === 0 || s.timeSlots.length === 0) {
    return <Shell title={s.storeName}>ただいまWeb予約を受け付けていません。お電話でお問い合わせください。{s.storePhone && ` （${s.storePhone}）`}</Shell>;
  }

  async function submit(request = isRequest): Promise<void> {
    setError("");
    setSending(true);
    try {
      await ensureAppCheck();
      const res = await callFunction<Record<string, unknown>, { code: string; status: "confirmed" | "request" }>("createWebReservation", {
        date,
        slotId,
        planId,
        counts: Object.fromEntries(categories.map((c) => [c.id, counts[c.id] ?? 0])),
        customerName: name,
        phone,
        email,
        memo,
        website,
        request,
      });
      setCode(res.code);
      setResultStatus(res.status);
      setStep("done");
      window.scrollTo(0, 0);
    } catch (e) {
      // 画面を見ている間に満員になった場合は、リクエストとして送るか確認する
      const details = e instanceof FirebaseError ? (e as FirebaseError & { details?: { canRequest?: boolean } }).details : undefined;
      if (!request && details?.canRequest) {
        setSending(false);
        if (window.confirm(`${cleanMessage((e as FirebaseError).message)}\n\n「予約リクエスト」として送りますか？\n（お店が確認のうえ、ご連絡します）`)) return submit(true);
        return;
      }
      setError(
        e instanceof FirebaseError && e.code.startsWith("functions/") && e.code !== "functions/internal"
          ? cleanMessage(e.message)
          : "予約を送れませんでした。電波の状態を確認して、もう一度お試しください。",
      );
    } finally {
      setSending(false);
    }
  }

  const summary = (
    <dl className="grid grid-cols-[6rem_1fr] gap-y-2 rounded-2xl bg-white p-4 shadow-sm">
      <dt className="text-gray-500">日時</dt>
      <dd className="font-bold">
        {date && formatJa(date, true)} {slot?.time}〜
      </dd>
      <dt className="text-gray-500">プラン</dt>
      <dd>
        {plan?.name}（{plan?.minutes}分）
      </dd>
      <dt className="text-gray-500">人数</dt>
      <dd>
        {categories
          .filter((c) => (counts[c.id] ?? 0) > 0)
          .map((c) => `${c.name} ${counts[c.id]}人`)
          .join("、")}
        （計{people}人）
      </dd>
      <dt className="text-gray-500">料金の目安</dt>
      <dd>{yen(amount)}（税込・当日お支払い）</dd>
      <dt className="text-gray-500">お名前</dt>
      <dd>{name} 様</dd>
      <dt className="text-gray-500">電話番号</dt>
      <dd>{phone}</dd>
      <dt className="text-gray-500">メール</dt>
      <dd className="break-all">{email}</dd>
      {memo && (
        <>
          <dt className="text-gray-500">ご要望</dt>
          <dd className="whitespace-pre-wrap">{memo}</dd>
        </>
      )}
    </dl>
  );

  if (step === "done") {
    return (
      <Shell title={s.storeName}>
        {resultStatus === "request" ? (
          <div className="rounded-2xl bg-purple-50 p-4 text-purple-900">
            <p className="text-lg font-bold">予約リクエストを受け付けました</p>
            <p className="mt-1 font-bold">まだご予約は確定していません。</p>
            <p className="mt-2">
              受付番号：<span className="font-mono text-xl font-bold tracking-widest">{code}</span>
            </p>
            <p className="mt-2 text-sm">お店で確認のうえ、お電話またはメールでご連絡します。しばらくお待ちください。</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-green-50 p-4 text-green-900">
            <p className="text-lg font-bold">ご予約が確定しました</p>
            <p className="mt-2">
              予約番号：<span className="font-mono text-xl font-bold tracking-widest">{code}</span>
            </p>
            <p className="mt-2 text-sm">当日、受付でお名前か予約番号をお伝えください。この画面を保存しておくと便利です（スクリーンショットなど）。</p>
          </div>
        )}
        <div className="mt-4">{summary}</div>
        <p className="mt-4 text-sm text-gray-600">
          変更・キャンセルは、お手数ですがお電話でご連絡ください。
          {s.storePhone && (
            <a href={`tel:${s.storePhone}`} className="ml-1 font-bold underline">
              {s.storePhone}
            </a>
          )}
        </p>
      </Shell>
    );
  }

  if (step === "confirm") {
    return (
      <Shell title={s.storeName}>
        <h2 className="text-lg font-bold">{isRequest ? "予約リクエストの確認" : "ご予約内容の確認"}</h2>
        {isRequest && <RequestNotice />}
        <div className="mt-3">{summary}</div>
        {error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={() => setStep("form")} disabled={sending} className="rounded-lg border px-4 py-3">
            戻る
          </button>
          <button
            onClick={() => submit()}
            disabled={sending}
            className={`flex-1 rounded-lg py-3 font-bold text-white disabled:opacity-50 ${isRequest ? "bg-purple-700" : "bg-berry"}`}
          >
            {sending ? "送信中…" : isRequest ? "この内容でリクエストする" : "この内容で予約する"}
          </button>
        </div>
      </Shell>
    );
  }

  function toConfirm(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!plan) return setError("プランを選んでください");
    if (people < 1) return setError("人数を選んでください");
    if (!date || !slotOk) return setError("日付と時間を選んでください");
    setStep("confirm");
    window.scrollTo(0, 0);
  }

  return (
    <Shell title={s.storeName}>
      <form onSubmit={toConfirm} className="space-y-6">
        {/* 1. プラン */}
        {plans.length > 1 && (
          <Section n={1} title="プラン">
            <div className="space-y-2">
              {plans.map((p) => (
                <label key={p.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border bg-white p-3 ${planId === p.id ? "border-berry ring-2 ring-berry/30" : ""}`}>
                  <input type="radio" name="plan" checked={planId === p.id} onChange={() => setPlanId(p.id)} />
                  <span>
                    <span className="font-bold">{p.name}</span>
                    <span className="ml-1 text-sm text-gray-500">{p.minutes}分</span>
                    <span className="block text-sm text-gray-600">
                      {s.priceCategories
                        .filter((c) => p.prices[c.id] !== undefined)
                        .map((c) => `${c.name} ${yen(p.prices[c.id])}`)
                        .join(" / ")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </Section>
        )}

        {/* 2. 人数 */}
        {plan && (
          <Section n={plans.length > 1 ? 2 : 1} title="人数">
            <div className="space-y-2 rounded-xl bg-white p-3">
              {categories.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <span className="flex-1">
                    {c.name}
                    <span className="ml-2 text-sm text-gray-500">{yen(plan.prices[c.id])}</span>
                  </span>
                  <Stepper value={counts[c.id] ?? 0} onChange={(v) => setCounts({ ...counts, [c.id]: v })} />
                </div>
              ))}
              <p className="border-t pt-2 text-right text-sm">
                合計 <b>{people}人</b>・{yen(amount)}（税込）
              </p>
            </div>
          </Section>
        )}

        {/* 3. 日付と時間 */}
        {plan && people > 0 && (
          <Section n={plans.length > 1 ? 3 : 2} title="日付と時間">
            {!booked || !daily || !stopped ? (
              <p className="text-gray-500">空き状況を読み込み中…</p>
            ) : (
              <Calendar
                first={first}
                last={last}
                selected={date}
                mark={(d) => {
                  if (!bookable(d)) return null;
                  const open = s.timeSlots.filter((t) => !isStopped(d, t.id));
                  // 全部の時間の受付を止めている日は、受付していない日として扱う
                  if (open.length === 0) return null;
                  const best = Math.max(...open.map((t) => remaining(d, t.id)));
                  return best < need ? "×" : best - need < 5 ? "△" : "○";
                }}
                onSelect={(d) => {
                  setDate(d);
                  setSlotId("");
                }}
              />
            )}
            <p className="mt-1 text-xs text-gray-500">○ 空きあり　△ 残りわずか　× 満員（リクエストのみ）　空欄は受付していない日</p>
            {date && (
              <div className="mt-3">
                <p className="font-bold">{formatJa(date)} の時間</p>
                {isRequest && <RequestNotice />}
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {s.timeSlots.map((t) => {
                    const rem = remaining(date, t.id);
                    const ok = rem >= need;
                    const selected = slotId === t.id;
                    if (isStopped(date, t.id)) {
                      return (
                        <button key={t.id} type="button" disabled className="rounded-xl border bg-gray-100 p-3 text-center text-gray-400">
                          <span className="block text-lg font-bold">{t.time}</span>
                          <span className="text-xs">受付終了</span>
                        </button>
                      );
                    }
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSlotId(t.id)}
                        className={`rounded-xl border p-3 text-center ${ok ? "bg-white" : "bg-purple-50 text-purple-900"} ${
                          selected ? (ok ? "border-berry ring-2 ring-berry/30" : "border-purple-600 ring-2 ring-purple-300") : ""
                        }`}
                      >
                        <span className="block text-lg font-bold">{t.time}</span>
                        <span className="text-xs">{ok ? `残り${rem}人` : `${rem <= 0 ? "満員" : `残り${Math.max(0, rem)}人`}・リクエスト可`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>
        )}

        {/* 4. お客様情報 */}
        {slotOk && (
          <Section n={plans.length > 1 ? 4 : 3} title="お客様の情報">
            <div className="space-y-3 rounded-xl bg-white p-3">
              <TextField label="お名前（代表者）" value={name} onChange={setName} required maxLength={50} autoComplete="name" />
              <TextField label="電話番号" type="tel" value={phone} onChange={setPhone} required maxLength={20} autoComplete="tel" />
              <TextField label="メールアドレス" type="email" value={email} onChange={setEmail} required maxLength={254} autoComplete="email" />
              <label className="block">
                <span className="text-sm text-gray-600">ご要望（任意・200文字まで）</span>
                <textarea value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} rows={2} className="mt-1 w-full rounded-lg border px-3 py-2 text-base" />
              </label>
              {/* 画面には表示しない（ロボット対策） */}
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
                aria-hidden="true"
              />
              <p className="text-xs text-gray-500">ご入力いただいた情報は、ご予約の確認・ご連絡のためだけに使います。</p>
            </div>
          </Section>
        )}

        {error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
        {slotOk && (
          <button type="submit" className={`w-full rounded-lg py-4 text-lg font-bold text-white ${isRequest ? "bg-purple-700" : "bg-berry"}`}>
            {isRequest ? "リクエストの確認へ進む" : "確認へ進む"}
          </button>
        )}
      </form>
    </Shell>
  );
}

function RequestNotice() {
  return (
    <p className="mt-2 rounded-lg bg-purple-50 p-3 text-sm text-purple-900">
      この時間は定員を超えるため、<b>「予約リクエスト」</b>になります。お店が確認のうえ、お電話かメールで可否をご連絡します。
      <b>ご連絡までは予約は確定していません。</b>
    </p>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 font-bold">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-berry text-sm text-white">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  maxLength?: number;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm text-gray-600">
        {props.label}
        {props.required && <span className="ml-1 text-red-600">*</span>}
      </span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        required={props.required}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border px-3 py-2 text-base"
      />
    </label>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} className="h-11 w-11 rounded-full border text-xl" aria-label="減らす">
        −
      </button>
      <span className="w-8 text-center text-lg font-bold">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(50, value + 1))} className="h-11 w-11 rounded-full border text-xl" aria-label="増やす">
        ＋
      </button>
    </span>
  );
}

/** 月ごとのカレンダー */
function Calendar({
  first,
  last,
  selected,
  mark,
  onSelect,
}: {
  first: string;
  last: string;
  selected: string;
  mark: (d: string) => "○" | "△" | "×" | null;
  onSelect: (d: string) => void;
}) {
  const months = useMemo(() => {
    const list: string[] = [];
    let m = first.slice(0, 7);
    while (m <= last.slice(0, 7)) {
      list.push(m);
      const [y, mo] = m.split("-").map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    }
    return list;
  }, [first, last]);
  const [index, setIndex] = useState(0);
  const month = months[Math.min(index, months.length - 1)];
  const [y, mo] = month.split("-").map(Number);
  const startDate = `${month}-01`;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const offset = "日月火水木金土".indexOf(weekday(startDate));

  return (
    <div className="rounded-xl bg-white p-3">
      <div className="flex items-center justify-between">
        <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)} className="rounded-lg border px-3 py-1 disabled:opacity-30">
          ‹
        </button>
        <span className="font-bold">
          {y}年{mo}月
        </span>
        <button
          type="button"
          disabled={index >= months.length - 1}
          onClick={() => setIndex(index + 1)}
          className="rounded-lg border px-3 py-1 disabled:opacity-30"
        >
          ›
        </button>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1 text-center text-xs text-gray-500">
        {"日月火水木金土".split("").map((w, i) => (
          <span key={w} className={i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : ""}>
            {w}
          </span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {Array.from({ length: offset }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = addDays(startDate, i);
          const m = mark(d);
          const can = m !== null;
          return (
            <button
              key={d}
              type="button"
              disabled={!can}
              onClick={() => onSelect(d)}
              className={`flex aspect-square flex-col items-center justify-center rounded-lg text-sm ${
                selected === d ? "bg-berry text-white" : can ? "bg-berry/5 hover:bg-berry/10" : "text-gray-300"
              }`}
            >
              <span>{i + 1}</span>
              <span className={`text-xs ${selected === d ? "" : m === "×" ? "text-gray-400" : m === "△" ? "text-amber-600" : "text-leaf"}`}>{m ?? ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
