// Excel（.xlsx と .xlsb）のシートを、表（文字の2次元配列）として読む小さな道具。
// どちらも ZIP の中にシートが入っているので、ブラウザの機能（DecompressionStream と DOMParser）で読める。
//   .xlsx … シートは XML
//   .xlsb … シートは「バイナリ形式」（Excel の BIFF12）
// 数式は計算済みの値（Excel が保存した値）を使う。

type Entry = { name: string; method: number; compSize: number; offset: number };

function readZipEntries(buf: ArrayBuffer): Entry[] {
  const v = new DataView(buf);
  // 末尾の「中央ディレクトリの終わり」を探す
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Excelファイル（.xlsx / .xlsb）ではないようです");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    out.push({ name: dec.decode(new Uint8Array(buf, p + 46, nameLen)), method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntryBytes(buf: ArrayBuffer, e: Entry): Promise<Uint8Array> {
  const v = new DataView(buf);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error("このExcelファイルの形式には対応していません");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const readEntryText = async (buf: ArrayBuffer, e: Entry) => new TextDecoder().decode(await readEntryBytes(buf, e));
const parseXml = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

/** 数の見た目をそろえる（45.0 → "45"） */
const numText = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : "");

/** 読み込んだブック。シート名の一覧と、名前を指定してシートを読む関数 */
export type Workbook = { sheetNames: string[]; readSheet: (name: string) => Promise<string[][]> };

/** .xlsx / .xlsb を開く */
export async function openWorkbook(buf: ArrayBuffer): Promise<Workbook> {
  const entries = readZipEntries(buf);
  const find = (name: string) => entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const binary = !!find("xl/workbook.bin");

  // シート名 → シートのファイル（workbook の rels で結び付ける）
  const relsEntry = find(binary ? "xl/_rels/workbook.bin.rels" : "xl/_rels/workbook.xml.rels");
  const rels = new Map<string, string>();
  if (relsEntry) {
    for (const r of Array.from(parseXml(await readEntryText(buf, relsEntry)).getElementsByTagName("Relationship"))) {
      const target = (r.getAttribute("Target") ?? "").replace(/^\//, "");
      rels.set(r.getAttribute("Id") ?? "", target.startsWith("xl/") ? target : `xl/${target}`);
    }
  }
  const sheets: { name: string; path: string }[] = [];
  if (binary) {
    for (const rec of records(await readEntryBytes(buf, find("xl/workbook.bin")!))) {
      if (rec.type !== 156) continue; // BrtBundleSh
      const r = new Reader(rec.data);
      r.skip(8);
      const relId = r.wideString();
      const name = r.wideString();
      sheets.push({ name, path: rels.get(relId) ?? "" });
    }
  } else {
    const wb = parseXml(await readEntryText(buf, find("xl/workbook.xml")!));
    for (const s of Array.from(wb.getElementsByTagName("sheet"))) {
      const relId = s.getAttribute("r:id") ?? s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? "";
      sheets.push({ name: s.getAttribute("name") ?? "", path: rels.get(relId) ?? "" });
    }
  }
  if (sheets.length === 0) throw new Error("シートが見つかりません");

  // 共有文字列（文字のセルはここを番号で指している）
  let shared: string[] | null = null;
  const loadShared = async () => {
    if (shared) return shared;
    shared = [];
    if (binary) {
      const e = find("xl/sharedStrings.bin");
      if (e) for (const rec of records(await readEntryBytes(buf, e))) if (rec.type === 19) shared.push(new Reader(rec.data).skip(1).wideString());
    } else {
      const e = find("xl/sharedStrings.xml");
      if (e) {
        for (const si of Array.from(parseXml(await readEntryText(buf, e)).getElementsByTagName("si"))) {
          // ふりがな（rPh の中の t）は入れない
          const ts = Array.from(si.getElementsByTagName("t")).filter((t) => t.parentElement?.localName !== "rPh");
          shared.push(ts.map((t) => t.textContent ?? "").join(""));
        }
      }
    }
    return shared;
  };

  return {
    sheetNames: sheets.map((s) => s.name),
    async readSheet(name) {
      const s = sheets.find((x) => x.name === name);
      const e = s && find(s.path);
      if (!e) throw new Error(`シート「${name}」が読めません`);
      const strings = await loadShared();
      return binary ? readBinarySheet(await readEntryBytes(buf, e), strings) : readXmlSheet(await readEntryText(buf, e), strings);
    },
  };
}

// ---------- .xlsx のシート ----------

/** "B12" → 列番号（0から） */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXmlSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of Array.from(parseXml(xml).getElementsByTagName("row"))) {
    const r = Number(row.getAttribute("r")) - 1;
    const cells: string[] = [];
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const type = c.getAttribute("t");
      let val = c.getElementsByTagName("v")[0]?.textContent ?? "";
      if (type === "s") val = shared[Number(val)] ?? "";
      else if (type === "inlineStr") val = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("");
      cells[colIndex(c.getAttribute("r") ?? "")] = val;
    }
    rows[r] = Array.from(cells, (x) => x ?? "");
  }
  return Array.from(rows, (x) => x ?? []);
}

