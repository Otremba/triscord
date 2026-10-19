// Converts a WOFF2 font to TrueType (sfnt) following the W3C WOFF2 specification, including the reversal of the
// glyf/loca transform. Local tool: it is used to turn fonts the user already has on this PC into files Qt can
// load. Usage: node woff2-to-ttf.cjs input.woff2 output.ttf
const fs = require("fs");
const zlib = require("zlib");

const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];

function readBase128(buffer, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[offset++];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, offset];
  }
  throw new Error("invalid UIntBase128");
}

class Reader {
  constructor(buffer) { this.b = buffer; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  u255() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return 253 + this.u8();
    if (code === 254) return 506 + this.u8();
    return code;
  }
}

function withSign(flag, value) { return flag & 1 ? value : -value; }

function decodeTriplet(flagByte, glyph) {
  const flag = flagByte & 0x7f;
  let dx, dy;
  if (flag < 10) { dx = 0; dy = withSign(flag, ((flag & 14) << 7) + glyph.u8()); }
  else if (flag < 20) { dx = withSign(flag, (((flag - 10) & 14) << 7) + glyph.u8()); dy = 0; }
  else if (flag < 84) {
    const b0 = flag - 20, b1 = glyph.u8();
    dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
    dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
  } else if (flag < 120) {
    const b0 = flag - 84, x = glyph.u8(), y = glyph.u8();
    dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + x);
    dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + y);
  } else if (flag < 124) {
    const b1 = glyph.u8(), b2 = glyph.u8(), b3 = glyph.u8();
    dx = withSign(flag, (b1 << 4) + (b2 >> 4));
    dy = withSign(flag >> 1, ((b2 & 0x0f) << 8) + b3);
  } else {
    const a = glyph.u8(), b = glyph.u8(), c = glyph.u8(), d = glyph.u8();
    dx = withSign(flag, (a << 8) + b);
    dy = withSign(flag >> 1, (c << 8) + d);
  }
  return [dx, dy];
}

function reverseGlyf(data) {
  const header = new Reader(data);
  header.u16(); // reserved
  header.u16(); // optionFlags
  const numGlyphs = header.u16(), indexFormat = header.u16();
  const sizes = [header.u32(), header.u32(), header.u32(), header.u32(), header.u32(), header.u32(), header.u32()];
  const [nContourSize, nPointsSize, flagSize, glyphSize, compositeSize, bboxSize, instructionSize] = sizes;
  const nContours = new Reader(header.bytes(nContourSize));
  const nPoints = new Reader(header.bytes(nPointsSize));
  const flags = new Reader(header.bytes(flagSize));
  const glyph = new Reader(header.bytes(glyphSize));
  const composite = new Reader(header.bytes(compositeSize));
  const bboxAll = header.bytes(bboxSize);
  const instructions = new Reader(header.bytes(instructionSize));
  const bitmapLength = 4 * Math.floor((numGlyphs + 31) / 32);
  const bitmap = bboxAll.subarray(0, bitmapLength);
  const bbox = new Reader(bboxAll.subarray(bitmapLength));
  const glyphs = [];
  for (let g = 0; g < numGlyphs; g++) {
    const contours = nContours.i16();
    const hasBox = !!(bitmap[g >> 3] & (0x80 >> (g & 7)));
    if (contours === 0) { glyphs.push(Buffer.alloc(0)); continue; }
    if (contours > 0) {
      const ends = []; let total = 0;
      for (let c = 0; c < contours; c++) { total += nPoints.u255(); ends.push(total - 1); }
      const xs = [], ys = [], on = []; let x = 0, y = 0;
      for (let p = 0; p < total; p++) {
        const flagByte = flags.u8();
        const [dx, dy] = decodeTriplet(flagByte, glyph);
        x += dx; y += dy; xs.push(x); ys.push(y); on.push(!(flagByte >> 7));
      }
      const instructionLength = glyph.u255();
      const code = instructions.bytes(instructionLength);
      let box;
      if (hasBox) box = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];
      else box = total ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
      // Simple glyph with full 16-bit coordinates and no flag repetition: valid and unambiguous.
      const out = Buffer.alloc(10 + contours * 2 + 2 + instructionLength + total + total * 4);
      let o = 0;
      out.writeInt16BE(contours, o); o += 2;
      for (const v of box) { out.writeInt16BE(v, o); o += 2; }
      for (const e of ends) { out.writeUInt16BE(e, o); o += 2; }
      out.writeUInt16BE(instructionLength, o); o += 2;
      code.copy(out, o); o += instructionLength;
      for (let p = 0; p < total; p++) out[o++] = on[p] ? 1 : 0;
      let px = 0; for (let p = 0; p < total; p++) { out.writeInt16BE(xs[p] - px, o); o += 2; px = xs[p]; }
      let py = 0; for (let p = 0; p < total; p++) { out.writeInt16BE(ys[p] - py, o); o += 2; py = ys[p]; }
      glyphs.push(out);
    } else {
      if (!hasBox) throw new Error("composite glyph without bbox");
      const box = [bbox.i16(), bbox.i16(), bbox.i16(), bbox.i16()];
      const start = composite.o; let more = true, haveInstructions = false;
      while (more) {
        const flag = composite.u16(); composite.u16();
        composite.o += flag & 1 ? 4 : 2;
        if (flag & 0x08) composite.o += 2; else if (flag & 0x40) composite.o += 4; else if (flag & 0x80) composite.o += 8;
        more = !!(flag & 0x20); haveInstructions = haveInstructions || !!(flag & 0x100);
      }
      const componentBytes = composite.b.subarray(start, composite.o);
      let code = Buffer.alloc(0), instructionLength = 0;
      if (haveInstructions) { instructionLength = glyph.u255(); code = instructions.bytes(instructionLength); }
      const out = Buffer.alloc(10 + componentBytes.length + (haveInstructions ? 2 + instructionLength : 0));
      out.writeInt16BE(-1, 0); box.forEach((v, i) => out.writeInt16BE(v, 2 + i * 2));
      componentBytes.copy(out, 10);
      if (haveInstructions) { out.writeUInt16BE(instructionLength, 10 + componentBytes.length); code.copy(out, 12 + componentBytes.length); }
      glyphs.push(out);
    }
  }
  // Rebuild glyf and a long-format loca (padded to 4 bytes).
  const offsets = []; let size = 0;
  for (const g of glyphs) { offsets.push(size); size += (g.length + 3) & ~3; }
  offsets.push(size);
  const glyf = Buffer.alloc(size); glyphs.forEach((g, i) => g.copy(glyf, offsets[i]));
  const loca = Buffer.alloc(offsets.length * 4); offsets.forEach((v, i) => loca.writeUInt32BE(v, i * 4));
  return { glyf, loca, indexFormat };
}

