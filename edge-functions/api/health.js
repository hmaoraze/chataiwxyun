import { getPasskeys } from '../_shared/auth.js';
import { loadConfig, requiredStatus } from '../_shared/config.js';
import { VERSION } from '../_shared/constants.js';
import { HttpError, corsHeaders, handleError, ok, preflight } from '../_shared/http.js';
import { openBusinessStore } from '../_shared/store.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const config = await loadConfig(context.env || {});
    const passkeys = await getPasskeys(context.env || {});
    const opened = openBusinessStore(config, context.env || {});
    const required = requiredStatus(config, config.__meta || {});
    return ok(
      {
        version: VERSION,
        time: new Date().toISOString(),
        initialized: passkeys.length > 0,
        passkey_count: passkeys.length,
        config_complete: required.complete,
        config_store: {
          mode: config.__meta.configStoreMode,
          binding: config.__meta.configStoreBinding,
          available: config.__meta.configStoreAvailable,
        },
        storage: {
          mode: opened.mode,
          available: opened.available,
          binding: opened.bindingName || '',
          error: opened.error || '',
        },
        master_key_source: config.__meta.masterKeySource,
        deepseek_configured: Boolean(config.deepseek.apiKey),
        wechat_configured: Boolean(
          config.wechat.botToken && config.wechat.ilinkBotId && config.wechat.ilinkUserId
        ),
      },
      corsHeaders()
    );
  } catch (error) {
    return handleError(error, corsHeaders());
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'GET') return onRequestGet(context);
  return handleError(
    new HttpError(405, 'METHOD_NOT_ALLOWED', '健康检查仅支持 GET'),
    corsHeaders()
  );
}
