"use client";

// 温度の見張り：見張り担当①②③が、寝る前に携帯でこの画面を開いて「見張りを始める」を押し、そのまま枕元に置いておく。
// 警報（どこかのハウスが知らせる温度より下がった・温度計が1時間読めない）はサーバーが20分ごとに alerts/temp に入れる。
// 警報が出たら、まず①が鳴り、5分たっても誰も止めなければ②、さらに5分で③も鳴る（管理者のログインで開いた画面は鳴らない。見るだけ）。
// だれかが「止める」を押せば全員の音が止まる。30分たっても直らなければ、また①から鳴らす。
// 音は <audio> で鳴らす（iPhone の消音スイッチやマナーモードでも鳴る。大きさはメディアの音量）。画面が消えないようにする
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { ackTempAlert, resetTempAlert, saveAlertTemp, saveTempWatchers, useGoveeConfig, useTempAlert, useTempWatchers } from "@/lib/govee";
import { useShiftMembers } from "@/lib/shift";

/** 「止める」を押したあと、まだ直っていなければ、もう一度鳴らすまでの分 */
const REMIND_MIN = 30;
/** 次の担当を鳴らすまでの分 */
const STEP_MIN = 5;
/** サーバーの確認（20分ごと）がこれより長く来なければ、見張りのしくみが止まっているとして鳴らす（分） */
const DOWN_MIN = 70;

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

const clockOf = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);
const NO = ["①", "②", "③"];

