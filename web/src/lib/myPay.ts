"use client";

// 従業員が携帯で見る、自分のタイムカード集計表と給与明細（サーバーが本人の分だけを返す。functions/src/myPay.ts）
import { callFunction } from "./callFunction";
import type { PayRow } from "./payroll";
import type { TimecardConfig, TimecardMonth } from "./timecard";

export type MyTimecard = {
  name: string;
  card: string | null;
  manager: boolean;
  rules: Partial<TimecardConfig>;
  data: Record<string, TimecardMonth>;
  /** その月が確定済みか */
  locked: boolean;
};
export const fetchMyTimecard = (month: string) => callFunction<{ month: string }, MyTimecard>("myTimecard", { month });

export type MySlip = { month: string; paymentDate: string; row: PayRow };
export type MyPayslips = { name: string; code: string; company: string; slips: MySlip[] };
export const fetchMyPayslips = () => callFunction<Record<string, never>, MyPayslips>("myPayslips", {});
