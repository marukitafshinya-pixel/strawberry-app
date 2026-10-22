// 古い形式の Excel（.xls、Excel 97〜2003 の BIFF8）のシートを、表（文字の2次元配列）として読む。
// .xls は「複合ドキュメント」（ファイルの中に小さなファイルシステムがある形）の中に、Workbook という流れ（ストリーム）が入っている。
// その中のレコード（種類・長さ・中身）を順に読んで、文字・数のセルだけを取り出す。数式は保存された計算結果を使う。
// 会計ソフトが書き出す試算表などを読むためのもので、書式や結合セルは見ない。
import type { Workbook } from "./xlsx";

/** .xls（複合ドキュメント）か。先頭の8バイトが D0 CF 11 E0 A1 B1 1A E1 */
export function isXls(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b.length === 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** 複合ドキュメントから、名前を指定してストリームを取り出す */
function readCfbStream(buf: ArrayBuffer, names: string[]): Uint8Array {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const sectorSize = 1 << v.getUint16(30, true);
  const miniSectorSize = 1 << v.getUint16(32, true);
  const numFatSectors = v.getUint32(44, true);
  const dirStart = v.getUint32(48, true);
  const miniCutoff = v.getUint32(56, true);
  const miniFatStart = v.getUint32(60, true);
  let difatSector = v.getUint32(68, true);
  const sectorOffset = (s: number) => (s + 1) * sectorSize;

  // FAT の場所：ヘッダーの109個と、DIFAT のつながり
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) fatSectors.push(v.getUint32(76 + i * 4, true));
  for (let guard = 0; difatSector !== ENDOFCHAIN && difatSector !== FREESECT && fatSectors.length < numFatSectors && guard < 10000; guard++) {
    const off = sectorOffset(difatSector);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFatSectors; i++) fatSectors.push(v.getUint32(off + i * 4, true));
    difatSector = v.getUint32(off + per * 4, true);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = sectorOffset(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(v.getUint32(off + i * 4, true));
  }
  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT && s < table.length && out.length <= table.length; s = table[s]) out.push(s);
    return out;
  };
  const readChain = (start: number) => {
    const list = chain(start, fat);
    const out = new Uint8Array(list.length * sectorSize);
    list.forEach((s, i) => out.set(bytes.subarray(sectorOffset(s), sectorOffset(s) + sectorSize), i * sectorSize));
    return out;
  };

  // ディレクトリ（1つ128バイト）
  const dir = readChain(dirStart);
  const dv = new DataView(dir.buffer);
  type DirEntry = { name: string; type: number; start: number; size: number };
  const entries: DirEntry[] = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dv.getUint16(p + 64, true);
    let name = "";
    for (let i = 0; i + 2 < nameLen; i += 2) name += String.fromCharCode(dv.getUint16(p + i, true));
    entries.push({ name, type: dir[p + 66], start: dv.getUint32(p + 116, true), size: dv.getUint32(p + 120, true) });
  }
  const root = entries[0];
  const target = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!target) throw new Error("Excelの中身（Workbook）が見つかりません");
  if (target.size >= miniCutoff) return readChain(target.start).subarray(0, target.size);

  // 小さいストリームは「ミニストリーム」（ルートのストリームの中を64バイトずつに分けたもの）にある
  const miniStream = readChain(root.start);
  const miniFatBytes = readChain(miniFatStart);
  const mfv = new DataView(miniFatBytes.buffer);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mfv.getUint32(i, true));
  const list = chain(target.start, miniFat);
  const out = new Uint8Array(list.length * miniSectorSize);
  list.forEach((s, i) => out.set(miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize), i * miniSectorSize));
  return out.subarray(0, target.size);
}

type Rec = { type: number; data: Uint8Array; pos: number };

function biffRecords(stream: Uint8Array): Rec[] {
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: Rec[] = [];
  for (let p = 0; p + 4 <= stream.length; ) {
    const type = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    out.push({ type, data: stream.subarray(p + 4, p + 4 + len), pos: p });
    p += 4 + len;
  }
  return out;
}

/**
 * つながったレコード（SST と、その続きの CONTINUE）を読む道具。
 * 文字の途中で次のレコードに移るときは、次のレコードの先頭に「1バイト文字か2バイト文字か」の印が1バイト入る
 */
class SegReader {
  private seg = 0;
  private pos = 0;
  private segs: Uint8Array[];
  constructor(segs: Uint8Array[]) {
    this.segs = segs;
  }
  private ensure() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg].length) {
      this.seg++;
      this.pos = 0;
    }
  }
  done() {
    this.ensure();
    return this.seg >= this.segs.length;
  }
  byte(): number {
    this.ensure();
    if (this.seg >= this.segs.length) throw new Error("Excelの文字の表が途中で切れています");
    return this.segs[this.seg][this.pos++];
  }
  u16() {
    return this.byte() | (this.byte() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let i = 0; i < n; i++) this.byte();
  }
  /** 文字を cch 文字読む。レコードの境目では印の1バイトを読み直す */
  chars(cch: number, highByte: boolean): string {
    let s = "";
    let wide = highByte;
    for (let i = 0; i < cch; i++) {
      if (this.seg < this.segs.length && this.pos >= this.segs[this.seg].length) {
        this.seg++;
        this.pos = 0;
        if (this.seg >= this.segs.length) break;
        wide = (this.segs[this.seg][this.pos++] & 1) === 1;
      }
      s += String.fromCharCode(wide ? this.u16() : this.byte());
    }
    return s;
  }
}

