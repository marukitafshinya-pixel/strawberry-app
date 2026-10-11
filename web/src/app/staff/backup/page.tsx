"use client";

// データのバックアップ（管理者だけ）。全データを1つのファイルにしてパソコンに保存する。
// 自動保存：保存先フォルダを選んでおくと、この画面を開いている間、毎晩決めた時刻に自動で保存する。
// パソコンの電源が切れていた日は、次にこの画面を開いたときにすぐ保存する。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/callFunction";
import { canPickFolder, downloadBackup, exportAll, folderPermission, pickFolder, savedFolder, writeToFolder, ymdJST } from "@/lib/backup";

const PREF_KEY = "ichigo.backupAuto";
/** 何日分のファイルを残すか */
const KEEP_DAYS = 30;
type Pref = { on: boolean; time: string; last?: string; lastInfo?: string };

const loadPref = (): Pref => {
  try {
    return { on: false, time: "23:00", ...(JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as Partial<Pref>) };
  } catch {
    return { on: false, time: "23:00" };
  }
};
const storePref = (p: Pref) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    // 覚えられなくても動かす
  }
};
const nowHm = () => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
/** どのデータで止まったかが分かるように、こちらで付けた説明はそのまま出す */
const why = (e: unknown) => (e instanceof Error && e.message.startsWith("「") ? e.message : errorText(e));
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);

