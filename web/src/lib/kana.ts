// かなとローマ字：科目を読みで探すときに使う（「syu」「しゅ」「シュ」→ 修繕費・種苗費など）

/** カタカナ → ひらがな（半角カナもそろえる） */
export const toHira = (s: string) => s.normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// ローマ字 → ひらがな（訓令式・ヘボン式のどちらでも）。長いつづりから順に見る
const TABLE: Record<string, string> = {
  kya: "きゃ", kyu: "きゅ", kyo: "きょ", sya: "しゃ", syu: "しゅ", syo: "しょ", sha: "しゃ", shu: "しゅ", sho: "しょ", shi: "し",
  tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ", cha: "ちゃ", chu: "ちゅ", cho: "ちょ", chi: "ち", tsu: "つ", nya: "にゃ", nyu: "にゅ", nyo: "にょ",
  hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ", mya: "みゃ", myu: "みゅ", myo: "みょ", rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ", zya: "じゃ", zyu: "じゅ", zyo: "じょ", jya: "じゃ", jyu: "じゅ", jyo: "じょ", bya: "びゃ", byu: "びゅ", byo: "びょ",
  pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ", dya: "ぢゃ", dyu: "ぢゅ", dyo: "ぢょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", ji: "じ", fu: "ふ", si: "し", ti: "ち", tu: "つ", zi: "じ", di: "ぢ", du: "づ", nn: "ん",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ", sa: "さ", su: "す", se: "せ", so: "そ", ta: "た", te: "て", to: "と",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の", ha: "は", hi: "ひ", hu: "ふ", he: "へ", ho: "ほ", ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ", ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ", wa: "わ", wo: "を",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご", za: "ざ", zu: "ず", ze: "ぜ", zo: "ぞ", da: "だ", de: "で", do: "ど",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ", pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  a: "あ", i: "い", u: "う", e: "え", o: "お", "-": "ー",
};

/**
 * ローマ字をひらがなにする。終わりの、まだ1文字にならない子音（「syu」の次に打ちかけの「k」など）は捨てる。
 * ローマ字でない文字（かな・漢字）は、そのまま残す
 */
export function romajiToHira(input: string): string {
  const s = input.normalize("NFKC").toLowerCase();
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (!/[a-z-]/.test(c)) {
      out += c;
      i++;
      continue;
    }
    // 小さい「っ」：同じ子音が2つ（kk・tt など。nn は「ん」）
    if (c === s[i + 1] && /[bcdfghjklmpqrstvwxyz]/.test(c) && c !== "n") {
      out += "っ";
      i++;
      continue;
    }
    // 「ん」：n のあとが母音・y でない（n で終わるのは、打ちかけかもしれないので捨てる）
    if (c === "n" && s[i + 1] !== undefined && !/[aiueoyn]/.test(s[i + 1])) {
      out += "ん";
      i++;
      continue;
    }
    let hit = false;
    for (const len of [3, 2, 1]) {
      const k = TABLE[s.slice(i, i + len)];
      if (k) {
        out += k;
        i += len;
        hit = true;
        break;
      }
    }
    if (!hit) i++;
  }
  return out;
}

/** 探す言葉をそろえる（ローマ字はひらがなに、カタカナもひらがなに、空白を消す） */
export const searchHira = (q: string) => toHira(romajiToHira(q)).replace(/\s/g, "");
