export const VERSION = '1.0.0';

// 配置与主密钥使用固定的 KV 键，避免修改业务键前缀后无法读取配置
export const CONFIG_KEY = 'cb_config';
export const MASTER_KEY = 'cb_master';
export const PASSKEY_KEY = 'cb_passkeys';

export const DEFAULT_CONFIG = {
  version: 1,
  initializedAt: null,
  updatedAt: null,
  security: {
    rpId: '',
    publicOrigin: '',
  },
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 60000,
    stream: true,
    maxToolRounds: 3,
  },
  prompt: {
    systemPrompt: '',
    maxHistoryMessages: 20,
    maxContextChars: 24000,
  },
  memory: {
    maxItems: 120,
    ttlDays: 180,
    summaryMaxChars: 1200,
    summaryMode: 'auto',
    summaryTopK: 30,
    minImportance: 2,
    autoExtractOnEnd: true,
    extractMaxItems: 10,
    similarityThreshold: 0.72,
  },
  session: {
    ttlMinutes: 120,
    idleTimeoutMinutes: 45,
    maxTurns: 60,
    maxInputChars: 8000,
    retentionDays: 7,
  },
  storage: {
    driver: 'kv',
    kvBinding: 'chat_kv',
    redisUrl: '',
    redisToken: '',
    keyPrefix: 'cb',
  },
  api: {
    serviceToken: '',
    rateLimitPerMinute: 30,
    allowAdminSessionForApi: true,
  },
  wechat: {
    botToken: '',
    ilinkBotId: '',
    ilinkUserId: '',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    channelVersion: '2.0.0',
    contextTokenTtlHours: 24,
    typingEnabled: true,
    pollTimeoutSeconds: 35,
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    mediaAesMode: 'AES-128-ECB',
    autoSend: false,
  },
};

// 需要加密落盘的字段
export const SECRET_PATHS = [
  ['deepseek', 'apiKey'],
  ['storage', 'redisToken'],
  ['api', 'serviceToken'],
  ['wechat', 'botToken'],
];

export const MEMORY_KINDS = ['fact', 'preference', 'goal', 'constraint', 'event'];

export const MEMORY_KIND_LABEL = {
  fact: '事实',
  preference: '偏好',
  goal: '目标',
  constraint: '约束',
  event: '事件',
};

export const SAVE_MEMORY_TOOL = {
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      '把对话中值得长期记住的用户信息写入长期记忆。适合保存稳定的偏好、事实、目标、约束或重要事件；不要保存寒暄、临时上下文或敏感凭据。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '一条独立、简洁、可脱离上下文理解的记忆，建议不超过 200 字。',
        },
        kind: {
          type: 'string',
          enum: MEMORY_KINDS,
          description: '记忆类型：fact 事实、preference 偏好、goal 目标、constraint 约束、event 事件。',
        },
        importance: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '重要度 1-5，5 表示长期核心信息。',
        },
      },
      required: ['content'],
    },
  },
};

export const MEMORY_DIRECTIVE_RE =
  /\[\[MEMORY:([a-z]+)\|([1-5])\]\]([\s\S]*?)\[\[\/MEMORY\]\]/gi;
export const MEMORY_INLINE_RE = /\[\[MEMORY:([^[\]|]{1,300})\]\]/g;
