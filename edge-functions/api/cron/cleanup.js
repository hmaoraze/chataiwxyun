import { loadConfig } from '../../_shared/config.js';
import {
  HttpError,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { finalizeSession, isExpired } from '../../_shared/session.js';
import {
  listAll,
  openBusinessStore,
  openConfigStore,
  sanitizePrefix,
} from '../../_shared/store.js';
import { constantTimeEqual, sha256Hex } from '../../_shared/util.js';

const MAX_FINALIZE_PER_RUN = 3;
const FINALIZE_BUDGET_MS = 60000;
const SESSION_SCAN_LIMIT = 1000;

function authorize(request, env) {
  const expected = String(env.CRON_SECRET || '');
  if (!expected) return;
  const url = new URL(request.url);
  const provided =
    request.headers.get('x-cron-secret') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    url.searchParams.get('secret') ||
    '';
  if (!provided || !constantTimeEqual(provided, expected)) {
    throw new HttpError(401, 'UNAUTHORIZED', '定时任务密钥不匹配');
  }
}

async function removeSession(store, config, meta, key) {
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const messageKeys = await listAll(store, `${prefix}_msg_${meta.id}_`, 2000);
  for (const messageKey of messageKeys) await store.delete(messageKey);
  const hash = (await sha256Hex(meta.userId || '')).slice(0, 24);
  await store.delete(`${prefix}_usess_${hash}_${meta.id}`);
  const active = await store.get(`${prefix}_active_${hash}`);
  if (active === meta.id) await store.delete(`${prefix}_active_${hash}`);
  await store.delete(key);
}

async function cleanupSetupTokens(configStore, now) {
  const keys = await listAll(configStore, 'cb_setup_', 500);
  let removed = 0;
  let active = 0;
  for (const key of keys) {
    const record = await configStore.getJson(key);
    if (!record) {
      await configStore.delete(key);
      removed += 1;
      continue;
    }
    if (Number(record.expiresAt) <= now) {
      await configStore.delete(key);
      removed += 1;
    } else {
      active += 1;
    }
  }
  return { removed, active };
}

async function cleanupRateLimits(configStore, now) {
  const keys = await listAll(configStore, 'cb_rl_', 1000);
  let removed = 0;
  for (const key of keys) {
    const parts = key.split('_');
    const window = Number(parts[parts.length - 1]);
    // 所有限流窗口最长 600 秒，超过 1 小时的计数已无意义
    if (Number.isFinite(window) && window * 600000 < now - 3600000) {
      await configStore.delete(key);
      removed += 1;
    }
  }
  return removed;
}

async function cleanupDedupe(store, config, now) {
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const keys = await listAll(store, `${prefix}_msgid_`, 1000);
  let removed = 0;
  for (const key of keys) {
    const record = await store.getJson(key);
    if (!record || Number(record.createdAt) < now - 86400000) {
      await store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

async function runCleanup(context, body = {}) {
  const env = context.env || {};
  const config = await loadConfig(env);
  const business = openBusinessStore(config, env);
  const { store } = business;
  const configStore = openConfigStore(env).store;
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const now = Date.now();
  const dryRun = body.dry_run === true;
  const retentionMs =
    Math.max(1, Number(config.session.retentionDays) || 7) * 86400000;

  const stats = {
    sessions_scanned: 0,
    sessions_finalized: 0,
    sessions_deleted: 0,
    messages_deleted: 0,
    setup_tokens_removed: 0,
    rate_limit_keys_removed: 0,
    dedupe_keys_removed: 0,
    deferred_finalize: 0,
    dry_run: dryRun,
  };

  const sessionKeys = await listAll(store, `${prefix}_sess_`, SESSION_SCAN_LIMIT);
  stats.sessions_scanned = sessionKeys.length;
  const started = Date.now();
  let finalized = 0;

  for (const key of sessionKeys) {
    const meta = await store.getJson(key);
    if (!meta) continue;

    if (meta.status === 'active' && isExpired(meta, Date.now())) {
      if (dryRun) {
        stats.sessions_finalized += 1;
        continue;
      }
      if (
        finalized >= MAX_FINALIZE_PER_RUN ||
        Date.now() - started > FINALIZE_BUDGET_MS
      ) {
        stats.deferred_finalize += 1;
        continue;
      }
      try {
        const result = await finalizeSession(store, config, meta, 'timeout');
        finalized += 1;
        if (!result.skipped) stats.sessions_finalized += 1;
      } catch (error) {
        console.warn('[cron] 超时结束会话失败', error.message);
      }
      continue;
    }

    if (meta.status !== 'active') {
      const endedAt = Number(meta.endedAt || meta.updatedAt || 0);
      if (endedAt && now - endedAt > retentionMs) {
        if (!dryRun) {
          const messageKeys = await listAll(store, `${prefix}_msg_${meta.id}_`, 2000);
          stats.messages_deleted += messageKeys.length;
          await removeSession(store, config, meta, key);
        }
        stats.sessions_deleted += 1;
      }
    }
  }

  if (!dryRun) {
    const setup = await cleanupSetupTokens(configStore, now);
    stats.setup_tokens_removed = setup.removed;
    stats.rate_limit_keys_removed = await cleanupRateLimits(configStore, now);
    stats.dedupe_keys_removed = await cleanupDedupe(store, config, now);
  }

  return {
    ...stats,
    storage: {
      mode: business.mode,
      available: business.available,
      warning: business.error || '',
    },
    finished_at: new Date().toISOString(),
  };
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    authorize(context.request, context.env || {});
    const body = await readJson(context.request).catch(() => ({}));
    return ok(await runCleanup(context, body));
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestGet(context) {
  try {
    authorize(context.request, context.env || {});
    const url = new URL(context.request.url);
    return ok(
      await runCleanup(context, {
        dry_run: url.searchParams.get('dry_run') === 'true',
      })
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'GET') return onRequestGet(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET/POST'));
}
