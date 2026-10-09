"use client";

// 勤務管理表の表（横に日付、縦に従業員）。管理者は記号を入れられ、ほかの人は見るだけ
import { useEffect, useRef, useState } from "react";
import { addDays, todayJST } from "@/lib/date";
import { isWorking, type ShiftConfig, type ShiftDay, type ShiftMember, type ShiftRequest } from "@/lib/shift";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
/** 日付の列の幅（px）。表の文字は、記号がこの幅にぎりぎり収まる大きさにする */
const COL_PX = 52;
/** マスの左右の余白と、希望の点線の枠の分（px） */
const CELL_INSET = 6;
/** 文字のいちばん大きい大きさは、列の幅の何倍までにするか（行が高くなりすぎないように） */
const FONT_CAP = 0.54;
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
  onMore,
  resetKey,
  onRequest,
  onCopyDay,
  onClearDay,
  fixed,
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
  /** マスを押したとき（押したマスの位置も渡す。そこに記号のリストを出す） */
  onCell?: (date: string, memberId: string, rect: DOMRect) => void;
  onNote?: (date: string) => void;
  /** 右の端に近づいたら呼ぶ（先の日を足す） */
  onMore?: () => void;
  /** 変わったら表を左端（先頭の日）に戻す */
  resetKey?: number;
  /** 希望が出ているマスを押したとき（管理者：その場で承認・却下する） */
  onRequest?: (r: ShiftRequest) => void;
  /** 一番上のまとまりの帯に出す「→」：その日の記号を次の日にコピーする（管理者） */
  onCopyDay?: (date: string) => void;
  /** 2番目のまとまりの帯に出す「－」：その日の記号を全部消す（管理者） */
  onClearDay?: (date: string) => void;
  /** 投影用：横に動かさず、表をそのままの大きさで出す（外側で画面に合わせて拡大する） */
  fixed?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // 表の文字の大きさ：マスの幅（枠）はそのままで、文字ができるだけ大きくなるようにする。
  // 表全体は、2文字までの記号と日付（31）がマスにぎりぎり収まる大きさ。それより長い記号だけ、そのマスで小さくする
  const [widths, setWidths] = useState<{ base: number; of: Record<string, number> }>({ base: 2, of: {} });
  const codesKey = cfg.codes.map((c) => c.code).join("|");
  useEffect(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx || !box.current) return;
    ctx.font = `bold 100px ${getComputedStyle(box.current).fontFamily}`;
    const w = (t: string) => ctx.measureText(t).width / 100;
    const codes = codesKey.split("|").filter(Boolean);
    const of = Object.fromEntries(codes.map((c) => [c, w(c)]));
    const base = Math.max(w("31"), ...codes.filter((c) => [...c].length <= 2).map((c) => of[c]), 1);
    setWidths({ base, of });
  }, [codesKey]);
  const room = COL_PX - CELL_INSET;
  const fontPx = Math.max(9, Math.min(COL_PX * FONT_CAP, Math.floor((room / widths.base) * 10) / 10));
  /** 長い記号は、そのマスに収まるところまで小さくする */
  const codeFont = (code: string) => {
    const u = widths.of[code];
    return u && u * fontPx > room ? Math.floor((room / u) * 10) / 10 : undefined;
  };
  useEffect(() => {
    if (box.current) box.current.scrollLeft = 0;
  }, [from, resetKey]);
  const dates = Array.from({ length: span }, (_, i) => addDays(from, i));
  const today = todayJST();
  const sorted = sortMembers(members, cfg);
  const groups = [...new Set(sorted.map((m) => m.group))];
  /** 横に見やすいよう、従業員の行を一段おきに色を付ける（まとまりをまたいで数える） */
  const rowNo = new Map(groups.flatMap((g) => sorted.filter((m) => m.group === g)).map((m, i) => [m.id, i]));
  const stripe = (m: ShiftMember) => (m.id === myMemberId ? "bg-emerald-50" : (rowNo.get(m.id) ?? 0) % 2 === 1 ? "bg-slate-200" : "bg-white");
  const req = new Map((requests ?? []).map((r) => [`${r.memberId}_${r.date}`, r]));
  const working = (d: string, m: ShiftMember) => isWorking(cfg, days[d]?.cells[m.id]);
  const colTone = (d: string) => (d === today ? "bg-amber-50" : wdOf(d) === 0 ? "bg-red-50/60" : wdOf(d) === 6 ? "bg-sky-50/60" : "");
  const headBase = "sticky left-0 z-10 whitespace-nowrap border-r px-2 text-left";
  const head = `${headBase} bg-white`;
  /** 月曜〜日曜を1週間として、月曜の左に太い縦線を引く */
  const wk = (d: string) => (wdOf(d) === 1 ? "border-l-2 border-l-gray-800!" : "");

  return (
    <div
      ref={box}
      className={fixed ? "inline-block bg-white" : "overflow-x-auto rounded-xl border bg-white"}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (onMore && el.scrollLeft + el.clientWidth > el.scrollWidth - 400) onMore();
      }}
    >
      {/* マス目の線は濃いめ（プロジェクターで映しても見えるように） */}
      <table className="border-collapse tabular-nums leading-tight [&_td]:border-gray-500 [&_th]:border-gray-500 [&_tr]:border-gray-500" style={{ fontSize: fontPx }}>
        <thead>
          <tr className="border-b">
            <th className={`${head} py-1 text-gray-500`}>月</th>
            {dates.map((d, i) => (
              <th key={d} style={{ width: COL_PX, minWidth: COL_PX, maxWidth: COL_PX }} className={`overflow-visible whitespace-nowrap px-0.5 py-1 text-left font-normal text-gray-500 ${colTone(d)} ${wk(d)}`}>
                {i === 0 || d.endsWith("-01") ? `${Number(d.slice(5, 7))}月` : ""}
              </th>
            ))}
          </tr>
          <tr>
            <th className={`${head} py-1`}>日付</th>
            {dates.map((d) => (
              <th key={d} className={`px-0.5 py-1 ${colTone(d)} ${wk(d)} ${d === today ? "text-amber-800" : ""}`}>
                {Number(d.slice(8))}
              </th>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1`}>曜日</th>
            {dates.map((d) => (
              <th key={d} className={`px-0.5 py-1 font-normal ${colTone(d)} ${wk(d)} ${wdOf(d) === 0 ? "text-red-600" : wdOf(d) === 6 ? "text-sky-700" : ""}`}>
                {WD[wdOf(d)]}
              </th>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1 font-normal`}>いちご狩り予約数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-semibold text-berry-dark ${colTone(d)} ${wk(d)}`}>
                {reserved?.[d] ? reserved[d] : ""}
              </td>
            ))}
          </tr>
          <tr className="border-b">
            <th className={`${head} py-1 font-normal`}>予定</th>
            {dates.map((d) => (
              <td key={d} className={`break-all px-0.5 py-1 text-center ${colTone(d)} ${wk(d)}`}>
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
            <GroupRows
              key={g}
              name={g}
              band={
                onCopyDay && g === groups[0]
                  ? dates.map((d) => (
                      <td key={d} className={`p-0 text-center ${wk(d)}`}>
                        <button
                          onClick={() => onCopyDay(d)}
                          title="この日の記号を次の日にコピー"
                          aria-label={`${Number(d.slice(5, 7))}月${Number(d.slice(8))}日の記号を次の日にコピー`}
                          className="w-full rounded px-1 text-sky-700 hover:bg-sky-100"
                        >
                          →
                        </button>
                      </td>
                    ))
                  : onClearDay && g === groups[1]
                    ? dates.map((d) => (
                        <td key={d} className={`p-0 text-center ${wk(d)}`}>
                          <button
                            onClick={() => onClearDay(d)}
                            title="この日の記号を全部消す"
                            aria-label={`${Number(d.slice(5, 7))}月${Number(d.slice(8))}日の記号を消す`}
                            className="w-full rounded px-1 font-bold text-red-600 hover:bg-red-50"
                          >
                            －
                          </button>
                        </td>
                      ))
                    : null
              }
            >
              {sorted
                .filter((m) => m.group === g)
                .map((m) => (
                  <tr key={m.id} className={`border-b ${stripe(m)}`}>
                    <th className={`${headBase} py-1 font-normal ${stripe(m)} ${m.id === myMemberId ? "font-bold" : ""}`}>
                      {m.name}
                      {m.floor && <span className="ml-1 rounded bg-emerald-100 px-1 text-[0.6em] text-emerald-800">売</span>}
                      {m.harvest && <span className="ml-1 rounded bg-rose-100 px-1 text-[0.6em] text-rose-800">収</span>}
                    </th>
                    {dates.map((d) => {
                      const code = days[d]?.cells[m.id];
                      const r = req.get(`${m.id}_${d}`);
                      const body = (
                        <>
                          {code ? (
                            <span className="font-bold" style={{ fontSize: codeFont(code) }}>
                              {code}
                            </span>
                          ) : (
                            ""
                          )}
                          {r && (
                            <span className="block whitespace-nowrap rounded border border-dashed border-purple-500 text-purple-800" style={{ fontSize: codeFont(r.code) }} title={`休みの希望：${r.code}${r.memo ? `（${r.memo}）` : ""}`}>
                              {r.code}
                            </span>
                          )}
                        </>
                      );
                      return (
                        // 記号ごとの色は付けない（行の色だけ）
                        <td key={d} className={`whitespace-nowrap border-l px-0 py-0 text-center ${wk(d)}`}>
                          {r && onRequest ? (
                            <button
                              onClick={() => onRequest(r)}
                              className="flex min-h-[2rem] w-full flex-col items-center justify-center px-0.5 py-1 hover:outline hover:outline-2 hover:outline-purple-500"
                              aria-label={`${m.name}さんの休みの希望を決める`}
                            >
                              {body}
                            </button>
                          ) : onCell ? (
                            <button onClick={(e) => onCell(d, m.id, e.currentTarget.getBoundingClientRect())} aria-label={`${m.name}さんの${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`} className="flex min-h-[2rem] w-full flex-col items-center justify-center px-0.5 py-1 hover:outline hover:outline-2 hover:outline-sky-400">
                              {body}
                            </button>
                          ) : (
                            <div className="flex min-h-[2rem] flex-col items-center justify-center px-0.5 py-1">{body}</div>
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
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)} ${wk(d)}`}>
                {sorted.filter((m) => m.floor && working(d, m)).length || ""}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className={`${head} py-1`}>収穫人数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)} ${wk(d)}`}>
                {sorted.filter((m) => m.harvest && working(d, m)).length || ""}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className={`${head} py-1`}>出勤人数</th>
            {dates.map((d) => (
              <td key={d} className={`px-0.5 py-1 text-center font-bold ${colTone(d)} ${wk(d)}`}>
                {sorted.filter((m) => working(d, m)).length || ""}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function GroupRows({ name, band, children }: { name: string; band?: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-b bg-gray-50">
        <th className="sticky left-0 z-10 bg-gray-50 px-2 py-0.5 text-left text-[0.7em] font-bold text-gray-600">{name}</th>
        {band ?? <td colSpan={999} />}
      </tr>
      {children}
    </>
  );
}
