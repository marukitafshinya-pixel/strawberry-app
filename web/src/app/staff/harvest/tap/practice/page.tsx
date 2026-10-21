"use client";

// 収穫報告の練習モード：架空のハウスで「入った」「終わった」と音声案内を試す。本当の記録には何も書かない（この画面の中だけ）。
// 流れ：予定のハウス（1番→2番）→ 応援（3番。向かっている途中に「応援先を変える」で4番に変わる）→ 全部終わる
import Link from "next/link";
import { useEffect, useState } from "react";
import { announce, unlockSound, useWakeLock } from "@/lib/announce";

const PLANNED = ["1", "2"];
const HELP_FIRST = "3";
const HELP_CHANGED = "4";

type Step = { house: string; kind: "plan" | "help"; inNow: boolean } | { done: true };

export default function PracticePage() {
  const [step, setStep] = useState<Step>({ house: PLANNED[0], kind: "plan", inNow: false });
  const [notice, setNotice] = useState<string | null>(null);
  const done = "done" in step;
  // 練習中も、本番と同じく画面を消さない
  useWakeLock(!done);
  useEffect(() => {
    document.addEventListener("pointerdown", unlockSound, { once: true });
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, []);

  function tapIn() {
    if (done || step.inNow) return;
    setStep({ ...step, inNow: true });
    announce(`${step.house}番ハウス、収穫がんばってください！`);
  }
  function tapOut() {
    if (done) return;
    const h = step.house;
    if (step.kind === "plan" && PLANNED.indexOf(h) < PLANNED.length - 1) {
      const next = PLANNED[PLANNED.indexOf(h) + 1];
      setStep({ house: next, kind: "plan", inNow: false });
      announce(`${h}番、おつかれさまです。次は${next}番ハウス、お願いします！`);
    } else if (step.kind === "plan") {
      setStep({ house: HELP_FIRST, kind: "help", inNow: false });
      announce(`${h}番、おつかれさまです。次は${HELP_FIRST}番ハウス、お願いします！`);
    } else {
      setStep({ done: true });
      announce("収穫作業はすべて終わりました。おつかれさまでした。");
    }
  }
  /** 向かっている途中に応援先が変わったことにする */
  function changeHelp() {
    if (done || step.kind !== "help" || step.inNow) return;
    const to = step.house === HELP_FIRST ? HELP_CHANGED : HELP_FIRST;
    const text = `応援先が変更になりました。${to}番へ向かってください。`;
    setStep({ house: to, kind: "help", inNow: false });
    announce(text, { chime: true, vibrate: true });
    setNotice(text);
  }

  const big = "w-full rounded-3xl py-8 text-4xl font-bold shadow disabled:opacity-40";
  return (
    <div className="mx-auto max-w-md space-y-5 pb-10">
      {notice && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-amber-400 p-6 text-center">
          <p className="text-3xl leading-snug font-bold text-gray-900">{notice}</p>
          <button onClick={() => setNotice(null)} className="rounded-2xl bg-white px-10 py-5 text-3xl font-bold shadow">
            わかった
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Link href="/staff/harvest/tap/" className="text-sm text-gray-600 underline">
          ← 収穫報告にもどる
        </Link>
      </div>
      <p className="rounded-xl bg-sky-700 px-3 py-2 text-center font-bold text-white">🎓 練習モード（本当の記録には入りません）</p>
      <h1 className="text-xl font-bold">🍓 収穫報告</h1>

      {done ? (
        <>
          <p className="rounded-2xl bg-green-50 p-6 text-center text-2xl font-bold text-green-800">今日の収穫はおわりです。おつかれさまでした</p>
          <button
            onClick={() => setStep({ house: PLANNED[0], kind: "plan", inNow: false })}
            className="w-full rounded-2xl border bg-white py-3 text-lg font-bold"
          >
            もう一度はじめから練習する
          </button>
        </>
      ) : (
        <>
          <div className={`rounded-3xl p-6 text-center shadow-sm ${step.kind === "help" && !step.inNow ? "bg-amber-50" : "bg-white"}`}>
            <p className="text-lg text-gray-600">
              {step.inNow
                ? "いま収穫しているハウス"
                : step.kind === "help"
                  ? "応援をお願いします。次は"
                  : step.house === PLANNED[0]
                    ? "今日はここから収穫をお願いします"
                    : "次は"}
            </p>
            <p className="my-1 text-7xl font-bold text-berry tabular-nums">{step.house}番</p>
            {!step.inNow && step.house !== PLANNED[0] && <p className="text-lg text-gray-600">の収穫をお願いします</p>}
          </div>
          <button disabled={step.inNow} onClick={tapIn} className={`${big} bg-sky-600 text-white`}>
            入った
          </button>
          <button disabled={!step.inNow} onClick={tapOut} className={`${big} bg-berry text-white`}>
            終わった
          </button>
          {step.kind === "help" && !step.inNow && (
            <button onClick={changeHelp} className="w-full rounded-2xl border-2 border-dashed border-amber-500 bg-white py-3 font-bold text-amber-800">
              （練習）向かっている途中で応援先が変わったことにする
            </button>
          )}
        </>
      )}
      <p className="text-sm text-gray-500">
        練習の流れ：1番 → 2番（予定のハウス）→
        3番（応援）。応援に向かっている途中で「応援先が変わったことにする」を押すと、音と声と黄色い画面で知らせます。音量は携帯の音量（音楽・動画の音量）で変わります。
      </p>
    </div>
  );
}
