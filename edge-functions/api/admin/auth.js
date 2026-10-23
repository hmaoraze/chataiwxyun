import {
  addPasskey,
  assertCsrf,
  clearAdminCookies,
  clearChallenge,
  clearSetupSession,
  consumeSetupToken,
  createAdminSession,
  getPasskeys,
  readChallenge,
  readSetupSession,
  requireAdmin,
  resolveSecurity,
  sealChallenge,
  sealSetupSession,
  touchPasskey,
  validateSetupToken,
} from '../../_shared/auth.js';
import { loadConfig, saveConfig } from '../../_shared/config.js';
import {
  HttpError,
  clientIp,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { rateLimit } from '../../_shared/rate-limit.js';
import { b64urlDecode, b64urlEncode, randomBytes, truncateText } from '../../_shared/util.js';
import { verifyAssertion, verifyRegistration } from '../../_shared/webauthn.js';

const RP_NAME = 'DeepSeek 记忆机器人控制台';

function credentialFrom(body) {
  const credential = body.credential || {};
  const response = credential.response || {};
  if (!credential.id || !response.clientDataJSON) {
    throw new HttpError(400, 'CREDENTIAL_REQUIRED', '缺少 WebAuthn 凭证');
  }
  return { credential, response };
}

async function bootstrapVerify(context, body) {
  const env = context.env || {};
  const request = context.request;
  await rateLimit(env, {
    bucket: 'bootstrap',
    key: clientIp(request),
    limit: 20,
    windowSeconds: 600,
  });
  const token = String(body.token || '').trim();
  if (!token) throw new HttpError(400, 'TOKEN_REQUIRED', '缺少安全链接令牌');
  const info = await validateSetupToken(env, token);
  if (!info) {
    throw new HttpError(401, 'INVALID_SETUP_TOKEN', '安全链接无效、已过期或已被使用');
  }
  const config = await loadConfig(env);
  const security = resolveSecurity(request, config, env);
  if (!config.security.publicOrigin || !config.security.rpId) {
    await saveConfig(env, {
      security: { publicOrigin: security.origin, rpId: security.rpId },
    });
  }
  const headers = new Headers();
  await sealSetupSession(
    request,
    headers,
    {
      setupHash: info.hash,
      setupKind: info.kind,
      label: info.label,
      rpId: security.rpId,
      origin: security.origin,
    },
    env
  );
  return ok({ rp_id: security.rpId, origin: security.origin, next: 'register' }, headers);
}

async function registerBegin(context, body) {
  const env = context.env || {};
  const request = context.request;
  const setup = await readSetupSession(request, env);
  let addMode = false;
  let rpId;
  let origin;
  let label;
  let session = null;

  if (setup) {
    rpId = setup.rpId;
    origin = setup.origin;
    label = String(body.label || setup.label || '主安全密钥').slice(0, 60);
  } else {
    session = await requireAdmin(request, env);
    assertCsrf(request, session);
    const config = await loadConfig(env);
    const security = resolveSecurity(request, config, env);
    rpId = security.rpId;
    origin = security.origin;
    label = String(body.label || '备用安全密钥').slice(0, 60);
    addMode = true;
  }

  const passkeys = await getPasskeys(env);
  const challenge = b64urlEncode(randomBytes(32));
  const publicKey = {
    challenge,
    rp: { name: RP_NAME, id: rpId },
    user: {
      id: b64urlEncode(randomBytes(16)),
      name: `admin@${rpId}`,
      displayName: label,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    timeout: 60000,
    attestation: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'preferred',
    },
    excludeCredentials: passkeys.map((passkey) => ({
      type: 'public-key',
      id: passkey.id,
      transports: passkey.transports || [],
    })),
  };

  const headers = new Headers();
  await sealChallenge(
    request,
    headers,
    {
      challenge,
      type: 'register',
      rpId,
      origin,
      add: addMode,
      setupHash: setup?.setupHash || '',
      setupKind: setup?.setupKind || '',
      label,
    },
    env
  );
  return ok(
    { public_key: publicKey, mode: addMode ? 'add' : 'setup', rp_id: rpId, origin },
    headers
  );
}

async function registerFinish(context, body) {
  const env = context.env || {};
  const request = context.request;
  const challenge = await readChallenge(request, env);
  if (!challenge || challenge.type !== 'register') {
    throw new HttpError(400, 'CHALLENGE_EXPIRED', '注册挑战已过期，请重新开始');
  }
  let session = null;
  if (challenge.add) {
    session = await requireAdmin(request, env);
    assertCsrf(request, session);
  } else if (!challenge.setupHash) {
    throw new HttpError(400, 'SETUP_REQUIRED', '请通过安全链接进入配置流程');
  }

  const { credential, response } = credentialFrom(body);
  let verified;
  try {
    verified = await verifyRegistration({
      clientDataJSON: b64urlDecode(response.clientDataJSON),
      attestationObject: b64urlDecode(response.attestationObject),
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      rpId: challenge.rpId,
    });
  } catch (error) {
    throw new HttpError(400, 'WEBAUTHN_FAILED', `安全密钥注册校验失败：${error.message}`);
  }

  const passkey = {
    id: verified.credentialId,
    publicKey: verified.publicKey,
    algorithm: verified.algorithm,
    counter: verified.counter,
    label: String(body.label || challenge.label || '安全密钥').slice(0, 60),
    transports: Array.isArray(response.transports)
      ? response.transports.slice(0, 5)
      : [],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    userAgent: truncateText(request.headers.get('user-agent') || '', 140),
  };
  await addPasskey(env, passkey);

  const headers = new Headers();
  clearChallenge(headers);
  if (!challenge.add) {
    await consumeSetupToken(env, {
      kind: challenge.setupKind,
      hash: challenge.setupHash,
    });
    clearSetupSession(headers);
  }
  const admin = challenge.add && session
    ? session
    : await createAdminSession(request, headers, passkey.id, env);
  return ok(
    {
      authenticated: true,
      passkey_id: passkey.id,
      csrf_token: admin.csrf,
      mode: challenge.add ? 'add' : 'setup',
    },
    headers
  );
}

async function loginBegin(context) {
  const env = context.env || {};
  const request = context.request;
  await rateLimit(env, {
    bucket: 'login',
    key: clientIp(request),
    limit: 20,
    windowSeconds: 600,
  });
  const passkeys = await getPasskeys(env);
  if (!passkeys.length) {
    throw new HttpError(409, 'NOT_INITIALIZED', '尚未注册安全密钥，请使用安全链接完成首次配置');
  }
  const config = await loadConfig(env);
  const security = resolveSecurity(request, config, env);
  const challenge = b64urlEncode(randomBytes(32));
  const publicKey = {
    challenge,
    rpId: security.rpId,
    timeout: 60000,
    userVerification: 'preferred',
    allowCredentials: passkeys.map((passkey) => ({
      type: 'public-key',
      id: passkey.id,
      transports: passkey.transports || [],
    })),
  };
  const headers = new Headers();
  await sealChallenge(
    request,
    headers,
    {
      challenge,
      type: 'login',
      rpId: security.rpId,
      origin: security.origin,
    },
    env
  );
  return ok(
    { public_key: publicKey, rp_id: security.rpId, origin: security.origin },
    headers
  );
}

async function loginFinish(context, body) {
  const env = context.env || {};
  const request = context.request;
  await rateLimit(env, {
    bucket: 'login',
    key: clientIp(request),
    limit: 20,
    windowSeconds: 600,
  });
  const challenge = await readChallenge(request, env);
  if (!challenge || challenge.type !== 'login') {
    throw new HttpError(400, 'CHALLENGE_EXPIRED', '登录挑战已过期，请重新登录');
  }
  const { credential, response } = credentialFrom(body);
  if (!response.authenticatorData || !response.signature) {
    throw new HttpError(400, 'CREDENTIAL_REQUIRED', '缺少认证器数据或签名');
  }
  const passkeys = await getPasskeys(env);
  const passkey = passkeys.find((item) => item.id === credential.id);
  if (!passkey) throw new HttpError(401, 'PASSKEY_UNKNOWN', '安全密钥未注册');

  let verified;
  try {
    verified = await verifyAssertion({
      clientDataJSON: b64urlDecode(response.clientDataJSON),
      authenticatorData: b64urlDecode(response.authenticatorData),
      signature: b64urlDecode(response.signature),
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      rpId: challenge.rpId,
      publicKey: passkey.publicKey,
      algorithm: passkey.algorithm,
      storedCounter: passkey.counter,
    });
  } catch (error) {
    throw new HttpError(401, 'WEBAUTHN_FAILED', `安全密钥验证失败：${error.message}`);
  }
  await touchPasskey(env, passkey.id, verified.counter);

  const headers = new Headers();
  clearChallenge(headers);
  const session = await createAdminSession(request, headers, passkey.id, env);
  return ok(
    {
      authenticated: true,
      passkey_id: passkey.id,
      csrf_token: session.csrf,
    },
    headers
  );
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const action = String(body.action || '');
    if (action === 'bootstrap_verify') return await bootstrapVerify(context, body);
    if (action === 'register_begin') return await registerBegin(context, body);
    if (action === 'register_finish') return await registerFinish(context, body);
    if (action === 'login_begin') return await loginBegin(context);
    if (action === 'login_finish') return await loginFinish(context, body);
    if (action === 'logout') {
      const headers = new Headers();
      clearAdminCookies(headers);
      return ok({ authenticated: false }, headers);
    }
    throw new HttpError(400, 'UNKNOWN_ACTION', `未知操作：${action}`);
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST'));
}
