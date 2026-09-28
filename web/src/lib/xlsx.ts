// Excel（.xlsx）の最初のシートを、表（文字の2次元配列）として読む小さな道具。
// .xlsx は ZIP の中に XML が入っているだけなので、ブラウザの機能（DecompressionStream と DOMParser）で読める。
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
  if (eocd < 0) throw new Error("Excelファイル（.xlsx）ではないようです");
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

async function readEntry(buf: ArrayBuffer, e: Entry): Promise<string> {
  const v = new DataView(buf);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("このExcelファイルの形式には対応していません");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

/** "B12" → 列番号（0から）。行は使わない */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** .xlsx の最初のシートを読む。空のセルは "" */
export async function readXlsxFirstSheet(buf: ArrayBuffer): Promise<string[][]> {
  const entries = readZipEntries(buf);
  const find = (name: string) => entries.find((e) => e.name === name);
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  // 共有文字列（文字のセルはここを番号で指している）
  const shared: string[] = [];
  const ss = find("xl/sharedStrings.xml");
  if (ss) {
    for (const si of Array.from(parse(await readEntry(buf, ss)).getElementsByTagName("si"))) {
      // ふりがな（rPh の中の t）は入れない
      const ts = Array.from(si.getElementsByTagName("t")).filter((t) => t.parentElement?.localName !== "rPh");
      shared.push(ts.map((t) => t.textContent ?? "").join(""));
    }
  }
  // 最初のシート（ふつうは sheet1.xml）
  const sheet = find("xl/worksheets/sheet1.xml") ?? entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheet) throw new Error("シートが見つかりません");
  const doc = parse(await readEntry(buf, sheet));
  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName("row"))) {
    const r = Number(row.getAttribute("r")) - 1;
    const cells: string[] = [];
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r") ?? "";
      const type = c.getAttribute("t");
      const vEl = c.getElementsByTagName("v")[0];
      let val = vEl?.textContent ?? "";
      if (type === "s") val = shared[Number(val)] ?? "";
      else if (type === "inlineStr") val = Array.from(c.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("");
      cells[colIndex(ref)] = val;
    }
    rows[r] = Array.from(cells, (x) => x ?? "");
  }
  return Array.from(rows, (x) => x ?? []);
}
