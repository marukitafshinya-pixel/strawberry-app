// ホーム画面用アイコン（PNG）を作る小さなスクリプト。 node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let col = [253, 248, 246]; // 背景
      // いちごの実（下すぼまりの形）
      const dx = (u - 0.5) / (0.36 - (v - 0.35) * 0.35), dy = (v - 0.58) / 0.32;
      if (dx * dx + dy * dy < 1 && v > 0.3) col = [214, 51, 74];
      // 種
      if (col[0] === 214 && ((Math.floor(u * 12) + Math.floor(v * 12)) % 3 === 0) && (u * 12) % 1 < 0.25 && (v * 12) % 1 < 0.35) col = [255, 225, 140];
      // へた
      const lx = (u - 0.5) / 0.3, ly = (v - 0.3) / 0.08;
      if (lx * lx + ly * ly < 1) col = [47, 125, 79];
      const i = y * (size * 3 + 1) + 1 + x * 3;
      raw[i] = col[0]; raw[i + 1] = col[1]; raw[i + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync("public/icon-192.png", png(192));
writeFileSync("public/icon-512.png", png(512));
writeFileSync("src/app/apple-icon.png", png(180));
