function readLength(view, offset, additional) {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) return { length: view.getUint8(offset), offset: offset + 1 };
  if (additional === 25) return { length: view.getUint16(offset, false), offset: offset + 2 };
  if (additional === 26) return { length: view.getUint32(offset, false), offset: offset + 4 };
  if (additional === 27) {
    const big = view.getBigUint64(offset, false);
    return { length: Number(big), offset: offset + 8 };
  }
  throw new Error('CBOR 长度字段不合法');
}

export function cborDecode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();

  function decode() {
    if (offset >= bytes.length) throw new Error('CBOR 数据提前结束');
    const initial = view.getUint8(offset);
    offset += 1;
    const major = initial >> 5;
    const additional = initial & 31;

    if (major === 0) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      return info.length;
    }
    if (major === 1) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      return -1 - info.length;
    }
    if (major === 2 || major === 3) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      const slice = bytes.slice(offset, offset + info.length);
      offset += info.length;
      return major === 2 ? slice : decoder.decode(slice);
    }
    if (major === 4) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      const array = [];
      for (let i = 0; i < info.length; i += 1) array.push(decode());
      return array;
    }
    if (major === 5) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      const map = new Map();
      for (let i = 0; i < info.length; i += 1) {
        const key = decode();
        const value = decode();
        map.set(key, value);
      }
      return map;
    }
    if (major === 6) {
      const info = readLength(view, offset, additional);
      offset = info.offset;
      return decode();
    }

    // major === 7
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    if (additional === 23) return undefined;
    if (additional === 25) {
      const half = view.getUint16(offset, false);
      offset += 2;
      const sign = half & 0x8000 ? -1 : 1;
      const exponent = (half >> 10) & 0x1f;
      const fraction = half & 0x3ff;
      if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
      if (exponent === 31) return fraction ? NaN : sign * Infinity;
      return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
    }
    if (additional === 26) {
      const value = view.getFloat32(offset, false);
      offset += 4;
      return value;
    }
    if (additional === 27) {
      const value = view.getFloat64(offset, false);
      offset += 8;
      return value;
    }
    if (additional === 24) {
      const value = view.getUint8(offset);
      offset += 1;
      return value;
    }
    throw new Error('不支持的 CBOR 简单值');
  }

  const value = decode();
  return { value, offset, bytesRead: offset };
}
