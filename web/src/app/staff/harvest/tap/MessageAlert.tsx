"use client";

// 個別の連絡を受けとる（従業員の携帯。収穫報告・勤務の画面）：自分あての連絡が来たら、効果音と声で読み上げ、画面いっぱいに出す。
// 「了解です」を押すまで出しつづけ、押すと送った人の画面に「✓ 了解です」と出る（開いていない間に来た連絡は、開いたときに出す）。
// 開いている間は「開いている印」を30秒ごとに入れる（送る人の画面で、相手がいま開いているかを見るため）
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { announce, unlockSound } from "@/lib/announce";
import { ackMessage, useMessages, usePresence } from "@/lib/harvestTap";
import type { ShiftMember } from "@/lib/shift";

export function MessageAlert({ date, me }: { date: string; me: ShiftMember }) {
  usePresence(date, me.id);
  const msgs = useMessages(date, me.id);
  const pending = (msgs ?? []).filter((m) => m.ackAt == null);
  /** 読み上げた連絡（同じ連絡を何度も読まない） */
  const spoken = useRef(new Set<string>());
  const say = (text: string) => announce(`${me.name}さん、連絡です。${text}`, { sound: "change", vibrate: true });
  // 画面を一度押したら、音と声を出せるようにしておく
  useEffect(() => {
    document.addEventListener("pointerdown", unlockSound, { once: true });
    return () => document.removeEventListener("pointerdown", unlockSound);
  }, []);
  const first = pending[0];
  useEffect(() => {
    if (!first || spoken.current.has(first.id)) return;
    spoken.current.add(first.id);
    say(first.text);
    // 新しい連絡が来たときだけ読み上げる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first?.id]);
  if (!first) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-sky-300 p-6 text-center">
      <p className="text-2xl font-bold text-sky-950">📣 連絡</p>
      <p className="text-3xl leading-snug font-bold whitespace-pre-wrap text-gray-900">{first.text}</p>
      <div className="flex flex-col gap-3">
        <button onClick={() => void ackMessage(date, first.id).catch(() => {})} className="rounded-2xl bg-white px-10 py-5 text-3xl font-bold shadow">
          了解です
        </button>
        <button onClick={() => say(first.text)} className="rounded-xl border-2 border-sky-800 bg-sky-100 px-6 py-2 text-lg font-bold text-sky-900">
          🔊 もう一度聞く
        </button>
      </div>
      {pending.length > 1 && <p className="text-sm text-sky-900">ほかにも連絡があります（あと{pending.length - 1}件）</p>}
    </div>,
    document.body,
  );
}
