"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DEFAULT_PRINTER, alignReceipt, loadPrinter, printReceipt, savePrinter, testReceipt, type PrinterConfig } from "@/lib/receiptPrinter";
import { useSettings } from "@/lib/reservations";

export default function RegisterSettingsPage() {
  const { value: settings } = useSettings();
  const [c, setC] = useState<PrinterConfig>(DEFAULT_PRINTER);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");

  // この端末に保存した設定を読む（画面を出したあとに1回だけ）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setC(loadPrinter());
    setLoaded(true);
    if (new URLSearchParams(window.location.search).get("printError")) setMessage("印刷できませんでした。下の「うまく印刷できないとき」を確かめてください。");
  }, []);

  const set = (patch: Partial<PrinterConfig>) => {
    const next = { ...c, ...patch };
    setC(next);
    savePrinter(next);
    setMessage("保存しました（この端末だけの設定です）");
  };

  if (!loaded) return <p className="text-gray-500">読み込み中…</p>;
  const radio = (on: boolean) => `flex items-start gap-3 rounded-xl border p-3 ${on ? "border-emerald-700 bg-emerald-50" : "bg-white"}`;

  return (
    <div className="max-w-2xl">
      <p className="text-sm">
        <Link href="/staff/checkout/" className="text-gray-500 underline">
          ← 注文入力
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-bold">レジの設定</h1>
      <p className="mt-1 text-sm text-gray-600">ここでの設定は、この端末（iPadなど）だけに保存されます。レジに使う端末ごとに設定してください。</p>
      {message && <p className="mt-3 rounded-lg bg-gray-50 p-2 text-sm">{message}</p>}

      <section className="mt-4 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">レシートの印刷方法</h2>
        <label className={radio(c.method === "sii")}>
          <input type="radio" name="method" checked={c.method === "sii"} onChange={() => set({ method: "sii" })} className="mt-1" />
          <span>
            <span className="font-semibold">レシートプリンター（SII RP-F10 など）</span>
            <span className="block text-sm text-gray-600">無料アプリ「SII URL Print Agent」を使って、Bluetoothのレシートプリンターで印刷します。</span>
          </span>
        </label>
        <label className={radio(c.method === "browser")}>
          <input type="radio" name="method" checked={c.method === "browser"} onChange={() => set({ method: "browser" })} className="mt-1" />
          <span>
            <span className="font-semibold">ふつうの印刷（AirPrint など）</span>
            <span className="block text-sm text-gray-600">印刷の画面が出て、プリンターを選んで印刷します。</span>
          </span>
        </label>
      </section>

      <section className="mt-4 space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="font-bold">レシートの設定</h2>
        <div className="flex items-center gap-3 text-sm">
          <span className="w-24">紙の幅</span>
          {([80, 58] as const).map((p) => (
            <button key={p} onClick={() => set({ paper: p })} className={`rounded-lg border px-4 py-2 ${c.paper === p ? "border-gray-800 bg-gray-800 text-white" : ""}`}>
              {p}mm
            </button>
          ))}
          <span className="text-xs text-gray-500">RP-F10 はふつう 80mm です</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-24">左の余白</span>
          <button onClick={() => set({ offsetMm: Math.max(0, c.offsetMm - 1) })} className="h-10 w-10 rounded-lg border text-lg" aria-label="左の余白を減らす">
            −
          </button>
          <span className="w-14 text-center text-lg font-bold tabular-nums">{c.offsetMm}mm</span>
          <button onClick={() => set({ offsetMm: Math.min(20, c.offsetMm + 1) })} className="h-10 w-10 rounded-lg border text-lg" aria-label="左の余白を増やす">
            ＋
          </button>
          <span className="text-xs text-gray-500">左が切れるときは増やします</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="w-24">右の余白</span>
          <button onClick={() => set({ rightMm: Math.max(0, c.rightMm - 1) })} className="h-10 w-10 rounded-lg border text-lg" aria-label="右の余白を減らす">
            −
          </button>
          <span className="w-14 text-center text-lg font-bold tabular-nums">{c.rightMm}mm</span>
          <button onClick={() => set({ rightMm: Math.min(20, c.rightMm + 1) })} className="h-10 w-10 rounded-lg border text-lg" aria-label="右の余白を増やす">
            ＋
          </button>
          <span className="text-xs text-gray-500">右が切れるときは増やします</span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={c.autoPrint} onChange={(e) => set({ autoPrint: e.target.checked })} />
          会計を確定したら、すぐにレシートを印刷する
        </label>
        {c.method === "sii" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.keepConnect} onChange={(e) => set({ keepConnect: e.target.checked })} />
            Bluetooth のつながりを保つ（2枚目からの印刷が速くなります）
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => settings && printReceipt(testReceipt(settings, c), "/staff/checkout/settings/")}
            disabled={!settings}
            className="rounded-lg bg-emerald-700 px-5 py-3 font-bold text-white disabled:opacity-40"
          >
            テスト印刷
          </button>
          <button onClick={() => printReceipt(alignReceipt(), "/staff/checkout/settings/")} className="rounded-lg border px-5 py-3 font-semibold">
            位置合わせ用の印刷（ものさし）
          </button>
        </div>
        <p className="text-xs text-gray-500">
          位置合わせ用の印刷は、左の余白を0mmにして、紙の左はしから何mmかを印刷します。左のはしで切れずに読めるいちばん小さい数字を見て、それより少し大きい値を「左の余白」にしてください。
        </p>
      </section>

      {c.method === "sii" && (
        <section className="mt-4 space-y-2 rounded-2xl bg-white p-4 text-sm shadow-sm">
          <h2 className="font-bold">はじめに（1回だけ）</h2>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              iPad に無料アプリ「
              <a href="https://apps.apple.com/jp/app/sii-url-print-agent/id1502527506" className="text-sky-700 underline">
                SII URL Print Agent
              </a>
              」を入れます。
            </li>
            <li>プリンター（RP-F10）の電源を入れます。</li>
            <li>SII URL Print Agent を開き、プリンターの設定で RP-F10 を選んで Bluetooth でつなぎます（アプリの案内に従ってください）。</li>
            <li>この画面に戻って「テスト印刷」を押します。はじめての時は「このページで “SII URL Print Agent” を開きますか？」と出るので「開く」を押します。</li>
            <li>レシートが出て、この画面に戻ってくれば完了です。</li>
          </ol>
          <h3 className="pt-2 font-bold">うまく印刷できないとき</h3>
          <ul className="list-disc space-y-1 pl-5">
            <li>プリンターの電源（青いランプ）と、紙が入っているかを確かめる</li>
            <li>iPad の「設定」→「Bluetooth」がオンか、ほかの端末（Airレジなど）とつながったままになっていないか確かめる</li>
            <li>SII URL Print Agent を開いて、プリンターが選ばれているか確かめる</li>
          </ul>
        </section>
      )}
    </div>
  );
}
