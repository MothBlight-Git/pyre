/**
 * Tiny PNG encoder so the tray icon and app icon need no binary asset in the
 * repo. Draws an ember: a warm dot with a soft glow on transparent.
 * The only chroma in the product is fire, and the icon is fire.
 */
import * as zlib from 'node:zlib';

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels as PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[y * (width * 4 + 1) + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An ember: bright core #FFE3A8 fading through #FFA850 to transparent. */
export function emberIcon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / R; // 0 centre → 1 edge
      const i = (y * size + x) * 4;
      // core to 0.32, glow to 1.0
      let r: number, g: number, b: number, a: number;
      if (d < 0.32) {
        const t = d / 0.32;
        r = 255; g = Math.round(227 - 40 * t); b = Math.round(168 - 90 * t); a = 255;
      } else {
        const t = Math.min(1, (d - 0.32) / 0.68);
        r = 255; g = Math.round(180 - 60 * t); b = Math.round(80 - 40 * t);
        a = Math.round(200 * Math.pow(1 - t, 2.2));
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return encodePng(size, size, px);
}
