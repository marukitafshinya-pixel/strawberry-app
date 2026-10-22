"use client";

// 収穫報告の音声案内：効果音・読み上げ（携帯に入っている日本語の声を、高めで若く楽しく。速さは少しゆっくり）・振動（Android）、画面を消さない。
// 携帯のブラウザは、画面を一度押したあとでないと音や声を出せないので、最初に押したときに unlockSound() を呼ぶ
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 効果音の種類：in＝入った（ピロリン↑）、out＝終わった（ピンポンピンポン）、done＝全部終わった（ファンファーレ）、change＝応援先の知らせ（ピンポン）、break＝休憩の合図 */
export type SoundKind = "in" | "out" | "done" | "change" | "break";

/** 音（高さ Hz・始まり秒・長さ秒）を並べた効果音を作る。外から音のファイルを読まないので、電波が弱くても鳴る */
function toneUrl(notes: [number, number, number][], gain = 0.6): string {
  const rate = 22050;
  const secs = Math.max(...notes.map(([, t, d]) => t + d)) + 0.05;
  const n = Math.floor(rate * secs);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, x: string) => [...x].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let x = 0;
    for (const [f, st, d] of notes) {
      const tt = t - st;
      if (tt < 0 || tt > d) continue;
      // 木琴のような明るい音（倍音を少し足して、だんだん小さく）
      const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 5) * Math.min(1, (d - tt) / 0.02);
      x += (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)) * env;
    }
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x * gain)) * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

// ド=523 ミ=659 ソ=784 ド'=1047 ミ'=1319 ソ'=1568
const SOUNDS: Record<SoundKind, () => string> = {
  in: () =>
    toneUrl([
      [784, 0, 0.18],
      [1047, 0.1, 0.18],
      [1568, 0.2, 0.4],
    ]),
  out: () =>
    toneUrl([
      [1319, 0, 0.25],
      [1047, 0.22, 0.3],
      [1319, 0.5, 0.25],
      [1047, 0.72, 0.4],
    ]),
  done: () =>
    toneUrl(
      [
        [784, 0, 0.14],
        [784, 0.14, 0.14],
        [784, 0.28, 0.14],
        [1047, 0.45, 0.7],
        [1319, 0.45, 0.7],
        [1568, 0.45, 0.7],
      ],
      0.35,
    ),
  change: () =>
    toneUrl([
      [1319, 0, 0.45],
      [1047, 0.45, 0.5],
    ]),
  // 休憩：ド・ミ・ソ・ミ・ド とやさしく
  break: () =>
    toneUrl(
      [
        [1047, 0, 0.3],
        [1319, 0.25, 0.3],
        [1568, 0.5, 0.3],
        [1319, 0.75, 0.3],
        [1047, 1.0, 0.6],
      ],
      0.5,
    ),
};
const audios: Partial<Record<SoundKind, HTMLAudioElement>> = {};
const getSound = (k: SoundKind) => (audios[k] ??= new Audio(SOUNDS[k]()));
let unlocked = false;

/** 画面を押したときに呼ぶ：音と声を出せるようにしておく（携帯のブラウザの決まり） */
export function unlockSound() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;
  for (const k of Object.keys(SOUNDS) as SoundKind[]) {
    const a = getSound(k);
    a.muted = true;
    void a
      .play()
      .then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      })
      .catch(() => {
        a.muted = false;
        unlocked = false;
      });
  }
  try {
    // 空の文字だと「出せるようにする」にならない携帯があるので、音量0で短いことばを読む
    const u = new SpeechSynthesisUtterance("はい");
    u.lang = "ja-JP";
    u.volume = 0;
    window.speechSynthesis?.speak(u);
    // すぐ止めておく（このあとの本当の案内を、待たずにすぐ読めるように）
    setTimeout(() => window.speechSynthesis?.cancel(), 0);
  } catch {
    // 読み上げのない携帯は、音だけ
  }
}

// ---------- 声（若く楽しい声：高め・せかさない速さ。携帯ごとに声を選べる） ----------
const VOICE_KEY = "harvestVoice";
/** 声の高さ（1＝ふつう）と速さ */
export const VOICE_PITCH = 1.25;
export const VOICE_RATE = 0.95;

/** この携帯で使える日本語の声 */
export function japaneseVoices(): SpeechSynthesisVoice[] {
  try {
    return (window.speechSynthesis?.getVoices() ?? []).filter((x) => x.lang.replace("_", "-").toLowerCase().startsWith("ja"));
  } catch {
    return [];
  }
}
/** この携帯で選んだ声の名前（選んでいなければ null） */
export function savedVoice(): string | null {
  try {
    return localStorage.getItem(VOICE_KEY);
  } catch {
    return null;
  }
}
export function saveVoice(name: string | null) {
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch {
    // 覚えられなくても、その場は使える
  }
}
/**
 * 使う声：声の設定で選んだ声だけ。選んでいなければ（おまかせ）声は選ばず、携帯のふだんの日本語の声を使う
 * （名前で探して選ぶと、携帯にダウンロードされていない声を選んで無音になることがあるため）
 */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const name = savedVoice();
  return name ? japaneseVoices().find((x) => x.name === name) : undefined;
}

