const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  const totalLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_CHARS[(triplet >>> 18) & 63]!;
    out += BASE64_CHARS[(triplet >>> 12) & 63]!;
    out += i + 1 < bytes.length ? BASE64_CHARS[(triplet >>> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? BASE64_CHARS[triplet & 63]! : '=';
  }
  return out;
}

function fromBase64(encoded: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(encoded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  const clean = encoded.replace(/=+$/, '');
  const outLen = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let pos = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i]!);
    const c1 = BASE64_CHARS.indexOf(clean[i + 1]!);
    const c2 = i + 2 < clean.length ? BASE64_CHARS.indexOf(clean[i + 2]!) : 0;
    const c3 = i + 3 < clean.length ? BASE64_CHARS.indexOf(clean[i + 3]!) : 0;
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (pos < outLen) out[pos++] = (triplet >>> 16) & 0xff;
    if (pos < outLen) out[pos++] = (triplet >>> 8) & 0xff;
    if (pos < outLen) out[pos++] = triplet & 0xff;
  }
  return out;
}

function deriveStreamBlock(
  key: Uint8Array,
  iv: Uint8Array,
  counter: number,
): Uint8Array {
  const input = new Uint8Array(key.length + iv.length + 4);
  input.set(key, 0);
  input.set(iv, key.length);
  const view = new DataView(input.buffer);
  view.setUint32(key.length + iv.length, counter >>> 0, false);
  return sha256(input);
}

function computeTag(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(key.length + iv.length + ciphertext.length);
  buf.set(key, 0);
  buf.set(iv, key.length);
  buf.set(ciphertext, key.length + iv.length);
  return sha256(buf);
}

function xorCtr(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(data.length);
  let counter = 0;
  for (let offset = 0; offset < data.length; offset += 32) {
    const block = deriveStreamBlock(key, iv, counter++);
    const end = Math.min(32, data.length - offset);
    for (let i = 0; i < end; i++) {
      out[offset + i] = data[offset + i]! ^ block[i]!;
    }
  }
  return out;
}

export function generateReconnectToken(): string {
  const bytes = randomBytes(18);
  return toBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export interface EncryptedCheckpoint {
  ivBase64: string;
  ciphertextBase64: string;
  keyBase64: string;
}

export function encryptCheckpoint(plaintext: string): EncryptedCheckpoint {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const plainBytes = new TextEncoder().encode(plaintext);
  const cipher = xorCtr(plainBytes, key, iv);
  const tag = computeTag(key, iv, cipher);
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher, 0);
  combined.set(tag, cipher.length);
  return {
    ivBase64: toBase64(iv),
    ciphertextBase64: toBase64(combined),
    keyBase64: toBase64(key),
  };
}

export function decryptCheckpoint(
  ivBase64: string,
  ciphertextBase64: string,
  keyBase64: string,
): string | null {
  try {
    const iv = fromBase64(ivBase64);
    const combined = fromBase64(ciphertextBase64);
    const key = fromBase64(keyBase64);
    if (iv.length !== 16 || key.length !== 32 || combined.length < 32) {
      return null;
    }
    const cipher = combined.subarray(0, combined.length - 32);
    const providedTag = combined.subarray(combined.length - 32);
    const expectedTag = computeTag(key, iv, cipher);
    let diff = 0;
    for (let i = 0; i < 32; i++) {
      diff |= providedTag[i]! ^ expectedTag[i]!;
    }
    if (diff !== 0) {
      return null;
    }
    const plainBytes = xorCtr(cipher, key, iv);
    return new TextDecoder().decode(plainBytes);
  } catch {
    return null;
  }
}