export default function WatchPage() {
  const { role, user } = useAuth();
  const isAdmin = role === "admin";
  const members = useShiftMembers();
  const watchers = useTempWatchers();
  const alert = useTempAlert();
  const [started, setStarted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const audio = useRef<HTMLAudioElement | null>(null);
  const lock = useRef<{ release: () => Promise<void> } | null>(null);

  // 15秒ごとに時刻を進める（次の担当を鳴らす時刻・しくみが止まっていないかをはかる）
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
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

  const me = members?.find((m) => m.uid === user?.uid) ?? null;
  // 自分の順番（0＝①）。担当でなければ -1（鳴らない）
  const myNo = me && watchers ? watchers.indexOf(me.id) : -1;
  const down = !!alert?.checkedAt && now - alert.checkedAt > DOWN_MIN * 60_000;
  const active = !!alert && (alert.items.length > 0 || down);
  const quiet = !!alert?.ackAt && now - alert.ackAt < REMIND_MIN * 60_000;
  // 鳴らしはじめる時刻：止めたあとなら止めてから30分後、しくみが止まっているなら最後の確認から70分後、ふつうは警報が出た時刻
  const base = alert?.ackAt
    ? alert.ackAt + REMIND_MIN * 60_000
    : alert?.items.length
      ? (alert.startedAt ?? now)
      : (alert?.checkedAt ?? now) + DOWN_MIN * 60_000;
  const myStart = base + Math.max(0, myNo) * STEP_MIN * 60_000;
  const ringing = started && myNo >= 0 && active && !quiet && now >= myStart;

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (ringing) {
      a.currentTime = 0;
      void a.play().catch(() => {});
    } else a.pause();
  }, [ringing]);

  if (role !== "admin" && role !== "worker") return <p>この画面は、管理者と見張り担当の従業員が使います。</p>;
  if (members === null || watchers === null || alert === undefined) return <p className="text-gray-500">読み込み中…</p>;
  if (!isAdmin && myNo < 0)
    return <p className="rounded-xl bg-white p-4 text-gray-700">あなたは温度の見張り担当になっていません。管理者に確認してください。</p>;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "（いない人）";
  const myName = me?.name ?? (isAdmin ? "管理者" : "");

  function siren() {
    if (!audio.current) {
      audio.current = new Audio(sirenUrl());
      audio.current.loop = true;
    }
    return audio.current;
  }
  async function start() {
    // ボタンを押したときに一度鳴らしておくと、あとで自動で鳴らせる（携帯のブラウザの決まり）
    const a = siren();
    a.muted = true;
    await a.play().catch(() => {});
    a.pause();
    a.muted = false;
    a.currentTime = 0;
    setStarted(true);
  }
  function testSound() {
    const a = siren();
    a.currentTime = 0;
    void a.play().catch(() => {});
    setTimeout(() => {
      if (!ringing) a.pause();
    }, 2500);
  }
  async function stop() {
    try {
      await ackTempAlert(myName);
    } catch {
      // 止めた印が入れられなくても（電波が悪いなど）、この携帯の音は止める
    }
    audio.current?.pause();
  }

  const houses = Object.keys(alert?.latest ?? {}).sort((a, b) => Number(a) - Number(b));
  const tempList = (
    <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {houses.map((h) => {
        const x = alert!.latest[h];
        const bad = alert!.items.some((a) => a.house === h);
        return (
          <li key={h} className={`rounded-lg px-3 py-2 ${bad ? "bg-red-700 text-white" : started ? "bg-gray-900 text-gray-300" : "border bg-white"}`}>
            <span className="font-bold">No.{h}</span>
            <span className="ml-2 text-lg font-bold tabular-nums">{x.temp.toFixed(1)}℃</span>
            <span className="ml-2 text-xs opacity-70">{clockOf(x.at)}</span>
          </li>
        );
      })}
    </ul>
  );
  const order = (
    <p className="text-sm">
      見張り担当：{watchers.length ? watchers.map((id, i) => `${NO[i]} ${nameOf(id)}`).join("　") : "まだ決まっていません"}
      {myNo >= 0 ? (
        <span className="ml-2 font-bold">（あなたは{NO[myNo]}）</span>
      ) : (
        <span className="ml-2 text-gray-500">（このログインでは鳴りません。担当の人は、自分の従業員のログインで開いてください）</span>
      )}
    </p>
  );

  if (started)
    return (
      <div className={`fixed inset-0 z-50 overflow-y-auto p-5 ${ringing ? "bg-red-900" : "bg-black"} text-gray-300`}>
        {active ? (
          <div className="rounded-2xl bg-red-700 p-5 text-white">
            <p className="text-2xl font-bold">⚠ 温度の警報</p>
            <ul className="mt-2 space-y-1 text-xl font-bold">
              {alert!.items.map((a) => (
                <li key={`${a.kind}-${a.house}`}>
                  No.{a.house}{" "}
                  {a.kind === "low" ? `${a.temp!.toFixed(1)}℃（${alert!.alertTemp}℃より低い）` : `温度計が読めません（${clockOf(a.since)}ごろから）`}
                </li>
              ))}
              {down && <li>見張りのしくみから連絡がありません（{clockOf(alert!.checkedAt!)}から）。携帯の電波か、温度計の登録を確かめてください</li>}
            </ul>
            {quiet ? (
              <p className="mt-3 text-sm">
                {alert!.ackBy}さんが {clockOf(alert!.ackAt!)} に止めました。直らなければ {clockOf(alert!.ackAt! + REMIND_MIN * 60_000)} にまた①から鳴らします。
              </p>
            ) : ringing ? (
              <button onClick={() => void stop()} className="mt-4 w-full rounded-xl bg-white py-5 text-2xl font-bold text-red-700">
                止める
              </button>
            ) : (
              <p className="mt-3 text-sm">
                {myNo > 0 ? `${NO[myNo - 1]}の人が止めなければ、${clockOf(myStart)} にこの携帯も鳴ります。` : "まもなく鳴ります。"}
              </p>
            )}
          </div>
        ) : (
          <div className="pt-10 text-center">
            <p className="text-lg">🌙 見張り中</p>
            <p className="mt-1 text-sm text-gray-500">
              {alert
                ? `${alert.alertTemp}℃より下がったら鳴ります（最後の確認 ${alert.checkedAt ? clockOf(alert.checkedAt) : "－"}）`
                : "温度の記録がまだありません"}
            </p>
          </div>
        )}
        <div className="mt-4 text-gray-400">{order}</div>
        {tempList}
        <button onClick={() => setStarted(false)} className="mt-8 w-full rounded-xl border border-gray-700 py-3 text-gray-400">
          見張りを終わる
        </button>
      </div>
    );

  return (
    <>
      <p className="text-sm">
        <Link href={isAdmin ? "/staff/" : "/staff/shift/me/"} className="text-gray-500 underline">
          ← {isAdmin ? "メニュー" : "勤務の画面"}
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">🌡 温度の見張り</h1>
      {isAdmin && <AdminSettings watchers={watchers} members={members} />}
      <div className="mt-4">{order}</div>
      {tempList}
      {myNo >= 0 && (
        <>
          <button onClick={() => void start()} className="mt-5 w-full rounded-2xl bg-indigo-700 py-5 text-2xl font-bold text-white">
            🌙 見張りを始める
          </button>
          <button onClick={testSound} className="mt-2 w-full rounded-xl border bg-white py-3 font-bold">
            🔊 音のテスト（2秒）
          </button>
        </>
      )}
      {alert && alert.items.length > 0 && (
        <p className="mt-4 rounded-xl bg-red-700 p-3 font-bold text-white">
          ⚠ 警報が出ています：{alert.items.map((a) => `No.${a.house} ${a.kind === "low" ? `${a.temp!.toFixed(1)}℃` : "温度計が読めません"}`).join("、")}
          {alert.ackBy && alert.ackAt ? `（${alert.ackBy}さんが ${clockOf(alert.ackAt)} に止めました）` : ""}
          {isAdmin && (
            <button
              onClick={() => {
                if (window.confirm("いまの警報を消して、全員の音を止めますか？（まだ温度が低ければ、次の確認（20分以内）でまた①から鳴ります）"))
                  void resetTempAlert().catch(() => window.alert("リセットできませんでした"));
              }}
              className="mt-2 block w-full rounded-lg bg-white py-3 text-lg font-bold text-red-700"
            >
              警報をリセット
            </button>
          )}
        </p>
      )}
      <div className="mt-5 rounded-xl border bg-white p-4 text-sm text-gray-700">
        <p className="font-bold">しくみ</p>
        <p className="mt-1">
          警報が出たら、まず①が鳴ります。{STEP_MIN}分たっても誰も止めなければ②、さらに{STEP_MIN}分で③も鳴ります。
          <b>誰か1人が「止める」を押せば、全員の音が止まります</b>。{REMIND_MIN}
          分たっても直らなければ、また①から鳴ります。サーバーが温度を読むのは20分ごとなので、下がってから鳴るまで最大20分くらいかかります。
        </p>
        <p className="mt-3 font-bold">寝る前に</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          <li>
            「音のテスト」で鳴るか確かめ、携帯の<b>音量（メディアの音量）を大きく</b>しておく
          </li>
          <li>「見張りを始める」を押す（画面が暗くなります）</li>
          <li>
            <b>充電器につないで、この画面のまま</b>枕元に置く（ほかのアプリを開いたり、画面を消したりすると見張りが止まります）
          </li>
        </ol>
        <p className="mt-3 font-bold">携帯の設定（初めの1回）</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>iPhone：設定 →「画面表示と明るさ」→「自動ロック」を「なし」にする（見張りの間だけでも）。消音スイッチがオンでも鳴ります。</li>
          <li>Android：見張り中は画面が消えないようにしています。消えてしまうときは、設定 →「ディスプレイ」→「画面消灯」を長くする。</li>
        </ul>
      </div>
    </>
  );
}

