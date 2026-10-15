"use client";

// 従業員の画面：自分の勤務・休みの希望・全員の勤務表（見るだけ）
import { useAuth } from "@/lib/auth";
import { useShiftConfig, useShiftMembers, useShiftRequests } from "@/lib/shift";
import { WorkerScreen } from "../WorkerScreen";

export default function MyShiftPage() {
  const { user, role } = useAuth();
  const cfg = useShiftConfig();
  const members = useShiftMembers();
  const me = members?.find((m) => m.uid === user?.uid);
  const requests = useShiftRequests(user?.uid);

  if (!cfg || !members) return <p className="text-gray-500">読み込み中…</p>;
  if (!me)
    return (
      <p className="rounded-xl bg-white p-4 text-gray-700">
        {role === "worker" ? "勤務の表に、あなたの名前がつながっていません。管理者に確認してください。" : "この画面は、従業員のログインで使います。"}
      </p>
    );
  return <WorkerScreen cfg={cfg} members={members} me={me} requests={requests} />;
}
