"use client";

// いちごの収穫色目カラーチャート（赤色の割合）。作業配置表・投影用の画面のボタンから、画面の上に大きく重ねて出す
export function ColorChartOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b bg-rose-50 px-3 py-1.5">
          <span className="font-bold text-rose-900">🍓 いちご 収穫色目カラーチャート</span>
          <button onClick={onClose} className="rounded-lg border bg-white px-4 py-1.5 font-bold">
            ✕ 閉じる
          </button>
        </div>
        {/* 画面の横幅いっぱいに（縦が足りなければ縦に合わせて）大きく出す */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/color-chart.webp" alt="いちご 収穫色目カラーチャート（赤色の割合：3割赤〜10割赤。未熟・収穫適期・収穫遅れ）" className="min-h-0 w-full flex-1 object-contain" />
      </div>
    </div>
  );
}
