const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function nowMs() {
  return Date.now();
}

export function utf8(value) {
  return encoder.encode(String(value));
}

export function decodeUtf8(bytes) {
  return decoder.decode(bytes);
}

export function randomBytes(length = 16) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomHex(bytes = 16) {
  return toHex(randomBytes(bytes));
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(bytes = 12) {
  const raw = randomBytes(bytes);
  let out = '';
  for (const b of raw) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? utf8(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value) {
  const text = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256(input) {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(input) {
  return toHex(await sha256(input));
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function constantTimeEqual(a, b) {
  const left = typeof a === 'string' ? utf8(a) : new Uint8Array(a);
  const right = typeof b === 'string' ? utf8(b) : new Uint8Array(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function extractJson(text) {
  if (!text) return null;
  const clean = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const direct = safeJsonParse(clean);
  if (direct) return direct;
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return safeJsonParse(clean.slice(start, end + 1));
  }
  return null;
}

export function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeUserId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  return id.slice(0, 128);
}

export function userHash(userId) {
  // 键只允许字母数字下划线，因此对用户 ID 做哈希
  return sha256Hex(userId).then((hex) => hex.slice(0, 24));
}

export function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

export function daysFromNow(days) {
  return Date.now() + days * 86400000;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
