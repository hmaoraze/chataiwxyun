import { SAVE_MEMORY_TOOL } from './constants.js';
import { deepseekChat } from './deepseek.js';
import { HttpError } from './http.js';
import {
  buildMemorySummary,
  extractMemories,
  saveMemory,
  memoryView,
} from './memory.js';
import { buildMessages, parseMemoryDirectives } from './prompt.js';
import { listAll, sanitizePrefix } from './store.js';
import { randomId, sha256Hex, truncateText } from './util.js';

function prefix(config) {
  return sanitizePrefix(config.storage.keyPrefix, 'cb');
}

function sessionKey(config, sid) {
  return `${prefix(config)}_sess_${sid}`;
}

function messagePrefix(config, sid) {
  return `${prefix(config)}_msg_${sid}_`;
}

async function userIndexPrefix(config, userId) {
  const hash = (await sha256Hex(userId)).slice(0, 24);
  return `${prefix(config)}_usess_${hash}_`;
}

async function activeKey(config, userId) {
  const hash = (await sha256Hex(userId)).slice(0, 24);
  return `${prefix(config)}_active_${hash}`;
}

export async function getSession(store, config, sid) {
  if (!sid || !/^[a-zA-Z0-9]+$/.test(sid)) return null;
  return store.getJson(sessionKey(config, sid));
}

export async function saveSession(store, config, meta) {
  await store.putJson(sessionKey(config, meta.id), meta);
}

