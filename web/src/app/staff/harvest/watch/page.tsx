"use client";

// 温度の見張り（管理者）：寝る前に携帯でこの画面を開いて「見張りを始める」を押し、そのまま枕元に置いておく。
// どこかのハウスの温度が「知らせる温度」より下がったら、または温度計が1時間読めなくなったら（停電など）、警報音を鳴らし続ける。
// 音は <audio> で鳴らす（iPhone の消音スイッチやマナーモードでも鳴る。大きさはメディアの音量）。画面が消えないようにする
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { addDays, todayJST } from "@/lib/date";
import { readingAt, saveAlertTemp, useGoveeConfig, useHouseTemps } from "@/lib/govee";

/** 温度計がこれより長く読めないと知らせる（分） */
const STALE_MIN = 60;
/** 「止める」を押したあと、まだ同じ状態なら、もう一度鳴らすまでの分 */
const REMIND_MIN = 30;

/** 警報音（ピーポーと2つの高さをくり返す）を作る。外から音のファイルを読まないので、電波が弱くても鳴る */
function sirenUrl(): string {
  const rate = 22050;
  const secs = 1.2;
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
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = t < secs / 2 ? 960 : 720;
    phase += (2 * Math.PI * f) / rate;
    // 矩形に近い波（よく聞こえる）。つなぎ目でぷつっと鳴らないよう、はじめと終わりを少しだけ小さくする
    const edge = Math.min(1, t / 0.01, (secs - t) / 0.01);
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, Math.sin(phase) * 3)) * 0.9 * edge * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

type Alert = { key: string; house: string; kind: "low" | "stale"; temp?: number; at: number };

const clockOf = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);

