"use client";

// 勤務管理表の投影用の画面（プロジェクターでホワイトボードに映す）。
// 勤務管理表の「投影用の画面」ボタンから、タブやブックマークのない別の小さなウィンドウで開く。
// 表の枠はそのままで、画面いっぱいに拡大して出す。見るだけ（入力は元の勤務管理表で）。
// 「全画面」はこのウィンドウだけを全画面にする（Esc で戻る）。ブラウザの設定は変えない。
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { addDays, isValidYmd, todayJST } from "@/lib/date";
import { useReservedPeople, useShiftConfig, useShiftDays, useShiftMembers } from "@/lib/shift";
import { ShiftTable } from "../ShiftTable";

const DAY_CHOICES = [7, 14, 21, 28] as const;
const DAYS_KEY = "ichigo.shiftDisplayDays";
const FIT_KEY = "ichigo.shiftDisplayFit";

export default function ShiftDisplayPage() {
  return (
    <Suspense fallback={<p className="p-6 text-gray-500">読み込み中…</p>}>
      <Display />
    </Suspense>
  );
}

function Display() {
  const params = useSearchParams();
  const q = params.get("from");
  const [from, setFrom] = useState(isValidYmd(q) ? q : todayJST());
  const [span, setSpan] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(DAYS_KEY));
      return (DAY_CHOICES as readonly number[]).includes(v) ? v : 14;
    } catch {
      return 14;
    }
  });
  /** all＝表全体が画面に入る大きさ、width＝横幅いっぱい（下は上下に動かして見る） */
  const [mode, setMode] = useState<"all" | "width">(() => {
    try {
      return localStorage.getItem(FIT_KEY) === "width" ? "width" : "all";
    } catch {
      return "all";
    }
  });
  const to = addDays(from, span - 1);
  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const days = useShiftDays(from, to);
  const reserved = useReservedPeople(from, to);
  const active = (members ?? []).filter((m) => m.active);

  // 表を、画面（ウィンドウ）の幅と高さにぎりぎり収まるところまで拡大する
  const stage = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ zoom: 1, w: 0, h: 0 });
  const [full, setFull] = useState(false);
  const ready = !!(cfg && members && days);
  useLayoutEffect(() => {
    if (!ready) return;
    const fit = () => {
      const s = stage.current;
      const t = inner.current;
      if (!s || !t) return;
      const w = t.offsetWidth;
      const h = t.offsetHeight;
      if (!w || !h) return;
      const byW = (s.clientWidth - (mode === "width" ? 16 : 0)) / w;
      setFit({ zoom: Math.max(0.3, mode === "width" ? byW : Math.min(byW, s.clientHeight / h)), w, h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (stage.current) ro.observe(stage.current);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, [ready, span, from, mode]);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  function changeSpan(n: number) {
    setSpan(n);
    try {
      localStorage.setItem(DAYS_KEY, String(n));
    } catch {
      // 覚えられなくても表示は変える
    }
  }
  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  const btn = "rounded-lg border bg-white px-3 py-1.5 text-sm";
  return (
    <div className="flex h-dvh flex-col bg-white">
      {/* 操作の帯。全画面のときは、マウスを上に持っていったときだけ見える */}
      <div className={`flex flex-wrap items-center gap-2 border-b bg-gray-50 px-3 py-2 transition-opacity ${full ? "absolute inset-x-0 top-0 z-20 opacity-0 hover:opacity-100" : ""}`}>
        <span className="font-bold">勤務管理表（投影用）</span>
        <button onClick={() => setFrom(addDays(from, -7))} className={btn}>
          ‹ 1週前
        </button>
        <button onClick={() => setFrom(todayJST())} className={btn}>
          今日から
        </button>
        <button onClick={() => setFrom(addDays(from, 7))} className={btn}>
          1週後 ›
        </button>
        <span className="ml-2 text-sm text-gray-600">日数</span>
        <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">
          {DAY_CHOICES.map((n) => (
            <button key={n} onClick={() => changeSpan(n)} className={`px-3 py-1.5 ${span === n ? "bg-emerald-700 font-bold text-white" : ""}`}>
              {n}日
            </button>
          ))}
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">
          {(
            [
              ["all", "全部を画面に"],
              ["width", "横幅いっぱい"],
            ] as const
          ).map(([m, l]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                try {
                  localStorage.setItem(FIT_KEY, m);
                } catch {
                  // 覚えられなくても表示は変える
                }
              }}
              className={`px-3 py-1.5 ${mode === m ? "bg-slate-700 font-bold text-white" : ""}`}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">日数を少なくするか「横幅いっぱい」にすると、文字が大きくなります</span>
        <div className="ml-auto flex gap-2">
          <button onClick={toggleFull} className="rounded-lg bg-berry px-4 py-1.5 text-sm font-bold text-white">
            {full ? "全画面をやめる（Esc）" : "全画面にする"}
          </button>
          <button onClick={() => window.close()} className={btn}>
            閉じる
          </button>
        </div>
      </div>
      <div ref={stage} className={`relative min-h-0 flex-1 ${mode === "width" ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"}`}>
        {!ready ? (
          <p className="p-6 text-gray-500">読み込み中…</p>
        ) : active.length === 0 ? (
          <p className="p-6 text-gray-600">まだ従業員が登録されていません。</p>
        ) : (
          <div className="flex h-full w-full items-start justify-center">
            {/* 拡大は transform で（表そのものの大きさ＝枠は変えない） */}
            <div style={{ width: fit.w * fit.zoom, height: fit.h * fit.zoom }}>
              <div ref={inner} className="w-max origin-top-left" style={{ transform: `scale(${fit.zoom})` }}>
                <ShiftTable fixed from={from} span={span} cfg={cfg!} members={active} days={days!} reserved={reserved} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
