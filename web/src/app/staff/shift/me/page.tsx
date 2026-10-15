"use client";

// 従業員の画面：自分の勤務・休みの希望・全員の勤務表（見るだけ）
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { todayJST } from "@/lib/date";
import { useHaichiDay } from "@/lib/haichi";
import { useShiftConfig, useShiftMembers, useShiftRequests } from "@/lib/shift";
import { WorkerScreen } from "../WorkerScreen";

export default function MyShiftPage() {
  const { user, role } = useAuth();
  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const me = members?.find((m) => m.uid === user?.uid);
  const requests = useShiftRequests(user?.uid);
  const haichi = useHaichiDay(todayJST());

  if (!cfg || !members) return <p className="text-gray-500">読み込み中…</p>;
  if (!me)
    return (
      <p className="rounded-xl bg-white p-4 text-gray-700">
        {role === "worker" ? "勤務の表に、あなたの名前がつながっていません。管理者に確認してください。" : "この画面は、従業員のログインで使います。"}
      </p>
    );
  // 今日の作業配置表で「集荷係」に入っているか、「収穫管理を毎日使える」の人なら、収穫管理（＋1で数える画面）を開けるボタンを出す
  const pickup = haichi?.cells.pickup?.members.includes(me.id) || me.harvestEntry === true;
  return (
    <>
      {pickup && (
        <Link href="/staff/harvest/" className="mb-4 block rounded-2xl bg-berry p-4 text-center text-xl font-bold text-white shadow">
          🍓 収穫管理（今日の集荷）を開く
        </Link>
      )}
      <WorkerScreen cfg={cfg} members={members} me={me} requests={requests} />
    </>
  );
}
