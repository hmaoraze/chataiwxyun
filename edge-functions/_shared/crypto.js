import {
  b64urlDecode,
  b64urlEncode,
  decodeUtf8,
  randomBytes,
  sha256,
  utf8,
} from './util.js';

export async function deriveAesKey(secret) {
  const digest = await sha256(`edgeone-memory-bot::${secret}`);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealJson(payload, secret) {
  const key = await deriveAesKey(secret);
  const iv = randomBytes(12);
  const plain = utf8(JSON.stringify(payload));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(cipher)}`;
}

export async function unsealJson(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const key = await deriveAesKey(secret);
    const iv = b64urlDecode(parts[1]);
    const cipher = b64urlDecode(parts[2]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(decodeUtf8(new Uint8Array(plain)));
  } catch {
    return null;
  }
}

export async function encryptSecret(value, secret) {
  const key = await deriveAesKey(secret);
  const iv = randomBytes(12);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(String(value)))
  );
  return `enc1.${b64urlEncode(iv)}.${b64urlEncode(cipher)}`;
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith('enc1.');
}

export async function decryptSecret(value, secret) {
  if (!value) return '';
  if (!isEncryptedSecret(value)) return String(value);
  try {
    const parts = value.split('.');
    if (parts.length !== 3) return '';
    const key = await deriveAesKey(secret);
    const iv = b64urlDecode(parts[1]);
    const cipher = b64urlDecode(parts[2]);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return decodeUtf8(new Uint8Array(plain));
  } catch {
    return '';
  }
}

export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '********';
  return `****${text.slice(-4)}`;
}
