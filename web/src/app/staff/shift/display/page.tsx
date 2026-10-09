"use client";

// 勤務管理表の投影用の画面（プロジェクターでホワイトボードに映す）。
// 勤務管理表の「投影用の画面」ボタンから、タブやブックマークのない別の小さなウィンドウで開く。
// ふだんは左半分に作業配置表、右半分に勤務表を並べる。どちらか一方だけを全画面にもできる。
// 表の枠はそのままで、それぞれの場所いっぱいに拡大して出す。見るだけ（入力は元の勤務管理表で）。
// 「全画面」はこのウィンドウだけを全画面にする（Esc で戻る）。ブラウザの設定は変えない。
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { addDays, formatJa, isValidYmd, todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import { useReservedPeople, useShiftConfig, useShiftDays, useShiftMembers } from "@/lib/shift";
import { HaichiBoard } from "../Haichi";
import { ShiftTable } from "../ShiftTable";

const DAY_CHOICES = [7, 14, 21, 28] as const;
const DAYS_KEY = "ichigo.shiftDisplayDays";
const FIT_KEY = "ichigo.shiftDisplayFit";
const LAYOUT_KEY = "ichigo.shiftDisplayLayout";

type Layout = "split" | "haichi" | "table";

export default function ShiftDisplayPage() {
  return (
    <Suspense fallback={<p className="p-6 text-gray-500">読み込み中…</p>}>
      <Display />
    </Suspense>
  );
}

const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, v: string) => {
  try {
    localStorage.setItem(key, v);
  } catch {
    // 覚えられなくても表示は変える
  }
};

