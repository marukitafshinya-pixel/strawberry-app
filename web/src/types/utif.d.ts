// UTIF.js（TIFFを読むライブラリ）の、使う分だけの型
declare module "utif" {
  type IFD = { width: number; height: number; [k: string]: unknown };
  const UTIF: {
    decode(buf: ArrayBuffer): IFD[];
    decodeImage(buf: ArrayBuffer, ifd: IFD): void;
    toRGBA8(ifd: IFD): Uint8Array;
  };
  export default UTIF;
}
