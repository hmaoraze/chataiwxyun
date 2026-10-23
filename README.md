# EdgeOne Makers · DeepSeek 记忆对话机器人

部署在腾讯云 EdgeOne Pages / Makers（边缘函数 + KV）上的 DeepSeek 对话服务，提供带长期记忆的会话能力、微信 iLink 协议适配，以及一个用 Passkey（无密码安全密钥）保护的可视化配置后台。

## 能力概览

- **统一会话接口**：创建 / 续接 / 结束 / 查询 / 列表，支持滑动 TTL 与空闲超时，多轮上下文落库。
- **固定前置提示词**：每轮请求都以独立的 `system` 消息注入，明确标注「最高优先级」，历史裁剪只作用于对话历史，不会截断该段内容。
- **双通道记忆写入**：模型可调用 `save_memory` 工具或输出 `[[MEMORY:kind|importance]]…[[/MEMORY]]` 指令主动保存；会话显式结束或超时结束时自动提炼重要记忆。
- **记忆治理**：相似度去重合并、重要度 / 时间 / 命中数综合排序、容量上限、TTL 过期淘汰。
- **记忆摘要注入**：新会话开始时把历史记忆压缩为摘要，放在前置提示词之前的独立段落。
- **安全配置后台**：一次性安全链接 + Passkey 注册/登录，配置项全部可在网页设置；密钥字段加密落盘、前端只回显掩码。
- **微信机器人**：iLink 消息入站处理、`context_token` 管理、输入状态、自动回复、消息去重。

## 目录结构

```
edge-functions/                 # EdgeOne 边缘函数（目录即路由）
  api/
    health.js                   # GET  /api/health
    session.js                  # POST /api/session       会话与对话（含 SSE）
    memory.js                   # GET/POST/DELETE /api/memory
    admin/status.js             # GET  /api/admin/status
    admin/auth.js               # POST /api/admin/auth    Passkey 注册/登录/引导
    admin/config.js             # GET/PUT /api/admin/config
    admin/security.js           # GET/POST /api/admin/security
    admin/overview.js           # GET  /api/admin/overview
    admin/test.js               # POST /api/admin/test
    wechat/message.js           # POST /api/wechat/message
    wechat/send.js              # POST /api/wechat/send
    wechat/typing.js            # POST /api/wechat/typing
    wechat/context.js           # GET/POST /api/wechat/context
    cron/cleanup.js             # POST /api/cron/cleanup
  _shared/                      # 共享模块（不被边缘路由暴露）
index.html                      # 配置控制台 SPA
assets/app.js assets/style.css
edgeone.json                    # 函数超时、SPA 重写、安全响应头、定时任务
```

## 部署步骤

1. **推送代码**：将本目录推送到 Git 仓库，在 EdgeOne Pages（Makers）中导入并启用边缘函数。
2. **创建 KV 命名空间**：在 EdgeOne 控制台创建 KV，并以变量名 **`chat_kv`** 绑定到项目。
   - 配置本身固定存放在该绑定（可用环境变量 `CONFIG_KV_BINDING` 改绑定名，但必须始终存在）。
   - 业务数据（会话/记忆）默认也用它；可在后台改为 Upstash Redis 或进程内存储（仅调试）。
3. **配置环境变量**（见下表，均为可选，但强烈建议设置前两项）。
4. **部署**。首次访问 `https://<你的域名>/setup?token=<BOOTSTRAP_TOKEN>`，登记一个 Passkey 后该链接立即失效。
5. 在控制台「必填配置」逐项填写并保存：DeepSeek API Key、前置提示词、存储、服务访问令牌、微信机器人参数。
6. 用「测试」页分别验证 DeepSeek / 存储 / 微信连通性；把服务令牌交给调用方（微信网关或自建前端）。

> 之后需要再改配置：用已注册的 Passkey 登录即可；若需要给同事开通，可在「安全密钥」页生成新的一次性配置链接（可同时存在多条，注册成功后自动失效），或直接注册第二把 Passkey（最多 20 把）。

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `BOOTSTRAP_TOKEN` | 推荐 | 首次配置安全链接的一次性令牌。仅在「尚未初始化」时用作 `/setup?token=`，使用后写入 `cb_boot_<hash>` 标记失效。 |
| `APP_MASTER_KEY` | 推荐 | ≥16 字节主密钥，用于加密 Cookie 与落盘密钥。未设置时自动生成并存 KV；多实例/多区域部署请显式设置，保证一致。 |
| `RP_ID` | 可选 | 覆盖 WebAuthn RP ID，默认取公开来源的域名。 |
| `PUBLIC_ORIGIN` | 可选 | 覆盖公开站点来源（生成安全链接、校验 origin 用），如 `https://bot.example.com`。 |
| `CRON_SECRET` | 推荐 | 定时清理接口的鉴权令牌；设置后需通过 `x-cron-secret`、`Authorization: Bearer` 或 `?secret=` 传入。未设置则不校验。 |
| `CONFIG_KV_BINDING` | 可选 | 配置存储使用的 KV 绑定名，默认 `chat_kv`。 |