/** 管理者だけ：知らせる温度と、見張り担当①②③ */
function AdminSettings({ watchers, members }: { watchers: string[]; members: { id: string; name: string; active: boolean; order: number }[] }) {
  const cfg = useGoveeConfig();
  const [temp, setTemp] = useState<string | null>(null);
  const [pick, setPick] = useState<string[] | null>(null);
  const [msg, setMsg] = useState("");
  const cur = pick ?? [0, 1, 2].map((i) => watchers[i] ?? "");
  const alertTemp = cfg?.alertTemp ?? 4;
  const active = members.filter((m) => m.active).sort((a, b) => a.order - b.order);
  async function save() {
    try {
      if (temp != null) {
        const v = Number(temp.replace(/[^0-9.\-]/g, ""));
        if (!Number.isFinite(v) || v < -10 || v > 20) return setMsg("知らせる温度は −10〜20 の数字を入れてください");
        await saveAlertTemp(Math.round(v * 10) / 10);
      }
      if (pick) {
        const list = cur.filter(Boolean);
        if (new Set(list).size !== list.length) return setMsg("同じ人が2回入っています");
        await saveTempWatchers(list);
      }
      setTemp(null);
      setPick(null);
      setMsg("保存しました");
    } catch {
      setMsg("保存できませんでした");
    }
  }
  return (
    <div className="mt-4 rounded-xl border bg-white p-4">
      <p className="font-bold">設定（管理者だけ）</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span>知らせる温度</span>
        <input
          value={temp ?? String(alertTemp)}
          onChange={(e) => setTemp(e.target.value)}
          inputMode="decimal"
          className="w-20 rounded border px-2 py-2 text-right text-lg tabular-nums"
        />
        <span>℃ より下がったら鳴らす</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <label key={i} className="flex items-center gap-2">
            <span className="w-14 font-bold">担当{NO[i]}</span>
            <select value={cur[i]} onChange={(e) => setPick(cur.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1 rounded border px-2 py-2">
              <option value="">（なし）</option>
              {active.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        {(temp != null || pick != null) && (
          <button onClick={() => void save()} className="rounded-lg bg-berry px-4 py-2 font-bold text-white">
            保存
          </button>
        )}
        {msg && <span className="text-sm">{msg}</span>}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        担当の人は、自分の従業員のログインで「勤務の画面」を開くと「温度の見張りを開く」ボタンが出ます。温度計が1時間読めないとき（停電・Wi-Fi
        が止まったときなど）も鳴ります。
      </p>
    </div>
  );
}
