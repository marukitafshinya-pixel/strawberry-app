"use client";

// 収穫報告の携帯を、収穫管理から見る・操作する（「入った」「終わった」以外）。
// usePhoneSync：携帯の側。使える声・いまの設定を知らせ、収穫管理で変えた声・順番を受けとり、指示（音声テスト・行き先）を実行する
// PhonePanel：収穫管理の側（その人の画面の下）。声の設定を見る・変える、音声テストを鳴らす、行き先を送る
import { useEffect, useRef, useState } from "react";
import { isIOS, japaneseVoices, saveVoice, saveVoiceOrder, savedVoice, voiceOrder, type VoiceOrder } from "@/lib/announce";
import { errorText } from "@/lib/callFunction";
import { PRESENCE_MS, setStopFor, usePresenceAll } from "@/lib/harvestTap";
import { doneCommand, reportPhone, sendCommand, setPhonePrefs, useMyCommands, usePhoneState, type PhoneState } from "@/lib/phoneRemote";

/** 収穫管理で変えた声・順番を、この携帯で最後に受けとった時刻（同じ変更を何度も受けとらない） */
const APPLIED_KEY = "harvestPrefsAt";
const appliedAt = () => {
  try {
    return Number(localStorage.getItem(APPLIED_KEY) ?? 0);
  } catch {
    return 0;
  }
};

const ORDER_LABEL: Record<VoiceOrder, string> = { voiceFirst: "声 → 効果音", soundFirst: "効果音 → 声", voiceOnly: "声だけ" };