export default function WatchPage() {
  const { role } = useAuth();
  const cfg = useGoveeConfig();
  const today = todayJST();
  // その日の分には「前の日の9時すぎ〜その日の9時」が入っているので、昨日〜明日の分を見る
  const temps = useHouseTemps(addDays(today, -1), addDays(today, 1));
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [acked, setAcked] = useState<Record<string, number>>({});
  const [edit, setEdit] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);

  // 30秒ごとに時刻を進める（温度計が読めない時間をはかる）
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // 画面が消えないようにする（見張り中だけ）。ほかのアプリから戻ったときも、もう一度たのむ
  useEffect(() => {
    if (!started) return;
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    const ask = () => {
      if (document.visibilityState === "visible" && wl)
        wl.request("screen").then(
          (l) => (lock.current = l),
          () => {},
        );
      setNow(Date.now());
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    return () => {
      document.removeEventListener("visibilitychange", ask);
      void lock.current?.release().catch(() => {});
      lock.current = null;
    };
  }, [started]);

  const alertTemp = cfg?.alertTemp ?? 4;
  const houses = [...new Set(Object.values(cfg?.houseOf ?? {}).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  // ハウスごとの、いちばん新しい温度
  const latest = houses.map((h) => {
    let best: { temp: number; at: number } | null = null;
    for (const [date, doc] of Object.entries(temps ?? {}))
      for (const x of doc[h] ?? []) {
        const at = readingAt(date, x.t);
        if (!best || at > best.at) best = { temp: x.temp, at };
      }
    return { house: h, last: best };
  });
  const alerts: Alert[] = [];
  for (const { house, last } of latest) {
    if (!last) continue; // 一度も読めていない温度計（つながっていない）は見張らない
    const age = (now - last.at) / 60_000;
    if (age > STALE_MIN && age < 24 * 60) alerts.push({ key: `stale-${house}`, house, kind: "stale", at: last.at });
    else if (age <= STALE_MIN && last.temp < alertTemp) alerts.push({ key: `low-${house}`, house, kind: "low", temp: last.temp, at: last.at });
  }
  const ringing = started && alerts.some((a) => acked[a.key] == null || now - acked[a.key] > REMIND_MIN * 60_000);
  const alertKeys = alerts.map((a) => a.key).join(",");

  // 直った（温度が戻った・読めるようになった）ものは「止めた」の印を消す（また下がったら鳴らす）
  const [seenKeys, setSeenKeys] = useState(alertKeys);
  if (seenKeys !== alertKeys) {
    setSeenKeys(alertKeys);
    const live = new Set(alerts.map((a) => a.key));
    setAcked(Object.fromEntries(Object.entries(acked).filter(([k]) => live.has(k))));
  }

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (ringing) {
      a.currentTime = 0;
      void a.play().catch(() => {});
    } else a.pause();
  }, [ringing]);

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;

  async function start() {
    if (!audio.current) {
      audio.current = new Audio(sirenUrl());
      audio.current.loop = true;
    }
    // ボタンを押したときに一度鳴らしておくと、あとで自動で鳴らせる（携帯のブラウザの決まり）
    const a = audio.current;
    a.muted = true;
    await a.play().catch(() => {});
    a.pause();
    a.muted = false;
    a.currentTime = 0;
    setStarted(true);
  }
  function testSound() {
    if (!audio.current) {
      audio.current = new Audio(sirenUrl());
      audio.current.loop = true;
    }
    const a = audio.current;
    a.currentTime = 0;
    void a.play().catch(() => {});
    setTimeout(() => {
      if (!ringing) a.pause();
    }, 2500);
  }
  function stop() {
    setAcked((cur) => ({ ...cur, ...Object.fromEntries(alerts.map((a) => [a.key, Date.now()])) }));
  }
  async function saveTemp() {
    const v = Number((edit ?? "").replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(v) || v < -10 || v > 20) return setMsg("−10〜20 の数字を入れてください");
    try {
      await saveAlertTemp(Math.round(v * 10) / 10);
      setEdit(null);
      setMsg("保存しました");
    } catch {
      setMsg("保存できませんでした");
    }
  }

  const tempList = (
    <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {latest.map(({ house, last }) => {
        const bad = alerts.find((a) => a.house === house);
        return (
          <li key={house} className={`rounded-lg px-3 py-2 ${bad ? "bg-red-700 text-white" : started ? "bg-gray-900 text-gray-300" : "border bg-white"}`}>
            <span className="font-bold">No.{house}</span>
            <span className="ml-2 text-lg font-bold tabular-nums">{last ? `${last.temp.toFixed(1)}℃` : "－"}</span>
            <span className="ml-2 text-xs opacity-70">{last ? clockOf(last.at) : "読めていません"}</span>
          </li>
        );
      })}
    </ul>
  );

  if (started)
    return (
      <div className={`fixed inset-0 z-50 overflow-y-auto p-5 ${ringing ? "bg-red-900" : "bg-black"} text-gray-300`}>
        {alerts.length > 0 ? (
          <div className="rounded-2xl bg-red-700 p-5 text-white">
            <p className="text-2xl font-bold">⚠ 温度の警報</p>
            <ul className="mt-2 space-y-1 text-xl font-bold">
              {alerts.map((a) => (
                <li key={a.key}>
                  No.{a.house} {a.kind === "low" ? `${a.temp!.toFixed(1)}℃（${alertTemp}℃より低い）` : `温度計が読めません（${clockOf(a.at)}から）`}
                </li>
              ))}
            </ul>
            {ringing && (
              <button onClick={stop} className="mt-4 w-full rounded-xl bg-white py-5 text-2xl font-bold text-red-700">
                止める
              </button>
            )}
            {!ringing && <p className="mt-3 text-sm">止めました。まだ直らなければ{REMIND_MIN}分後にもう一度鳴らします。</p>}
          </div>
        ) : (
          <div className="pt-10 text-center">
            <p className="text-lg">🌙 見張り中</p>
            <p className="mt-1 text-sm text-gray-500">
              {alertTemp}℃より下がったら、警報音が鳴ります（最終確認 {clockOf(now)}）
            </p>
          </div>
        )}
        {tempList}
        <button onClick={() => setStarted(false)} className="mt-8 w-full rounded-xl border border-gray-700 py-3 text-gray-400">
          見張りを終わる
        </button>
      </div>
    );

  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">🌡 温度の見張り</h1>
      {cfg === undefined || temps === null ? (
        <p className="mt-4 text-gray-500">読み込み中…</p>
      ) : !cfg?.keySet || houses.length === 0 ? (
        <p className="mt-4 text-gray-600">
          温度計（Govee）がまだ登録されていません。「収穫の実績」画面の下の「ハウスの中の温度計（Govee）」で登録してください。
        </p>
      ) : (
        <>
          <div className="mt-4 rounded-xl border bg-white p-4">
            <p className="font-bold">知らせる温度</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={edit ?? String(alertTemp)}
                onChange={(e) => setEdit(e.target.value)}
                inputMode="decimal"
                className="w-20 rounded border px-2 py-2 text-right text-lg tabular-nums"
              />
              <span>℃ より下がったら鳴らす</span>
              {edit != null && (
                <button onClick={() => void saveTemp()} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
                  保存
                </button>
              )}
              {msg && <span className="text-sm">{msg}</span>}
            </div>
            <p className="mt-1 text-xs text-gray-500">温度計が{STALE_MIN}分読めないとき（停電・Wi-Fi が止まったときなど）も鳴らします。</p>
          </div>
          {tempList}
          <button onClick={() => void start()} className="mt-5 w-full rounded-2xl bg-indigo-700 py-5 text-2xl font-bold text-white">
            🌙 見張りを始める
          </button>
          <button onClick={testSound} className="mt-2 w-full rounded-xl border bg-white py-3 font-bold">
            🔊 音のテスト（2秒）
          </button>
          <div className="mt-5 rounded-xl border bg-white p-4 text-sm text-gray-700">
            <p className="font-bold">寝る前に</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              <li>
                「音のテスト」で鳴るか確かめ、携帯の<b>音量（メディアの音量）を大きく</b>しておく
              </li>
              <li>「見張りを始める」を押す（画面が暗くなります）</li>
              <li>
                <b>充電器につないで、この画面のまま</b>枕元に置く（ほかのアプリを開いたり、画面を消したりすると見張りが止まります）
              </li>
            </ol>
            <p className="mt-2 font-bold">携帯の設定（初めの1回）</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>iPhone：設定 →「画面表示と明るさ」→「自動ロック」を「なし」にする（見張りの間だけでも）。消音スイッチがオンでも鳴ります。</li>
              <li>Android：見張り中は画面が消えないようにしています。消えてしまうときは、設定 →「ディスプレイ」→「画面消灯」を長くする。</li>
            </ul>
          </div>
        </>
      )}
    </>
  );
}