/** 読み上げる（前の読み上げは止める）。選んだ声が鳴らなければ（1.5秒たってもしゃべり始めなければ）、ふだんの声で言い直す */
export function speak(text: string, useChosen = true, onEnd?: () => void) {
  try {
    const s = window.speechSynthesis;
    if (!s) return onEnd?.();
    // しゃべっている途中なら止める（止めたすぐあとに読むと、しゃべらない携帯があるので少し待つ）
    const busy = s.speaking || s.pending;
    if (busy) s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.pitch = VOICE_PITCH;
    u.rate = VOICE_RATE;
    u.volume = 1;
    const voice = useChosen ? pickVoice() : undefined;
    try {
      if (voice) u.voice = voice;
    } catch {
      // 声を選べなくても、ふだんの声で読み上げる
    }
    let started = false;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      onEnd?.();
    };
    u.onstart = () => (started = true);
    u.onend = end;
    u.onerror = end;
    if (busy) setTimeout(() => s.speak(u), 60);
    else s.speak(u);
    setTimeout(() => {
      if (started || s.speaking) return;
      // 選んだ声が鳴らなければ、ふだんの声で言い直す。それでもだめなら、あとの効果音だけは鳴らす
      if (voice) speak(text, false, end);
      else end();
    }, 1500);
  } catch {
    // 読み上げのない携帯は、なにもしない
    onEnd?.();
  }
}

// ---------- 音と声の順番（携帯ごと） ----------
/** soundFirst＝音→声、voiceFirst＝声→音、voiceOnly＝声だけ */
export type VoiceOrder = "soundFirst" | "voiceFirst" | "voiceOnly";
const ORDER_KEY = "harvestVoiceOrder";
/** iPhone・iPad か（iPhone は効果音のすぐあとだと声が出ないことがあるので、ふだんは声→音） */
const isIOS = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1));
export function voiceOrder(): VoiceOrder {
  try {
    const v = localStorage.getItem(ORDER_KEY);
    if (v === "soundFirst" || v === "voiceFirst" || v === "voiceOnly") return v;
  } catch {
    // 覚えていなければ、ふだんの順番
  }
  return isIOS() ? "voiceFirst" : "soundFirst";
}
export function saveVoiceOrder(v: VoiceOrder) {
  try {
    localStorage.setItem(ORDER_KEY, v);
  } catch {
    // 覚えられなくても、その場は使える
  }
}
const playSound = (k: SoundKind, then?: () => void) => {
  const a = getSound(k);
  a.currentTime = 0;
  let done = false;
  const next = () => {
    if (done) return;
    done = true;
    then?.();
  };
  a.onended = next;
  setTimeout(next, 2000); // 音が鳴らなかったときも先へ
  void a.play().catch(next);
};

/** 効果音と読み上げ（順番は携帯ごとの設定：音→声・声→音・声だけ）。vibrate＝振動もする（Android。iPhone は振動できない） */
export function announce(text: string, opts: { sound?: SoundKind; vibrate?: boolean } = {}) {
  if (opts.vibrate) navigator.vibrate?.([300, 150, 300, 150, 300]);
  const order = voiceOrder();
  const sound = opts.sound;
  if (!sound || order === "voiceOnly") return speak(text);
  if (order === "voiceFirst") return speak(text, true, () => playSound(sound));
  playSound(sound, () => speak(text));
}

/** 案内のことば（楽しく元気に） */
export const SAY = {
  in: (h: string) => `${h}番ハウス、いってらっしゃい！収穫がんばってください！`,
  out: (h: string, next: string) => `${h}番、おつかれさまでした！次は${next}番ハウス、よろしくお願いします！`,
  outOnly: (h: string) => `${h}番、おつかれさまでした！`,
  stop: (h: string) => `${h}番、おつかれさまでした！今日の収穫はここまでです。`,
  done: "今日の収穫はすべて終わりました！みなさん、おつかれさまでした！",
  change: (h: string) => `応援先が変更になりました！${h}番へ向かってください！`,
  help: (h: string) => `応援をお願いします！${h}番へ向かってください！`,
  break: "おつかれさまです！ただいまから休憩の時間です。",
};

/** active の間、画面が消えないようにする（ほかのアプリから戻ったときも、もう一度たのむ） */
export function useWakeLock(active: boolean) {
  const lock = useRef<{ release: () => Promise<void> } | null>(null);
  useEffect(() => {
    if (!active) return;
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wl) return;
    const ask = () => {
      if (document.visibilityState === "visible" && !lock.current)
        wl.request("screen").then(
          (l) => {
            lock.current = l;
            // 携帯が自分で外したとき（ほかのアプリへ移ったなど）は、次に戻ったときにまたたのむ
            (l as unknown as EventTarget).addEventListener?.("release", () => (lock.current = null));
          },
          () => {},
        );
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    // 携帯によっては、画面を押したあとでないとたのめないので、押したときにもたのむ
    document.addEventListener("pointerdown", ask);
    return () => {
      document.removeEventListener("visibilitychange", ask);
      document.removeEventListener("pointerdown", ask);
      void lock.current?.release().catch(() => {});
      lock.current = null;
    };
  }, [active]);
}

