import { adminSessionFromRequest } from './auth.js';
import { loadConfig } from './config.js';
import { HttpError } from './http.js';
import { openBusinessStore } from './store.js';
import { constantTimeEqual } from './util.js';

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export async function loadApiContext(context, { requireServiceToken = false } = {}) {
  const { request, env = {} } = context;
  const config = await loadConfig(env);
  const opened = openBusinessStore(config, env);
  const token = bearerToken(request);

  if (token && config.api.serviceToken && constantTimeEqual(token, config.api.serviceToken)) {
    return {
      config,
      store: opened.store,
      storage: opened,
      auth: { kind: 'service', user: 'service' },
    };
  }

  if (config.api.allowAdminSessionForApi !== false && !requireServiceToken) {
    const session = await adminSessionFromRequest(request, env);
    if (session) {
      return {
        config,
        store: opened.store,
        storage: opened,
        auth: { kind: 'admin', session },
      };
    }
  }

  if (!config.api.serviceToken && !requireServiceToken) {
    throw new HttpError(503, 'SERVICE_NOT_CONFIGURED', '服务尚未完成配置');
  }
  throw new HttpError(401, 'UNAUTHORIZED', '无效的服务访问令牌');
}