function Display() {
  const params = useSearchParams();
  const q = params.get("from");
  // 勤務表の先頭の日と、作業配置表の日（別々に動かせる）
  const [from, setFrom] = useState(isValidYmd(q) ? q : todayJST());
  const [hDate, setHDate] = useState(isValidYmd(q) && params.get("view") === "haichi" ? q : todayJST());
  const [span, setSpan] = useState<number>(() => {
    const v = Number(load(DAYS_KEY));
    return (DAY_CHOICES as readonly number[]).includes(v) ? v : 14;
  });
  /** all＝表全体が入る大きさ、width＝横幅いっぱい（下は上下に動かして見る） */
  const [mode, setMode] = useState<"all" | "width">(() => (load(FIT_KEY) === "width" ? "width" : "all"));
  /** split＝左に作業配置表・右に勤務表。haichi / table＝その一方だけ */
  const [layout, setLayoutState] = useState<Layout>(() => {
    const v = load(LAYOUT_KEY);
    return v === "haichi" || v === "table" ? v : "split";
  });
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    store(LAYOUT_KEY, l);
  };
  const haichiTemplate = useHaichiTemplate();
  const haichiDay = useHaichiDay(hDate);
  const to = addDays(from, span - 1);
  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const days = useShiftDays(from, to);
  const reserved = useReservedPeople(from, to);
  const active = (members ?? []).filter((m) => m.active);
  const names = Object.fromEntries((members ?? []).map((m) => [m.id, m.name]));

  const [full, setFull] = useState(false);
  /** 左半分・右半分にしたとき：全画面と同じように、操作の帯を隠して表を画面いっぱいにする */
  const [halfSide, setHalfSide] = useState<"left" | "right" | null>(null);
  const hideBar = full || halfSide !== null;
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }
  /** 一方だけにして全画面にする */
  function onlyFull(l: "haichi" | "table") {
    setLayout(l);
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
  }
  /**
   * このウィンドウを、いま映っている画面（プロジェクター）の左半分・右半分の大きさにする。
   * 高さは画面いっぱい。ブラウザの設定は変えない（このウィンドウの大きさと位置だけ）
   */
  async function half(side: "left" | "right") {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const sc = window.screen as Screen & { availLeft?: number; availTop?: number };
    const left = sc.availLeft ?? 0;
    const top = sc.availTop ?? 0;
    const w = Math.floor(sc.availWidth / 2);
    // 全画面をやめた直後は大きさを変えられないことがあるので、少し待ってから
    setHalfSide(side);
    setTimeout(() => {
      window.resizeTo(w, sc.availHeight);
      window.moveTo(side === "left" ? left : left + w, top);
      setTimeout(() => {
        if (Math.abs(window.outerWidth - w) > 40) {
          setHalfSide(null);
          window.alert("ウィンドウの大きさを変えられませんでした。勤務管理表の「📽 投影用の画面」ボタンから開いたウィンドウで使ってください。");
        }
      }, 400);
    }, 150);
  }

  const ready = !!(cfg && members && days);
  const showH = layout !== "table";
  const showT = layout !== "haichi";
  const btn = "rounded-lg border bg-white px-3 py-1.5 text-sm";
  const seg = (on: boolean) => `px-3 py-1.5 ${on ? "bg-slate-700 font-bold text-white" : ""}`;

  const haichiPane = (
    <FitPane fitMode="all" deps={[hDate, haichiDay, haichiTemplate, layout]}>
      {haichiTemplate && haichiDay ? (
        // 半分のときは2段（縦長の場所に合わせる）、全画面のときは3段
        <div className={`p-3 ${layout === "split" ? "w-[1000px]" : "w-[1500px]"}`}>
          <h2 className="mb-2 text-4xl font-bold">作業配置表　{formatJa(hDate)}</h2>
          <HaichiBoard big cols={layout === "split" ? 2 : 3} template={haichiTemplate} day={haichiDay} names={names} />
        </div>
      ) : (
        <p className="p-6 text-gray-500">読み込み中…</p>
      )}
    </FitPane>
  );
  const tablePane = (
    <FitPane fitMode={mode} stretchTable deps={[span, from, mode, days, layout]}>
      <ShiftTable fixed bare from={from} span={span} cfg={cfg!} members={active} days={days!} reserved={reserved} />
    </FitPane>
  );

  return (
    <div className="flex h-dvh flex-col bg-white">
      {/* 操作の帯。全画面・半分のときは隠して、マウスを上に持っていったときだけ見える */}
      <div className={`flex flex-wrap items-center gap-2 border-b bg-gray-50 px-3 py-2 transition-opacity ${hideBar ? "absolute inset-x-0 top-0 z-30 opacity-0 shadow-md hover:opacity-100" : ""}`}>
        <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm font-bold">
          {(
            [
              ["split", "◫ 2画面"],
              ["haichi", "作業配置表"],
              ["table", "勤務表"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => setLayout(v)} className={`px-3 py-1.5 ${layout === v ? "bg-berry text-white" : ""}`}>
              {l}
            </button>
          ))}
        </div>
        {showH && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-white px-1 text-sm">
            <span className="px-1 text-xs text-gray-500">配置表</span>
            <button onClick={() => setHDate(addDays(hDate, -1))} className={btn}>
              ‹ 前の日
            </button>
            <button onClick={() => setHDate(todayJST())} className={btn}>
              今日
            </button>
            <button onClick={() => setHDate(addDays(hDate, 1))} className={btn}>
              次の日 ›
            </button>
          </span>
        )}
        {showT && (
          <span className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-white px-1 text-sm">
            <span className="px-1 text-xs text-gray-500">勤務表</span>
            <button onClick={() => setFrom(addDays(from, -7))} className={btn}>
              ‹ 1週前
            </button>
            <button onClick={() => setFrom(todayJST())} className={btn}>
              今日から
            </button>
            <button onClick={() => setFrom(addDays(from, 7))} className={btn}>
              1週後 ›
            </button>
            <div className="inline-flex overflow-hidden rounded-lg border bg-white">
              {DAY_CHOICES.map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setSpan(n);
                    store(DAYS_KEY, String(n));
                  }}
                  className={`px-2.5 py-1.5 ${span === n ? "bg-emerald-700 font-bold text-white" : ""}`}
                >
                  {n}日
                </button>
              ))}
            </div>
            <div className="inline-flex overflow-hidden rounded-lg border bg-white">
              {(
                [
                  ["all", "全部を入れる"],
                  ["width", "横幅いっぱい"],
                ] as const
              ).map(([m, l]) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    store(FIT_KEY, m);
                  }}
                  className={seg(mode === m)}
                >
                  {l}
                </button>
              ))}
            </div>
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border bg-white text-sm">
            <button onClick={() => half("left")} title="ウィンドウを画面の左半分の大きさにする" className="px-3 py-1.5">
              ◧ 左半分
            </button>
            <button onClick={() => half("right")} title="ウィンドウを画面の右半分の大きさにする" className="border-l px-3 py-1.5">
              右半分 ◨
            </button>
          </div>
          {halfSide && !full && (
            <button onClick={() => setHalfSide(null)} title="この操作の帯を、いつも見えるように戻す" className={btn}>
              帯を表示
            </button>
          )}
          <button onClick={toggleFull} className="rounded-lg bg-berry px-4 py-1.5 text-sm font-bold text-white">
            {full ? "全画面をやめる（Esc）" : "全画面にする"}
          </button>
          <button onClick={() => window.close()} className={btn}>
            閉じる
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {!ready ? (
          <p className="p-6 text-gray-500">読み込み中…</p>
        ) : active.length === 0 ? (
          <p className="p-6 text-gray-600">まだ従業員が登録されていません。</p>
        ) : (
          <>
            {showH && (
              <PaneBox
                single={layout !== "split"}
                onFull={() => onlyFull("haichi")}
                onBack={() => setLayout("split")}
                label="作業配置表"
                className={showT ? "w-1/2 border-r-4 border-gray-700" : "w-full"}
              >
                {haichiPane}
              </PaneBox>
            )}
            {showT && (
              <PaneBox single={layout !== "split"} onFull={() => onlyFull("table")} onBack={() => setLayout("split")} label="勤務表" className={showH ? "w-1/2" : "w-full"}>
                {tablePane}
              </PaneBox>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 左右それぞれの場所。右下に「この表だけ全画面」「2画面に戻す」のボタン（ふだんは薄く、マウスを乗せると見える） */
function PaneBox({
  children,
  single,
  onFull,
  onBack,
  label,
  className,
}: {
  children: ReactNode;
  single: boolean;
  onFull: () => void;
  onBack: () => void;
  label: string;
  className: string;
}) {
  return (
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      <div className="absolute bottom-2 right-2 z-20 flex gap-1 opacity-20 transition-opacity hover:opacity-100">
        {single ? (
          <button onClick={onBack} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-bold shadow">
            ◫ 2画面に戻す
          </button>
        ) : (
          <button onClick={onFull} title={`${label}だけを全画面にする`} className="rounded-lg border bg-white px-3 py-1.5 text-sm font-bold shadow">
            ⛶ {label}を全画面
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * 中身を、場所（幅と高さ）にぎりぎり収まるところまで拡大する。
 * stretchTable のとき、「全部を入れる」で下が余れば、表の行の高さを広げて縦いっぱいにする（文字はゆがめない）
 */
function FitPane({ children, fitMode, stretchTable, deps }: { children: ReactNode; fitMode: "all" | "width"; stretchTable?: boolean; deps: unknown[] }) {
  const stage = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ zoom: 1, w: 0, h: 0 });
  useLayoutEffect(() => {
    const run = () => {
      const s = stage.current;
      const t = inner.current;
      if (!s || !t) return;
      // 縦に伸ばした分をいったん外して、表そのものの大きさを測る
      const table = stretchTable ? t.querySelector("table") : null;
      if (table) table.style.height = "";
      const w = t.offsetWidth;
      const h = t.offsetHeight;
      if (!w || !h) return;
      const byW = (s.clientWidth - (fitMode === "width" ? 16 : 0)) / w;
      const zoom = Math.max(0.2, fitMode === "width" ? byW : Math.min(byW, s.clientHeight / h));
      let hh = h;
      if (fitMode === "all" && table && h * zoom < s.clientHeight - 1) {
        hh = s.clientHeight / zoom;
        table.style.height = `${hh - (h - table.offsetHeight)}px`;
      }
      setFit({ zoom, w, h: hh });
    };
    run();
    const ro = new ResizeObserver(run);
    if (stage.current) ro.observe(stage.current);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitMode, stretchTable, ...deps]);
  return (
    <div ref={stage} className={`relative min-h-0 flex-1 ${fitMode === "width" ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"}`}>
      <div className="flex h-full w-full items-start justify-center">
        {/* 拡大は transform で（表そのものの大きさ＝枠は変えない） */}
        <div style={{ width: fit.w * fit.zoom, height: fit.h * fit.zoom }}>
          <div ref={inner} className="w-max origin-top-left" style={{ transform: `scale(${fit.zoom})` }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
