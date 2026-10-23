import { cborDecode } from './cbor.js';
import {
  b64urlEncode,
  concatBytes,
  constantTimeEqual,
  decodeUtf8,
  sha256,
} from './util.js';

const FLAG_UP = 0x01;
const FLAG_AT = 0x40;

function parseAuthData(bytes) {
  if (bytes.length < 37) throw new Error('authenticatorData 长度不足');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const counter = view.getUint32(33, false);
  let credentialId = null;
  let publicKeyBytes = null;
  if (flags & FLAG_AT) {
    if (bytes.length < 55) throw new Error('attestedCredentialData 长度不足');
    const credentialIdLength = view.getUint16(53, false);
    const start = 55;
    const end = start + credentialIdLength;
    if (end > bytes.length) throw new Error('credentialId 长度不合法');
    credentialId = bytes.slice(start, end);
    publicKeyBytes = bytes.slice(end);
  }
  return { rpIdHash, flags, counter, credentialId, publicKeyBytes };
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error('COSE 公钥格式不合法');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
      throw new Error('仅支持 P-256 的 EC 公钥');
    }
    if (alg !== -7) throw new Error('仅支持 ES256 算法');
    return {
      alg,
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: b64urlEncode(x),
        y: b64urlEncode(y),
        ext: true,
      },
    };
  }
  if (kty === 3) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error('RSA 公钥字段不合法');
    }
    if (alg !== -257) throw new Error('仅支持 RS256 算法');
    return {
      alg,
      jwk: {
        kty: 'RSA',
        n: b64urlEncode(n),
        e: b64urlEncode(e),
        alg: 'RS256',
        ext: true,
      },
    };
  }
  throw new Error('不支持的 COSE 公钥类型');
}

function readDerLength(bytes, offset) {
  let length = bytes[offset];
  let consumed = 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 2) throw new Error('DER 长度不合法');
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[offset + 1 + i];
    consumed = 1 + count;
  }
  return { length, consumed };
}

function es256SignatureToRaw(signature) {
  if (signature.length === 64) return signature;
  const bytes = new Uint8Array(signature);
  if (bytes[0] !== 0x30) throw new Error('ECDSA 签名格式不合法');
  let offset = 1;
  const sequence = readDerLength(bytes, offset);
  offset += sequence.consumed;
  if (bytes[offset] !== 0x02) throw new Error('签名缺少 R 整数');
  offset += 1;
  const rInfo = readDerLength(bytes, offset);
  offset += rInfo.consumed;
  const r = bytes.slice(offset, offset + rInfo.length);
  offset += rInfo.length;
  if (bytes[offset] !== 0x02) throw new Error('签名缺少 S 整数');
  offset += 1;
  const sInfo = readDerLength(bytes, offset);
  offset += sInfo.consumed;
  const s = bytes.slice(offset, offset + sInfo.length);

  const out = new Uint8Array(64);
  const copyInt = (value, start) => {
    let trimmed = value;
    while (trimmed.length > 32 && trimmed[0] === 0) trimmed = trimmed.slice(1);
    if (trimmed.length > 32) throw new Error('ECDSA 整数长度超限');
    out.set(trimmed, start + (32 - trimmed.length));
  };
  copyInt(r, 0);
  copyInt(s, 32);
  return out;
}

async function importVerifyKey(jwk, alg) {
  if (alg === -7) {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  }
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function verifySignature(jwk, alg, signature, data) {
  const key = await importVerifyKey(jwk, alg);
  if (alg === -7) {
    const raw = es256SignatureToRaw(signature);
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      raw,
      data
    );
  }
  return crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature,
    data
  );
}

export function parseClientData(clientDataJSON) {
  const bytes = new Uint8Array(clientDataJSON);
  const data = JSON.parse(decodeUtf8(bytes));
  return { data, bytes };
}

function checkClientData(clientData, expectedChallenge, expectedOrigin, type) {
  if (clientData.type !== type) throw new Error('clientData.type 不匹配');
  if (String(clientData.challenge) !== String(expectedChallenge)) {
    throw new Error('challenge 不匹配');
  }
  const origin = String(expectedOrigin || '').replace(/\/$/, '');
  const actual = String(clientData.origin || '').replace(/\/$/, '');
  if (origin && actual !== origin) throw new Error('origin 不匹配');
  if (clientData.crossOrigin === true) throw new Error('不允许跨域认证');
}

export async function verifyRegistration({
  clientDataJSON,
  attestationObject,
  expectedChallenge,
  expectedOrigin,
  rpId,
}) {
  const { data: clientData } = parseClientData(clientDataJSON);
  checkClientData(clientData, expectedChallenge, expectedOrigin, 'webauthn.create');

  const decoded = cborDecode(new Uint8Array(attestationObject));
  const attestation = decoded.value;
  if (!(attestation instanceof Map)) throw new Error('attestationObject 格式不合法');
  const authData = attestation.get('authData');
  if (!(authData instanceof Uint8Array)) throw new Error('缺少 authData');
  const parsed = parseAuthData(authData);
  if (!(parsed.flags & FLAG_UP)) throw new Error('用户未完成身份验证');
  if (!(parsed.flags & FLAG_AT)) throw new Error('缺少凭证公钥');

  const expectedRpIdHash = await sha256(rpId);
  if (!constantTimeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('rpIdHash 不匹配');
  }
  const cose = cborDecode(parsed.publicKeyBytes).value;
  const { jwk, alg } = coseToJwk(cose);

  return {
    credentialId: b64urlEncode(parsed.credentialId),
    publicKey: jwk,
    algorithm: alg,
    counter: parsed.counter,
    fmt: attestation.get('fmt') || 'none',
  };
}

export async function verifyAssertion({
  clientDataJSON,
  authenticatorData,
  signature,
  expectedChallenge,
  expectedOrigin,
  rpId,
  publicKey,
  algorithm,
  storedCounter,
}) {
  const { data: clientData } = parseClientData(clientDataJSON);
  checkClientData(clientData, expectedChallenge, expectedOrigin, 'webauthn.get');

  const authBytes = new Uint8Array(authenticatorData);
  const parsed = parseAuthData(authBytes);
  if (!(parsed.flags & FLAG_UP)) throw new Error('用户未完成身份验证');
  const expectedRpIdHash = await sha256(rpId);
  if (!constantTimeEqual(parsed.rpIdHash, expectedRpIdHash)) {
    throw new Error('rpIdHash 不匹配');
  }

  const clientHash = await sha256(new Uint8Array(clientDataJSON));
  const signed = concatBytes(authBytes.slice(0, 37), clientHash);
  const valid = await verifySignature(
    publicKey,
    algorithm,
    new Uint8Array(signature),
    signed
  );
  if (!valid) throw new Error('签名校验失败');

  const previous = Number(storedCounter) || 0;
  if (parsed.counter !== 0 || previous !== 0) {
    if (parsed.counter <= previous) throw new Error('签名计数器未递增，可能被克隆');
  }
  return { counter: parsed.counter, userVerified: Boolean(parsed.flags & 0x04) };
}
