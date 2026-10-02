"use client";

// 勤務管理表の表（横に日付、縦に従業員）。管理者は記号を入れられ、ほかの人は見るだけ
import { addDays, todayJST } from "@/lib/date";
import { isWorking, type ShiftConfig, type ShiftDay, type ShiftMember, type ShiftRequest } from "@/lib/shift";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const wdOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** まとまりの順、その中は並び順で並べる */
export function sortMembers(members: ShiftMember[], cfg: ShiftConfig) {
  const gi = (g: string) => {
    const i = cfg.groups.indexOf(g);
    return i < 0 ? cfg.groups.length : i;
  };
  return [...members].sort((a, b) => gi(a.group) - gi(b.group) || a.order - b.order);
}

export function ShiftTable({
  from,
  span,
  cfg,
  members,
  days,
  reserved,
  requests,
  myMemberId,
  onCell,
  onNote,
}: {
  from: string;
  span: number;
  cfg: ShiftConfig;
  members: ShiftMember[];
  days: Record<string, ShiftDay>;
  reserved: Record<string, number> | null;
  /** まだ決まっていない希望（管理者の画面で印を付ける） */
  requests?: ShiftRequest[];
  /** 従業員の画面：自分の行を目立たせる */
  myMemberId?: string;
  onCell?: (date: string, memberId: string) => void;
  onNote?: (date: string) => void;
}) {
  const dates = Array.from({ length: span }, (_, i) => addDays(from, i));
  const today = todayJST();
  const sorted = sortMembers(members, cfg);
  const groups = [...new Set(sorted.map((m) => m.group))];
  /** 横に見やすいよう、従業員の行を一段おきに色を付ける（まとまりをまたいで数える） */
  const rowNo = new Map(groups.flatMap((g) => sorted.filter((m) => m.group === g)).map((m, i) => [m.id, i]));
  const stripe = (m: ShiftMember) => (m.id === myMemberId ? "bg-emerald-50" : (rowNo.get(m.id) ?? 0) % 2 === 1 ? "bg-slate-100" : "bg-white");
  const req = new Map((requests ?? []).map((r) => [`${r.memberId}_${r.date}`, r]));
  const working = (d: string, m: ShiftMember) => isWorking(cfg, days[d]?.cells[m.id]);
  const colTone = (d: string) => (d === today ? "bg-amber-50" : wdOf(d) === 0 ? "bg-red-50/60" : wdOf(d) === 6 ? "bg-sky-50/60" : "");
  const headBase = "sticky left-0 z-10 whitespace-nowrap border-r px-2 text-left";
  const head = `${headBase} bg-white`;

  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="border-collapse text-xs tabular-nums">
        <thead>
          <tr className="border-b">
            <th className={`${head} py-1 text-gray-500`}>月</th>
            {dates.map((d, i) => (
              <th key={d} className={`min-w-[3.1rem] px-0.5 py-1 font-normal text-gray-500 ${colTone(d)}`}>
                {i === 0 || d.endsWith("-01") ? `${Number(d.slice(5, 7))}月` : ""}
              </th>
            ))}
          </tr>
          <tr>
            <th className={`${head} py-1`}>日付</th>
            {dates.map((d) => (
              <th key={d} className={`px-0.5 py-1 text-sm ${colTone(d)} ${d === today ? "text-amber-800" : ""}`}>
                {Number(d.slice(8))}
              </th>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1`}>曜日</th>
            {dates.map((d) => (
              <th key={d} className={`px-0.5 py-1 font-normal ${colTone(d)} ${wdOf(d) === 0 ? "text-red-600" : wdOf(d) === 6 ? "text-sky-700" : ""}`}>
                {WD[wdOf(d)]}
              </th>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1 font-normal`}>いちご狩り予約数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-semibold text-berry-dark ${colTone(d)}`}>
                {reserved?.[d] ? reserved[d] : ""}
              </td>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1 font-normal`}>予定</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center text-[10px] leading-tight ${colTone(d)}`}>
                {onNote ? (
                  <button onClick={() => onNote(d)} className="min-h-[1.5rem] w-full rounded hover:bg-gray-100">
                    {days[d]?.note || <span className="text-gray-300">＋</span>}
                  </button>
                ) : (
                  days[d]?.note
                )}
              </td>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g} name={g}>
              {sorted
                .filter((m) => m.group === g)
                .map((m) => (
                  <tr key={m.id} className={`border-b ${stripe(m)}`}>
                    <th className={`${headBase} py-1 font-normal ${stripe(m)} ${m.id === myMemberId ? "font-bold" : ""}`}>
                      {m.name}
                      {m.floor && <span className="ml-1 rounded bg-emerald-100 px-1 text-[10px] text-emerald-800">売</span>}
                      {m.harvest && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] text-rose-800">収</span>}
                    </th>
                    {dates.map((d) => {
                      const code = days[d]?.cells[m.id];
                      const r = req.get(`${m.id}_${d}`);
                      const body = (
                        <>
                          {code ?? ""}
                          {r && (
                            <span className="block rounded border border-dashed border-purple-500 px-0.5 text-[10px] text-purple-800" title={r.memo}>
                              希:{r.code}
                            </span>
                          )}
                        </>
                      );
                      return (
                        // 記号ごとの色は付けない（行の色だけ）
                        <td key={d} className="border-l px-0 py-0 text-center">
                          {onCell ? (
                            <button onClick={() => onCell(d, m.id)} className="block h-full min-h-[2rem] w-full px-0.5 py-1 hover:outline hover:outline-2 hover:outline-sky-400">
                              {body}
                            </button>
                          ) : (
                            <div className="min-h-[2rem] px-0.5 py-1">{body}</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </GroupRows>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2">
            <th className={`${head} py-1`}>売り場対応人数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)}`}>
                {sorted.filter((m) => m.floor && working(d, m)).length || ""}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className={`${head} py-1`}>収穫人数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)}`}>
                {sorted.filter((m) => m.harvest && working(d, m)).length || ""}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className={`${head} py-1`}>出勤人数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)}`}>
                {sorted.filter((m) => working(d, m)).length || ""}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function GroupRows({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-b bg-gray-50">
        <th className="sticky left-0 z-10 bg-gray-50 px-2 py-0.5 text-left text-[11px] font-bold text-gray-600">{name}</th>
        <td colSpan={999} />
      </tr>
      {children}
    </>
  );
}
