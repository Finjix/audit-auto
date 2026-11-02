/**
 * Writes the boxes of a small MP4 the way encoders lay them out, for the header tests: ftyp, then either mdat before moov (a plain
 * export) or moov first (faststart), with a movie header and one video track whose picture may be stored on its side (phone videos).
 */
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};

export interface Mp4 { seconds: number; width: number; height: number; rotated?: boolean; moovFirst?: boolean; version1?: boolean; payload?: number }

export function makeMp4(options: Mp4): Buffer {
  const scale = 1000;
  const length = Math.round(options.seconds * scale);
  const v1 = options.version1 === true;
  const mvhd = Buffer.alloc(v1 ? 112 : 100);
  mvhd[0] = v1 ? 1 : 0;
  if (v1) { mvhd.writeUInt32BE(scale, 20); mvhd.writeBigUInt64BE(BigInt(length), 24); } else { mvhd.writeUInt32BE(scale, 12); mvhd.writeUInt32BE(length, 16); }
  const tkhd = Buffer.alloc(v1 ? 96 : 84);
  tkhd[0] = v1 ? 1 : 0;
  const base = v1 ? 36 : 24;
  // The display matrix: identity, or 90° (a = 0, b = 1, c = -1, d = 0).
  const matrix = options.rotated ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  matrix.forEach((value, i) => tkhd.writeInt32BE(value, base + 16 + i * 4));
  tkhd.writeUInt32BE(options.width * 65536, base + 52);
  tkhd.writeUInt32BE(options.height * 65536, base + 56);
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8, 'latin1');
  const sound = box('trak', box('tkhd', Buffer.alloc(84)), box('mdia', box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('soun', 'latin1'), Buffer.alloc(12)]))));
  const moov = box('moov', box('mvhd', mvhd), sound, box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(options.payload ?? 4096, 1));
  return Buffer.concat(options.moovFirst ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}