export default function BackupPage() {
  const { role } = useAuth();
  const [pref, setPrefState] = useState<Pref>(loadPref);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [perm, setPerm] = useState<"granted" | "denied" | "prompt" | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const running = useRef(false);

  const setPref = (p: Pref) => {
    setPrefState(p);
    storePref(p);
  };

  useEffect(() => {
    void savedFolder().then(async (h) => {
      if (!h) return;
      setFolderName(h.name);
      setPerm(await folderPermission(h, false));
    });
  }, []);

  /** フォルダに保存する（自動・手動どちらも） */
  const saveToFolder = useCallback(async (auto: boolean) => {
    if (running.current) return;
    const h = await savedFolder();
    if (!h) return setMsg({ ok: false, text: "保存先のフォルダを選んでください" });
    const p = await folderPermission(h, !auto);
    setPerm(p);
    if (p !== "granted") return setMsg({ ok: false, text: "保存先のフォルダに書く許可がありません。「保存先の使用を許可する」を押してください" });
    running.current = true;
    try {
      const data = await exportAll((l) => setBusy(`読み込み中…（${l}）`));
      setBusy("保存中…");
      const r = await writeToFolder(h, data, KEEP_DAYS);
      const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
      const info = `${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}　${r.name}（${total}件・${kb(r.bytes)}）${r.removed ? `・古いファイル${r.removed}個を削除` : ""}`;
      const next = { ...loadPref(), last: ymdJST(), lastInfo: info };
      setPref(next);
      setMsg({ ok: true, text: `保存しました：${info}` });
    } catch (e) {
      setMsg({ ok: false, text: `保存できませんでした：${why(e)}` });
    } finally {
      running.current = false;
      setBusy("");
    }
  }, []);

  // 自動保存：1分ごとに、決めた時刻を過ぎていて今日の分がまだなら保存する。
  // 前の日の分も保存できていなければ（パソコンが切れていたなど）、時刻を待たずにすぐ保存する
  useEffect(() => {
    if (role !== "admin" || !pref.on || perm !== "granted") return;
    const tick = () => {
      const p = loadPref();
      const today = ymdJST();
      const yesterday = ymdJST(new Date(Date.now() - 86400_000));
      const due = (nowHm() >= p.time && p.last !== today) || (!!p.last && p.last < yesterday) || !p.last;
      if (due) void saveToFolder(true);
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [role, pref.on, perm, saveToFolder]);

  async function downloadNow() {
    setMsg(null);
    try {
      const data = await exportAll((l) => setBusy(`読み込み中…（${l}）`));
      downloadBackup(data);
      const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
      setMsg({ ok: true, text: `ダウンロードしました（${total}件）` });
    } catch (e) {
      setMsg({ ok: false, text: `ダウンロードできませんでした：${why(e)}` });
    } finally {
      setBusy("");
    }
  }

  async function choose() {
    setMsg(null);
    try {
      const h = await pickFolder();
      setFolderName(h.name);
      setPerm(await folderPermission(h, true));
    } catch (e) {
      // 選ぶのをやめたときは何もしない
      if (!(e instanceof DOMException && e.name === "AbortError")) setMsg({ ok: false, text: `保存先を選べませんでした：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;
  const box = "mt-4 rounded-2xl bg-white p-4 shadow-sm";
  return (
    <>
      <p className="text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          ← メニュー
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">データのバックアップ</h1>
      <p className="mt-1 text-sm text-gray-600">
        予約・会計・顧客・勤務表・給与など、アプリの全データを1つのファイルにしてパソコンに保存します。
        <b className="text-red-700">お客様の連絡先や給与が入ったファイルなので、ほかの人が見られない場所に保管してください。</b>
      </p>

      <section className={box}>
        <h2 className="font-bold">今すぐ保存する</h2>
        <p className="mt-1 text-sm text-gray-600">押すと、ファイル（ichigo-backup-日付.json）をダウンロードします。</p>
        <button disabled={!!busy} onClick={downloadNow} className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-50">
          ⬇ 今すぐダウンロード
        </button>
      </section>

      <section className={box}>
        <h2 className="font-bold">毎晩、自動でパソコンに保存する</h2>
        {!canPickFolder() ? (
          <p className="mt-1 text-sm text-red-700">このブラウザでは使えません。パソコンの Google Chrome か Microsoft Edge で開いてください。</p>
        ) : (
          <>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-gray-700">
              <li>「保存先のフォルダを選ぶ」で、保存するフォルダ（例：ドキュメントの中に作った「いちごバックアップ」）を選びます。</li>
              <li>「自動で保存する」に印を付け、保存する時刻を決めます。</li>
              <li>
                <b>この画面を開いたまま</b>にしておきます（ほかのタブを使っていても大丈夫です）。パソコンが眠らない設定にしてください。
              </li>
            </ol>
            <p className="mt-1 text-xs text-gray-500">
              パソコンの電源が切れていた日は、次にこの画面を開いたときにすぐ保存します。{KEEP_DAYS}日より古いファイルは自動で消します。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={choose} className="rounded-lg border bg-white px-3 py-2 text-sm">
                📁 保存先のフォルダを選ぶ
              </button>
              <span className="text-sm">{folderName !== null ? `保存先：${folderName || "（選んだフォルダ）"}` : "まだ選んでいません"}</span>
              {folderName !== null && perm !== "granted" && (
                <button
                  onClick={async () => {
                    const h = await savedFolder();
                    if (h) setPerm(await folderPermission(h, true));
                  }}
                  className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-bold text-white"
                >
                  保存先の使用を許可する
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={pref.on} disabled={folderName === null} onChange={(e) => setPref({ ...pref, on: e.target.checked })} className="h-5 w-5" />
                <span className="font-bold">自動で保存する</span>
              </label>
              <label className="flex items-center gap-1">
                毎日
                <input type="time" value={pref.time} onChange={(e) => e.target.value && setPref({ ...pref, time: e.target.value })} className="rounded border px-2 py-1" />
                に保存
              </label>
              {folderName !== null && (
                <button disabled={!!busy} onClick={() => saveToFolder(false)} className="rounded-lg border bg-white px-3 py-2 disabled:opacity-50">
                  今すぐフォルダに保存
                </button>
              )}
            </div>
            {pref.on && perm === "granted" && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">● 自動保存が動いています（毎日 {pref.time}）。この画面は閉じないでください。</p>}
            {pref.on && perm !== "granted" && folderName !== null && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">ブラウザを開き直したため、自動保存が止まっています。「保存先の使用を許可する」を押してください。</p>
            )}
            <p className="mt-2 text-sm text-gray-600">前回の保存：{pref.lastInfo ?? "まだありません"}</p>
          </>
        )}
      </section>

      {busy && <p className="mt-3 text-sm text-gray-600">{busy}</p>}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>{msg.text}</p>}
    </>
  );
}