// ---------- .xlsb のシート（BIFF12 のレコードを順に読む） ----------

class Reader {
  p = 0;
  v: DataView;
  constructor(private b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  skip(n: number) {
    this.p += n;
    return this;
  }
  u8() {
    return this.b[this.p++];
  }
  u32() {
    const x = this.v.getUint32(this.p, true);
    this.p += 4;
    return x;
  }
  i32() {
    const x = this.v.getInt32(this.p, true);
    this.p += 4;
    return x;
  }
  f64() {
    const x = this.v.getFloat64(this.p, true);
    this.p += 8;
    return x;
  }
  /** 文字数（4バイト）＋ UTF-16 */
  wideString() {
    const n = this.u32();
    if (n === 0xffffffff || n > 0x100000) return "";
    const s = new TextDecoder("utf-16le").decode(this.b.subarray(this.p, this.p + n * 2));
    this.p += n * 2;
    return s;
  }
}

/** レコード（種類・中身）を順に取り出す。種類と長さは7ビットずつの可変長 */
function* records(b: Uint8Array): Generator<{ type: number; data: Uint8Array }> {
  let p = 0;
  while (p < b.length) {
    let type = b[p++] & 0x7f;
    if (b[p - 1] & 0x80) type |= (b[p++] & 0x7f) << 7;
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const x = b[p++];
      size |= (x & 0x7f) << (7 * i);
      if (!(x & 0x80)) break;
    }
    yield { type, data: b.subarray(p, p + size) };
    p += size;
  }
}

/** RK形式の数（整数か、倍精度の上位30ビット。100で割る印あり） */
function rk(x: number): number {
  let n: number;
  if (x & 0x02) n = (x | 0) >> 2;
  else {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setUint32(4, x & 0xfffffffc, true);
    n = dv.getFloat64(0, true);
  }
  return x & 0x01 ? n / 100 : n;
}

function readBinarySheet(b: Uint8Array, shared: string[]): string[][] {
  const rows: string[][] = [];
  let row = -1;
  for (const { type, data } of records(b)) {
    if (type === 0) {
      // BrtRowHdr：ここから次の行
      row = new Reader(data).u32();
      rows[row] ??= [];
      continue;
    }
    if (type < 1 || type > 11 || row < 0) continue;
    const r = new Reader(data);
    const col = r.u32();
    r.skip(4); // 書式など
    let val = "";
    switch (type) {
      case 2: // BrtCellRk
        val = numText(rk(r.u32()));
        break;
      case 4: // BrtCellBool
      case 10: // BrtFmlaBool
        val = r.u8() ? "TRUE" : "FALSE";
        break;
      case 5: // BrtCellReal
      case 9: // BrtFmlaNum
        val = numText(r.f64());
        break;
      case 6: // BrtCellSt
      case 8: // BrtFmlaString
        val = r.wideString();
        break;
      case 7: // BrtCellIsst
        val = shared[r.u32()] ?? "";
        break;
      default: // 空・エラー
        val = "";
    }
    rows[row][col] = val;
  }
  return Array.from(rows, (x) => Array.from(x ?? [], (c) => c ?? ""));
}