/** 携帯の側：設定を知らせる・受けとる、指示を実行する。返す version は、声の設定を受けとるたびに増える（声の設定の欄を作り直すため） */
export function usePhoneSync({
  date,
  memberId,
  enabled,
  onGoto,
  onTest,
}: {
  date: string;
  memberId: string;
  enabled: boolean;
  onGoto: (house: string) => void;
  onTest: () => void;
}): { version: number; report: (voice?: string | null, order?: VoiceOrder) => void } {
  const [version, setVersion] = useState(0);
  const report = (voice: string | null = savedVoice(), order: VoiceOrder = voiceOrder()) => {
    if (!enabled) return;
    void reportPhone(memberId, { voices: japaneseVoices().map((v) => v.name), ios: isIOS(), localVoice: voice, localOrder: order }).catch(() => {});
  };
  // 開いたときと、声の一覧が届いたときに知らせる
  useEffect(() => {
    if (!enabled) return;
    report();
    const onVoices = () => report();
    window.speechSynthesis?.addEventListener?.("voiceschanged", onVoices);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", onVoices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, memberId]);
  // 収穫管理で変えた声・順番を受けとる
  const phone = usePhoneState(enabled ? memberId : null);
  useEffect(() => {
    if (!enabled || !phone?.wantAt || phone.wantAt <= appliedAt()) return;
    saveVoice(phone.wantVoice);
    if (phone.wantOrder) saveVoiceOrder(phone.wantOrder);
    try {
      localStorage.setItem(APPLIED_KEY, String(phone.wantAt));
    } catch {
      // 覚えられなくても、その場は使える
    }
    setTimeout(() => setVersion((v) => v + 1), 0);
    report(phone.wantVoice, phone.wantOrder ?? voiceOrder());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, phone?.wantAt]);
  // 指示を実行する（同じ指示は1回だけ）
  const cmds = useMyCommands(date, memberId, enabled);
  const done = useRef(new Set<string>());
  useEffect(() => {
    for (const c of cmds) {
      if (done.current.has(c.id)) continue;
      done.current.add(c.id);
      if (c.kind === "test") onTest();
      if (c.kind === "goto" && c.house) onGoto(c.house);
      void doneCommand(date, c.id).catch(() => {});
    }
    // 新しい指示が来たときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmds]);
  return { version, report };
}

/** 収穫管理の側：その人の携帯の設定と操作 */
export function PhonePanel({
  date,
  memberId,
  name,
  choices,
  target,
  stopAt,
}: {
  date: string;
  memberId: string;
  name: string;
  choices: string[];
  /** その人のいまのハウス（入っている・次に行く） */
  target: string | null;
  /** その人だけの「ここで終了」を付けているハウス */
  stopAt: string | null;
}) {
  const [stopPick, setStopPick] = useState("");
  const phone = usePhoneState(memberId);
  const presence = usePresenceAll(date);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const [msg, setMsg] = useState("");
  const seen = presence?.[memberId] ?? null;
  const open = seen != null && seen > now - PRESENCE_MS;
  const hm = (ms: number | null) => (ms == null ? "－" : new Date(ms + 9 * 3600e3).toISOString().slice(11, 16));
  const run = (p: Promise<unknown>, ok: string) => {
    setMsg("");
    p.then(() => setMsg(open ? ok : `${ok}（${name}さんのアプリが開いていません。開いたときに届きます）`)).catch((e) =>
      setMsg(`できませんでした：${errorText(e)}`),
    );
  };
  const voice = phone?.localVoice ?? null;
  const order = phone?.localOrder ?? (phone?.ios ? "voiceFirst" : "soundFirst");
  const waiting = !!phone?.wantAt && (phone.wantVoice !== phone.localVoice || (phone.wantOrder != null && phone.wantOrder !== phone.localOrder));

  return (
    <div className="space-y-3 rounded-2xl border-2 border-gray-300 bg-gray-50 p-3 text-sm">
      <p className="font-bold">
        ⚙ {name}さんの携帯の設定
        <span className={`ml-2 font-normal ${open ? "text-emerald-700" : "text-gray-500"}`}>
          {open ? "🟢 いま開いている" : `⚪ 開いていない（最後に開いていたのは ${hm(seen)}）`}
        </span>
      </p>
      {phone === undefined ? (
        <p className="text-gray-500">読み込み中…</p>
      ) : !phone ? (
        <p className="text-gray-500">まだこの人の携帯から設定が届いていません（収穫報告を一度開くと届きます）。</p>
      ) : (
        <>
          <p className="text-gray-600">
            {phone.ios ? "iPhone" : "Android など"}・使える日本語の声 {phone.voices.length}種類
          </p>
          <label className="block">
            <span className="font-bold">声</span>
            <select
              value={voice ?? ""}
              onChange={(e) => run(setPhonePrefs(memberId, e.target.value || null, order as VoiceOrder), "声を変えました")}
              className="mt-1 w-full rounded-lg border bg-white px-2 py-2 text-base"
            >
              <option value="">おまかせ（携帯のふだんの声）</option>
              {phone.voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="font-bold">音と声の順番</span>
            <select
              value={order}
              onChange={(e) => run(setPhonePrefs(memberId, voice, e.target.value as VoiceOrder), "順番を変えました")}
              className="mt-1 w-full rounded-lg border bg-white px-2 py-2 text-base"
            >
              {(Object.keys(ORDER_LABEL) as VoiceOrder[]).map((k) => (
                <option key={k} value={k}>
                  {ORDER_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          {waiting && <p className="text-amber-700">変えた設定は、{name}さんの携帯がまだ受けとっていません（アプリを開くと届きます）。</p>}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run(sendCommand(date, memberId, "test"), "音声案内のテストを送りました")}
          className="rounded-xl border bg-white px-4 py-2 font-bold"
        >
          🔊 {name}さんの携帯で音声テスト
        </button>
      </div>
      <label className="block">
        <span className="font-bold">行き先を決める（ほかのハウスに行く）</span>
        <select
          value=""
          onChange={(e) => e.target.value && run(sendCommand(date, memberId, "goto", e.target.value), `${e.target.value}番へ行くよう送りました`)}
          className="mt-1 w-full rounded-lg border bg-white px-2 py-2 text-base"
        >
          <option value="">ハウスを選ぶ</option>
          {choices.map((h) => (
            <option key={h} value={h}>
              {h}番
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-gray-500">選ぶと、{name}さんの携帯に「管理者の指示で、次は◯番」と出て、声で知らせます。</span>
      </label>
      {/* 🏁 個人でここで終了：その人がこのハウスを終えたら、次のハウスも応援も出さずに今日の収穫をここまでにする（ハウスの人全員の🏁はそのまま） */}
      <div className="rounded-xl border border-emerald-300 bg-white p-2">
        <p className="font-bold">🏁 {name}さんだけ、ここで終了</p>
        {stopAt ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-emerald-700 px-3 py-1 font-bold text-white">🏁 {stopAt}番で終了</span>
            <button
              onClick={() => run(setStopFor(date, stopAt, memberId, false), `${stopAt}番の「ここで終了」を外しました`)}
              className="rounded-lg border bg-white px-3 py-1"
            >
              外す
            </button>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select value={stopPick || target || ""} onChange={(e) => setStopPick(e.target.value)} className="rounded-lg border bg-white px-2 py-2 text-base">
              <option value="">ハウスを選ぶ</option>
              {[...new Set([...(target ? [target] : []), ...choices])].map((h) => (
                <option key={h} value={h}>
                  {h}番{h === target ? "（いまのハウス）" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={!(stopPick || target)}
              onClick={() => {
                const h = stopPick || target!;
                run(setStopFor(date, h, memberId, true), `${name}さんは${h}番を終えたら終了にしました`);
              }}
              className="rounded-lg bg-emerald-700 px-3 py-2 font-bold text-white disabled:opacity-40"
            >
              ここで終了にする
            </button>
          </div>
        )}
        <p className="mt-1 text-xs text-gray-500">このハウスを終えたら、次のハウスも応援も出さずに「今日の収穫はここまでです」と知らせます。</p>
      </div>
      {msg && <p className="rounded-lg bg-white p-2 font-bold text-sky-900">{msg}</p>}
    </div>
  );
}

export type { PhoneState };