## 配置项（全部可在网页设置）

### DeepSeek

| 字段 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deepseek.apiKey` | – | ✅ | DeepSeek API Key（加密存储） |
| `deepseek.baseUrl` | `https://api.deepseek.com` | | OpenAI 兼容基址 |
| `deepseek.model` | `deepseek-chat` | | 模型名 |
| `deepseek.temperature` | `0.7` | | 0–2 |
| `deepseek.maxTokens` | `1024` | | 单轮最大输出 |
| `deepseek.timeoutMs` | `60000` | | 请求超时 |
| `deepseek.stream` | `true` | | 是否流式 |
| `deepseek.maxToolRounds` | `3` | | 工具调用最大轮次 |

### 提示词

| 字段 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt.systemPrompt` | – | ✅ | 人设、规则与输出约束；每轮固定注入，标注最高优先级，不可被用户输入覆盖 |
| `prompt.maxHistoryMessages` | `20` | | 携带的历史消息条数上限 |
| `prompt.maxContextChars` | `24000` | | 上下文预算（仅裁剪历史） |

### 记忆

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `memory.maxItems` | `120` | 每用户记忆容量上限，超出按评分淘汰 |
| `memory.ttlDays` | `180` | 记忆有效期（天） |
| `memory.summaryTopK` | `30` | 摘要最多纳入的高分记忆条数 |
| `memory.summaryMaxChars` | `1200` | 摘要长度上限 |
| `memory.summaryMode` | `auto` | `auto`/`model`/`off`，摘要由模型或本地拼接生成 |
| `memory.minImportance` | `2` | 低于该重要度的记忆不进入摘要 |
| `memory.similarityThreshold` | `0.72` | 去重合并阈值（0.4–0.99） |
| `memory.autoExtractOnEnd` | `true` | 会话结束时自动提炼 |
| `memory.extractMaxItems` | `10` | 单次提炼上限 |

### 会话

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `session.ttlMinutes` | `120` | 会话总时长上限 |
| `session.idleTimeoutMinutes` | `45` | 空闲超时，续聊时滑动顺延 |
| `session.maxTurns` | `60` | 单会话最大轮数 |
| `session.maxInputChars` | `8000` | 单条输入长度上限 |
| `session.retentionDays` | `7` | 已结束会话的消息保留天数 |

### 存储

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `storage.driver` | `kv` | `kv` / `redis` / `memory` |
| `storage.kvBinding` | `chat_kv` | KV 绑定变量名 |
| `storage.redisUrl` | – | Upstash REST 地址（Redis 模式必填） |
| `storage.redisToken` | – | Upstash Token（加密存储） |
| `storage.keyPrefix` | `cb` | 键前缀（仅字母数字下划线） |

### API

| 字段 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `api.serviceToken` | – | ✅ | 服务访问令牌，`Authorization: Bearer <token>`（加密存储，可一键轮换） |
| `api.rateLimitPerMinute` | `30` | | 每用户每分钟消息上限 |
| `api.allowAdminSessionForApi` | `true` | | 允许已登录控制台直接调用业务接口（便于测试） |

### 微信机器人（iLink）

| 字段 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `wechat.botToken` | – | ✅ | `bot_token`（加密存储） |
| `wechat.ilinkBotId` | – | ✅ | `ilink_bot_id` |
| `wechat.ilinkUserId` | – | ✅ | `ilink_user_id` |
| `wechat.baseUrl` | `https://ilinkai.weixin.qq.com` | ✅ | iLink 基座地址 |
| `wechat.channelVersion` | `2.0.0` | | `channel_version` 请求头 |
| `wechat.contextTokenTtlHours` | `24` | | `context_token` 缓存时长 |
| `wechat.typingEnabled` | `true` | | 是否发送「正在输入」 |
| `wechat.pollTimeoutSeconds` | `35` | | 长轮询超时 |
| `wechat.cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | | 媒体 CDN 基址 |
| `wechat.autoSend` | `false` | | 入站消息处理后是否直接调用 `/sendmessage` |

## 接口一览

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /api/health` | 无 | 版本、初始化状态、存储/配置状态 |
| `POST /api/session` | 服务令牌或管理员会话 | `action`: `create` / `message` / `end` / `get` / `list`；`message` 支持 `stream:true` 返回 SSE |
| `GET/POST/DELETE /api/memory` | 服务令牌或管理员会话 | 记忆查询 / 手动新增 / 删除 |
| `GET /api/admin/status` | 无 | 登录状态、CSRF、脱敏配置与必填项 |
| `POST /api/admin/auth` | 无 | `bootstrap_verify` / `register_begin` / `register_finish` / `login_begin` / `login_finish` / `logout` |
| `GET/PUT /api/admin/config` | 管理员 + CSRF | 读写配置，支持增量保存、清除密钥、轮换服务令牌 |
| `GET/POST /api/admin/security` | 管理员（POST 需 CSRF） | 安全密钥列表、生成/撤销一次性链接、删除 Passkey |
| `GET /api/admin/overview` | 管理员 | 会话/记忆统计概览 |
| `POST /api/admin/test` | 管理员 + CSRF | `target`: `deepseek` / `storage` / `wechat` / `all` |
| `POST /api/wechat/message` | 服务令牌 | 微信入站消息 → 生成回复，可选自动发送 |
| `POST /api/wechat/send` | 服务令牌 | 主动发送消息（需 `context_token`） |
| `POST /api/wechat/typing` | 服务令牌 | 发送/取消「正在输入」 |
| `GET/POST /api/wechat/context` | 服务令牌 | 保存/读取用户 `context_token` |
| `POST /api/cron/cleanup` | `CRON_SECRET`（可干跑） | 超时会话收尾、过期数据清理 |