/** XLUnicodeRichExtendedString（共有文字列の1つ） */
function richString(r: SegReader): string {
  const cch = r.u16();
  const flags = r.byte();
  const runs = flags & 8 ? r.u16() : 0;
  const ext = flags & 4 ? r.u32() : 0;
  const s = r.chars(cch, (flags & 1) === 1);
  r.skip(runs * 4 + ext);
  return s;
}

/** 1つのレコードの中の文字（XLUnicodeString：文字数が2バイト／ShortXLUnicodeString：1バイト） */
function plainString(d: Uint8Array, p: number, shortLen: boolean): string {
  const cch = shortLen ? d[p] : d[p] | (d[p + 1] << 8);
  p += shortLen ? 1 : 2;
  const wide = (d[p++] & 1) === 1;
  let s = "";
  for (let i = 0; i < cch; i++) s += String.fromCharCode(wide ? d[p + i * 2] | (d[p + i * 2 + 1] << 8) : d[p + i]);
  return s;
}

/** RK（数を4バイトに詰めたもの）→ 数 */
function rkValue(rk: number): number {
  const div100 = rk & 1;
  let n: number;
  if (rk & 2) n = rk >> 2;
  else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, rk & 0xfffffffc, true);
    n = b.getFloat64(0, true);
  }
  return div100 ? n / 100 : n;
}

const numText = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : "");

/** .xls を開く */
export function openXls(buf: ArrayBuffer): Workbook {
  const stream = readCfbStream(buf, ["Workbook", "Book"]);
  const recs = biffRecords(stream);
  const sheets: { name: string; pos: number }[] = [];
  const sst: string[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 0x0085) {
      const d = r.data;
      sheets.push({ name: plainString(d, 6, true), pos: d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24) });
      // 種類（d[5]）が 0 のものがふつうのシート。グラフなどは後で読めないだけ
    } else if (r.type === 0x00fc) {
      const segs = [r.data];
      for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) segs.push(recs[j].data);
      const rd = new SegReader(segs);
      rd.u32();
      const unique = rd.u32();
      for (let k = 0; k < unique && !rd.done(); k++) sst.push(richString(rd));
    } else if (r.type === 0x000a && sheets.length && r.pos > 0) {
      // 最初の EOF（ブック全体の部分の終わり）まで
      break;
    }
  }
  if (sheets.length === 0) throw new Error("シートが見つかりません");

  const readSheet = (name: string): string[][] => {
    const s = sheets.find((x) => x.name === name);
    if (!s) throw new Error(`シート「${name}」が読めません`);
    const rows: string[][] = [];
    const put = (row: number, col: number, val: string) => {
      while (rows.length <= row) rows.push([]);
      const r = rows[row];
      while (r.length < col) r.push("");
      r[col] = val;
    };
    const start = recs.findIndex((r) => r.pos === s.pos);
    if (start < 0) throw new Error(`シート「${name}」が読めません`);
    let pendingFormula: { row: number; col: number } | null = null;
    for (let i = start + 1; i < recs.length; i++) {
      const { type, data: d } = recs[i];
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const row = d.length >= 4 ? dv.getUint16(0, true) : 0;
      const col = d.length >= 4 ? dv.getUint16(2, true) : 0;
      if (type === 0x000a) break; // EOF
      if (type === 0x00fd) put(row, col, sst[dv.getUint32(6, true)] ?? "");
      else if (type === 0x0203) put(row, col, numText(dv.getFloat64(6, true)));
      else if (type === 0x027e) put(row, col, numText(rkValue(dv.getUint32(6, true))));
      else if (type === 0x00bd) {
        const last = dv.getUint16(d.length - 2, true);
        for (let c = col, p = 4; c <= last; c++, p += 6) put(row, c, numText(rkValue(dv.getUint32(p + 2, true))));
      } else if (type === 0x0204) put(row, col, plainString(d, 6, false));
      else if (type === 0x0006) {
        // 数式：結果の8バイト。最後の2バイトが FFFF なら数でなく、文字なら続く STRING レコードにある
        if (dv.getUint16(12, true) === 0xffff) {
          const kind = d[6];
          if (kind === 0) pendingFormula = { row, col };
          else if (kind === 1) put(row, col, d[8] ? "TRUE" : "FALSE");
        } else put(row, col, numText(dv.getFloat64(6, true)));
      } else if (type === 0x0207 && pendingFormula) {
        put(pendingFormula.row, pendingFormula.col, plainString(d, 0, false));
        pendingFormula = null;
      }
    }
    return rows.map((r) => r.map((c) => c ?? ""));
  };

  return { sheetNames: sheets.map((s) => s.name), readSheet: async (name) => readSheet(name) };
}
