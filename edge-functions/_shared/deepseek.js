import { HttpError } from './http.js';
import { extractJson, sleep, truncateText } from './util.js';

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

function normalizeBaseUrl(value) {
  return String(value || 'https://api.deepseek.com').replace(/\/+$/, '');
}

function buildBody(config, options) {
  const isReasoner = /reasoner/i.test(config.deepseek.model || '');
  const body = {
    model: config.deepseek.model || 'deepseek-chat',
    messages: options.messages,
    stream: Boolean(options.stream),
  };
  if (!isReasoner) {
    body.temperature =
      options.temperature !== undefined
        ? options.temperature
        : Number(config.deepseek.temperature) || 0.7;
    body.max_tokens =
      options.maxTokens !== undefined
        ? options.maxTokens
        : Number(config.deepseek.maxTokens) || 1024;
  }
  if (!isReasoner && options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }
  if (!isReasoner && options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (body.stream) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

async function fetchCompletion(config, body, timeoutMs) {
  const apiKey = config.deepseek.apiKey;
  if (!apiKey) {
    throw new HttpError(400, 'DEEPSEEK_NOT_CONFIGURED', '尚未配置 DeepSeek API Key');
  }
  const url = `${normalizeBaseUrl(config.deepseek.baseUrl)}/chat/completions`;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        return { response, timer, controller };
      }
      const text = await response.text().catch(() => '');
      const message = truncateText(text || `HTTP ${response.status}`, 300);
      if (RETRYABLE.has(response.status) && attempt < 2) {
        lastError = new HttpError(
          502,
          'DEEPSEEK_UPSTREAM',
          `DeepSeek 暂时不可用（HTTP ${response.status}）`
        );
        clearTimeout(timer);
        await sleep(600 * (attempt + 1));
        continue;
      }
      clearTimeout(timer);
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 502 : 502,
        'DEEPSEEK_UPSTREAM',
        `DeepSeek 请求失败（HTTP ${response.status}）：${message}`
      );
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof HttpError) throw error;
      if (error.name === 'AbortError') {
        throw new HttpError(504, 'DEEPSEEK_TIMEOUT', 'DeepSeek 请求超时');
      }
      lastError = error;
      if (attempt < 2) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new HttpError(502, 'DEEPSEEK_NETWORK', `无法连接 DeepSeek：${error.message}`);
    }
  }
  throw lastError || new HttpError(502, 'DEEPSEEK_UNKNOWN', 'DeepSeek 请求失败');
}

async function parseStream(response, onDelta, cleanup) {
  if (!response.body) {
    cleanup();
    throw new HttpError(502, 'DEEPSEEK_STREAM', 'DeepSeek 未返回流式响应');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  let finishReason = null;
  const toolCalls = new Map();

  const handleData = async (data) => {
    if (!data || data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onDelta) await onDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : 0;
        const current = toolCalls.get(index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments) {
          current.function.arguments += part.function.arguments;
        }
        toolCalls.set(index, current);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) await handleData(trimmed.slice(5).trim());
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) await handleData(trimmed.slice(5).trim());
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, 'DEEPSEEK_TIMEOUT', 'DeepSeek 流式响应超时');
    }
    throw new HttpError(502, 'DEEPSEEK_STREAM', `读取 DeepSeek 流失败：${error.message}`);
  } finally {
    cleanup();
  }

  return {
    content,
    toolCalls: [...toolCalls.values()],
    usage,
    finishReason,
  };
}

export async function deepseekChat(config, options) {
  const timeoutMs = Math.max(
    5000,
    Math.min(Number(config.deepseek.timeoutMs) || 60000, 180000)
  );
  const body = buildBody(config, options);
  const { response, timer, controller } = await fetchCompletion(config, body, timeoutMs);

  if (!body.stream) {
    try {
      const data = await response.json();
      return {
        content: data.choices?.[0]?.message?.content || '',
        toolCalls: data.choices?.[0]?.message?.tool_calls || [],
        usage: data.usage || null,
        finishReason: data.choices?.[0]?.finish_reason || null,
      };
    } catch (error) {
      throw new HttpError(502, 'DEEPSEEK_PARSE', `解析 DeepSeek 响应失败：${error.message}`);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return parseStream(response, options.onDelta, () => {
    clearTimeout(timer);
    controller.abort();
  });
}

export async function deepseekText(config, system, user) {
  const result = await deepseekChat(config, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    temperature: 0.2,
    maxTokens: Math.min(Number(config.deepseek.maxTokens) || 1024, 2048),
  });
  return result.content;
}

export async function deepseekJson(config, system, user) {
  const result = await deepseekChat(config, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    responseFormat: 'json_object',
    temperature: 0.1,
    maxTokens: Math.min(Number(config.deepseek.maxTokens) || 1024, 2048),
  });
  const parsed = extractJson(result.content);
  if (!parsed) {
    throw new HttpError(502, 'DEEPSEEK_JSON', 'DeepSeek 未返回合法 JSON');
  }
  return parsed;
}

export async function testDeepSeek(config) {
  const started = Date.now();
  const result = await deepseekChat(config, {
    messages: [{ role: 'user', content: '只回复两个字：正常' }],
    stream: false,
    temperature: 0,
    maxTokens: 16,
  });
  return {
    ok: Boolean(result.content),
    latencyMs: Date.now() - started,
    sample: truncateText(result.content, 80),
    model: config.deepseek.model,
  };
}