### 调用示例

```bash
# 创建会话
curl -X POST https://bot.example.com/api/session \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"create","user_id":"wx_user_001","title":"首次对话"}'

# 续接对话
curl -X POST https://bot.example.com/api/session \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"message","user_id":"wx_user_001","session_id":"sXXXX","content":"我叫小林，喜欢喝美式"}'

# 结束并提炼记忆
curl -X POST https://bot.example.com/api/session \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"end","user_id":"wx_user_001","session_id":"sXXXX"}'
```

## 微信接入

云端只负责「消息 → 回复」，长轮询由你的常驻网关（或 EdgeOne 定时任务）完成：

1. 网关调用 `POST {baseUrl}/getupdates`（长轮询），取出新消息；
2. 将 `from_user_id`、文本、`msg_id`、`context_token` 转发到 `POST /api/wechat/message`；
3. 若配置 `autoSend: true`（或请求体 `auto_send: true`），云端会直接调用 `/sendmessage` 回复微信；否则由网关使用返回的 `reply` 自行发送；
4. `context_token` 会按 `contextTokenTtlHours` 缓存，`/sendmessage`、`/sendtyping` 复用；缓存过期时会在入站消息中自动刷新。

## 安全模型

- **一次性安全链接**：`/setup?token=…` 仅用于首次登记 Passkey。令牌哈希存 KV，注册成功即删除；`BOOTSTRAP_TOKEN` 使用后也会写入标记而失效。
- **Passkey（WebAuthn）**：服务端完整校验 `clientDataJSON`、`authenticatorData`、`rpIdHash`、ES256/RS256 签名与签名计数器；支持多把密钥（上限 20），且禁止删除最后一枚或当前正在使用的密钥。
- **密封 Cookie**：管理员会话、注册 setup 状态、登录 challenge 都用 AES-GCM 密封后放入 HttpOnly Cookie，避免 KV 最终一致性带来的状态错乱。
- **CSRF 双提交**：写操作同时校验 `X-CSRF-Token` 请求头与 `cb_csrf` Cookie。
- **密钥加密**：DeepSeek Key、Redis Token、服务令牌、微信 `bot_token` 均以 AES-GCM 加密后写入 KV，接口只返回掩码与 `has` 状态。
- **限流**：登录/引导/配置链接/会话消息均有固定窗口限流。

## 本地开发

```bash
npm run dev    # 需要安装 EdgeOne CLI：edgeone pages dev
```

未绑定 KV 时，配置与业务存储自动降级为进程内存储（重启丢失），便于本地调试。

## 已知限制

- EdgeOne KV 无原生 TTL，过期靠读写时惰性判断 + 每日 02:00（Asia/Shanghai）的定时清理；KV 写入最终一致（约秒级到分钟级）。
- 多实例部署务必显式设置 `APP_MASTER_KEY`，否则各实例可能自动生成不同的主密钥。
- 单次函数最长 120 秒；长对话较多时建议开启流式输出或降低 `maxTokens`。

更详细的接口契约、数据结构与算法说明见 [docs/DESIGN.md](docs/DESIGN.md)。