/** 音声案内のテスト：実際の案内を順番に流す（記録はなにも変えない）。onNotice＝応援先が変わったときの画面の知らせを出す */
export function voiceTest(onNotice: (text: string | null) => void): () => void {
  unlockSound();
  const steps: [number, () => void][] = [
    [0, () => announce(SAY.in("24"), { sound: "in" })],
    [5000, () => announce(SAY.out("24", "25"), { sound: "out" })],
    [
      11500,
      () => {
        announce(SAY.change("8"), { sound: "change", vibrate: true });
        onNotice(SAY.change("8"));
      },
    ],
    [18000, () => announce(SAY.done, { sound: "done" })],
  ];
  const timers = steps.map(([ms, f]) => setTimeout(f, ms));
  return () => timers.forEach(clearTimeout);
}

/**
 * しばらく触らないと画面を黒くする（電池の節約。有機ELの画面は黒いところがほとんど光らない）。
 * ms 触らないと dim＝true。画面を触ると wake() で戻す（黒い画面への最初のひと押しは、下のボタンを押さない）
 */
export function useIdleDim(active: boolean, ms: number): { dim: boolean; wake: () => void } {
  const [dim, setDim] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    last.current = Date.now();
    const touch = () => (last.current = Date.now());
    document.addEventListener("pointerdown", touch);
    const t = setInterval(() => {
      if (Date.now() - last.current >= ms) setDim(true);
    }, 1000);
    return () => {
      document.removeEventListener("pointerdown", touch);
      clearInterval(t);
      setTimeout(() => setDim(false), 0);
    };
  }, [active, ms]);
  const wake = () => {
    last.current = Date.now();
    setDim(false);
  };
  return { dim: active && dim, wake };
}

/** 黒い画面（触ると戻る）。text＝暗い灰色で小さく出す（いまのハウスなど） */
export function DimScreen({ text, onWake }: { text: string; onWake: () => void }) {
  // 画面全体をおおうため、ページの外（body の直下）に出す
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onWake();
      }}
    >
      <p className="text-center text-xl text-gray-700">
        {text}
        <span className="mt-3 block text-sm">画面を触るともどります</span>
      </p>
    </div>,
    document.body,
  );
}

/** 声の設定：この携帯で使える日本語の声から選ぶ（選んだ声はこの携帯に覚える）。「この声で試す」で聞ける */
export function VoiceSettings() {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string>(() => (typeof window === "undefined" ? "" : (savedVoice() ?? "")));
  const [order, setOrder] = useState<VoiceOrder>(() => (typeof window === "undefined" ? "soundFirst" : voiceOrder()));
  useEffect(() => {
    if (!open) return;
    // 携帯によっては、声の一覧があとから届く
    const load = () => setVoices(japaneseVoices().map((x) => x.name));
    const t = setTimeout(load, 0);
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => {
      clearTimeout(t);
      window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
    };
  }, [open]);
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="rounded-xl border bg-white px-4 py-2 text-sm text-gray-700">
        🎙 声の設定
      </button>
    );
  return (
    <div className="w-full rounded-xl border bg-white p-3 text-sm">
      <p className="font-bold">🎙 声の設定（この携帯だけ）</p>
      {voices.length === 0 ? (
        <p className="mt-1 text-gray-500">この携帯で選べる日本語の声が見つかりません（いつもの声で読み上げます）。</p>
      ) : (
        <select
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            saveVoice(e.target.value || null);
          }}
          className="mt-1 w-full rounded-lg border px-2 py-2 text-base"
          aria-label="声"
        >
          <option value="">おまかせ（携帯のふだんの声を明るく）</option>
          {voices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      <p className="mt-1 text-xs text-gray-500">声によっては、携帯にダウンロードされていないと鳴りません。鳴らないときは「おまかせ」にしてください。</p>
      <label className="mt-3 block font-bold">音と声の順番</label>
      <select
        value={order}
        onChange={(e) => {
          setOrder(e.target.value as VoiceOrder);
          saveVoiceOrder(e.target.value as VoiceOrder);
        }}
        className="mt-1 w-full rounded-lg border px-2 py-2 text-base"
        aria-label="音と声の順番"
      >
        <option value="voiceFirst">声 → 効果音（iPhone のおすすめ）</option>
        <option value="soundFirst">効果音 → 声</option>
        <option value="voiceOnly">声だけ（効果音なし）</option>
      </select>
      <p className="mt-1 text-xs text-gray-500">声が出ないときは、順番を変えて「この声で試す」を押してみてください。</p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => {
            unlockSound();
            announce(SAY.in("24"), { sound: "in" });
          }}
          className="rounded-lg bg-sky-600 px-4 py-2 font-bold text-white"
        >
          ▶ この声で試す
        </button>
        <button onClick={() => setOpen(false)} className="rounded-lg border px-4 py-2">
          閉じる
        </button>
      </div>
    </div>
  );
}
