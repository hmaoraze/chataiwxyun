import { assertCsrf, requireAdmin } from '../../_shared/auth.js';
import { loadConfig } from '../../_shared/config.js';
import { testDeepSeek } from '../../_shared/deepseek.js';
import {
  HttpError,
  handleError,
  ok,
  preflight,
  readJson,
} from '../../_shared/http.js';
import { openBusinessStore } from '../../_shared/store.js';
import { testWechat } from '../../_shared/wechat.js';

async function runDeepSeek(config) {
  if (!config.deepseek.apiKey) {
    return { ok: false, error: '尚未配置 DeepSeek API Key' };
  }
  const result = await testDeepSeek(config);
  return { ...result, base_url: config.deepseek.baseUrl };
}

async function runStorage(config, env) {
  const opened = openBusinessStore(config, env);
  const result = await opened.store.probe();
  return {
    ok: true,
    ...result,
    driver: config.storage.driver,
    available: opened.available,
    binding: opened.bindingName || '',
    warning: opened.error || '',
  };
}

async function runWechat(config, store) {
  return testWechat(config, store);
}

async function safeRun(target, config, env, store) {
  try {
    if (target === 'deepseek') return { target, ...(await runDeepSeek(config)) };
    if (target === 'storage') return { target, ...(await runStorage(config, env)) };
    if (target === 'wechat') return { target, ...(await runWechat(config, store)) };
    throw new HttpError(400, 'UNKNOWN_TARGET', `未知测试目标：${target}`);
  } catch (error) {
    return {
      target,
      ok: false,
      error: error instanceof HttpError ? error.message : error.message || '测试失败',
      code: error.code || 'TEST_FAILED',
    };
  }
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost(context) {
  try {
    const env = context.env || {};
    const session = await requireAdmin(context.request, env);
    assertCsrf(context.request, session);
    const body = await readJson(context.request);
    const target = String(body.target || 'all');
    const config = await loadConfig(env);
    const opened = openBusinessStore(config, env);

    if (target === 'all') {
      const results = [];
      results.push(await safeRun('storage', config, env, opened.store));
      results.push(await safeRun('deepseek', config, env, opened.store));
      results.push(await safeRun('wechat', config, env, opened.store));
      return ok({
        results,
        all_ok: results.every((item) => item.ok),
      });
    }

    const result = await safeRun(target, config, env, opened.store);
    return ok(result);
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method === 'POST') return onRequestPost(context);
  return handleError(new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST'));
}
