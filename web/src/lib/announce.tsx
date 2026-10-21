"use client";

// 収穫報告の音声案内：知らせの音（ピンポン）・読み上げ（携帯に入っている日本語の声）・振動（Android）、画面を消さない。
// 携帯のブラウザは、画面を一度押したあとでないと音や声を出せないので、最初に押したときに unlockSound() を呼ぶ
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** 知らせの音（ピン・ポンの2つの高さ）を作る。外から音のファイルを読まないので、電波が弱くても鳴る */
function chimeUrl(): string {
  const rate = 22050;
  const secs = 0.9;
  const n = Math.floor(rate * secs);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
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
    const first = t < secs / 2;
    const f = first ? 1318 : 1047;
    const tt = first ? t : t - secs / 2;
    // だんだん小さくなる音（鐘のような音）
    const env = Math.exp(-tt * 6) * Math.min(1, tt / 0.005);
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * tt) * env * 0.8 * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

let chime: HTMLAudioElement | null = null;
const getChime = () => (chime ??= new Audio(chimeUrl()));
let unlocked = false;

/** 画面を押したときに呼ぶ：音と声を出せるようにしておく（携帯のブラウザの決まり） */
export function unlockSound() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;
  const a = getChime();
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
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis?.speak(u);
  } catch {
    // 読み上げのない携帯は、音だけ
  }
}

/** 読み上げる（前の読み上げは止める） */
export function speak(text: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 1;
    u.volume = 1;
    const ja = s.getVoices().find((x) => x.lang.startsWith("ja"));
    if (ja) u.voice = ja;
    s.speak(u);
  } catch {
    // 読み上げのない携帯は、なにもしない
  }
}

/** 知らせの音を鳴らして、鳴り終わったら読み上げる。vibrate＝振動もする（Android。iPhone は振動できない） */
export function announce(text: string, opts: { chime?: boolean; vibrate?: boolean } = {}) {
  if (opts.vibrate) navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (!opts.chime) return speak(text);
  const a = getChime();
  a.currentTime = 0;
  let done = false;
  const next = () => {
    if (done) return;
    done = true;
    speak(text);
  };
  a.onended = next;
  setTimeout(next, 1200); // 音が鳴らなかったときも読み上げる
  void a.play().catch(next);
}

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
  const change = "応援先が変更になりました。8番へ向かってください。";
  const steps: [number, () => void][] = [
    [0, () => announce("24番ハウス、収穫がんばってください！")],
    [4500, () => announce("24番、おつかれさまです。次は25番ハウス、お願いします！")],
    [
      10500,
      () => {
        announce(change, { chime: true, vibrate: true });
        onNotice(change);
      },
    ],
    [17000, () => announce("収穫作業はすべて終わりました。おつかれさまでした。")],
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
