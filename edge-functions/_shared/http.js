const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function mergeHeaders(extraHeaders = {}) {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders instanceof Headers) {
    extraHeaders.forEach((value, key) => headers.append(key, value));
    return headers;
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: mergeHeaders(extraHeaders),
  });
}

export function ok(data = null, extraHeaders = {}) {
  return json({ ok: true, data }, 200, extraHeaders);
}

export function fail(error, extraHeaders = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message =
    error instanceof HttpError ? error.message : '服务内部错误，请稍后重试';
  const body = { ok: false, error: { code, message } };
  if (error instanceof HttpError && error.details) body.error.details = error.details;
  return json(body, status, extraHeaders);
}

export async function handleError(error, extraHeaders = {}) {
  if (!(error instanceof HttpError)) {
    console.error('[unhandled]', error && (error.stack || error.message || error));
  }
  return fail(error, extraHeaders);
}

export async function readJson(request, limit = 1024 * 1024) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过 1MB 限制');
  }
  const text = await request.text();
  if (!text) return {};
  if (text.length > limit) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过 1MB 限制');
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体不是合法的 JSON 对象');
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}

export function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value || '')}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

export function appendCookie(headers, cookie) {
  headers.append('Set-Cookie', cookie);
}

export function clearCookie(name) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

export function requestOrigin(request) {
  const url = new URL(request.url);
  return url.origin;
}

export function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    'unknown'
  );
}

export function assertSameOrigin(request, expectedOrigin) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = expectedOrigin || requestOrigin(request);
  if (origin.replace(/\/$/, '') !== allowed.replace(/\/$/, '')) {
    throw new HttpError(403, 'ORIGIN_MISMATCH', '请求来源不合法');
  }
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token',
    'Access-Control-Max-Age': '86400',
  };
}

export function preflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function methodNotAllowed(allowed) {
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', `仅支持 ${allowed.join('/')} 方法`);
}

export function sseResponse(stream, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    headers.set(key, String(value));
  }
  return new Response(stream, { status: 200, headers });
}

export function sseWriter() {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let closed = false;
  return {
    readable,
    async send(event, data) {
      if (closed) return;
      try {
        await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        closed = true;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writer.close();
      } catch {
        /* 客户端可能已断开 */
      }
    },
  };
}
