/**
 * base64 编解码（纯 JS，不依赖 `btoa` / `atob`）。
 *
 * 为什么不用原生的：输入帧会同时经过主窗口和 Engine Worker。`btoa` 在两边都存在，
 * 但它只接受「每字符 ≤ 0xFF」的字符串，一不小心就会得到 `InvalidCharacterError`；
 * 而 `atob` 对填充符的宽容度也不一致。两端算出来的字节必须完全相同，所以这里
 * 自己实现一份，行为只由这段代码决定。
 *
 * 只用于把 39~200 字节的输入包塞进 `sendAction` 的 JSON（平台这条通道只收 JSON）。
 * 大文件不要用它。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/** 非法字符与错误填充一律当 0 处理 —— 网络包不该让整局崩在解码上。 */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const chars = clean.length;
  if (chars === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(Math.floor((chars * 3) / 4));
  let byteIndex = 0;
  for (let i = 0; i < chars; i += 4) {
    const c0 = LOOKUP[clean.charCodeAt(i)] ?? -1;
    const c1 = LOOKUP[clean.charCodeAt(i + 1)] ?? -1;
    const c2 = i + 2 < chars ? LOOKUP[clean.charCodeAt(i + 2)] ?? -1 : 0;
    const c3 = i + 3 < chars ? LOOKUP[clean.charCodeAt(i + 3)] ?? -1 : 0;
    const v0 = c0 < 0 ? 0 : c0;
    const v1 = c1 < 0 ? 0 : c1;
    const v2 = c2 < 0 ? 0 : c2;
    const v3 = c3 < 0 ? 0 : c3;
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (triple >> 16) & 0xff;
    if (i + 2 < chars && byteIndex < bytes.length) bytes[byteIndex++] = (triple >> 8) & 0xff;
    if (i + 3 < chars && byteIndex < bytes.length) bytes[byteIndex++] = triple & 0xff;
  }
  return bytes.subarray(0, byteIndex);
}
