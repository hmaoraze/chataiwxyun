import {
  adminSessionFromRequest,
  getPasskeys,
  resolveSecurity,
} from '../../_shared/auth.js';
import {
  clientConfig,
  loadConfig,
  requiredStatus,
} from '../../_shared/config.js';
import { VERSION } from '../../_shared/constants.js';
import {
  HttpError,
  handleError,
  isHttps,
  ok,
  preflight,
  requestOrigin,
} from '../../_shared/http.js';
import { openBusinessStore } from '../../_shared/store.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const env = context.env || {};
    const config = await loadConfig(env);
    const passkeys = await getPasskeys(env);
    const session = await adminSessionFromRequest(context.request, env);
    const security = resolveSecurity(context.request, config, env);
    const opened = openBusinessStore(config, env);
    const authenticated = Boolean(session);
    const meta = config.__meta || {};

    return ok({
      version: VERSION,
      initialized: passkeys.length > 0 || authenticated,
      passkey_count: passkeys.length,
      authenticated,
      csrf_token: authenticated ? session.csrf : '',
      request_origin: requestOrigin(context.request),
      cookie_secure: isHttps(context.request),
      security: {
        rp_id: security.rpId,
        public_origin: security.origin,
      },
      config_store: {
        mode: meta.configStoreMode,
        binding: meta.configStoreBinding,
        available: meta.configStoreAvailable,
      },
      storage: {
        mode: opened.mode,
        available: opened.available,
        binding: opened.bindingName || '',
        driver: config.storage.driver,
        error: opened.error || '',
      },
      master_key_source: meta.masterKeySource,
      env: {
        bootstrap_configured: Boolean(env.BOOTSTRAP_TOKEN),
        rp_id_override: Boolean(env.RP_ID),
        public_origin_override: Boolean(env.PUBLIC_ORIGIN),
      },
      config: authenticated ? clientConfig(config) : null,
      required: authenticated ? requiredStatus(config, meta) : null,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'GET') return onRequestGet(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET'));
}
