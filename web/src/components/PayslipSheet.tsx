// 1人分の給与明細書（A4縦）。従業員の携帯（staff/shift/me/payslip）と、管理者の個人別の印刷（staff/payroll/slip）で同じものを使う
import { PAY_ITEMS, computeRow, reiwa, type PayKey, type PayRow } from "@/lib/payroll";
import { hm } from "@/lib/timecard";

export const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
export const slipMonthLabel = (ym: string) => `${reiwa(Number(ym.slice(0, 4)))} ${Number(ym.slice(5))}月度分`;
export const slipDateLabel = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(0, 4))}年${Number(d.slice(5, 7))}月${Number(d.slice(8))}日` : d);
export const PAY_LINES = PAY_ITEMS.filter((i) => i.group === "pay");
export const SOCIAL_LINES = PAY_ITEMS.filter((i) => i.group === "social");
export const TAX_LINES = PAY_ITEMS.filter((i) => i.group === "tax");

export type SlipPerson = { name: string; code: string; company: string };
export type SlipWork = { days: number; work: number; over: number };

export function SlipHead({ title, sub, me }: { title: string; sub: string; me: SlipPerson }) {
  return (
    <div className="mb-3 border-b-2 border-gray-800 pb-2">
      <h2 className="text-center text-xl font-bold tracking-widest">{title}</h2>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-sm">
        <span>{sub}</span>
        <span className="text-base font-bold">
          {me.code && <span className="mr-2 text-sm font-normal text-gray-600">{me.code}</span>}
          {me.name} 様
        </span>
      </div>
      {me.company && <p className="mt-1 text-right text-xs text-gray-600">{me.company}</p>}
    </div>
  );
}

export const slipBox =
  "w-full border-collapse text-sm tabular-nums [&_td]:border [&_td]:border-gray-400 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-400 [&_th]:bg-gray-100 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-normal";

export function SlipLines({
  title,
  items,
  row,
  total,
  totalLabel,
}: {
  title: string;
  items: readonly { key: PayKey; label: string }[];
  row: Partial<Record<PayKey, number>>;
  total?: number;
  totalLabel?: string;
}) {
  const shown = items.filter((i) => row[i.key]);
  return (
    <table className={`${slipBox} mt-3`}>
      <thead>
        <tr>
          <th colSpan={2} className="!bg-gray-200 !font-bold">
            {title}
          </th>
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 && (
          <tr>
            <td colSpan={2} className="text-gray-400">
              なし
            </td>
          </tr>
        )}
        {shown.map((i) => (
          <tr key={i.key}>
            <th className="w-1/2">{i.label}</th>
            <td className="text-right">{yen(row[i.key] ?? 0)}</td>
          </tr>
        ))}
        {totalLabel && (
          <tr className="font-bold">
            <th className="!font-bold">{totalLabel}</th>
            <td className="text-right">{yen(total ?? 0)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 1か月分の給与明細（勤怠はタイムカードから計算したもの。なければ出さない） */
export function PayslipSheet({
  month,
  paymentDate,
  row,
  me,
  work,
}: {
  month: string;
  paymentDate: string;
  row: PayRow;
  me: SlipPerson;
  work?: SlipWork | null;
}) {
  const t = computeRow(row);
  const deduct = t.social + (row.incomeTax ?? 0) + (row.residentTax ?? 0) - (row.yearEnd ?? 0);
  return (
    <section className="rounded-xl bg-white p-4 shadow-sm print:p-0 print:shadow-none">
      <SlipHead title="給与明細書" sub={`${slipMonthLabel(month)}　支給日 ${slipDateLabel(paymentDate) || "－"}`} me={me} />
      {work && (
        <table className={slipBox}>
          <tbody>
            <tr>
              <th>出勤日数</th>
              <td className="text-right">{work.days}日</td>
              <th>労働時間</th>
              <td className="text-right">{hm(work.work)}</td>
              <th>うち残業</th>
              <td className="text-right">{work.over ? hm(work.over) : "－"}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="sm:grid sm:grid-cols-2 sm:gap-3 print:grid print:grid-cols-2 print:gap-3">
        <SlipLines title="支給" items={PAY_LINES} row={row} totalLabel="支給合計" total={t.pay} />
        <div>
          <SlipLines title="控除（社会保険）" items={SOCIAL_LINES} row={row} totalLabel="社会保険料計" total={t.social} />
          <SlipLines title="控除（税金など）" items={TAX_LINES} row={row} />
        </div>
      </div>
      <table className={`${slipBox} mt-3`}>
        <tbody>
          <tr>
            <th>控除合計</th>
            <td className="text-right">{yen(deduct)}</td>
          </tr>
          <tr className="text-lg font-bold">
            <th className="!font-bold">差引支給額</th>
            <td className="text-right">{yen(t.net)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
