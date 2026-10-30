"use client";

// 打刻タブレット：入口に置いたAndroidタブレット（Chrome）に、従業員が自分のNFCタグをかざして出勤・退勤する。
// その日の最初にかざすと出勤、そのあとは退勤（最後にかざした時刻）。「休憩時間を修正」を押してからかざすと、その人のその日の休憩を変える。
// 通信が切れているときは、かざした時刻をタブレットに預かって、つながったら送る。
// タグは、本体のNFC（AndroidのChrome）と、USBのNFCリーダー（キーボード入力のもの。番号を打ち込んでEnter）のどちらでも読む
import { FirebaseError } from "firebase/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { hm } from "@/lib/timecard";
import { BREAK_CHOICES, fixBreak, punch } from "@/lib/timeclock";

// Web NFC（AndroidのChromeだけ）の型
type NdefReadingEvent = Event & { serialNumber: string };
type NdefReader = EventTarget & {
  scan(o?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((e: NdefReadingEvent) => void) | null;
  onreadingerror: ((e: Event) => void) | null;
};
declare global {
  interface Window {
    NDEFReader?: new () => NdefReader;
  }
}

type Tone = "in" | "out" | "info" | "error";
type Result = { tone: Tone; title: string; sub?: string };
/** ふつう＝打刻、pick＝休憩の長さを選んでいる、break＝選んだ長さで、タグを待っている */
type Mode = { kind: "punch" } | { kind: "pick" } | { kind: "break"; minutes: number | null; until: number };
/** 預かった打刻（tries＝送ろうとした回数） */
type Queued = { serial: string; at: number; tries?: number };

const QUEUE_KEY = "timeclockQueue";
/** 同じタグを続けて読んだ分は、この間（ミリ秒）は数えない（かざしている間、何度も読むため） */
const SAME_TAG_MS = 5000;

const loadQueue = (): Queued[] => {
  try {
    const v = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const saveQueue = (q: Queued[]) => {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // 保存できなくても、画面の中では預かったまま
  }
};
/** 通信が切れていて送れなかったか */
const offline = (e: unknown) =>
  !navigator.onLine || (e instanceof FirebaseError && ["functions/unavailable", "functions/deadline-exceeded", "functions/internal"].includes(e.code));
const nowMin = () => {
  const d = new Date(Date.now() + 9 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

export default function TimeclockPage() {
  const { role } = useAuth();
  if (role !== "timeclock" && role !== "admin") return <p className="p-6">この画面は、打刻タブレットのログインで使います。</p>;
  return <Kiosk admin={role === "admin"} />;
}

function Kiosk({ admin }: { admin: boolean }) {
  const { logout } = useAuth();
  const [nfc, setNfc] = useState<"unsupported" | "need-tap" | "on" | "error">(() =>
    typeof window !== "undefined" && !window.NDEFReader ? "unsupported" : "need-tap",
  );
  const [mode, setMode] = useState<Mode>({ kind: "punch" });
  const [result, setResult] = useState<Result | null>(null);
  const [recent, setRecent] = useState<{ key: number; text: string }[]>([]);
  const [queued, setQueued] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const modeRef = useRef(mode);
  const last = useRef<{ serial: string; at: number } | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // 時計（1秒ごと）。休憩の修正でタグを待つのは30秒まで
  useEffect(() => {
    const t = setInterval(() => {
      setClock(Date.now());
      const m = modeRef.current;
      if (m.kind === "break" && Date.now() > m.until) setMode({ kind: "punch" });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // 画面を消さない（タブレットを置きっぱなしにするため）
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
    const get = () => {
      if (document.visibilityState === "visible" && nav.wakeLock)
        nav.wakeLock
          .request("screen")
          .then((l) => (lock = l))
          .catch(() => {});
    };
    get();
    document.addEventListener("visibilitychange", get);
    return () => {
      document.removeEventListener("visibilitychange", get);
      void lock?.release().catch(() => {});
    };
  }, []);

  /** 音（出勤：高い2音、退勤：低い2音、そのほか：1音） */
  const beep = useCallback((tone: Tone) => {
    try {
      const ctx = (audio.current ??= new AudioContext());
      void ctx.resume();
      const notes = tone === "in" ? [880, 1320] : tone === "out" ? [660, 440] : tone === "error" ? [220] : [880];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.value = 0.25;
        o.connect(g).connect(ctx.destination);
        const t = ctx.currentTime + i * 0.16;
        o.start(t);
        o.stop(t + 0.14);
      });
    } catch {
      // 音が出せなくても打刻はできる
    }
  }, []);

  const show = useCallback(
    (r: Result) => {
      setResult(r);
      beep(r.tone);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setResult(null), 5000);
      if (r.tone === "in" || r.tone === "out") setRecent((list) => [{ key: Date.now(), text: `${r.title}　${r.sub ?? ""}` }, ...list].slice(0, 6));
    },
    [beep],
  );

  /** 預かった打刻を送る（古い順）。通信が切れていたら、次の機会に */
  const flush = useCallback(async () => {
    let q = loadQueue();
    while (q.length) {
      try {
        await punch(q[0].serial, q[0].at);
      } catch (e) {
        // 通信が切れていれば、次の機会に（サーバーの不具合などで送れないまま、20回（10分）をこえたら捨てる）
        if (offline(e) && (q[0].tries ?? 0) < 20) {
          q = [{ ...q[0], tries: (q[0].tries ?? 0) + 1 }, ...q.slice(1)];
          saveQueue(q);
          break;
        }
        // 古すぎるなど、送れないものは捨てる（管理者がタイムカードの画面で直す）
      }
      q = q.slice(1);
      saveQueue(q);
    }
    setQueued(q.length);
  }, []);
  useEffect(() => {
    // はじめに、前に預かった分を送る（送ったあとで数を出す）
    const first = setTimeout(() => void flush(), 0);
    const t = setInterval(() => void flush(), 30_000);
    const on = () => void flush();
    window.addEventListener("online", on);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      window.removeEventListener("online", on);
    };
  }, [flush]);

  /** タグを読んだ */
  const onTag = useCallback(
    async (serial: string) => {
      const now = Date.now();
      if (last.current && last.current.serial === serial && now - last.current.at < SAME_TAG_MS) return;
      last.current = { serial, at: now };
      const m = modeRef.current;
      if (m.kind === "pick") return;
      if (m.kind === "break") {
        setMode({ kind: "punch" });
        try {
          const r = await fixBreak(serial, m.minutes);
          if (r.unknown) return show({ tone: "error", title: "登録されていないタグです", sub: "管理者に登録してもらってください" });
          show({
            tone: "info",
            title: `${r.name}さん`,
            sub: m.minutes === null ? "今日の休憩を、いつもどおりに戻しました" : `今日の休憩を ${m.minutes}分 にしました`,
          });
        } catch (e) {
          show({ tone: "error", title: "休憩を直せませんでした", sub: offline(e) ? "通信できません。少しあとで、もう一度してください" : errorText(e) });
        }
        return;
      }
      try {
        const r = await punch(serial);
        if (r.unknown) return show({ tone: "error", title: "登録されていないタグです", sub: "管理者に登録してもらってください" });
        if (r.kind === "dup") return show({ tone: "info", title: `${r.name}さん`, sub: "もう打刻しました" });
        show({
          tone: r.kind === "in" ? "in" : "out",
          title: `${r.name}さん`,
          sub: r.kind === "in" ? `出勤 ${hm(r.min)}　おはようございます` : `退勤 ${hm(r.min)}　おつかれさまでした`,
        });
      } catch (e) {
        if (!offline(e)) return show({ tone: "error", title: "打刻できませんでした", sub: errorText(e) });
        const q = [...loadQueue(), { serial, at: now }];
        saveQueue(q);
        setQueued(q.length);
        show({ tone: "info", title: "打刻を預かりました", sub: `${hm(nowMin())}　通信がつながったら送ります` });
      }
    },
    [show],
  );

  /** NFCを読み始める（はじめての時は、画面を押してから） */
  const startNfc = useCallback(async () => {
    if (!window.NDEFReader) return setNfc("unsupported");
    try {
      const reader = new window.NDEFReader();
      await reader.scan();
      reader.onreading = (e) => void onTag(e.serialNumber.toLowerCase());
      reader.onreadingerror = () => show({ tone: "error", title: "読めませんでした", sub: "もう一度、ゆっくりかざしてください" });
      setNfc("on");
    } catch (e) {
      setNfc((e as Error)?.name === "NotAllowedError" ? "need-tap" : "error");
    }
  }, [onTag, show]);
  useEffect(() => {
    // 前にNFCを許可していれば、押さなくても読み始める
    const t = setTimeout(() => void startNfc(), 0);
    return () => clearTimeout(t);
  }, [startNfc]);

  // USBのNFCリーダー：タグの番号を、キーボードのようにすばやく打ち込んで Enter を送ってくる。
  // 人の手で打つのとまちがえないよう、文字の間があいたら（0.3秒）はじめからにする
  useEffect(() => {
    let buf = "";
    let lastAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - lastAt > 300) buf = "";
      lastAt = now;
      if (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") {
        const sn = buf.toLowerCase();
        buf = "";
        if (/^[0-9a-f:]{4,64}$/.test(sn)) {
          e.preventDefault();
          void onTag(sn);
        }
        return;
      }
      // パソコンの入力が日本語（「あ」）のままだと、文字が「Process」になるので、押したキーの場所（code）から読む
      const ch =
        /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? /^Key([A-Z])$/.exec(e.code)?.[1] ?? (e.key.length === 1 && /[0-9a-zA-Z:]/.test(e.key) ? e.key : null);
      if (ch) {
        buf += ch;
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTag]);

  const d = new Date(clock + 9 * 3600e3);
  const time = `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const date = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${"日月火水木金土"[d.getUTCDay()]}）`;
  const toneCls: Record<Tone, string> = {
    in: "bg-emerald-600 text-white",
    out: "bg-sky-700 text-white",
    info: "bg-gray-700 text-white",
    error: "bg-red-700 text-white",
  };

  return (
    <div className="flex min-h-screen select-none flex-col bg-rose-50 p-4" onPointerDown={() => void audio.current?.resume()}>
      <div className="text-center">
        <p className="text-2xl text-gray-700">{date}</p>
        <p className="text-8xl font-bold tabular-nums text-gray-900">{time}</p>
      </div>

      <div className="mt-6 flex flex-1 flex-col items-center justify-center rounded-3xl bg-white p-6 text-center shadow">
        {mode.kind === "pick" ? (
          <div>
            <p className="text-3xl font-bold">今日の休憩を何分にしますか？</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {BREAK_CHOICES.map((m) => (
                <button
                  key={m}
                  onClick={() => setMode({ kind: "break", minutes: m, until: Date.now() + 30_000 })}
                  className="rounded-2xl border-2 border-amber-500 bg-amber-50 px-8 py-6 text-3xl font-bold"
                >
                  {m}分
                </button>
              ))}
              <button
                onClick={() => setMode({ kind: "break", minutes: null, until: Date.now() + 30_000 })}
                className="rounded-2xl border-2 bg-white px-6 py-6 text-2xl"
              >
                いつもどおり（自動）
              </button>
            </div>
            <button onClick={() => setMode({ kind: "punch" })} className="mt-6 text-xl text-gray-600 underline">
              やめる
            </button>
          </div>
        ) : mode.kind === "break" ? (
          <div>
            <p className="text-4xl font-bold text-amber-800">{mode.minutes === null ? "休憩をいつもどおりに戻します" : `休憩を ${mode.minutes}分 にします`}</p>
            <p className="mt-4 text-3xl">📶 タグをかざしてください</p>
            <p className="mt-2 text-gray-500">あと {Math.max(0, Math.ceil((mode.until - clock) / 1000))}秒</p>
            <button onClick={() => setMode({ kind: "punch" })} className="mt-6 text-xl text-gray-600 underline">
              やめる
            </button>
          </div>
        ) : (
          <div>
            <p className="text-5xl font-bold text-gray-800">📶 タグをかざしてください</p>
            <p className="mt-4 text-2xl text-gray-600">はじめにかざすと出勤、帰るときにかざすと退勤です</p>
          </div>
        )}
      </div>

      {mode.kind === "punch" && (
        <button
          onClick={() => setMode({ kind: "pick" })}
          className="mt-4 rounded-2xl border-2 border-amber-500 bg-amber-50 py-5 text-2xl font-bold text-amber-900"
        >
          ☕ 休憩時間を修正
        </button>
      )}

      {recent.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-2xl bg-white/70 p-3 text-lg text-gray-700">
          {recent.map((r) => (
            <li key={r.key}>{r.text}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-3 text-sm text-gray-500">
        {queued > 0 && <span className="font-bold text-amber-800">通信を待っている打刻：{queued}件</span>}
        {/* 本体のNFC：使えるときだけ。USBのリーダーは、つなぐだけで使える */}
        {nfc === "on" ? (
          <span>本体のNFC：使えます</span>
        ) : nfc !== "unsupported" ? (
          <button onClick={() => void startNfc()} className="underline">
            本体のNFCも使う
          </button>
        ) : null}
        {admin && <span className="text-red-700">管理者のログインで開いています（かざすと本当に打刻されます）</span>}
        <button onClick={() => confirm("打刻タブレットからログアウトしますか？") && void logout()} className="ml-auto underline">
          ログアウト
        </button>
      </div>

      {result && (
        <div className={`fixed inset-0 z-20 flex flex-col items-center justify-center p-6 text-center ${toneCls[result.tone]}`} onClick={() => setResult(null)}>
          <p className="text-6xl font-bold">{result.title}</p>
          {result.sub && <p className="mt-6 text-4xl">{result.sub}</p>}
        </div>
      )}
    </div>
  );
}
