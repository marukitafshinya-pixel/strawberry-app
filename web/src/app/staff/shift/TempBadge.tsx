"use client";

// 作業配置表の日付の横に出す、その日の最高気温（9:00〜14:00）と最低気温（21:00〜翌朝8:00）。気象庁の予報から
import { dayHighLow, useForecast } from "@/lib/forecast";

export function TempBadge({ date, big }: { date: string; big?: boolean }) {
  const { data } = useForecast();
  if (!data) return null;
  const { high, low } = dayHighLow(data, date);
  if (high === null && low === null) return null;
  return (
    <span className={`inline-flex items-baseline gap-3 font-bold tabular-nums ${big ? "text-4xl" : "text-lg"}`} title={`気象庁の予報（気温は${data.tempPoint}）。最高は9時〜14時、最低は21時〜翌朝8時`}>
      {high !== null && (
        <span className="text-red-600">
          <span className={`font-normal ${big ? "text-2xl" : "text-sm"}`}>最高</span> {high}℃
        </span>
      )}
      {low !== null && (
        <span className="text-sky-700">
          <span className={`font-normal ${big ? "text-2xl" : "text-sm"}`}>最低</span> {low}℃
        </span>
      )}
    </span>
  );
}
