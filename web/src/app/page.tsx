import Link from "next/link";

// お客様用の予約ページ（第1段階の手順5で作ります）
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
      <h1 className="text-2xl font-bold text-berry">🍓 いちご狩り ご予約</h1>
      <p className="mt-4 text-gray-700">ご予約ページは準備中です。</p>
      <p className="mt-10 text-sm">
        <Link href="/staff/" className="text-gray-500 underline">
          スタッフの方はこちら
        </Link>
      </p>
    </main>
  );
}
