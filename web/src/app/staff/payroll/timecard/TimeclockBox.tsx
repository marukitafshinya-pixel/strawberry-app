"use client";

// 打刻タブレットの設定（管理者）：タブレットのログインと、NFCタグ → 従業員の登録。
// 未登録のタグは、タブレットにかざすと「未登録のタグ」に出るので、ここで従業員を選んで登録する
import { useState } from "react";
import { errorText } from "@/lib/callFunction";
import {
  saveTimeclockLogin,
  setTimeclockTag,
  shortSerial,
  stopTimeclockLogin,
  useTimeclockLogin,
  useTimeclockTags,
  useTimeclockUnknown,
} from "@/lib/timeclock";

type Emp = { id: string; code: string; name: string; active?: boolean };

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
        新しいタグをタブレットにかざすと、ここに出ます。従業員を選んで「登録」を押してください（1枚ずつ、かざしてから登録すると間違えません）。
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
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 font-bold">③ 登録したタグ</h3>
      {tags === undefined ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : tagList.length === 0 ? (
        <p className="text-sm text-gray-500">まだありません。</p>
      ) : (
        <table className="mt-1 text-sm">
          <thead className="text-left text-xs text-gray-500">
            <tr>
              <th className="px-2 py-1">氏名</th>
              <th className="px-2 py-1">カード</th>
              <th className="px-2 py-1">タグ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tagList.map(([serial, t]) => (
              <tr key={serial} className="border-t">
                <td className="px-2 py-1">{t.name}</td>
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
