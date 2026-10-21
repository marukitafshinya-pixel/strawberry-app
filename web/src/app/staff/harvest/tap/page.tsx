"use client";

// 収穫報告（収穫する人の携帯の画面）：今のハウスの番号と「入った」「終わった」だけを出す。
// 回るハウスと順番は、今日の作業配置表（名前と矢印）から読む。「終わった」を押すと、次のハウスを知らせる。
// 自分の予定が全部終わった人には、応援に行くハウス（まだ誰も入っていないハウスのうち、いちばん遅く終わりそうなハウス）を知らせる
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { todayJST } from "@/lib/date";
import { useHaichiDay, useHaichiTemplate } from "@/lib/haichi";
import { useHouseUse } from "@/lib/harvest";
import { useDayTaps } from "@/lib/harvestTap";
import { useShiftMembers } from "@/lib/shift";
import { back, TapScreen } from "./TapScreen";

export default function HarvestTapPage() {
  const { role, user } = useAuth();
  const date = todayJST();
  const template = useHaichiTemplate();
  const haichi = useHaichiDay(date);
  const use = useHouseUse(date);
  const members = useShiftMembers();
  const taps = useDayTaps(date);

  if (role !== "worker")
    return (
      <div className="space-y-3 p-4">
        <p>この画面は、従業員のログインで使います。</p>
        {/* 管理者・スタッフも、音声案内と練習モードは試せる（記録は変えない） */}
        <Link href="/staff/harvest/tap/practice/" className="inline-block rounded-xl border bg-white px-4 py-2">
          🎓 練習モード（音声案内も試せます）
        </Link>
      </div>
    );
  if (!template || haichi === null || !use || !members || !taps) return <p className="p-4 text-gray-500">読み込み中…</p>;
  const me = members.find((m) => m.uid === user?.uid);
  if (!me) return <p className="p-4 text-gray-500">従業員リストに名前が見つかりません。{back}</p>;
  return <TapScreen date={date} template={template} haichi={haichi} use={use.houses} members={members} taps={taps} me={me} />;
}
