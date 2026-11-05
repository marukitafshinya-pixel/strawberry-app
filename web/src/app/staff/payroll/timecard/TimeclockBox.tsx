"use client";

// 打刻タブレットの設定（管理者）：タブレットのログインと、NFCタグ → 従業員の登録。
// 未登録のタグは、タブレットにかざすと「未登録のタグ」に出るので、ここで従業員を選んで登録する
import { useEffect, useRef, useState } from "react";
import { speak } from "@/lib/announce";
import { errorText } from "@/lib/callFunction";
import {
  forgetUnknownTag,
  guessTimeclockYomi,
  saveTimeclockLogin,
  setTimeclockTag,
  setTimeclockYomi,
  shortSerial,
  stopTimeclockLogin,
  useTimeclockLogin,
  useTimeclockTags,
  useTimeclockUnknown,
} from "@/lib/timeclock";

type Emp = { id: string; code: string; name: string; active?: boolean };
type Tag = NonNullable<ReturnType<typeof useTimeclockTags>>[string];

/** 名前の読み方（打刻のあいさつの声で読む）。AIの予測のままなら「予測」と出す。直して「保存」、🔊で聞ける */
function YomiCell({ serial, t, busy, run }: { serial: string; t: Tag; busy: boolean; run: (f: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [v, setV] = useState(t.yomi ?? "");
  const [base, setBase] = useState(t.yomi ?? "");
  // 予測が入った・ほかの画面で直されたときは、入力欄も合わせる（打ちかけのときはそのまま）
  if ((t.yomi ?? "") !== base) {
    if (v === base) setV(t.yomi ?? "");
    setBase(t.yomi ?? "");
  }
  const changed = v.trim() !== (t.yomi ?? "");
  // 保存したら、入力欄はそろえた読み方（カタカナ→ひらがな）にする
  const save = () =>
    run(async () => {
      const r = await setTimeclockYomi(serial, v.trim() === "" ? null : v.trim());
      setV(r.yomi ?? "");
    }, `${t.name}さんの読み方を保存しました`);
  return (
    <span className="flex items-center gap-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && changed && void save()}
        placeholder="ひらがなで"
        aria-label={`${t.name}さんの読み方`}
        className="w-36 rounded border px-2 py-0.5"
      />
      {t.yomiGuess && !changed && <span className="rounded bg-amber-100 px-1 text-xs text-amber-800">予測</span>}
      {changed && (
        <button disabled={busy} onClick={() => void save()} className="rounded bg-berry px-2 py-0.5 text-xs font-bold text-white disabled:opacity-40">
          保存
        </button>
      )}
      <button
        onClick={() => speak(`${v.trim() || t.name}さん、おはようございます`)}
        title="タブレットでの読み上げを聞く"
        aria-label={`${t.name}さんの読み上げを聞く`}
        className="rounded border px-1.5 py-0.5 text-xs"
      >
        🔊
      </button>
    </span>
  );
}

const timeOf = (ms: number) => {
  const d = new Date(ms + 9 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

export function TimeclockBox({ employees }: { employees: Emp[] }) {
  const tags = useTimeclockTags();
  const unknown = useTimeclockUnknown();
  const login = useTimeclockLogin();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [loginId, setLoginId] = useState("dakoku");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await f();
      setMsg(done);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const active = employees.filter((e) => e.active !== false);
  const tagged = new Set(Object.values(tags ?? {}).map((t) => t.employeeId));
  const noTag = active.filter((e) => !tagged.has(e.id));
  const unknownList = Object.entries(unknown ?? {}).sort((a, b) => b[1] - a[1]);
  const tagList = Object.entries(tags ?? {}).sort((a, b) => a[1].name.localeCompare(b[1].name, "ja"));
  // 読み方がまだない人がいれば、AIで予測して入れる（この画面を開いたときに1回だけ）
  const guessed = useRef(false);
  const missing = tagList.filter(([, t]) => !t.yomi).length;
  useEffect(() => {
    if (guessed.current || missing === 0) return;
    guessed.current = true;
    guessTimeclockYomi()
      .then((r) => r.count > 0 && setMsg(`${r.count}人の読み方を予測して入れました（「予測」の印）。違っていたら直して「保存」を押してください`))
      .catch((e) => setErr(errorText(e)));
  }, [missing]);

  return (
    <details className="mt-4 rounded-xl border bg-white p-4">
      <summary className="cursor-pointer font-bold">
        📶 打刻タブレット（NFCタグ）
        <span className="ml-2 text-sm font-normal text-gray-600">
          登録したタグ {tagList.length}枚{unknownList.length > 0 && <span className="ml-2 font-bold text-red-700">未登録のタグ {unknownList.length}枚</span>}
        </span>
      </summary>
      <p className="mt-2 text-sm text-gray-600">
        入口のAndroidタブレットのChromeでこのアプリを開き、下の「タブレットのログイン」でログインすると、打刻の画面になります。
        タブレットでかざした打刻は、この画面のタイムカードにそのまま入ります（同じ日にMAXの取り込みがあっても、タブレットの打刻を使います）。
      </p>
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}

      <h3 className="mt-4 font-bold">① タブレットのログイン</h3>
      {login === undefined ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : (
        <div className="mt-1 flex flex-wrap items-end gap-2 text-sm">
          {login.loginId ? (
            <span>
              ログインID：<b>{login.loginId}</b>（{login.active ? "使える" : <span className="text-red-700">止めている</span>}）
            </span>
          ) : (
            <label>
              ログインID
              <input value={loginId} onChange={(e) => setLoginId(e.target.value)} className="ml-1 w-32 rounded border px-2 py-1" />
            </label>
          )}
          <label>
            {login.loginId ? "新しいパスワード" : "パスワード"}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8文字以上"
              className="ml-1 w-40 rounded border px-2 py-1"
            />
          </label>
          <button
            disabled={busy || password.length < 8}
            onClick={() =>
              run(
                () => saveTimeclockLogin(password, login.loginId ? undefined : loginId).then(() => setPassword("")),
                login.loginId ? "パスワードを変えました。タブレットでログインし直してください" : "タブレットのログインを作りました",
              )
            }
            className="rounded-lg bg-berry px-3 py-1.5 font-bold text-white disabled:opacity-40"
          >
            {login.loginId ? (login.active ? "パスワードを変える" : "パスワードを変えて使えるようにする") : "ログインを作る"}
          </button>
          {login.loginId && login.active && (
            <button
              disabled={busy}
              onClick={() => confirm("打刻タブレットを止めますか？（タブレットで打刻できなくなります）") && run(stopTimeclockLogin, "タブレットを止めました")}
              className="rounded-lg border px-3 py-1.5"
            >
              止める
            </button>
          )}
        </div>
      )}

      <h3 className="mt-4 font-bold">② 未登録のタグ</h3>
      <p className="text-sm text-gray-600">
        新しいタグをタブレットにかざすと、ここに出ます。従業員を選んで「登録」を押してください（1枚ずつ、かざしてから登録すると間違えません）。まちがえてかざしたタグは「消す」で一覧から消せます。
      </p>
      {unknownList.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">ありません。</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {unknownList.map(([serial, at]) => (
            <li key={serial} className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2 py-1 text-sm">
              <span className="font-mono">{shortSerial(serial)}</span>
              <span className="text-gray-500">{timeOf(at)} にかざした</span>
              <select value={pick[serial] ?? ""} onChange={(e) => setPick({ ...pick, [serial]: e.target.value })} className="rounded border px-2 py-1">
                <option value="">（従業員を選ぶ）</option>
                {noTag.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} {e.name}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !pick[serial]}
                onClick={() => run(() => setTimeclockTag(serial, pick[serial]), "タグを登録しました")}
                className="rounded-lg bg-berry px-3 py-1 font-bold text-white disabled:opacity-40"
              >
                登録
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  confirm(`${shortSerial(serial)} のタグを一覧から消しますか？（登録はしません。もう一度かざすと、また出ます）`) &&
                  run(() => forgetUnknownTag(serial), "未登録のタグを消しました")
                }
                className="rounded-lg border px-3 py-1 text-gray-600 disabled:opacity-40"
              >
                消す
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 font-bold">③ 登録したタグ</h3>
      <p className="text-sm text-gray-600">
        タブレットでかざすと「〇〇さん、おはようございます」と読み上げます。読み方はAIの予測で入るので、違っていたら直して「保存」を押してください（🔊で聞けます）。
      </p>
      {tags === undefined ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : tagList.length === 0 ? (
        <p className="text-sm text-gray-500">まだありません。</p>
      ) : (
        <table className="mt-1 text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="px-2 py-1">氏名</th>
              <th className="px-2 py-1">読み方（あいさつの声）</th>
              <th className="px-2 py-1">カード</th>
              <th className="px-2 py-1">タグ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tagList.map(([serial, t]) => (
              <tr key={serial} className="border-t">
                <td className="px-2 py-1">{t.name}</td>
                <td className="px-2 py-1">
                  <YomiCell serial={serial} t={t} busy={busy} run={run} />
                </td>
                <td className="px-2 py-1">{t.card}</td>
                <td className="px-2 py-1 font-mono">{shortSerial(serial)}</td>
                <td className="px-2 py-1">
                  <button
                    disabled={busy}
                    onClick={() =>
                      confirm(`${t.name}さんのタグを外しますか？（なくしたときなど。外したタグでは打刻できなくなります）`) &&
                      run(() => setTimeclockTag(serial, null), "タグを外しました")
                    }
                    className="rounded border px-2 py-0.5 text-xs"
                  >
                    外す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tags !== undefined && noTag.length > 0 && <p className="mt-2 text-xs text-gray-500">タグがまだない人：{noTag.map((e) => e.name).join("・")}</p>}
    </details>
  );
}