function checksum(buffer) {
  let sum = 0;
  const padded = Buffer.alloc((buffer.length + 3) & ~3); buffer.copy(padded);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function convert(input) {
  if (input.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error("not a WOFF2 file");
  const flavor = input.readUInt32BE(4), numTables = input.readUInt16BE(12), compressedSize = input.readUInt32BE(20);
  let offset = 48; const directory = [];
  for (let i = 0; i < numTables; i++) {
    const flags = input[offset++], index = flags & 0x3f;
    let tag;
    if (index === 63) { tag = input.subarray(offset, offset + 4).toString("latin1"); offset += 4; } else tag = KNOWN[index];
    const transform = flags >> 6;
    let originalLength, transformedLength;
    [originalLength, offset] = readBase128(input, offset);
    const transformed = tag === "glyf" || tag === "loca" ? transform === 0 : transform !== 0;
    if (transformed) [transformedLength, offset] = readBase128(input, offset); else transformedLength = originalLength;
    directory.push({ tag, originalLength, transformedLength, transformed });
  }
  const stream = zlib.brotliDecompressSync(input.subarray(offset, offset + compressedSize));
  let position = 0; const tables = new Map();
  for (const entry of directory) {
    tables.set(entry.tag, stream.subarray(position, position + entry.transformedLength));
    position += entry.transformedLength;
    if (entry.transformed && entry.tag !== "glyf" && entry.tag !== "loca") throw new Error("unsupported transform for " + entry.tag);
  }
  const rebuilt = reverseGlyf(tables.get("glyf"));
  tables.set("glyf", rebuilt.glyf); tables.set("loca", rebuilt.loca);
  const head = Buffer.from(tables.get("head")); head.writeInt16BE(1, 50); head.writeUInt32BE(0, 8); tables.set("head", head);
  const tags = [...tables.keys()].sort();
  const count = tags.length; let pow = 1, log = 0; while (pow * 2 <= count) { pow *= 2; log++; }
  const headerSize = 12 + 16 * count;
  let dataOffset = headerSize; const records = []; const chunks = [];
  for (const tag of tags) {
    const data = tables.get(tag); const padded = Buffer.alloc((data.length + 3) & ~3); data.copy(padded);
    records.push({ tag, checksum: checksum(data), offset: dataOffset, length: data.length });
    chunks.push(padded); dataOffset += padded.length;
  }
  const out = Buffer.alloc(dataOffset);
  out.writeUInt32BE(flavor, 0); out.writeUInt16BE(count, 4); out.writeUInt16BE(pow * 16, 6); out.writeUInt16BE(log, 8); out.writeUInt16BE(count * 16 - pow * 16, 10);
  records.forEach((r, i) => { const o = 12 + i * 16; out.write(r.tag, o, 4, "latin1"); out.writeUInt32BE(r.checksum, o + 4); out.writeUInt32BE(r.offset, o + 8); out.writeUInt32BE(r.length, o + 12); });
  let o = headerSize; for (const chunk of chunks) { chunk.copy(out, o); o += chunk.length; }
  const headRecord = records.find((r) => r.tag === "head");
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headRecord.offset + 8);
  return out;
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) { console.error("usage: node woff2-to-ttf.cjs input.woff2 output.ttf"); process.exit(2); }
fs.writeFileSync(outputPath, convert(fs.readFileSync(inputPath)));
console.log("wrote " + outputPath);
