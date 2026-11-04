// 打刻タブレットでかざしたときの、その日の記録の決め方（サーバーの timeclockPunch から使う。データベースは使わない）。
// raw（i・o）は機械の打刻、e は画面で直した時刻（あれば集計表は e を使う）。
// 手で直した日にかざしても集計表に出るように、直した時刻（e）にもタブレットの時刻を入れる。
export type PunchDay = {
  i: number | null;
  o: number | null;
  s?: string;
  e?: { i: number | null; o: number | null };
  bk?: number;
  x?: string;
};

/** 続けてかざした分は数えない（分） */
export const DUP_MIN = 2;

export function nextPunch(day: PunchDay | undefined, min: number): { kind: "in" | "out" | "dup"; next?: PunchDay } {
  // その日の出勤：直した時刻があればそれ、なければタブレットの打刻（MAXの打刻はタブレットで置き換えるので数えない）
  const effIn = day?.e ? day.e.i : day?.s === "tab" ? day.i : null;
  if (!day || effIn == null) {
    const next: PunchDay = { ...(day ?? { i: null, o: null }), i: min, o: null, s: "tab" };
    delete next.x;
    if (day?.e) next.e = { ...day.e, i: min };
    return { kind: "in", next };
  }
  const effOut = day.e ? day.e.o : day.o;
  const last = effOut ?? effIn;
  if (Math.abs(min - last) < DUP_MIN || min < effIn) return { kind: "dup" };
  const next: PunchDay = { ...day, o: min, s: "tab" };
  if (day.s !== "tab" && !day.e) next.i = effIn;
  if (day.e) next.e = { ...day.e, o: min };
  return { kind: "out", next };
}
