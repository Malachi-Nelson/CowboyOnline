// Byte-level reader and writer for the wire format. Little-endian throughout.
const enc = new TextEncoder(), dec = new TextDecoder();

export class Writer {
  constructor(size = 2048) {
    this.u8a = new Uint8Array(size);
    this.dv = new DataView(this.u8a.buffer);
    this.o = 0;
  }
  reset() { this.o = 0; return this; }
  u8(v) { this.dv.setUint8(this.o, v); this.o += 1; }
  i8(v) { this.dv.setInt8(this.o, v); this.o += 1; }
  u16(v) { this.dv.setUint16(this.o, v, true); this.o += 2; }
  i16(v) { this.dv.setInt16(this.o, v, true); this.o += 2; }
  u24(v) { this.dv.setUint16(this.o, v & 0xffff, true); this.dv.setUint8(this.o + 2, (v >>> 16) & 0xff); this.o += 3; }
  u32(v) { this.dv.setUint32(this.o, v, true); this.o += 4; }
  f32(v) { this.dv.setFloat32(this.o, v, true); this.o += 4; }
  f64(v) { this.dv.setFloat64(this.o, v, true); this.o += 8; }
  // unsigned varint: 7 bits a byte, low bits first
  varu(v) { v >>>= 0; while (v > 127) { this.u8((v & 127) | 128); v >>>= 7; } this.u8(v); }
  // signed varint (zigzag), for small deltas either way
  vari(v) { this.varu(((v << 1) ^ (v >> 31)) >>> 0); }
  // a short string: one length byte, then UTF-8, cut at 255 bytes
  str(s) {
    const b = enc.encode(String(s || '')), n = Math.min(255, b.length);
    this.u8(n); this.u8a.set(n === b.length ? b : b.subarray(0, n), this.o); this.o += n;
  }
  setU8(at, v) { this.dv.setUint8(at, v); }
  bytes() { return this.u8a.slice(0, this.o); }       // a copy the caller owns
}

export class Reader {
  constructor(u8a) { this.set(u8a); }
  set(u8a) {
    this.u8a = u8a;
    this.dv = new DataView(u8a.buffer, u8a.byteOffset, u8a.byteLength);
    this.o = 0; this.n = u8a.byteLength;
    return this;
  }
  get left() { return this.n - this.o; }
  // DataView throws a RangeError past the end, so a short or hostile message cannot read out of bounds
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8() { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u24() { const v = this.dv.getUint16(this.o, true) | (this.dv.getUint8(this.o + 2) << 16); this.o += 3; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  varu() { let v = 0, s = 0, b; do { b = this.u8(); v |= (b & 127) << s; s += 7; } while (b & 128 && s < 35); return v >>> 0; }
  vari() { const v = this.varu(); return (v >>> 1) ^ -(v & 1); }
  str() { const n = this.u8(); if (this.o + n > this.n) throw new RangeError('string past end'); const s = dec.decode(this.u8a.subarray(this.o, this.o + n)); this.o += n; return s; }
}
