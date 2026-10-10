"use client";

// 天気予報だけの投影用の画面（投影用の画面の「🌤 天気予報」ボタンから、別の小さなウィンドウで開く）。
// 今日と明日の天気を、ウィンドウいっぱいに拡大して出す。見るだけ。
import { useEffect, useState } from "react";
import { FitPane } from "../../FitPane";
import { ForecastStrip } from "../../ForecastStrip";

export default function WeatherDisplayPage() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    document.title = "天気予報";
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  return (
    <main className="flex h-dvh flex-col bg-white">
      {!full && (
        <div className="flex items-center justify-end gap-2 border-b bg-gray-100 px-2 py-1">
          <button onClick={() => void document.documentElement.requestFullscreen?.()} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            ⛶ 全画面
          </button>
          <button onClick={() => window.close()} className="rounded-lg border bg-white px-3 py-1.5 text-sm">
            閉じる
          </button>
        </div>
      )}
      <FitPane fitMode="all" deps={[full]}>
        <div className="w-[1200px] p-3">
          <ForecastStrip big />
        </div>
      </FitPane>
    </main>
  );
}
