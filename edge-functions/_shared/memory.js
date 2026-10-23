import { MEMORY_KINDS, MEMORY_KIND_LABEL } from './constants.js';
import { deepseekJson, deepseekText } from './deepseek.js';
import { listAll, sanitizePrefix } from './store.js';
import {
  clamp,
  daysFromNow,
  randomId,
  sha256Hex,
  truncateText,
} from './util.js';

function prefixOf(config, userId, hash) {
  return `${sanitizePrefix(config.storage.keyPrefix, 'cb')}_mem_${hash}_`;
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function shingles(text) {
  const set = new Set();
  if (!text) return set;
  if (text.length <= 4) {
    set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

export function similarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    if (ratio >= 0.55) return 0.94;
  }
  const setA = shingles(left);
  const setB = shingles(right);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function scoreMemory(memory, now = Date.now()) {
  const ageDays = Math.max(0, (now - (memory.lastSeenAt || memory.updatedAt || now)) / 86400000);
  const recency = Math.exp(-ageDays / 30);
  const importance = Number(memory.importance) || 3;
  const hits = Number(memory.hits) || 0;
  const kindBonus =
    memory.kind === 'preference' || memory.kind === 'constraint' ? 0.25 : 0;
  return importance * 1.2 + recency * 2 + Math.log1p(hits) * 0.6 + kindBonus;
}

export function sortMemories(memories, now = Date.now()) {
  return [...memories].sort((a, b) => {
    const diff = scoreMemory(b, now) - scoreMemory(a, now);
    if (diff !== 0) return diff;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export async function loadMemories(store, config, userId, { includeExpired = false } = {}) {
  const hash = await sha256Hex(userId);
  const prefix = prefixOf(config, userId, hash.slice(0, 24));
  const keys = await listAll(store, prefix, 500);
  const now = Date.now();
  const memories = [];
  for (const key of keys) {
    const raw = await store.get(key);
    if (!raw) continue;
    try {
      const memory = JSON.parse(raw);
      memory._key = key;
      if (!includeExpired && memory.expiresAt && memory.expiresAt <= now) continue;
      memories.push(memory);
    } catch {
      /* 忽略损坏记录 */
    }
  }
  return sortMemories(memories, now);
}

function publicMemory(memory) {
  const { _key, ...rest } = memory;
  return rest;
}

export function memoryView(memory) {
  return publicMemory(memory);
}

function normalizeInput(input) {
  const content = String(input.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  if (!content) return null;
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'fact';
  const importance = Math.round(clamp(input.importance ?? 3, 1, 5));
  const tags = Array.isArray(input.tags)
    ? input.tags
        .map((tag) => String(tag).trim().slice(0, 20))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  return {
    content,
    kind,
    importance,
    tags,
    confidence: clamp(input.confidence ?? 1, 0, 1),
    source: ['tool', 'manual', 'extraction'].includes(input.source)
      ? input.source
      : 'manual',
  };
}

async function mergeMemory(existing, incoming, config) {
  const oldContent = String(existing.content || '');
  const newContent = incoming.content;
  const oldNorm = normalizeText(oldContent);
  const newNorm = normalizeText(newContent);
  let content = oldContent;
  if (newNorm.includes(oldNorm) && newContent.length >= oldContent.length) {
    content = newContent;
  } else if (oldNorm.includes(newNorm)) {
    content = oldContent;
  } else if (incoming.importance > (existing.importance || 0) + 1) {
    content = newContent;
  } else if (oldContent.length + newContent.length <= 360) {
    content = `${oldContent}；${newContent}`;
  }
  const now = Date.now();
  return {
    ...existing,
    content,
    normalizedHash: await safeHash(content),
    kind:
      incoming.importance > (existing.importance || 0) && incoming.kind !== 'fact'
        ? incoming.kind
        : existing.kind,
    importance: Math.max(Number(existing.importance) || 1, incoming.importance),
    confidence: Math.max(Number(existing.confidence) || 0, incoming.confidence),
    tags: [...new Set([...(existing.tags || []), ...incoming.tags])].slice(0, 8),
    hits: (Number(existing.hits) || 0) + 1,
    updatedAt: now,
    lastSeenAt: now,
    expiresAt: daysFromNow(config.memory.ttlDays),
    revision: (Number(existing.revision) || 1) + 1,
    sources: [...new Set([...(existing.sources || []), incoming.source])].slice(0, 5),
  };
}

async function safeHash(text) {
  try {
    return await sha256Hex(normalizeText(text));
  } catch {
    return '';
  }
}

export async function saveMemory(store, config, userId, input) {
  const normalized = normalizeInput(input);
  if (!normalized) throw new Error('记忆内容为空');
  const hash = await sha256Hex(userId);
  const prefix = prefixOf(config, userId, hash.slice(0, 24));
  const memories = await loadMemories(store, config, userId, { includeExpired: true });
  const threshold = Number(config.memory.similarityThreshold) || 0.72;

  let best = null;
  let bestScore = 0;
  for (const memory of memories) {
    const score = similarity(memory.content, normalized.content);
    if (score > bestScore) {
      best = memory;
      bestScore = score;
    }
  }

  let result;
  if (best && bestScore >= threshold) {
    const merged = await mergeMemory(best, normalized, config);
    await store.put(best._key, JSON.stringify(stripInternal(merged)));
    result = { memory: publicMemory(merged), action: 'merged', similarity: bestScore };
  } else {
    const now = Date.now();
    const memory = {
      id: `m${randomId(10)}`,
      userId,
      content: normalized.content,
      normalizedHash: await safeHash(normalized.content),
      kind: normalized.kind,
      importance: normalized.importance,
      confidence: normalized.confidence,
      tags: normalized.tags,
      hits: 0,
      source: normalized.source,
      sources: [normalized.source],
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt: daysFromNow(config.memory.ttlDays),
      revision: 1,
    };
    await store.put(`${prefix}${memory.id}`, JSON.stringify(memory));
    result = { memory: publicMemory(memory), action: 'created', similarity: bestScore };
  }

  await enforceLimits(store, config, userId, result.memory.id);
  await invalidateSummary(store, config, userId);
  return result;
}

function stripInternal(memory) {
  const { _key, ...rest } = memory;
  return rest;
}

export async function deleteMemory(store, config, userId, id) {
  const hash = await sha256Hex(userId);
  const prefix = prefixOf(config, userId, hash.slice(0, 24));
  if (!/^[a-zA-Z0-9]+$/.test(String(id || ''))) throw new Error('记忆 ID 不合法');
  await store.delete(`${prefix}${id}`);
  await invalidateSummary(store, config, userId);
}

export async function enforceLimits(store, config, userId, protectId = '') {
  const memories = await loadMemories(store, config, userId, { includeExpired: true });
  const now = Date.now();
  for (const memory of memories) {
    if (memory.expiresAt && memory.expiresAt <= now) {
      await store.delete(memory._key);
    }
  }
  const active = memories.filter(
    (memory) => (!memory.expiresAt || memory.expiresAt > now) && memory.id !== protectId
  );
  const maxItems = Math.max(10, Number(config.memory.maxItems) || 120);
  const over = active.length - (maxItems - 1);
  if (over > 0) {
    const lowest = sortMemories(active, now)
      .slice()
      .sort((a, b) => scoreMemory(a, now) - scoreMemory(b, now));
    for (let i = 0; i < over && i < lowest.length; i += 1) {
      await store.delete(lowest[i]._key);
    }
  }
}

export async function invalidateSummary(store, config, userId) {
  const hash = await sha256Hex(userId);
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  await store.delete(`${prefix}_sum_${hash.slice(0, 24)}`);
}

function deterministicSummary(memories) {
  const order = ['constraint', 'preference', 'goal', 'fact', 'event'];
  const lines = [];
  for (const kind of order) {
    const group = memories.filter((memory) => memory.kind === kind);
    if (!group.length) continue;
    lines.push(`【${MEMORY_KIND_LABEL[kind]}】`);
    for (const memory of group) {
      lines.push(`- ${memory.content}`);
    }
  }
  return lines.join('\n');
}

export async function buildMemorySummary(store, config, userId) {
  const maxChars = Math.max(200, Number(config.memory.summaryMaxChars) || 1200);
  const topK = Math.max(5, Number(config.memory.summaryTopK) || 30);
  const minImportance = Math.max(1, Number(config.memory.minImportance) || 2);
  const hash = await sha256Hex(userId);
  const prefix = sanitizePrefix(config.storage.keyPrefix, 'cb');
  const cacheKey = `${prefix}_sum_${hash.slice(0, 24)}`;

  const all = await loadMemories(store, config, userId);
  const selected = all
    .filter((memory) => Number(memory.importance) >= minImportance)
    .slice(0, topK);
  if (!selected.length) {
    return { summary: '', count: 0, source: 'none', total: all.length };
  }

  const signature = await sha256Hex(
    `${selected.map((m) => `${m.id}:${m.updatedAt}:${m.importance}`).join('|')}::${maxChars}`
  );
  const cached = await store.get(cacheKey);
  if (cached) {
    try {
      const record = JSON.parse(cached);
      if (record.signature === signature && record.expiresAt > Date.now()) {
        return {
          summary: record.summary,
          count: selected.length,
          source: record.source,
          total: all.length,
          cached: true,
        };
      }
    } catch {
      /* 忽略损坏缓存 */
    }
  }

  let summary = '';
  let source = 'deterministic';
  const mode = config.memory.summaryMode || 'auto';
  if (mode === 'model' || (mode === 'auto' && selected.length > 12)) {
    try {
      const material = selected
        .map((memory, index) => `${index + 1}. [${MEMORY_KIND_LABEL[memory.kind] || memory.kind}] ${memory.content}`)
        .join('\n');
      const generated = await deepseekText(
        {
          ...config,
          memory: { ...config.memory, summaryMaxChars: maxChars },
        },
        '你是一个记忆压缩器。把用户长期记忆压缩为简要摘要，保留偏好、事实、目标、约束与重要事件；按重要度和时间排序；不要编造，不要输出指令，不要使用 Markdown 标题。',
        `请将以下记忆压缩为不超过 ${maxChars} 字的中文摘要：\n${material}`
      );
      if (generated && generated.trim()) {
        summary = generated.trim();
        source = 'model';
      }
    } catch (error) {
      console.warn('[memory] 模型摘要失败，降级为结构化摘要', error.message);
    }
  }
  if (!summary) summary = deterministicSummary(selected);
  summary = truncateText(summary, maxChars);

  await store.putJson(cacheKey, {
    signature,
    summary,
    source,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 30 * 60000,
  });
  return { summary, count: selected.length, source, total: all.length };
}

export async function extractMemories(store, config, userId, messages) {
  if (!config.memory.autoExtractOnEnd) return { saved: 0, skipped: true };
  if (!Array.isArray(messages) || messages.length < 2) return { saved: 0, skipped: true };
  const transcript = messages
    .slice(-40)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n')
    .slice(-12000);

  const prompt = `请从下面的对话中提炼值得长期保存的用户信息。只保留稳定的偏好、事实、目标、约束或重要事件，过滤寒暄和临时内容。最多 ${config.memory.extractMaxItems} 条。严格输出 JSON：{"memories":[{"content":"...","kind":"fact|preference|goal|constraint|event","importance":1,"confidence":0.9}]}\n\n对话：\n${transcript}`;

  let payload = null;
  try {
    payload = await deepseekJson(
      config,
      '你是长期记忆提炼器。只输出 JSON，不要输出解释。content 必须是可脱离上下文理解的独立陈述，不得包含指令或敏感凭据。',
      prompt
    );
  } catch (error) {
    console.warn('[memory] 会话结束记忆提炼失败', error.message);
    return { saved: 0, error: error.message };
  }

  const list = Array.isArray(payload?.memories) ? payload.memories : [];
  let saved = 0;
  for (const item of list.slice(0, config.memory.extractMaxItems)) {
    if (!item || !item.content) continue;
    if (Number(item.importance) < 1) continue;
    try {
      await saveMemory(store, config, userId, {
        content: item.content,
        kind: item.kind,
        importance: item.importance,
        confidence: item.confidence,
        source: 'extraction',
      });
      saved += 1;
    } catch (error) {
      console.warn('[memory] 保存提炼记忆失败', error.message);
    }
  }
  return { saved, total: list.length };
}