export async function listMessages(store, config, sid, limit = 200) {
  const keys = await listAll(store, messagePrefix(config, sid), limit);
  const messages = [];
  for (const key of keys) {
    const message = await store.getJson(key);
    if (message) messages.push(message);
  }
  return messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function appendMessage(store, config, sid, message) {
  const now = Date.now();
  const key = `${messagePrefix(config, sid)}${String(now).padStart(14, '0')}_${randomId(4)}`;
  const record = { ...message, id: key, sessionId: sid, createdAt: now };
  await store.putJson(key, record);
  return record;
}

export function isExpired(meta, now = Date.now()) {
  if (!meta) return true;
  if (meta.status !== 'active') return true;
  if (meta.expiresAt && now > meta.expiresAt) return true;
  if (meta.idleExpiresAt && now > meta.idleExpiresAt) return true;
  return false;
}

function publicSession(meta, extra = {}) {
  return {
    session_id: meta.id,
    user_id: meta.userId,
    status: meta.status,
    title: meta.title || '',
    created_at: meta.createdAt,
    updated_at: meta.updatedAt,
    last_message_at: meta.lastMessageAt || null,
    expires_at: meta.expiresAt,
    idle_expires_at: meta.idleExpiresAt,
    turn_count: meta.turnCount || 0,
    memory_count: meta.memoryCount || 0,
    memory_summary: meta.memorySummary || '',
    end_reason: meta.endReason || '',
    metadata: meta.metadata || {},
    ...extra,
  };
}

export async function createSession(store, config, userId, options = {}) {
  const memory = options.memory || (await buildMemorySummary(store, config, userId));
  const now = Date.now();
  const sid = `s${randomId(16)}`;
  const ttlMinutes = Math.max(1, Number(config.session.ttlMinutes) || 120);
  const idleMinutes = Math.max(1, Number(config.session.idleTimeoutMinutes) || 45);
  const meta = {
    id: sid,
    userId,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    expiresAt: now + ttlMinutes * 60000,
    idleExpiresAt: now + idleMinutes * 60000,
    status: 'active',
    title: String(options.title || '').slice(0, 60),
    turnCount: 0,
    memorySummary: memory.summary || '',
    memoryCount: memory.count || 0,
    memorySource: memory.source || 'none',
    metadata: options.metadata || {},
    extractionStatus: 'pending',
    memoriesSaved: 0,
  };
  await saveSession(store, config, meta);
  const indexKey = `${await userIndexPrefix(config, userId)}${sid}`;
  await store.putJson(indexKey, { sessionId: sid, updatedAt: now });
  await store.put(await activeKey(config, userId), sid);
  return publicSession(meta);
}

export async function finalizeSession(store, config, meta, reason = 'ended', options = {}) {
  if (!meta) return { skipped: true };
  if (meta.status !== 'active') {
    return { skipped: true, status: meta.status, memoriesSaved: meta.memoriesSaved || 0 };
  }
  const messages = options.messages || (await listMessages(store, config, meta.id, 400));
  let extraction = { saved: 0, skipped: true };
  if (options.extract !== false) {
    try {
      extraction = await extractMemories(store, config, meta.userId, messages);
      meta.extractionStatus = extraction.saved > 0 ? 'ok' : extraction.error ? 'failed' : 'skipped';
    } catch (error) {
      meta.extractionStatus = 'failed';
      console.warn('[session] 提炼记忆失败', error.message);
    }
  } else {
    meta.extractionStatus = 'skipped';
  }

  const now = Date.now();
  meta.status = reason === 'timeout' ? 'expired' : 'ended';
  meta.endReason = reason;
  meta.endedAt = now;
  meta.updatedAt = now;
  meta.memoriesSaved = extraction.saved || 0;
  await saveSession(store, config, meta);

  const active = await store.get(await activeKey(config, meta.userId));
  if (active === meta.id) await store.delete(await activeKey(config, meta.userId));

  return {
    skipped: false,
    status: meta.status,
    memoriesSaved: extraction.saved || 0,
    extractionStatus: meta.extractionStatus,
  };
}

function normalizeToolCall(call) {
  return {
    id: call.id || `call_${randomId(8)}`,
    type: 'function',
    function: {
      name: call.function?.name || '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments || {}),
    },
  };
}

async function executeToolCalls(store, config, userId, toolCalls) {
  const saved = [];
  const results = [];
  for (const call of toolCalls) {
    const normalized = normalizeToolCall(call);
    if (normalized.function.name !== 'save_memory') {
      results.push({
        tool_call_id: normalized.id,
        role: 'tool',
        content: JSON.stringify({ ok: false, error: 'unknown tool' }),
      });
      continue;
    }
    try {
      const args = JSON.parse(normalized.function.arguments || '{}');
      const result = await saveMemory(store, config, userId, {
        content: args.content,
        kind: args.kind,
        importance: args.importance,
        source: 'tool',
      });
      saved.push(result.memory);
      results.push({
        tool_call_id: normalized.id,
        role: 'tool',
        content: JSON.stringify({
          ok: true,
          action: result.action,
          memory_id: result.memory.id,
        }),
      });
    } catch (error) {
      results.push({
        tool_call_id: normalized.id,
        role: 'tool',
        content: JSON.stringify({ ok: false, error: truncateText(error.message, 120) }),
      });
    }
  }
  return { saved, results };
}

async function runModel(store, config, userId, messages, stream, onDelta) {
  const savedMemories = [];
  const maxRounds = Math.max(1, Math.min(Number(config.deepseek.maxToolRounds) || 3, 5));
  const conversation = [...messages];
  let last = { content: '', usage: null, toolCalls: [] };

  for (let round = 0; round <= maxRounds; round += 1) {
    const forceAnswer = round === maxRounds;
    const result = await deepseekChat(config, {
      messages: conversation,
      tools: forceAnswer ? [] : [SAVE_MEMORY_TOOL],
      stream,
      onDelta,
    });
    last = result;
    const toolCalls = result.toolCalls || [];
    if (!toolCalls.length) {
      return { content: result.content || '', usage: result.usage, savedMemories };
    }
    const normalized = toolCalls.map(normalizeToolCall);
    conversation.push({
      role: 'assistant',
      content: result.content || '',
      tool_calls: normalized,
    });
    const executed = await executeToolCalls(store, config, userId, normalized);
    savedMemories.push(...executed.saved);
    conversation.push(...executed.results);
  }

  return {
    content: last.content || '',
    usage: last.usage,
    savedMemories,
  };
}

export async function handleMessage(store, config, userId, options = {}) {
  const content = String(options.content || '').trim();
  if (!content) throw new HttpError(400, 'EMPTY_MESSAGE', '消息内容不能为空');
  const maxInput = Math.max(100, Number(config.session.maxInputChars) || 8000);
  if (content.length > maxInput) {
    throw new HttpError(413, 'MESSAGE_TOO_LONG', `消息长度不能超过 ${maxInput} 字`);
  }
  if (!String(config.prompt.systemPrompt || '').trim()) {
    throw new HttpError(400, 'PROMPT_NOT_CONFIGURED', '尚未配置前置提示词');
  }
  if (!config.deepseek.apiKey) {
    throw new HttpError(400, 'DEEPSEEK_NOT_CONFIGURED', '尚未配置 DeepSeek API Key');
  }

  let meta = null;
  let renewed = false;
  let finalized = null;

  if (options.sessionId) {
    meta = await getSession(store, config, options.sessionId);
    if (!meta) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
    if (meta.userId !== userId) {
      throw new HttpError(403, 'SESSION_FORBIDDEN', '会话不属于该用户');
    }
    if (meta.status === 'active' && isExpired(meta)) {
      finalized = await finalizeSession(store, config, meta, 'timeout');
      meta = null;
    } else if (meta.status !== 'active') {
      meta = null;
    }
  }

  if (!meta) {
    const created = await createSession(store, config, userId, {
      title: content.slice(0, 30),
    });
    meta = await getSession(store, config, created.session_id);
    renewed = Boolean(options.sessionId);
  }

  const maxTurns = Math.max(1, Number(config.session.maxTurns) || 60);
  if ((meta.turnCount || 0) >= maxTurns) {
    await finalizeSession(store, config, meta, 'ended');
    const created = await createSession(store, config, userId, {
      title: content.slice(0, 30),
    });
    meta = await getSession(store, config, created.session_id);
    renewed = true;
  }

  const history = await listMessages(store, config, meta.id, 400);
  const messages = buildMessages({
    config,
    memorySummary: meta.memorySummary,
    history,
    userContent: content,
  });

  const result = await runModel(
    store,
    config,
    userId,
    messages,
    Boolean(options.stream),
    options.onDelta
  );

  const parsed = parseMemoryDirectives(result.content);
  const directiveMemories = [];
  for (const directive of parsed.directives) {
    try {
      const saved = await saveMemory(store, config, userId, {
        content: directive.content,
        kind: directive.kind,
        importance: directive.importance,
        source: 'tool',
      });
      directiveMemories.push(saved.memory);
    } catch (error) {
      console.warn('[session] 指令记忆保存失败', error.message);
    }
  }

  const reply = parsed.text || '（模型未返回内容）';
  const savedMemories = [...result.savedMemories, ...directiveMemories];

  await appendMessage(store, config, meta.id, {
    role: 'user',
    content,
    meta: { client: options.client || 'api' },
  });
  await appendMessage(store, config, meta.id, {
    role: 'assistant',
    content: reply,
    meta: {
      model: config.deepseek.model,
      usage: result.usage || null,
      memories_saved: savedMemories.length,
    },
  });

  const now = Date.now();
  meta.turnCount = (meta.turnCount || 0) + 1;
  meta.updatedAt = now;
  meta.lastMessageAt = now;
  meta.expiresAt = now + Math.max(1, Number(config.session.ttlMinutes) || 120) * 60000;
  meta.idleExpiresAt =
    now + Math.max(1, Number(config.session.idleTimeoutMinutes) || 45) * 60000;
  if (!meta.title) meta.title = content.slice(0, 30);
  await saveSession(store, config, meta);

  const indexKey = `${await userIndexPrefix(config, userId)}${meta.id}`;
  await store.putJson(indexKey, { sessionId: meta.id, updatedAt: now });
  await store.put(await activeKey(config, userId), meta.id);

  return {
    session: publicSession(meta),
    reply,
    usage: result.usage,
    memoriesSaved: savedMemories.length,
    memories: savedMemories.map(memoryView),
    renewed,
    finalized: finalized ? { status: finalized.status, memoriesSaved: finalized.memoriesSaved } : null,
  };
}

export async function endSession(store, config, userId, sid, options = {}) {
  const meta = await getSession(store, config, sid);
  if (!meta) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  if (meta.userId !== userId) {
    throw new HttpError(403, 'SESSION_FORBIDDEN', '会话不属于该用户');
  }
  const result = await finalizeSession(store, config, meta, 'ended', options);
  const fresh = await getSession(store, config, sid);
  return { ...result, session: publicSession(fresh) };
}

export async function getSessionDetail(store, config, userId, sid) {
  const meta = await getSession(store, config, sid);
  if (!meta) throw new HttpError(404, 'SESSION_NOT_FOUND', '会话不存在');
  if (userId && meta.userId !== userId) {
    throw new HttpError(403, 'SESSION_FORBIDDEN', '会话不属于该用户');
  }
  const messages = await listMessages(store, config, sid, 400);
  return {
    session: publicSession(meta),
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      created_at: message.createdAt,
      meta: message.meta || {},
    })),
  };
}

export async function listSessions(store, config, userId = '', limit = 50) {
  const keys = userId
    ? await listAll(store, await userIndexPrefix(config, userId), 200)
    : await listAll(store, `${prefix(config)}_sess_`, 200);
  const ids = new Set();
  const sessions = [];
  for (const key of keys) {
    let sid = '';
    if (userId) {
      const record = await store.getJson(key);
      sid = record?.sessionId || '';
    } else {
      sid = key.slice(`${prefix(config)}_sess_`.length);
    }
    if (!sid || ids.has(sid)) continue;
    ids.add(sid);
    const meta = await getSession(store, config, sid);
    if (!meta) continue;
    sessions.push(publicSession(meta));
  }
  return sessions
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export async function getActiveSessionId(store, config, userId) {
  return store.get(await activeKey(config, userId));
}

export async function setActiveSession(store, config, userId, sid) {
  await store.put(await activeKey(config, userId), sid);
}
