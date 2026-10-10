"use client";

// 管理者の「携帯画面」タブ：従業員が自分の携帯で見る画面を、携帯くらいの大きさの枠の中で確かめる（中は上下に動かせる）。
// 確認用なので、希望を出す・取り消すはしない
import { useState } from "react";
import { useShiftRequests, type ShiftConfig, type ShiftMember } from "@/lib/shift";
import { sortMembers } from "./ShiftTable";
import { WorkerScreen } from "./WorkerScreen";

/** 携帯の画面の大きさ（iPhone くらい） */
const PHONE_W = 390;
const PHONE_H = 780;

export function PhonePreview({ cfg, members }: { cfg: ShiftConfig; members: ShiftMember[] }) {
  const active = sortMembers(
    members.filter((m) => m.active),
    cfg,
  );
  const [id, setId] = useState(active[0]?.id ?? "");
  const me = active.find((m) => m.id === id) ?? active[0];
  const requests = useShiftRequests(undefined, me?.id);
  if (!me) return <p className="mt-4 rounded-xl bg-white p-4 text-gray-600">まだ従業員が登録されていません。</p>;
  return (
    <div className="mt-3 flex flex-wrap items-start gap-6">
      <div className="max-w-xs space-y-2 text-sm">
        <label className="block">
          <span className="font-bold">だれの画面を見るか</span>
          <select value={me.id} onChange={(e) => setId(e.target.value)} className="mt-1 block w-full rounded-lg border bg-white px-2 py-2">
            {active.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.loginId ? "" : "（ログインなし）"}
              </option>
            ))}
          </select>
        </label>
        <p className="text-gray-600">従業員が自分の携帯で見る画面です。枠の中は上下・左右に動かせます。</p>
        <p className="text-gray-600">確認用なので、ここから希望を出したり取り消したりはできません。</p>
      </div>
      {/* 携帯の形の枠 */}
      <div className="shrink-0 rounded-[2.5rem] border-[10px] border-gray-800 bg-gray-800 shadow-xl" style={{ width: PHONE_W + 20 }}>
        <div className="overflow-hidden rounded-[1.8rem] bg-[#fdf6f4]" style={{ width: PHONE_W, height: `min(${PHONE_H}px, calc(100dvh - 12rem))` }}>
          <div className="h-full overflow-y-auto overscroll-contain">
            <div className="sticky top-0 z-30 flex items-center justify-between bg-berry px-3 py-2.5 text-sm text-white">
              <span className="font-bold">🍓 スタッフ</span>
              <span className="text-xs">{me.name}（従業員）</span>
            </div>
            <div className="px-4 py-5">
              <WorkerScreen preview cfg={cfg} members={members} me={me} requests={requests} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
