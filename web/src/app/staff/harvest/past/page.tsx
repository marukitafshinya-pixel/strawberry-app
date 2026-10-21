"use client";

// 去年の出荷実績（管理者）：日別実績のシートの「月」「日」「合計重量」の行を貼り付けて保存し、天気の影響（夜温・日照）を計算する。
// 植える時期や株休めは毎年ちがうので、去年の「この時期の量」は使わず、天気でどれだけ変わるかだけを今年の予測に使う
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { callFunction, errorText } from "@/lib/callFunction";
import { refreshHarvestSpeeds } from "@/lib/harvestForecast";
import { parsePastShipments, usePastYield } from "@/lib/pastShipments";
import { todayJST } from "@/lib/date";

const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

export default function PastShipmentsPage() {
  const { role } = useAuth();
  const past = usePastYield();
  const [year, setYear] = useState(() => Number(todayJST().slice(0, 4)) - 1);
  const [season, setSeason] = useState(() => `R${Number(todayJST().slice(0, 4)) - 1 - 2018}`);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const parsed = useMemo(() => (text.trim() ? parsePastShipments(text, year) : null), [text, year]);
  const dates = parsed ? Object.keys(parsed.days).sort() : [];
  const total = parsed ? Object.values(parsed.days).reduce((s, x) => s + x, 0) : 0;

  if (role !== "admin") return <p>この画面は管理者だけが使えます。</p>;

  async function run(withDays: boolean) {
    setBusy(true);
    setMsg("");
    try {
      const r = await callFunction<{ season: string; days?: Record<string, number> }, { missing: string[]; model: unknown }>("savePastShipments", {
        season,
        ...(withDays && parsed ? { days: parsed.days } : {}),
      });
      if (withDays) setText("");
      // 今日の見込み（stats/harvestYield）にもすぐ入れる
      await refreshHarvestSpeeds();
      setMsg(
        r.missing.length
          ? `保存しました。まだ天気のない月があります（${r.missing.join("・")}）。少しおいて「計算し直す」を押してください`
          : r.model
            ? "保存して、天気の影響を計算しました"
            : "保存しました。ただ、天気のそろった出荷が少なく、天気の影響は出せませんでした",
      );
    } catch (e) {
      setMsg(`できませんでした：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const m = past?.model;
  return (
    <div className="max-w-2xl space-y-4 pb-24">
      <p className="text-sm">
        <Link href="/staff/harvest/report/" className="text-gray-500 underline">
          ← 収穫の振り返り
        </Link>
      </p>
      <h1 className="text-xl font-bold">去年の出荷実績と天気の影響</h1>
      <p className="text-sm text-gray-600">
        去年の出荷の量が、前後1週間のふだんの量より多いか少ないかを、その日の夜温（最低気温）と前の日の日照時間でくらべます。植える時期や株休めは毎年ちがうので、去年の「この時期の量」は使わず、天気でどれだけ変わるかだけを今年の収穫ケース数の予測に使います。今年の記録がたまるほど、今年の分が強くなります。
      </p>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="font-bold">いま使っている天気の影響</h2>
        {past === undefined ? (
          <p className="mt-2 text-gray-500">読み込み中…</p>
        ) : !past ? (
          <p className="mt-2 text-gray-500">まだ実績が入っていません。</p>
        ) : (
          <div className="mt-2 space-y-1 text-sm">
            <p>
              {past.season}：{past.from} 〜 {past.to}（出荷 {past.shipments}回・合計 {past.total.toLocaleString("ja-JP")}kg）
            </p>
            {m ? (
              <>
                <p className="text-lg font-bold text-sky-800">夜温が1℃高いと {pct(m.b)}</p>
                <p className="text-lg font-bold text-sky-800">前の日の日照が1時間多いと {pct(m.c)}</p>
                <p className="text-xs text-gray-500">天気のそろった出荷 {m.n}回分から計算しました。</p>
              </>
            ) : (
              <p className="text-gray-600">天気のそろった出荷が少なく、まだ天気の影響は出せていません。</p>
            )}
            {past.missing?.length > 0 && <p className="text-amber-700">まだ天気のない月：{past.missing.join("・")}（「計算し直す」で取り込みます）</p>}
            <button disabled={busy} onClick={() => run(false)} className="mt-2 rounded-lg border bg-white px-3 py-2 disabled:opacity-50">
              計算し直す
            </button>
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="font-bold">実績を貼り付ける</h2>
        <p className="mt-1 text-sm text-gray-600">
          エクセルの日別実績のシートで、「月」の行から「合計重量（kg）」の行までを、左はしから右はしまで選んでコピーし、下に貼り付けてください（間の行もいっしょで大丈夫です）。「日付」「kg」の2列（縦）でも読めます。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <label>
            年（最初の月）
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="ml-1 w-24 rounded border px-2 py-1" />
          </label>
          <label>
            名前
            <input
              value={season}
              onChange={(e) => setSeason(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 10))}
              className="ml-1 w-20 rounded border px-2 py-1"
            />
          </label>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="ここに貼り付け"
          className="mt-2 w-full rounded border p-2 font-mono text-xs"
        />
        {parsed && (
          <p className="mt-1 text-sm">
            {dates.length ? (
              <>
                読めた日：{dates.length}日（{dates[0]} 〜 {dates[dates.length - 1]}）・合計 <b>{Math.round(total).toLocaleString("ja-JP")}kg</b>
                <span className="ml-1 text-gray-500">← エクセルの合計と同じか確かめてください</span>
              </>
            ) : (
              <span className="text-red-600">日付と重量が読めませんでした。</span>
            )}
            {parsed.skipped > 0 && <span className="ml-2 text-amber-700">読めなかった行・列：{parsed.skipped}</span>}
          </p>
        )}
        <button
          disabled={busy || !dates.length || !season}
          onClick={() => run(true)}
          className="mt-2 rounded-lg bg-berry px-4 py-2 font-bold text-white disabled:opacity-40"
        >
          {busy ? "計算中…" : `${season}として保存して計算する`}
        </button>
        <p className="mt-1 text-xs text-gray-500">同じ名前で保存すると、前の分と入れかわります。実績は管理者だけが見られます。</p>
      </section>
      {msg && <p className="rounded-xl bg-sky-50 p-3 text-sm text-sky-900">{msg}</p>}
    </div>
  );
}
