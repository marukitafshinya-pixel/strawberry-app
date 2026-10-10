"use client";

// 中身を、その場所いっぱいに拡大して出す（投影用の画面）。枠や文字の大きさの設定はそのままで transform で拡大する
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 中身を、場所（幅と高さ）にぎりぎり収まるところまで拡大する。
 * stretchTable のとき、「全部を入れる」で下が余れば、表の行の高さを広げて縦いっぱいにする（文字はゆがめない）
 */
export function FitPane({ children, fitMode, stretchTable, deps }: { children: ReactNode; fitMode: "all" | "width"; stretchTable?: boolean; deps: unknown[] }) {
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
