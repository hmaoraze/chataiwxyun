import { requireAdmin } from '../../_shared/auth.js';
import { loadConfig, requiredStatus } from '../../_shared/config.js';
import { HttpError, handleError, ok, preflight } from '../../_shared/http.js';
import { isExpired } from '../../_shared/session.js';
import { listAll, openBusinessStore, sanitizePrefix } from '../../_shared/store.js';

const SESSION_SCAN_LIMIT = 1000;
const MEMORY_SCAN_LIMIT = 2000;

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(context) {
  try {
    const env = context.env || {};
    await requireAdmin(context.request, env);
    const config = await loadConfig(env);
    const meta = config.__meta || {};
    const opened = openBusinessStore(config, env);
    const store = opened.store;
    const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
    const now = Date.now();

    const [sessionKeys, memoryKeys, userKeys] = await Promise.all([
      listAll(store, `${prefix}_sess_`, SESSION_SCAN_LIMIT),
      listAll(store, `${prefix}_mem_`, MEMORY_SCAN_LIMIT),
      listAll(store, `${prefix}_active_`, 500),
    ]);

    let active = 0;
    let expired = 0;
    let ended = 0;
    let turns = 0;
    let today = 0;
    let latest = 0;

    for (const key of sessionKeys) {
      const session = await store.getJson(key);
      if (!session) continue;
      const updated = Number(session.updatedAt) || 0;
      if (updated > latest) latest = updated;
      if (updated > now - 86400000) today += 1;
      turns += Number(session.turnCount) || 0;
      if (session.status === 'active') {
        if (isExpired(session, now)) expired += 1;
        else active += 1;
      } else {
        ended += 1;
      }
    }

    return ok({
      version: config.__meta.version,
      time: new Date(now).toISOString(),
      sessions: {
        total: sessionKeys.length,
        active,
        expired_pending: expired,
        ended,
        turns,
        last_24h: today,
        latest_updated_at: latest ? new Date(latest).toISOString() : null,
        sampled: sessionKeys.length >= SESSION_SCAN_LIMIT,
      },
      memories: {
        total: memoryKeys.length,
        sampled: memoryKeys.length >= MEMORY_SCAN_LIMIT,
        limit_per_user: config.memory.maxItems,
      },
      users: {
        active_sessions: userKeys.length,
        sampled: userKeys.length >= 500,
      },
      storage: {
        mode: opened.mode,
        driver: config.storage.driver,
        available: opened.available,
        binding: opened.bindingName || '',
        warning: opened.error || '',
      },
      config_store: {
        mode: meta.configStoreMode,
        binding: meta.configStoreBinding,
        available: meta.configStoreAvailable,
      },
      master_key_source: meta.masterKeySource,
      required: requiredStatus(config, meta),
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
