# Telegram 频道备份系统 - 技术实现方案

> **版本说明**
>
> | 版本 | 状态 | 说明 |
> |------|------|------|
> | **v1.0** | 当前实现 | 核心功能：频道订阅、历史镜像、实时同步、失败重试、Web 管理界面 |
> | **v1.1** | 计划中 | 编辑/删除同步、编辑历史保留、媒体组合并处理 |
> | **v2.0** | 待规划 | 多并发镜像、导出功能、频道状态监控 |
>
> 文档中标注 `[v1.1]` 或 `[v1.1 计划]` 的功能表示当前版本暂未完整实现。

## 技术栈选型

| 层级 | 技术选择 | 说明 |
|------|----------|------|
| **前端** | Next.js 14 (App Router) | React 框架，支持 SSR/SSG，与 Supabase 集成良好 |
| **后端 API** | Next.js API Routes | 与前端统一部署，简化架构 |
| **镜像服务** | Node.js + gramjs | 独立进程，使用 MTProto 协议 |
| **数据库** | Supabase (PostgreSQL) | 免费版：500MB 存储、无限 API 请求 |
| **ORM** | Drizzle ORM | 类型安全、轻量、支持 PostgreSQL |
| **样式** | Tailwind CSS + shadcn/ui | 快速开发、组件丰富 |

---

## 项目结构

```
tg-back/
├── apps/
│   ├── web/                          # Next.js Web 应用
│   │   ├── app/
│   │   │   ├── (dashboard)/          # 仪表盘布局组
│   │   │   │   ├── page.tsx          # 首页/仪表盘
│   │   │   │   ├── channels/
│   │   │   │   │   ├── page.tsx      # 频道列表
│   │   │   │   │   └── [id]/page.tsx # 频道详情
│   │   │   │   ├── messages/
│   │   │   │   │   └── page.tsx      # 消息浏览
│   │   │   │   ├── tasks/
│   │   │   │   │   └── page.tsx      # 任务管理
│   │   │   │   └── settings/
│   │   │   │       └── page.tsx      # 系统设置
│   │   │   ├── api/                  # API Routes
│   │   │   │   ├── channels/
│   │   │   │   ├── messages/
│   │   │   │   ├── tasks/
│   │   │   │   ├── settings/
│   │   │   │   └── auth/
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   │   ├── ui/                   # shadcn/ui 组件
│   │   │   ├── channels/
│   │   │   ├── messages/
│   │   │   └── common/
│   │   ├── lib/
│   │   │   ├── supabase/
│   │   │   │   ├── client.ts         # 浏览器客户端
│   │   │   │   └── server.ts         # 服务端客户端
│   │   │   └── utils.ts
│   │   └── hooks/
│   │
│   └── mirror-service/               # 镜像服务（独立进程）
│       ├── src/
│       │   ├── index.ts              # 入口
│       │   ├── client/
│       │   │   └── telegram.ts       # gramjs 客户端封装
│       │   ├── services/
│       │   │   ├── task-runner.ts    # 任务调度主循环
│       │   │   ├── history-sync.ts   # 历史消息同步
│       │   │   ├── realtime-sync.ts  # 实时消息监听
│       │   │   ├── message-mirror.ts # 消息镜像逻辑
│       │   │   ├── settings-cache.ts # 设置缓存
│       │   │   └── rate-limiter.ts   # 限流处理
│       │   ├── handlers/
│       │   │   ├── text.ts
│       │   │   ├── media.ts
│       │   │   └── media-group.ts
│       │   └── utils/
│       │       ├── retry.ts
│       │       └── logger.ts
│       └── package.json
│
├── packages/
│   └── db/                           # 数据库层（共享）
│       ├── src/
│       │   ├── schema/               # Drizzle Schema
│       │   │   ├── source-channels.ts
│       │   │   ├── mirror-channels.ts
│       │   │   ├── message-mappings.ts
│       │   │   ├── sync-tasks.ts
│       │   │   ├── sync-events.ts
│       │   │   └── settings.ts
│       │   ├── index.ts              # 导出
│       │   └── client.ts             # 数据库客户端
│       ├── drizzle/
│       │   └── migrations/           # 数据库迁移
│       └── drizzle.config.ts
│
├── package.json                      # Monorepo 根配置
├── pnpm-workspace.yaml
├── turbo.json                        # Turborepo 配置
└── .env.example
```

---

## Supabase 数据库设计

### 免费版限制与应对

| 限制项 | 免费额度 | 应对策略 |
|--------|----------|----------|
| 数据库大小 | 500MB | 只存元数据和文本，不存媒体文件 |
| API 请求 | 无限制 | 正常使用即可 |
| 边缘函数调用 | 500K/月 | 使用 Next.js API Routes 替代 |
| 实时订阅 | 200 并发 | 个人使用足够 |
| 文件存储 | 1GB | 不使用，媒体存镜像频道 |

### 数据库 Schema (Drizzle ORM)

```typescript
// packages/db/src/schema/source-channels.ts
import { pgTable, uuid, text, timestamp, boolean, integer, bigint, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';

export const syncStatusEnum = pgEnum('sync_status', ['pending', 'syncing', 'completed', 'error']);
export const mirrorModeEnum = pgEnum('mirror_mode', ['forward', 'copy']);

export const sourceChannels = pgTable('source_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 用户输入的频道标识（username 或 invite link），用于展示和重新解析
  channelIdentifier: text('channel_identifier').notNull(),
  // Telegram 真实频道 ID（数字），resolve 成功后写入；NULL 表示尚未解析
  // 使用 unique() 约束，PostgreSQL 允许多个 NULL 值存在
  telegramId: bigint('telegram_id', { mode: 'string' }).unique(),
  // access_hash 用于构造 InputPeerChannel，重启后也能稳定操作频道
  accessHash: bigint('access_hash', { mode: 'string' }),
  name: text('name').notNull(),
  username: text('username'),
  avatarUrl: text('avatar_url'),
  description: text('description'),
  subscribedAt: timestamp('subscribed_at', { withTimezone: true }).defaultNow().notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  syncStatus: syncStatusEnum('sync_status').default('pending').notNull(),
  lastMessageId: integer('last_message_id'),
  isProtected: boolean('is_protected').default(false).notNull(),
  memberCount: integer('member_count'),
  totalMessages: integer('total_messages'),
  mirrorMode: mirrorModeEnum('mirror_mode').default('copy'),
  isActive: boolean('is_active').default(true).notNull(),
  priority: integer('priority').default(0).notNull(),
});
```

```typescript
// packages/db/src/schema/mirror-channels.ts
import { pgTable, uuid, text, timestamp, boolean, bigint } from 'drizzle-orm/pg-core';
import { sourceChannels } from './source-channels';

export const mirrorChannels = pgTable('mirror_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceChannelId: uuid('source_channel_id')
    .notNull()
    .unique()
    .references(() => sourceChannels.id, { onDelete: 'cascade' }),
  telegramId: bigint('telegram_id', { mode: 'string' }).notNull(),
  // access_hash 用于构造 InputPeerChannel
  accessHash: bigint('access_hash', { mode: 'string' }),
  name: text('name').notNull(),
  username: text('username'),
  inviteLink: text('invite_link'),
  isAutoCreated: boolean('is_auto_created').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

```typescript
// packages/db/src/schema/message-mappings.ts
import { pgTable, uuid, text, timestamp, boolean, integer, bigint, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sourceChannels } from './source-channels';
import { mirrorChannels } from './mirror-channels';

export const messageStatusEnum = pgEnum('message_status', ['pending', 'success', 'failed', 'skipped']);
export const messageTypeEnum = pgEnum('message_type', ['text', 'photo', 'video', 'document', 'audio', 'voice', 'animation', 'sticker', 'other']);
export const skipReasonEnum = pgEnum('skip_reason', [
  'protected_content',
  'file_too_large',
  'unsupported_type',
  'rate_limited_skip',
  'failed_too_many_times',  // 超过最大重试次数
  'message_deleted',        // 源消息已删除
]);

export const messageMappings = pgTable('message_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceChannelId: uuid('source_channel_id')
    .notNull()
    .references(() => sourceChannels.id, { onDelete: 'cascade' }),
  sourceMessageId: integer('source_message_id').notNull(),
  mirrorChannelId: uuid('mirror_channel_id')
    .notNull()
    .references(() => mirrorChannels.id, { onDelete: 'cascade' }),
  mirrorMessageId: integer('mirror_message_id'),
  messageType: messageTypeEnum('message_type').notNull(),
  mediaGroupId: text('media_group_id'),
  status: messageStatusEnum('status').default('pending').notNull(),
  skipReason: skipReasonEnum('skip_reason'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0).notNull(),
  hasMedia: boolean('has_media').default(false).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }),  // 使用 bigint 支持大文件
  text: text('text'),                    // 完整文本，用于搜索
  textPreview: text('text_preview'),     // 前200字符，用于列表展示
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  mirroredAt: timestamp('mirrored_at', { withTimezone: true }),
  isDeleted: boolean('is_deleted').default(false).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  editCount: integer('edit_count').default(0).notNull(),
  lastEditedAt: timestamp('last_edited_at', { withTimezone: true }),
}, (table) => ({
  // 唯一约束（使用 uniqueIndex 确保正确生成）
  uniqueSourceMessage: uniqueIndex('unique_source_message')
    .on(table.sourceChannelId, table.sourceMessageId),
  // 常用查询索引
  channelSentAtIdx: index('channel_sent_at_idx')
    .on(table.sourceChannelId, table.sentAt),
  statusChannelIdx: index('status_channel_idx')
    .on(table.status, table.sourceChannelId),
  mediaGroupIdx: index('media_group_idx')
    .on(table.mediaGroupId),
}));
```

```typescript
// packages/db/src/schema/sync-tasks.ts
import { pgTable, uuid, timestamp, integer, text, pgEnum, index } from 'drizzle-orm/pg-core';
import { sourceChannels } from './source-channels';

export const taskTypeEnum = pgEnum('task_type', ['resolve', 'history_full', 'history_partial', 'realtime', 'retry_failed']);
export const taskStatusEnum = pgEnum('task_status', ['pending', 'running', 'paused', 'completed', 'failed']);

export const syncTasks = pgTable('sync_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceChannelId: uuid('source_channel_id')
    .notNull()
    .references(() => sourceChannels.id, { onDelete: 'cascade' }),
  taskType: taskTypeEnum('task_type').notNull(),
  status: taskStatusEnum('status').default('pending').notNull(),
  progressCurrent: integer('progress_current').default(0).notNull(),
  progressTotal: integer('progress_total'),
  lastProcessedId: integer('last_processed_id'),
  failedCount: integer('failed_count').default(0).notNull(),  // 记录失败消息数
  skippedCount: integer('skipped_count').default(0).notNull(), // 记录跳过消息数
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelStatusIdx: index('channel_status_idx')
    .on(table.sourceChannelId, table.status),
  statusCreatedIdx: index('status_created_idx')
    .on(table.status, table.createdAt),
}));
```

```typescript
// packages/db/src/schema/sync-events.ts
import { pgTable, uuid, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { sourceChannels } from './source-channels';

export const eventLevelEnum = pgEnum('event_level', ['info', 'warn', 'error']);

export const syncEvents = pgTable('sync_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceChannelId: uuid('source_channel_id')
    .references(() => sourceChannels.id, { onDelete: 'cascade' }),
  level: eventLevelEnum('level').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelCreatedIdx: index('event_channel_created_idx')
    .on(table.sourceChannelId, table.createdAt),
}));
```

```typescript
// packages/db/src/schema/settings.ts
import { pgTable, text, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
});

// 默认设置
export const defaultSettings = {
  // Telegram session（加密存储）
  // 注意：telegram_api_id 和 telegram_api_hash 已移至环境变量，不再存储于数据库
  telegram_session: '',          // 登录后的 session 字符串（加密）

  // 镜像设置
  default_mirror_mode: 'copy',   // 'forward' | 'copy'
  concurrent_mirrors: 1,
  mirror_interval_ms: 1000,      // 镜像间隔（毫秒）

  // 频道命名
  auto_channel_prefix: '[备份] ',
  auto_channel_private: true,

  // 重试设置
  max_retry_count: 3,
  retry_interval_sec: 60,
  skip_after_max_retry: true,

  // 编辑与撤回（备份语义：镜像频道消息只追加，不会被编辑/删除）
  // 以下开关仅决定是否“记录源消息的编辑/撤回状态到 DB”，不会改动镜像频道中的备份消息
  sync_message_edits: false,
  keep_edit_history: true,       // 可选：记录编辑历史（仅 DB）
  sync_message_deletions: false,

  // 媒体处理
  mirror_videos: true,
  max_file_size_mb: 100,
  skip_protected_content: true,
  group_media_messages: true,

  // 访问控制
  access_password: '',           // 简单密码保护
};
```

### 全文搜索设置 (SQL)

```sql
-- 启用 pg_trgm 扩展（中文搜索）
create extension if not exists pg_trgm;

-- 为 text 字段创建 trigram 索引
create index if not exists message_mappings_text_trgm_idx
  on message_mappings
  using gin (text gin_trgm_ops);

-- 为 cursor 分页创建复合索引
create index if not exists message_mappings_cursor_idx
  on message_mappings (source_channel_id, sent_at desc, source_message_id desc);

/**
 * 搜索函数（已弃用，保留供参考）
 *
 * 注意：建议直接使用 Web API 的 cursor 分页查询，而非此 SQL function。
 * 此函数使用 OFFSET 分页，在大数据量时性能较差。
 *
 * 如果仍需使用此函数，请注意：
 * - 搜索关键词建议 >= 3 字符
 * - 务必带 channel_id 或 start_date/end_date 过滤条件
 * - 避免全表扫描
 */
create or replace function search_messages_deprecated(
  search_query text,
  channel_id uuid default null,
  msg_type text default null,
  start_date timestamp default null,
  end_date timestamp default null,
  page_size int default 20,
  page_offset int default 0
)
returns table (
  id uuid,
  source_channel_id uuid,
  source_message_id int,
  mirror_message_id int,
  message_type text,
  text_preview text,
  sent_at timestamp,
  similarity float4
)
language plpgsql
as $$
begin
  return query
  select
    m.id,
    m.source_channel_id,
    m.source_message_id,
    m.mirror_message_id,
    m.message_type::text,
    m.text_preview,
    m.sent_at,
    similarity(m.text, search_query) as similarity
  from message_mappings m
  where
    m.status = 'success'
    and (search_query is null or m.text ilike '%' || search_query || '%')
    and (channel_id is null or m.source_channel_id = channel_id)
    and (msg_type is null or m.message_type::text = msg_type)
    and (start_date is null or m.sent_at >= start_date)
    and (end_date is null or m.sent_at <= end_date)
  order by
    case when search_query is not null
      then similarity(m.text, search_query)
      else 0
    end desc,
    m.sent_at desc
  limit page_size
  offset page_offset;
end;
$$;
```

> **搜索实现说明**：
> - **主推方案**：使用 Web API 的 cursor 分页（`/api/messages?cursor_sent_at=...&cursor_message_id=...`）
> - **SQL function**：`search_messages_deprecated` 保留供特殊场景使用，但不推荐
> - **索引策略**：`pg_trgm` 用于模糊搜索，复合索引用于 cursor 分页

---

## 镜像服务实现

### gramjs 客户端封装

```typescript
// apps/mirror-service/src/client/telegram.ts
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { db } from '@tg-back/db';
import { settings } from '@tg-back/db/schema';
import { eq } from 'drizzle-orm';
import { decrypt } from '../utils/crypto';

export class TelegramService {
  private client: TelegramClient | null = null;
  private apiId: number = 0;
  private apiHash: string = '';

  async initialize() {
    // 优先从环境变量读取 API 凭证（推荐），session 从数据库读取
    this.apiId = Number(process.env.TELEGRAM_API_ID);
    this.apiHash = process.env.TELEGRAM_API_HASH || '';

    if (!this.apiId || !this.apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables');
    }

    // 从数据库读取加密的 session
    const sessionSetting = await db.select().from(settings).where(eq(settings.key, 'telegram_session'));
    const encryptedSession = String(sessionSetting[0]?.value || '');

    // 解密 session（如果已加密）
    let sessionString = '';
    if (encryptedSession) {
      try {
        sessionString = decrypt(encryptedSession);
      } catch (error) {
        console.error('Failed to decrypt session:', error);
        throw new Error(
          'Session 解密失败，可能是加密密钥已更换或 session 数据损坏。' +
          '请通过 Web 界面重新登录 Telegram 账号。'
        );
      }
    }

    const session = new StringSession(sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    await this.client.connect();
    return this.client;
  }

  async getClient(): Promise<TelegramClient> {
    if (!this.client) {
      await this.initialize();
    }
    return this.client!;
  }

  /**
   * 根据已持久化的 telegramId 和 accessHash 构造 InputPeerChannel
   * 避免每次都调用 getEntity() 导致额外 API 开销或缓存失效问题
   */
  getInputPeerChannel(telegramId: string, accessHash: string): Api.InputPeerChannel {
    if (!accessHash) {
      throw new Error(`Missing accessHash for channel ${telegramId}. Channel may need to be re-resolved.`);
    }
    return new Api.InputPeerChannel({
      channelId: BigInt(telegramId),
      accessHash: BigInt(accessHash),
    });
  }

  // 解析频道标识，返回真实的 channel ID 和 access_hash
  async resolveChannel(channelIdentifier: string): Promise<{
    id: string;
    accessHash: string;
    title: string;
    username?: string;
    participantsCount?: number;
    about?: string;
    noforwards: boolean;
  }> {
    const client = await this.getClient();
    const entity = await client.getEntity(channelIdentifier);

    if (!(entity instanceof Api.Channel)) {
      throw new Error('Not a channel');
    }

    const fullChannel = await client.invoke(
      new Api.channels.GetFullChannel({ channel: entity })
    ) as Api.messages.ChatFull;

    return {
      id: entity.id.toString(),
      accessHash: entity.accessHash?.toString() || '',
      title: entity.title,
      username: entity.username || undefined,
      participantsCount: (fullChannel.fullChat as Api.ChannelFull).participantsCount,
      about: (fullChannel.fullChat as Api.ChannelFull).about,
      noforwards: entity.noforwards || false,
    };
  }

  // 获取频道历史消息（使用 InputPeer 避免 getEntity 开销）
  async *getChannelHistory(
    telegramId: string,
    accessHash: string,
    offsetId: number = 0,
    limit: number = 100
  ) {
    const client = await this.getClient();
    const inputPeer = this.getInputPeerChannel(telegramId, accessHash);

    while (true) {
      const messages = await client.getMessages(inputPeer, {
        limit,
        offsetId,
        reverse: true,  // 从旧到新
      });

      if (messages.length === 0) break;

      for (const msg of messages) {
        yield msg;
      }

      offsetId = messages[messages.length - 1].id;
    }
  }

  // 创建私有频道
  async createPrivateChannel(title: string, about: string = '') {
    const client = await this.getClient();

    const result = await client.invoke(
      new Api.channels.CreateChannel({
        title,
        about,
        broadcast: true,
        megagroup: false,
      })
    ) as Api.Updates;

    const channel = result.chats[0] as Api.Channel;

    const inviteLink = await client.invoke(
      new Api.messages.ExportChatInvite({
        peer: channel,
      })
    ) as Api.ChatInviteExported;

    return {
      id: channel.id.toString(),
      accessHash: channel.accessHash?.toString() || '',
      title: channel.title,
      inviteLink: inviteLink.link,
    };
  }

  // 转发消息（使用 InputPeer）
  async forwardMessage(
    fromTelegramId: string,
    fromAccessHash: string,
    toTelegramId: string,
    toAccessHash: string,
    messageIds: number[]
  ) {
    const client = await this.getClient();
    const fromPeer = this.getInputPeerChannel(fromTelegramId, fromAccessHash);
    const toPeer = this.getInputPeerChannel(toTelegramId, toAccessHash);

    const result = await client.invoke(
      new Api.messages.ForwardMessages({
        fromPeer,
        toPeer,
        id: messageIds,
        randomId: messageIds.map(() => BigInt(Math.floor(Math.random() * 1e15))),
      })
    );

    return result;
  }

  // 复制消息（无转发标记）- 使用 InputPeer，移除 parseMode 避免 HTML 解析错误
  async copyMessage(
    toTelegramId: string,
    toAccessHash: string,
    message: Api.Message
  ) {
    const client = await this.getClient();
    const toPeer = this.getInputPeerChannel(toTelegramId, toAccessHash);

    if (message.media) {
      // 下载媒体到 buffer
      const buffer = await client.downloadMedia(message, {});
      if (!buffer) {
        throw new Error('Failed to download media');
      }

      // 重新上传发送（不使用 parseMode，直接发送原始文本）
      return await client.sendFile(toPeer, {
        file: buffer,
        caption: message.message || '',
        // 不设置 parseMode，避免 HTML 解析错误
        // 如需保留格式，应使用 message.entities 传递
        formattingEntities: message.entities,
        // 保留原始文件名（如果有）
        attributes: this.getMediaAttributes(message),
      });
    } else {
      // 发送纯文本消息，保留原始 entities 格式
      return await client.sendMessage(toPeer, {
        message: message.message || '',
        formattingEntities: message.entities,
      });
    }
  }

  // 获取媒体属性（文件名等）
  private getMediaAttributes(message: Api.Message): Api.TypeDocumentAttribute[] | undefined {
    if (message.media instanceof Api.MessageMediaDocument) {
      const doc = message.media.document;
      if (doc instanceof Api.Document) {
        return doc.attributes;
      }
    }
    return undefined;
  }

  // 监听频道新消息（使用 gramjs 的 NewMessage 事件）
  // 注意：订阅时仍需通过 getEntity 获取实体，因为 NewMessage 事件需要 Chat 对象
  // 但这只在订阅时调用一次，后续消息处理不需要再调用
  async subscribeToChannels(
    channels: Array<{ telegramId: string; accessHash: string }>,
    callback: (channelId: string, message: Api.Message) => Promise<void>
  ) {
    const client = await this.getClient();

    // 为每个频道创建事件监听
    for (const channel of channels) {
      // 使用 InputPeerChannel 获取实体（比直接用 ID 字符串更可靠）
      const inputPeer = this.getInputPeerChannel(channel.telegramId, channel.accessHash);
      const entity = await client.getEntity(inputPeer);

      client.addEventHandler(async (event: NewMessageEvent) => {
        if (event.message && event.message instanceof Api.Message) {
          await callback(channel.telegramId, event.message);
        }
      }, new NewMessage({ chats: [entity] }));
    }

    console.log(`Subscribed to ${channels.length} channels for real-time sync`);
  }

  // 监听消息编辑
  async subscribeToEdits(
    channelIds: string[],
    callback: (channelId: string, message: Api.Message) => Promise<void>
  ) {
    const client = await this.getClient();

    // gramjs 使用 Raw handler 监听编辑事件
    client.addEventHandler(async (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateEditChannelMessage) {
        const message = update.message;
        if (message instanceof Api.Message) {
          const channelId = message.peerId;
          if (channelId instanceof Api.PeerChannel) {
            const id = channelId.channelId.toString();
            if (channelIds.includes(id)) {
              await callback(id, message);
            }
          }
        }
      }
    });
  }

  // 监听消息删除
  async subscribeToDeletes(
    channelIds: string[],
    callback: (channelId: string, messageIds: number[]) => Promise<void>
  ) {
    const client = await this.getClient();

    client.addEventHandler(async (update: Api.TypeUpdate) => {
      if (update instanceof Api.UpdateDeleteChannelMessages) {
        const channelId = update.channelId.toString();
        if (channelIds.includes(channelId)) {
          await callback(channelId, update.messages);
        }
      }
    });
  }
}

export const telegramService = new TelegramService();
```

### 限流处理

```typescript
// apps/mirror-service/src/services/rate-limiter.ts
import { sleep } from '../utils/sleep';
import { settingsCache } from './settings-cache';

interface RateLimitConfig {
  baseIntervalMs: number;      // 基础间隔
  maxRetries: number;          // 最大重试次数
  backoffMultiplier: number;   // 退避倍数
}

export class RateLimiter {
  private lastRequestTime: number = 0;
  private floodWaitUntil: number = 0;
  private config: RateLimitConfig;

  constructor(defaultConfig: RateLimitConfig) {
    this.config = defaultConfig;
  }

  // 从设置更新配置
  async updateFromSettings(): Promise<void> {
    const settings = await settingsCache.get();
    this.config = {
      baseIntervalMs: settings.mirror_interval_ms,
      maxRetries: settings.max_retry_count,
      backoffMultiplier: 2,  // 退避倍数保持固定
    };
  }

  async waitForSlot(): Promise<void> {
    // 每次调用时检查是否需要更新配置
    await this.updateFromSettings();

    const now = Date.now();

    // 如果处于 FLOOD_WAIT 状态
    if (this.floodWaitUntil > now) {
      const waitTime = this.floodWaitUntil - now;
      console.log(`Rate limited, waiting ${waitTime}ms`);
      await sleep(waitTime);
    }

    // 确保基础间隔
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.config.baseIntervalMs) {
      await sleep(this.config.baseIntervalMs - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
  }

  handleFloodWait(seconds: number): void {
    this.floodWaitUntil = Date.now() + (seconds * 1000);
    console.log(`FLOOD_WAIT received, pausing for ${seconds} seconds`);
  }

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    onRetry?: (attempt: number, error: Error) => void
  ): Promise<T> {
    // 确保使用最新设置
    await this.updateFromSettings();

    let lastError: Error | null = null;
    let delay = this.config.baseIntervalMs;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.waitForSlot();
        return await operation();
      } catch (error: any) {
        lastError = error;

        // 处理 FLOOD_WAIT
        if (error.message?.includes('FLOOD_WAIT')) {
          const waitSeconds = parseInt(error.message.match(/\d+/)?.[0] || '60');
          this.handleFloodWait(waitSeconds);
          delay = waitSeconds * 1000;
        } else {
          delay *= this.config.backoffMultiplier;
        }

        if (onRetry) {
          onRetry(attempt, error);
        }

        if (attempt < this.config.maxRetries) {
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }
}

// 默认配置，实际运行时会从 settings 获取
export const globalRateLimiter = new RateLimiter({
  baseIntervalMs: 1000,  // 默认值，会被 settings.mirror_interval_ms 覆盖
  maxRetries: 3,         // 默认值，会被 settings.max_retry_count 覆盖
  backoffMultiplier: 2,
});

/**
 * 注意：v1 版本暂不支持 concurrent_mirrors 并发镜像。
 * 当前实现为单并发（一次只处理一个任务），后续版本可通过任务队列实现多并发。
 */
```

### 设置缓存

```typescript
// apps/mirror-service/src/services/settings-cache.ts
import { db } from '@tg-back/db';
import { settings } from '@tg-back/db/schema';

interface CachedSettings {
  default_mirror_mode: 'forward' | 'copy';
  concurrent_mirrors: number;
  mirror_interval_ms: number;
  max_retry_count: number;
  retry_interval_sec: number;
  skip_after_max_retry: boolean;
  sync_message_edits: boolean;
  keep_edit_history: boolean;
  sync_message_deletions: boolean;
  mirror_videos: boolean;
  max_file_size_mb: number;
  skip_protected_content: boolean;
  group_media_messages: boolean;
  auto_channel_prefix: string;
}

const DEFAULT_SETTINGS: CachedSettings = {
  default_mirror_mode: 'copy',
  concurrent_mirrors: 1,
  mirror_interval_ms: 1000,
  max_retry_count: 3,
  retry_interval_sec: 60,
  skip_after_max_retry: true,
  sync_message_edits: false,
  keep_edit_history: true,
  sync_message_deletions: false,
  mirror_videos: true,
  max_file_size_mb: 100,
  skip_protected_content: true,
  group_media_messages: true,
  auto_channel_prefix: '[备份] ',
};

class SettingsCache {
  private cache: CachedSettings | null = null;
  private lastLoadTime: number = 0;
  private readonly ttlMs: number = 60000; // 1 分钟 TTL

  async get(): Promise<CachedSettings> {
    const now = Date.now();

    // 如果缓存有效，直接返回
    if (this.cache && (now - this.lastLoadTime) < this.ttlMs) {
      return this.cache;
    }

    // 重新加载
    await this.reload();
    return this.cache!;
  }

  async reload(): Promise<void> {
    const rows = await db.select().from(settings);
    const settingsMap = new Map(rows.map(r => [r.key, r.value]));

    this.cache = {
      default_mirror_mode: (settingsMap.get('default_mirror_mode') as string) || DEFAULT_SETTINGS.default_mirror_mode,
      concurrent_mirrors: Number(settingsMap.get('concurrent_mirrors')) || DEFAULT_SETTINGS.concurrent_mirrors,
      mirror_interval_ms: Number(settingsMap.get('mirror_interval_ms')) || DEFAULT_SETTINGS.mirror_interval_ms,
      max_retry_count: Number(settingsMap.get('max_retry_count')) || DEFAULT_SETTINGS.max_retry_count,
      retry_interval_sec: Number(settingsMap.get('retry_interval_sec')) || DEFAULT_SETTINGS.retry_interval_sec,
      skip_after_max_retry: settingsMap.get('skip_after_max_retry') !== false,
      sync_message_edits: settingsMap.get('sync_message_edits') === true,
      keep_edit_history: settingsMap.get('keep_edit_history') !== false,
      sync_message_deletions: settingsMap.get('sync_message_deletions') === true,
      mirror_videos: settingsMap.get('mirror_videos') !== false,
      max_file_size_mb: Number(settingsMap.get('max_file_size_mb')) || DEFAULT_SETTINGS.max_file_size_mb,
      skip_protected_content: settingsMap.get('skip_protected_content') !== false,
      group_media_messages: settingsMap.get('group_media_messages') !== false,
      auto_channel_prefix: (settingsMap.get('auto_channel_prefix') as string) || DEFAULT_SETTINGS.auto_channel_prefix,
    } as CachedSettings;

    this.lastLoadTime = Date.now();
    console.log('Settings cache reloaded');
  }

  // 强制刷新（设置变更时调用）
  invalidate(): void {
    this.cache = null;
    this.lastLoadTime = 0;
  }
}

export const settingsCache = new SettingsCache();
```

### 任务调度主循环

```typescript
// apps/mirror-service/src/services/task-runner.ts
import { db } from '@tg-back/db';
import { syncTasks, sourceChannels, mirrorChannels } from '@tg-back/db/schema';
import { eq, and, or, sql, desc, asc, isNotNull } from 'drizzle-orm';
import { runHistorySync } from './history-sync';
import { runRetryFailed } from './retry-failed';
import { telegramService } from '../client/telegram';
import { logSyncEvent } from '../utils/logger';
import { settingsCache } from './settings-cache';

interface TaskRunner {
  start(): Promise<void>;
  stop(): void;
}

class TaskRunnerService implements TaskRunner {
  private isRunning: boolean = false;
  private currentTaskId: string | null = null;
  private pollIntervalMs: number = 5000; // 5 秒轮询一次

  async start(): Promise<void> {
    this.isRunning = true;
    console.log('Task runner started');

    while (this.isRunning) {
      try {
        await this.processNextTask();
      } catch (error: any) {
        console.error('Task runner error:', error.message);
      }

      // 等待下一次轮询
      await this.sleep(this.pollIntervalMs);
    }
  }

  stop(): void {
    this.isRunning = false;
    console.log('Task runner stopping...');
  }

  private async processNextTask(): Promise<void> {
    // 获取设置
    const settings = await settingsCache.get();

    // 查找下一个待执行的任务
    // 使用 CASE 显式排序：pending=0 优先于 paused=1
    // priority DESC 让高优先级先执行
    const [task] = await db.select({
      task: syncTasks,
      channel: sourceChannels,
    })
      .from(syncTasks)
      .innerJoin(sourceChannels, eq(syncTasks.sourceChannelId, sourceChannels.id))
      .where(
        and(
          // 只选择 pending 状态的任务
          // paused 状态需要用户手动 resume（会变回 pending）才会被选中
          eq(syncTasks.status, 'pending'),
          eq(sourceChannels.isActive, true)  // 只处理活跃频道
        )
      )
      .orderBy(
        // 高优先级优先（priority DESC）
        desc(sourceChannels.priority),
        // 同优先级按创建时间排序
        asc(syncTasks.createdAt)
      )
      .limit(1);

    if (!task) {
      return; // 没有待处理任务
    }

    this.currentTaskId = task.task.id;

    try {
      console.log(`Starting task ${task.task.id} (${task.task.taskType}) for channel ${task.channel.name}`);

      // 根据任务类型执行不同逻辑
      switch (task.task.taskType) {
        case 'resolve':
          await this.runResolveTask(task.task.id, task.channel);
          break;
        case 'history_full':
        case 'history_partial':
          // 检查频道是否已解析（telegramId 不为空）
          if (!task.channel.telegramId) {
            console.log(`Channel ${task.channel.id} not resolved yet, skipping history sync`);
            return;
          }
          await runHistorySync(task.task.id);
          break;
        case 'retry_failed':
          await runRetryFailed(task.task.id);
          break;
        // realtime 类型任务由 realtime-sync 服务单独管理，不在此处理
      }

    } catch (error: any) {
      // 系统级错误（非单条消息失败）才标记任务失败
      if (this.isSystemError(error)) {
        await db.update(syncTasks)
          .set({
            status: 'failed',
            lastError: error.message,
          })
          .where(eq(syncTasks.id, task.task.id));

        await logSyncEvent(task.channel.id, 'error', `Task failed: ${error.message}`);
      }
    } finally {
      this.currentTaskId = null;
    }
  }

  // 处理 resolve 任务：解析频道并创建镜像频道（幂等设计）
  private async runResolveTask(taskId: string, channel: any): Promise<void> {
    // 更新任务状态
    await db.update(syncTasks)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(syncTasks.id, taskId));

    try {
      // 1. 检查频道是否已解析（幂等：避免重复解析）
      if (channel.telegramId && channel.accessHash) {
        await logSyncEvent(channel.id, 'info', 'Channel already resolved, skipping resolve step');
      } else {
        // 1.1 解析频道
        const resolved = await telegramService.resolveChannel(channel.channelIdentifier);

        // 1.2 验证 accessHash 存在（必须有才能后续操作）
        if (!resolved.accessHash) {
          throw new Error('Failed to get accessHash for channel. Cannot proceed.');
        }

        // 1.3 更新频道信息
        await db.update(sourceChannels)
          .set({
            telegramId: resolved.id,
            accessHash: resolved.accessHash,
            name: resolved.title,
            username: resolved.username,
            memberCount: resolved.participantsCount,
            description: resolved.about,
            isProtected: resolved.noforwards,
            syncStatus: 'syncing',
          })
          .where(eq(sourceChannels.id, channel.id));

        // 更新 channel 对象供后续使用
        channel.telegramId = resolved.id;
        channel.accessHash = resolved.accessHash;
        channel.name = resolved.title;
      }

      // 2. 检查镜像频道是否已存在（幂等：避免重复创建）
      const [existingMirror] = await db.select()
        .from(mirrorChannels)
        .where(eq(mirrorChannels.sourceChannelId, channel.id));

      if (existingMirror) {
        await logSyncEvent(channel.id, 'info', 'Mirror channel already exists, skipping creation');
      } else {
        // 2.1 创建镜像频道
        const settings = await settingsCache.get();
        const mirrorTitle = `${settings.auto_channel_prefix || '[备份] '}${channel.name}`;
        const mirror = await telegramService.createPrivateChannel(mirrorTitle, `备份自: ${channel.name}`);

        // 2.2 验证 accessHash 存在
        if (!mirror.accessHash) {
          throw new Error('Failed to get accessHash for mirror channel. Cannot proceed.');
        }

        // 2.3 保存镜像频道信息（使用 onConflictDoNothing 进一步保证幂等）
        await db.insert(mirrorChannels)
          .values({
            sourceChannelId: channel.id,
            telegramId: mirror.id,
            accessHash: mirror.accessHash,
            name: mirror.title,
            inviteLink: mirror.inviteLink,
            isAutoCreated: true,
          })
          .onConflictDoNothing();

        await logSyncEvent(channel.id, 'info', `Mirror channel created: ${mirror.title}`);
      }

      // 3. 标记 resolve 任务完成
      await db.update(syncTasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(syncTasks.id, taskId));

      // 4. 检查是否已有历史同步任务（幂等：避免重复创建）
      const [existingHistoryTask] = await db.select()
        .from(syncTasks)
        .where(
          and(
            eq(syncTasks.sourceChannelId, channel.id),
            eq(syncTasks.taskType, 'history_full')
          )
        );

      if (!existingHistoryTask) {
        // 创建历史同步任务（不设置 progressTotal，因为成员数≠消息数）
        await db.insert(syncTasks).values({
          sourceChannelId: channel.id,
          taskType: 'history_full',
          status: 'pending',
          // progressTotal 留空，前端显示"已处理 N 条"而非进度百分比
        });
      }

      await logSyncEvent(channel.id, 'info', `Channel resolve completed: ${channel.name}`);

    } catch (error: any) {
      await db.update(syncTasks)
        .set({ status: 'failed', lastError: error.message })
        .where(eq(syncTasks.id, taskId));

      await db.update(sourceChannels)
        .set({ syncStatus: 'error' })
        .where(eq(sourceChannels.id, channel.id));

      await logSyncEvent(channel.id, 'error', `Resolve failed: ${error.message}`);
      throw error;
    }
  }

  // 判断是否为系统级错误（需要暂停任务）
  private isSystemError(error: Error): boolean {
    const systemErrors = [
      'AUTH_KEY_UNREGISTERED',  // 登录失效
      'SESSION_REVOKED',
      'USER_DEACTIVATED',
      'CONNECTION_',           // 连接错误
      'ECONNREFUSED',
      'ETIMEDOUT',
    ];

    return systemErrors.some(e => error.message.includes(e));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 外部调用：暂停指定任务
  async pauseTask(taskId: string): Promise<void> {
    await db.update(syncTasks)
      .set({
        status: 'paused',
        pausedAt: new Date(),
      })
      .where(eq(syncTasks.id, taskId));
  }

  // 外部调用：恢复指定任务
  async resumeTask(taskId: string): Promise<void> {
    await db.update(syncTasks)
      .set({
        status: 'pending',  // 重新进入待处理队列
        pausedAt: null,
      })
      .where(eq(syncTasks.id, taskId));
  }

  // 外部调用：取消指定任务
  async cancelTask(taskId: string): Promise<void> {
    await db.delete(syncTasks).where(eq(syncTasks.id, taskId));
  }
}

export const taskRunner = new TaskRunnerService();
```

### 历史同步服务

```typescript
// apps/mirror-service/src/services/history-sync.ts
import { db } from '@tg-back/db';
import { syncTasks, sourceChannels } from '@tg-back/db/schema';
import { eq } from 'drizzle-orm';
import { telegramService } from '../client/telegram';
import { globalRateLimiter } from './rate-limiter';
import { mirrorMessage, MirrorResult } from './message-mirror';
import { logSyncEvent } from '../utils/logger';
import { settingsCache } from './settings-cache';

export async function runHistorySync(taskId: string) {
  // 获取任务信息
  const [task] = await db.select().from(syncTasks).where(eq(syncTasks.id, taskId));
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 更新任务状态为运行中
  await db.update(syncTasks)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(syncTasks.id, taskId));

  // 获取频道信息
  const [channel] = await db.select()
    .from(sourceChannels)
    .where(eq(sourceChannels.id, task.sourceChannelId));

  let processedCount = task.progressCurrent;
  let failedCount = task.failedCount || 0;
  let skippedCount = task.skippedCount || 0;
  let lastMessageId = task.lastProcessedId || 0;
  const offsetId = task.lastProcessedId || 0;

  try {
    // 遍历历史消息（使用 InputPeer）
    for await (const message of telegramService.getChannelHistory(
      channel.telegramId!,
      channel.accessHash!,
      offsetId
    )) {
      // 检查任务是否被暂停
      const [currentTask] = await db.select()
        .from(syncTasks)
        .where(eq(syncTasks.id, taskId));

      if (currentTask.status === 'paused') {
        await logSyncEvent(channel.id, 'info', `Task ${taskId} paused at message ${message.id}`);
        return;
      }

      // 镜像单条消息，捕获错误但不中断任务
      try {
        const result = await globalRateLimiter.executeWithRetry(
          () => mirrorMessage(channel, message),
          (attempt, error) => {
            logSyncEvent(channel.id, 'warn',
              `Retry ${attempt} for message ${message.id}: ${error.message}`
            );
          }
        );

        // 根据结果更新计数
        if (result.status === 'failed') {
          failedCount++;
        } else if (result.status === 'skipped') {
          skippedCount++;
        }

      } catch (error: any) {
        // 单条消息重试后仍失败，记录并继续
        failedCount++;
        await logSyncEvent(channel.id, 'error',
          `Message ${message.id} failed after retries: ${error.message}`
        );
        // 不 throw，继续处理下一条
      }

      processedCount++;
      lastMessageId = message.id;  // 记录最后处理的消息 ID

      // 每 10 条更新一次进度
      if (processedCount % 10 === 0) {
        await db.update(syncTasks)
          .set({
            progressCurrent: processedCount,
            lastProcessedId: message.id,
            failedCount,
            skippedCount,
          })
          .where(eq(syncTasks.id, taskId));
      }
    }

    // 任务完成（即使有失败消息也算完成）
    await db.update(syncTasks)
      .set({
        status: 'completed',
        completedAt: new Date(),
        progressCurrent: processedCount,
        lastProcessedId: lastMessageId,  // 确保最后一条也被记录
        failedCount,
        skippedCount,
      })
      .where(eq(syncTasks.id, taskId));

    // 同步更新 source_channels 状态（生命周期闭环）
    await db.update(sourceChannels)
      .set({
        syncStatus: 'completed',
        lastSyncAt: new Date(),
        lastMessageId: lastMessageId,
        totalMessages: processedCount,
      })
      .where(eq(sourceChannels.id, channel.id));

    await logSyncEvent(channel.id, 'info',
      `History sync completed: ${processedCount} processed, ${failedCount} failed, ${skippedCount} skipped`
    );

  } catch (error: any) {
    // 只有系统级错误才标记任务失败（如连接断开、登录失效）
    await db.update(syncTasks)
      .set({
        status: 'failed',
        lastError: error.message,
        progressCurrent: processedCount,
        lastProcessedId: lastMessageId,  // 保存进度以便恢复
        failedCount,
        skippedCount,
      })
      .where(eq(syncTasks.id, taskId));

    // 同步更新 source_channels 状态为 error
    await db.update(sourceChannels)
      .set({ syncStatus: 'error' })
      .where(eq(sourceChannels.id, channel.id));

    await logSyncEvent(channel.id, 'error', `History sync failed: ${error.message}`);
    throw error;  // 重新抛出让 task-runner 判断是否为系统错误
  }
}
```

### 失败消息补偿重试服务

```typescript
// apps/mirror-service/src/services/retry-failed.ts
import { db } from '@tg-back/db';
import { syncTasks, sourceChannels, messageMappings, mirrorChannels } from '@tg-back/db/schema';
import { eq, and, lt, isNotNull } from 'drizzle-orm';
import { telegramService } from '../client/telegram';
import { globalRateLimiter } from './rate-limiter';
import { logSyncEvent } from '../utils/logger';
import { settingsCache } from './settings-cache';

/**
 * 失败消息补偿重试
 * 从 DB 扫描 status=failed AND retry_count < max_retry_count 的消息进行重试
 */
export async function runRetryFailed(taskId: string) {
  // 获取任务信息
  const [task] = await db.select().from(syncTasks).where(eq(syncTasks.id, taskId));
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 更新任务状态
  await db.update(syncTasks)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(syncTasks.id, taskId));

  // 获取设置
  const settings = await settingsCache.get();

  // 获取频道信息
  const [channel] = await db.select()
    .from(sourceChannels)
    .where(eq(sourceChannels.id, task.sourceChannelId));

  // 获取镜像频道
  const [mirror] = await db.select()
    .from(mirrorChannels)
    .where(eq(mirrorChannels.sourceChannelId, channel.id));

  if (!mirror) {
    throw new Error(`Mirror channel not found for ${channel.id}`);
  }

  let retriedCount = 0;
  let successCount = 0;
  let stillFailedCount = 0;
  let skippedCount = 0;

  try {
    // 查询所有失败且未超过最大重试次数的消息
    const failedMessages = await db.select()
      .from(messageMappings)
      .where(
        and(
          eq(messageMappings.sourceChannelId, channel.id),
          eq(messageMappings.status, 'failed'),
          lt(messageMappings.retryCount, settings.max_retry_count)
        )
      )
      .orderBy(messageMappings.sentAt);

    if (failedMessages.length === 0) {
      await db.update(syncTasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(syncTasks.id, taskId));
      await logSyncEvent(channel.id, 'info', 'No failed messages to retry');
      return;
    }

    await logSyncEvent(channel.id, 'info', `Starting retry for ${failedMessages.length} failed messages`);

    for (const msg of failedMessages) {
      // 检查任务是否被暂停
      const [currentTask] = await db.select()
        .from(syncTasks)
        .where(eq(syncTasks.id, taskId));

      if (currentTask.status === 'paused') {
        await logSyncEvent(channel.id, 'info', `Retry task ${taskId} paused`);
        return;
      }

      retriedCount++;

      try {
        // 从 Telegram 重新获取消息（使用 InputPeer 避免缓存失效问题）
        const client = await telegramService.getClient();
        const inputPeer = telegramService.getInputPeerChannel(channel.telegramId!, channel.accessHash!);
        const messages = await client.getMessages(inputPeer, {
          ids: [msg.sourceMessageId],
        });

        if (messages.length === 0 || !messages[0]) {
          // 消息已不存在，标记为 skipped
          await db.update(messageMappings)
            .set({
              status: 'skipped',
              skipReason: 'message_deleted',
            })
            .where(eq(messageMappings.id, msg.id));
          skippedCount++;
          continue;
        }

        const message = messages[0];
        const mode = channel.mirrorMode || settings.default_mirror_mode;

        // 重新尝试镜像（使用 InputPeer）
        await globalRateLimiter.waitForSlot();

        let mirrorMessageId: number;
        if (mode === 'forward') {
          const result = await telegramService.forwardMessage(
            channel.telegramId!,
            channel.accessHash!,
            mirror.telegramId,
            mirror.accessHash!,
            [message.id]
          );
          mirrorMessageId = extractMirrorMessageId(result);
        } else {
          const result = await telegramService.copyMessage(
            mirror.telegramId,
            mirror.accessHash!,
            message
          );
          mirrorMessageId = result.id;
        }

        // 更新为成功
        await db.update(messageMappings)
          .set({
            status: 'success',
            mirrorMessageId,
            mirroredAt: new Date(),
            errorMessage: null,
          })
          .where(eq(messageMappings.id, msg.id));
        successCount++;

      } catch (error: any) {
        // 重试失败，增加重试次数
        const newRetryCount = msg.retryCount + 1;

        if (newRetryCount >= settings.max_retry_count && settings.skip_after_max_retry) {
          // 达到最大重试次数，标记为 skipped
          await db.update(messageMappings)
            .set({
              status: 'skipped',
              skipReason: 'failed_too_many_times',
              retryCount: newRetryCount,
              errorMessage: error.message,
            })
            .where(eq(messageMappings.id, msg.id));
          skippedCount++;
        } else {
          // 更新错误信息和重试次数
          await db.update(messageMappings)
            .set({
              retryCount: newRetryCount,
              errorMessage: error.message,
            })
            .where(eq(messageMappings.id, msg.id));
          stillFailedCount++;
        }
      }

      // 更新进度
      if (retriedCount % 10 === 0) {
        await db.update(syncTasks)
          .set({ progressCurrent: retriedCount })
          .where(eq(syncTasks.id, taskId));
      }
    }

    // 任务完成
    await db.update(syncTasks)
      .set({
        status: 'completed',
        completedAt: new Date(),
        progressCurrent: retriedCount,
        failedCount: stillFailedCount,
        skippedCount: skippedCount,
      })
      .where(eq(syncTasks.id, taskId));

    await logSyncEvent(channel.id, 'info',
      `Retry completed: ${retriedCount} retried, ${successCount} success, ${stillFailedCount} still failed, ${skippedCount} skipped`
    );

  } catch (error: any) {
    await db.update(syncTasks)
      .set({
        status: 'failed',
        lastError: error.message,
        progressCurrent: retriedCount,
      })
      .where(eq(syncTasks.id, taskId));

    await logSyncEvent(channel.id, 'error', `Retry task failed: ${error.message}`);
    throw error;
  }
}

function extractMirrorMessageId(result: any): number {
  if (result.updates) {
    for (const update of result.updates) {
      if (update.id) return update.id;
    }
  }
  throw new Error('Could not extract mirror message ID from forward result');
}
```

### 实时同步服务

```typescript
// apps/mirror-service/src/services/realtime-sync.ts
	import { Api } from 'telegram';
	import { db } from '@tg-back/db';
	import { sourceChannels, messageMappings } from '@tg-back/db/schema';
	import { eq, and, isNotNull, inArray, sql } from 'drizzle-orm';
	import { telegramService } from '../client/telegram';
	import { mirrorMessage } from './message-mirror';
	import { globalRateLimiter } from './rate-limiter';
	import { logSyncEvent } from '../utils/logger';
	import { settingsCache } from './settings-cache';

/**
 * 实时同步服务
 * 负责监听已订阅频道的新消息并实时镜像
 */
class RealtimeSyncService {
  private subscribedChannelIds: Set<string> = new Set();
  private syncIntervalMs: number = 30000; // 30 秒检查一次频道列表变化
  private isRunning: boolean = false;

  /**
   * 启动实时同步服务
   * 包含动态订阅管理：定期检查 DB 中活跃频道列表，自动订阅新增频道
   */
  async start(): Promise<void> {
    this.isRunning = true;

    // 初始订阅
    await this.syncSubscriptions();

    // 启动定期检查任务
    this.startSubscriptionSync();

    console.log('Realtime sync service started');
  }

  stop(): void {
    this.isRunning = false;
    console.log('Realtime sync service stopping...');
  }

  /**
   * 同步订阅状态：对比 DB 中活跃频道与当前订阅，添加新订阅
   */
  private async syncSubscriptions(): Promise<void> {
    // 获取所有已解析且活跃的频道（包含 accessHash）
    const activeChannels = await db.select()
      .from(sourceChannels)
      .where(
        and(
          eq(sourceChannels.isActive, true),
          isNotNull(sourceChannels.telegramId),
          isNotNull(sourceChannels.accessHash)  // 必须有 accessHash
        )
      );

    // 找出新增的频道（在 DB 中活跃但尚未订阅）
    const newChannels: Array<{ telegramId: string; accessHash: string }> = [];
    for (const channel of activeChannels) {
      if (channel.telegramId && channel.accessHash && !this.subscribedChannelIds.has(channel.telegramId)) {
        newChannels.push({
          telegramId: channel.telegramId,
          accessHash: channel.accessHash,
        });
      }
    }

    // 订阅新增频道
    if (newChannels.length > 0) {
      console.log(`Subscribing to ${newChannels.length} new channels`);
      await this.subscribeToChannels(newChannels);
    }

    // 注意：gramjs 的事件处理器移除较为复杂，暂不实现退订
    // 对于暂停的频道，在 callback 中检查 isActive 状态来跳过处理
    // 如需完全退订，建议重启服务
  }

  /**
   * 启动定期同步任务
   */
  private startSubscriptionSync(): void {
    const syncLoop = async () => {
      while (this.isRunning) {
        await this.sleep(this.syncIntervalMs);
        if (!this.isRunning) break;

        try {
          await this.syncSubscriptions();
        } catch (error: any) {
          console.error('Subscription sync error:', error.message);
        }
      }
    };

    // 后台运行，不阻塞
    syncLoop().catch(err => console.error('Subscription sync loop error:', err));
  }

  /**
   * 订阅指定频道列表
   */
  private async subscribeToChannels(
    channels: Array<{ telegramId: string; accessHash: string }>
  ): Promise<void> {
    await telegramService.subscribeToChannels(
      channels,
      async (channelId: string, message: Api.Message) => {
        await this.handleNewMessage(channelId, message);
      }
    );

    // 同时订阅编辑和删除事件（按设置）
    const settings = await settingsCache.get();
    const channelIds = channels.map(c => c.telegramId);

    if (settings.sync_message_edits) {
      await telegramService.subscribeToEdits(
        channelIds,
        async (channelId: string, message: Api.Message) => {
          await this.handleMessageEdit(channelId, message);
        }
      );
    }

    if (settings.sync_message_deletions) {
      await telegramService.subscribeToDeletes(
        channelIds,
        async (channelId: string, messageIds: number[]) => {
          await this.handleMessageDelete(channelId, messageIds);
        }
      );
    }

    // 记录已订阅
    for (const channel of channels) {
      this.subscribedChannelIds.add(channel.telegramId);
    }
  }

  /**
   * 处理新消息
   */
  private async handleNewMessage(channelId: string, message: Api.Message): Promise<void> {
    // 查找频道记录
    const [channel] = await db.select()
      .from(sourceChannels)
      .where(eq(sourceChannels.telegramId, channelId));

    // 检查频道是否仍活跃
    if (!channel || !channel.isActive) return;

    try {
      await globalRateLimiter.executeWithRetry(
        () => mirrorMessage(channel, message)
      );

      // 更新最后同步时间
      await db.update(sourceChannels)
        .set({ lastSyncAt: new Date(), lastMessageId: message.id })
        .where(eq(sourceChannels.id, channel.id));

    } catch (error: any) {
      await logSyncEvent(channel.id, 'error',
        `Failed to mirror message ${message.id}: ${error.message}`
      );
    }
  }

  /**
   * 处理消息编辑（需要 sync_message_edits 设置开启）
   *
   * 备份语义：镜像频道的消息一旦发送不再修改。
   * 因此这里仅“记录源消息发生过编辑”这一事实到 DB（edit_count/last_edited_at），不改动镜像频道消息内容。
   */
  private async handleMessageEdit(channelId: string, message: Api.Message): Promise<void> {
    const settings = await settingsCache.get();
    if (!settings.sync_message_edits) return;

    // 查找频道记录
    const [channel] = await db.select()
      .from(sourceChannels)
      .where(eq(sourceChannels.telegramId, channelId));
    if (!channel) return;

    // 仅做 DB 标记：不修改镜像频道消息
    await db.update(messageMappings)
      .set({
        editCount: sql`${messageMappings.editCount} + 1`,
        lastEditedAt: new Date(),
      })
      .where(
        and(
          eq(messageMappings.sourceChannelId, channel.id),
          eq(messageMappings.sourceMessageId, message.id)
        )
      );
  }

  /**
   * 处理消息删除（需要 sync_message_deletions 设置开启）
   *
   * 备份语义：不把“撤回/删除”同步到镜像频道（避免备份也被删）。
   * 这里仅更新 DB 标记：is_deleted/deleted_at，用于 Web 展示“源消息已撤回”的提示。
   */
  private async handleMessageDelete(channelId: string, messageIds: number[]): Promise<void> {
    const settings = await settingsCache.get();
    if (!settings.sync_message_deletions) return;

    const [channel] = await db.select()
      .from(sourceChannels)
      .where(eq(sourceChannels.telegramId, channelId));
    if (!channel) return;

    // 仅做 DB 标记：不删除镜像频道消息
    await db.update(messageMappings)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
      })
      .where(
        and(
          eq(messageMappings.sourceChannelId, channel.id),
          inArray(messageMappings.sourceMessageId, messageIds)
        )
      );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const realtimeSyncService = new RealtimeSyncService();

/**
 * 便捷方法：启动实时同步
 */
export async function startRealtimeSync(): Promise<void> {
  await realtimeSyncService.start();
}
```

> **实时订阅说明**：
> - 服务启动时订阅所有已解析且活跃的频道
> - 每 30 秒检查一次 DB，自动订阅新增频道
> - 暂停频道时，在回调中检查 `isActive` 状态跳过处理
> - 完全退订需要重启服务（gramjs 限制）
> - 编辑/删除事件按设置项接入，但**不会修改镜像频道消息**（只做 DB 标记）

### 消息镜像逻辑

> **备份语义（不可变）**：镜像频道是“只追加”的备份快照。已镜像的消息不会在镜像频道中被编辑/删除；
> 源频道后续的编辑/撤回（若开启）仅记录到数据库用于标记，不影响镜像频道内容。

```typescript
// apps/mirror-service/src/services/message-mirror.ts
	import { Api } from 'telegram';
	import { db } from '@tg-back/db';
	import { messageMappings, mirrorChannels } from '@tg-back/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { telegramService } from '../client/telegram';
import { settingsCache } from './settings-cache';

// 返回结果类型
export interface MirrorResult {
  status: 'success' | 'failed' | 'skipped';
  mirrorMessageId?: number;
  skipReason?: string;
  error?: string;
}

type SourceChannel = {
  id: string;
  telegramId: string;
  accessHash: string;  // 新增：需要 accessHash 用于 InputPeer
  mirrorMode: 'forward' | 'copy' | null;
  isProtected: boolean;
};

export async function mirrorMessage(
  sourceChannel: SourceChannel,
  message: Api.Message
): Promise<MirrorResult> {
  // 获取设置（用于默认镜像模式）
  const settings = await settingsCache.get();

  // 获取镜像频道
  const [mirror] = await db.select()
    .from(mirrorChannels)
    .where(eq(mirrorChannels.sourceChannelId, sourceChannel.id));

  if (!mirror) {
    throw new Error(`Mirror channel not found for ${sourceChannel.id}`);
  }

  if (!mirror.accessHash) {
    throw new Error(`Mirror channel ${mirror.id} missing accessHash`);
  }

  // 检查是否已成功镜像（防止重复发送）
  const [existingMapping] = await db.select()
    .from(messageMappings)
    .where(
      and(
        eq(messageMappings.sourceChannelId, sourceChannel.id),
        eq(messageMappings.sourceMessageId, message.id)
      )
    );

  if (existingMapping?.status === 'success' && existingMapping.mirrorMessageId) {
    // 已成功镜像，直接返回
    return { status: 'success', mirrorMessageId: existingMapping.mirrorMessageId };
  }

  const messageType = getMessageType(message);
  const baseData = {
    sourceChannelId: sourceChannel.id,
    sourceMessageId: message.id,
    mirrorChannelId: mirror.id,
    messageType,
    mediaGroupId: message.groupedId?.toString() || null,
    text: message.message || null,
    textPreview: message.message?.slice(0, 200) || null,
    sentAt: new Date(message.date * 1000),
    hasMedia: !!message.media,
    fileSize: getFileSize(message),
  };

  // 检查是否应该跳过
  const skipReason = await shouldSkipMessage(sourceChannel, message);
  if (skipReason) {
    await upsertMessageMapping({
      ...baseData,
      status: 'skipped',
      skipReason,
    });
    return { status: 'skipped', skipReason };
  }

  // 执行镜像（优先使用频道设置，其次全局设置）
  const mode = sourceChannel.mirrorMode || settings.default_mirror_mode;

  try {
    let mirrorMessageId: number;

    if (mode === 'forward') {
      const result = await telegramService.forwardMessage(
        sourceChannel.telegramId,
        sourceChannel.accessHash,
        mirror.telegramId,
        mirror.accessHash,
        [message.id]
      );
      mirrorMessageId = extractMirrorMessageId(result);
    } else {
      const result = await telegramService.copyMessage(
        mirror.telegramId,
        mirror.accessHash,
        message
      );
      mirrorMessageId = result.id;
    }

    // 记录成功（upsert）
    await upsertMessageMapping({
      ...baseData,
      mirrorMessageId,
      status: 'success',
      mirroredAt: new Date(),
      errorMessage: null,
      retryCount: 0,
    });

    return { status: 'success', mirrorMessageId };

  } catch (error: any) {
    // 记录失败（upsert，增加重试次数）
    await upsertMessageMapping({
      ...baseData,
      status: 'failed',
      errorMessage: error.message,
      // retryCount 在 upsert 时递增
    });

    return { status: 'failed', error: error.message };
  }
}

// 使用 upsert 实现幂等写入
async function upsertMessageMapping(data: any): Promise<void> {
  await db.insert(messageMappings)
    .values(data)
    .onConflictDoUpdate({
      target: [messageMappings.sourceChannelId, messageMappings.sourceMessageId],
      set: {
        status: data.status,
        mirrorMessageId: data.mirrorMessageId ?? sql`${messageMappings.mirrorMessageId}`,
        mirroredAt: data.mirroredAt ?? sql`${messageMappings.mirroredAt}`,
        errorMessage: data.errorMessage,
        skipReason: data.skipReason ?? null,
        // 失败时递增重试次数
        retryCount: data.status === 'failed'
          ? sql`${messageMappings.retryCount} + 1`
          : sql`${messageMappings.retryCount}`,
      },
    });
}

function extractMirrorMessageId(result: any): number {
  // 从转发结果中提取消息 ID
  if (result.updates) {
    for (const update of result.updates) {
      if (update.id) return update.id;
    }
  }
  throw new Error('Could not extract mirror message ID from forward result');
}

function getMessageType(message: Api.Message): string {
  if (!message.media) return 'text';
  if (message.media instanceof Api.MessageMediaPhoto) return 'photo';
  if (message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document) {
      if (doc.mimeType?.startsWith('video/')) return 'video';
      if (doc.mimeType?.startsWith('audio/')) return 'audio';
    }
    return 'document';
  }
  if (message.media instanceof Api.MessageMediaPoll) return 'other';
  return 'other';
}

function getFileSize(message: Api.Message): number | null {
  if (!message.media) return null;
  if (message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document) {
      return Number(doc.size) || null;
    }
  }
  return null;
}

async function shouldSkipMessage(
  channel: SourceChannel,
  message: Api.Message
): Promise<string | null> {
  // 使用缓存的设置
  const settings = await settingsCache.get();

  // 受保护内容
  if (channel.isProtected && settings.skip_protected_content) {
    return 'protected_content';
  }

  // 文件大小限制
  const fileSize = getFileSize(message);
  if (fileSize && fileSize > settings.max_file_size_mb * 1024 * 1024) {
    return 'file_too_large';
  }

  // 不支持的类型（如投票、服务消息）
  if (message.media instanceof Api.MessageMediaPoll) {
    return 'unsupported_type';
  }

  // 检查视频设置（v1.1 功能，当前已实现）
  if (!settings.mirror_videos && message.media instanceof Api.MessageMediaDocument) {
    const doc = message.media.document;
    if (doc instanceof Api.Document && doc.mimeType?.startsWith('video/')) {
      return 'unsupported_type';  // 或新增 'video_disabled' 类型
    }
  }

  return null;
}


```

---

## Web 前端实现

### API Routes 示例

```typescript
// apps/web/app/api/channels/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tg-back/db';
import { sourceChannels, mirrorChannels, syncTasks } from '@tg-back/db/schema';
import { eq } from 'drizzle-orm';

// GET /api/channels - 获取频道列表
export async function GET() {
  const channels = await db.select()
    .from(sourceChannels)
    .leftJoin(mirrorChannels, eq(sourceChannels.id, mirrorChannels.sourceChannelId))
    .orderBy(sourceChannels.subscribedAt);

  return NextResponse.json(channels);
}

// POST /api/channels - 添加新频道
// 注意：此 API 创建 pending 状态的频道记录，镜像服务的 resolve 任务负责解析
export async function POST(request: NextRequest) {
  const { channelIdentifier, mirrorMode } = await request.json();

  // 创建一个 pending 状态的记录
  // telegramId 为 NULL，等待镜像服务 resolve 后填充
  const [channel] = await db.insert(sourceChannels)
    .values({
      channelIdentifier,  // 保存用户输入
      // telegramId: NULL (默认)，resolve 成功后更新
      // accessHash: NULL (默认)，resolve 成功后更新
      name: 'Resolving...',
      syncStatus: 'pending',
      mirrorMode,
    })
    .returning();

  // 创建 resolve 任务，镜像服务处理完后会：
  // 1. 调用 Telegram API 解析频道信息
  // 2. 更新 telegramId 和 accessHash
  // 3. 创建镜像频道
  // 4. 自动创建 history_full 任务
  await db.insert(syncTasks).values({
    sourceChannelId: channel.id,
    taskType: 'resolve',
    status: 'pending',
  });

  return NextResponse.json(channel, { status: 201 });
}
```

```typescript
// apps/web/app/api/tasks/retry/route.ts
// 创建失败消息重试任务
//
// 触发方式：
// 1. 前端"重试失败消息"按钮（推荐）：频道详情页显示失败消息数量，用户点击按钮触发
// 2. 定时任务（可选）：可通过 cron/定时器每天夜间自动为有失败消息的频道创建重试任务
// 3. API 直接调用：POST /api/tasks/retry { "channelId": "xxx" }
//
// 前端实现示例：
// <button onClick={() => fetch('/api/tasks/retry', {
//   method: 'POST',
//   body: JSON.stringify({ channelId })
// })}>重试失败消息</button>
//
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tg-back/db';
import { syncTasks, sourceChannels, messageMappings } from '@tg-back/db/schema';
import { eq, and, or, sql } from 'drizzle-orm';

// POST /api/tasks/retry - 为指定频道创建重试任务
export async function POST(request: NextRequest) {
  const { channelId } = await request.json();

  if (!channelId) {
    return NextResponse.json(
      { error: 'channelId is required' },
      { status: 400 }
    );
  }

  // 检查频道是否存在
  const [channel] = await db.select()
    .from(sourceChannels)
    .where(eq(sourceChannels.id, channelId));

  if (!channel) {
    return NextResponse.json(
      { error: 'Channel not found' },
      { status: 404 }
    );
  }

  // 检查是否有失败的消息需要重试
  const [failedResult] = await db.select({ count: sql<number>`count(*)` })
    .from(messageMappings)
    .where(
      and(
        eq(messageMappings.sourceChannelId, channelId),
        eq(messageMappings.status, 'failed')
      )
    );

  if (!failedResult || failedResult.count === 0) {
    return NextResponse.json({
      message: 'No failed messages to retry',
      taskCreated: false,
    });
  }

  // 检查是否已有 pending/running 的重试任务
  const [existingTask] = await db.select()
    .from(syncTasks)
    .where(
      and(
        eq(syncTasks.sourceChannelId, channelId),
        eq(syncTasks.taskType, 'retry_failed'),
        or(
          eq(syncTasks.status, 'pending'),
          eq(syncTasks.status, 'running')
        )
      )
    );

  if (existingTask) {
    return NextResponse.json({
      message: 'Retry task already exists',
      taskId: existingTask.id,
      taskCreated: false,
    });
  }

  // 创建重试任务
  const [task] = await db.insert(syncTasks)
    .values({
      sourceChannelId: channelId,
      taskType: 'retry_failed',
      status: 'pending',
    })
    .returning();

  return NextResponse.json({
    message: 'Retry task created',
    taskId: task.id,
    taskCreated: true,
  }, { status: 201 });
}
```

```typescript
// apps/web/app/api/messages/route.ts
// 使用 cursor 分页替代 offset 分页
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@tg-back/db';
import { messageMappings, sourceChannels } from '@tg-back/db/schema';
import { eq, and, gte, lte, lt, ilike, desc, or } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const query = searchParams.get('q');
  const channelId = searchParams.get('channel');
  const type = searchParams.get('type');
  const startDate = searchParams.get('start');
  const endDate = searchParams.get('end');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

  // Cursor 分页参数：使用 sentAt + sourceMessageId 组合作为游标
  const cursorSentAt = searchParams.get('cursor_sent_at');
  const cursorMessageId = searchParams.get('cursor_message_id');

  // 构建查询条件
  const conditions = [eq(messageMappings.status, 'success')];

  if (query && query.length >= 2) {  // 最短 2 字符
    conditions.push(ilike(messageMappings.text, `%${query}%`));
  }
  if (channelId) {
    conditions.push(eq(messageMappings.sourceChannelId, channelId));
  }
  if (type) {
    conditions.push(eq(messageMappings.messageType, type as any));
  }
  if (startDate) {
    conditions.push(gte(messageMappings.sentAt, new Date(startDate)));
  }
  if (endDate) {
    conditions.push(lte(messageMappings.sentAt, new Date(endDate)));
  }

  // Cursor 条件：获取比游标"更早"的记录
  if (cursorSentAt && cursorMessageId) {
    const cursorDate = new Date(cursorSentAt);
    conditions.push(
      or(
        lt(messageMappings.sentAt, cursorDate),
        and(
          eq(messageMappings.sentAt, cursorDate),
          lt(messageMappings.sourceMessageId, parseInt(cursorMessageId))
        )
      )!
    );
  }

  const messages = await db.select({
    id: messageMappings.id,
    sourceChannelId: messageMappings.sourceChannelId,
    sourceMessageId: messageMappings.sourceMessageId,
    mirrorMessageId: messageMappings.mirrorMessageId,
    messageType: messageMappings.messageType,
    textPreview: messageMappings.textPreview,
    sentAt: messageMappings.sentAt,
    hasMedia: messageMappings.hasMedia,
  })
    .from(messageMappings)
    .where(and(...conditions))
    .orderBy(desc(messageMappings.sentAt), desc(messageMappings.sourceMessageId))
    .limit(limit + 1);  // 多取一条判断是否有下一页

  const hasMore = messages.length > limit;
  const results = hasMore ? messages.slice(0, limit) : messages;

  // 构造下一页的 cursor
  let nextCursor = null;
  if (hasMore && results.length > 0) {
    const lastMessage = results[results.length - 1];
    nextCursor = {
      sent_at: lastMessage.sentAt.toISOString(),
      message_id: lastMessage.sourceMessageId,
    };
  }

  return NextResponse.json({
    messages: results,
    nextCursor,
    hasMore,
  });
}
```

### 前端组件示例

```tsx
// apps/web/components/channels/channel-card.tsx
'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ExternalLink, Shield, AlertCircle } from 'lucide-react';

interface ChannelCardProps {
  channel: {
    id: string;
    name: string;
    username?: string;
    avatarUrl?: string;
    syncStatus: 'pending' | 'syncing' | 'completed' | 'error';
    lastSyncAt?: Date;
    isProtected: boolean;
    totalMessages?: number;
    mirrorChannel?: {
      inviteLink?: string;
    };
  };
  syncProgress?: {
    current: number;
    total?: number;  // 可选：无 total 时仅显示已处理数量
  };
}

export function ChannelCard({ channel, syncProgress }: ChannelCardProps) {
  const statusBadge = {
    pending: <Badge variant="secondary">等待中</Badge>,
    syncing: <Badge variant="default">同步中</Badge>,
    completed: <Badge variant="success">已完成</Badge>,
    error: <Badge variant="destructive">错误</Badge>,
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-4">
        {channel.avatarUrl ? (
          <img
            src={channel.avatarUrl}
            alt={channel.name}
            className="w-12 h-12 rounded-full"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            {channel.name[0]}
          </div>
        )}
        <div className="flex-1">
          <CardTitle className="flex items-center gap-2">
            {channel.name}
            {channel.isProtected && (
              <Shield className="w-4 h-4 text-yellow-500" title="受保护频道" />
            )}
          </CardTitle>
          {channel.username && (
            <p className="text-sm text-muted-foreground">@{channel.username}</p>
          )}
        </div>
        {statusBadge[channel.syncStatus]}
      </CardHeader>

      <CardContent>
        {channel.syncStatus === 'syncing' && syncProgress && (
          <div className="mb-4">
            {syncProgress.total ? (
              // 有 total 时显示进度条
              <>
                <div className="flex justify-between text-sm mb-1">
                  <span>同步进度</span>
                  <span>{syncProgress.current} / {syncProgress.total}</span>
                </div>
                <Progress value={(syncProgress.current / syncProgress.total) * 100} />
              </>
            ) : (
              // 无 total 时仅显示已处理数量（不显示进度条）
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="animate-pulse">●</span>
                <span>已处理 {syncProgress.current} 条消息</span>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between items-center text-sm">
          <span className="text-muted-foreground">
            {channel.totalMessages || 0} 条消息
          </span>

          {channel.mirrorChannel?.inviteLink && (
            <a
              href={channel.mirrorChannel.inviteLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline"
            >
              查看镜像频道
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {channel.lastSyncAt && (
          <p className="text-xs text-muted-foreground mt-2">
            最后同步: {new Date(channel.lastSyncAt).toLocaleString('zh-CN')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

---

## 开发流程

### 1. 初始化项目

```bash
# 创建 monorepo
pnpm init
pnpm add -D turbo

# 创建工作区
mkdir -p apps/web apps/mirror-service packages/db

# 初始化各个包
cd apps/web && pnpm create next-app@latest . --typescript --tailwind --app
cd apps/mirror-service && pnpm init
cd packages/db && pnpm init
```

### 2. 设置 Supabase

1. 在 [supabase.com](https://supabase.com) 创建项目
2. 获取连接字符串和 API Keys
3. 运行数据库迁移

```bash
# 安装 Drizzle
cd packages/db
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit

# 生成迁移
pnpm drizzle-kit generate

# 执行迁移
pnpm drizzle-kit migrate
```

### 3. 开发顺序建议

1. **数据库层** (`packages/db`)
   - 定义 Schema
   - 设置 Drizzle
   - 运行迁移

2. **镜像服务核心** (`apps/mirror-service`)
   - Telegram 客户端连接
   - 消息获取和发送
   - 限流处理

3. **Web API** (`apps/web/app/api`)
   - 频道管理 API
   - 消息查询 API
   - 设置 API

4. **Web 前端** (`apps/web`)
   - 仪表盘
   - 频道管理页面
   - 消息浏览页面
   - 设置页面

5. **联调测试**
   - 端到端流程测试
   - 边界情况处理

---

## Telegram 登录流程

### 流程概述

首次使用系统时，需要通过 Telegram 登录向导获取 session 并保存。流程如下：

```
1. 输入手机号
   └── 调用 Telegram API 发送验证码

2. 输入验证码
   └── 验证通过 → 继续
   └── 需要 2FA → 进入步骤 3

3. 输入 2FA 密码（如果开启了两步验证）
   └── 验证通过 → 继续

4. 保存 session
   └── 加密后存入数据库
   └── 登录完成
```

### API 实现

> **重要说明**：登录状态需要在多个 API route 之间共享。在生产环境中建议使用 Redis，
> 开发环境可使用模块级变量（需确保服务端进程不重启）。

```typescript
// apps/web/lib/telegram-login.ts
// 登录状态共享模块
import { TelegramClient } from 'telegram';

export interface LoginSession {
  client: TelegramClient;
  phoneCodeHash: string;
  phoneNumber: string;
  createdAt: number;
}

// 登录会话存储（生产环境建议使用 Redis）
// 使用模块级变量确保在多个 route 间共享
export const loginSessions = new Map<string, LoginSession>();

// 清理过期会话（30 分钟超时）
export function cleanupExpiredSessions(): void {
  const now = Date.now();
  const timeout = 30 * 60 * 1000; // 30 分钟

  for (const [loginId, session] of loginSessions.entries()) {
    if (now - session.createdAt > timeout) {
      session.client.disconnect().catch(() => {});
      loginSessions.delete(loginId);
    }
  }
}

// 定期清理（每 5 分钟）
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);
```

```typescript
// apps/web/app/api/telegram/login/send-code/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { loginSessions } from '@/lib/telegram-login';

export async function POST(request: NextRequest) {
  const { phoneNumber } = await request.json();

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH!;

  if (!apiId || !apiHash) {
    return NextResponse.json(
      { error: 'TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables' },
      { status: 500 }
    );
  }

  try {
    const client = new TelegramClient(
      new StringSession(''),
      apiId,
      apiHash,
      { connectionRetries: 3 }
    );

    await client.connect();

    const result = await client.sendCode(
      { apiId, apiHash },
      phoneNumber
    );

    // 生成临时登录 ID
    const loginId = crypto.randomUUID();

    // 保存登录状态（包含 phoneNumber 以便后续验证）
    loginSessions.set(loginId, {
      client,
      phoneCodeHash: result.phoneCodeHash,
      phoneNumber,
      createdAt: Date.now(),
    });

    return NextResponse.json({
      loginId,
      // 不返回 phoneCodeHash 给前端（安全考虑）
    });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 400 }
    );
  }
}
```

```typescript
// apps/web/app/api/telegram/login/verify-code/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { Api } from 'telegram';
import { db } from '@tg-back/db';
import { settings } from '@tg-back/db/schema';
import { encrypt } from '@/lib/crypto';
import { loginSessions } from '@/lib/telegram-login';

export async function POST(request: NextRequest) {
  const { loginId, code, password } = await request.json();

  const session = loginSessions.get(loginId);
  if (!session) {
    return NextResponse.json(
      { error: 'Login session expired. Please restart the login process.' },
      { status: 400 }
    );
  }

  const { client, phoneCodeHash, phoneNumber } = session;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH!;

  try {
    // 使用 gramjs 的正确登录流程：signIn 需要 phoneCodeHash
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,  // 使用保存的 phoneCodeHash
          phoneCode: code,
        })
      );
    } catch (error: any) {
      // 如果需要 2FA 密码
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          return NextResponse.json({
            requiresPassword: true,
            message: '请输入两步验证密码',
          });
        }

        // 获取 2FA 密码信息并验证
        const passwordInfo = await client.invoke(new Api.account.GetPassword());
        const passwordResult = await client.invoke(
          new Api.auth.CheckPassword({
            password: await client.computePasswordCheck(passwordInfo, password),
          })
        );
      } else {
        throw error;
      }
    }

    // 获取 session 字符串并加密保存
    const sessionString = client.session.save() as unknown as string;
    const encryptedSession = encrypt(sessionString);

    // 保存到数据库
    await db.insert(settings)
      .values({ key: 'telegram_session', value: encryptedSession })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: encryptedSession },
      });

    // 清理登录状态并断开临时连接
    client.disconnect();
    loginSessions.delete(loginId);

    return NextResponse.json({ success: true });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || error.errorMessage || 'Login failed' },
      { status: 400 }
    );
  }
}
```

```typescript
// apps/web/app/api/telegram/login/status/route.ts
import { NextResponse } from 'next/server';
import { db } from '@tg-back/db';
import { settings } from '@tg-back/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const [session] = await db.select()
    .from(settings)
    .where(eq(settings.key, 'telegram_session'));

  const isLoggedIn = !!(session?.value && session.value !== '');

  return NextResponse.json({ isLoggedIn });
}
```

```typescript
// apps/web/app/api/telegram/logout/route.ts
import { NextResponse } from 'next/server';
import { db } from '@tg-back/db';
import { settings } from '@tg-back/db/schema';
import { eq } from 'drizzle-orm';

export async function POST() {
  // 清空 session
  await db.update(settings)
    .set({ value: '' })
    .where(eq(settings.key, 'telegram_session'));

  return NextResponse.json({ success: true });
}
```

### 前端登录向导组件

```tsx
// apps/web/components/telegram/login-wizard.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Step = 'phone' | 'code' | 'password' | 'success';

export function TelegramLoginWizard() {
  const [step, setStep] = useState<Step>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loginId, setLoginId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/telegram/login/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLoginId(data.loginId);
      setStep('code');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (withPassword = false) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/telegram/login/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loginId,
          phoneNumber,
          code,
          password: withPassword ? password : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.requiresPassword) {
        setStep('password');
        return;
      }

      setStep('success');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Telegram 登录</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="mb-4 p-2 bg-red-100 text-red-700 rounded text-sm">
            {error}
          </div>
        )}

        {step === 'phone' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              请输入您的 Telegram 手机号（包含国际区号）
            </p>
            <Input
              placeholder="+86 13800138000"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <Button onClick={sendCode} disabled={loading || !phoneNumber}>
              {loading ? '发送中...' : '发送验证码'}
            </Button>
          </div>
        )}

        {step === 'code' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              请输入 Telegram 发送到您账号的验证码
            </p>
            <Input
              placeholder="12345"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button onClick={() => verifyCode()} disabled={loading || !code}>
              {loading ? '验证中...' : '验证'}
            </Button>
          </div>
        )}

        {step === 'password' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              您的账号开启了两步验证，请输入密码
            </p>
            <Input
              type="password"
              placeholder="两步验证密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button onClick={() => verifyCode(true)} disabled={loading || !password}>
              {loading ? '验证中...' : '确认'}
            </Button>
          </div>
        )}

        {step === 'success' && (
          <div className="text-center space-y-4">
            <div className="text-green-600 text-lg">✓ 登录成功</div>
            <p className="text-sm text-muted-foreground">
              Telegram 已连接，现在可以添加频道进行备份了
            </p>
            <Button onClick={() => window.location.href = '/channels'}>
              开始使用
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

### API 凭证说明

> **重要**：`TELEGRAM_API_ID` 和 `TELEGRAM_API_HASH` 必须通过环境变量配置，不建议存入数据库。
>
> 获取方式：
> 1. 访问 https://my.telegram.org
> 2. 登录并进入 "API development tools"
> 3. 创建应用获取 `api_id` 和 `api_hash`
>
> ```env
> TELEGRAM_API_ID=your-api-id
> TELEGRAM_API_HASH=your-api-hash
> ```

---

## 安全考虑

### 访问控制（完整实现）

```typescript
// apps/web/lib/auth.ts
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const SECRET_KEY = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'fallback-secret-change-in-production'
);
const TOKEN_NAME = 'auth_token';
const TOKEN_EXPIRY = '7d';

export async function createToken(password: string): Promise<string | null> {
  const accessPassword = process.env.ACCESS_PASSWORD;

  if (!accessPassword || password !== accessPassword) {
    return null;
  }

  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(SECRET_KEY);

  return token;
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function setAuthCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(TOKEN_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60, // 7 days
    path: '/',
  });
}

export async function clearAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TOKEN_NAME);
}

export async function getAuthToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(TOKEN_NAME)?.value;
}
```

```typescript
// apps/web/app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createToken, setAuthCookie } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const { password } = await request.json();

  const token = await createToken(password);

  if (!token) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  await setAuthCookie(token);

  return NextResponse.json({ success: true });
}
```

```typescript
// apps/web/app/api/auth/logout/route.ts
import { NextResponse } from 'next/server';
import { clearAuthCookie } from '@/lib/auth';

export async function POST() {
  await clearAuthCookie();
  return NextResponse.json({ success: true });
}
```

```typescript
// apps/web/middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const SECRET_KEY = new TextEncoder().encode(
  process.env.AUTH_SECRET || 'fallback-secret-change-in-production'
);

export async function middleware(request: NextRequest) {
  // 如果未配置密码，跳过认证
  if (!process.env.ACCESS_PASSWORD) {
    return NextResponse.next();
  }

  const token = request.cookies.get('auth_token')?.value;

  // 验证 JWT token
  let isAuthenticated = false;
  if (token) {
    try {
      await jwtVerify(token, SECRET_KEY);
      isAuthenticated = true;
    } catch {
      isAuthenticated = false;
    }
  }

  if (!isAuthenticated) {
    if (request.nextUrl.pathname.startsWith('/api')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)'],
};
```

### Telegram 凭证加密存储

```typescript
// apps/mirror-service/src/utils/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// 从环境变量获取加密密钥（必须配置）
function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET environment variable is required');
  }
  // 使用 scrypt 派生固定长度的密钥
  return scryptSync(secret, 'tg-back-salt', KEY_LENGTH);
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // 格式: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, encrypted] = ciphertext.split(':');

  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid ciphertext format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

> **加密模块共享说明**：
>
> `encrypt`/`decrypt` 函数需要在 Web 端和 mirror-service 之间共享，有两种推荐方式：
>
> **方式一（推荐）**：抽到共享包 `packages/shared/src/crypto.ts`，两边引用同一实现
> ```typescript
> // packages/shared/src/crypto.ts
> // 代码同上 apps/mirror-service/src/utils/crypto.ts
> export { encrypt, decrypt };
>
> // apps/web 引用
> import { encrypt } from '@tg-back/shared/crypto';
>
> // apps/mirror-service 引用
> import { decrypt } from '@tg-back/shared/crypto';
> ```
>
> **方式二**：在 `apps/web/lib/crypto.ts` 复制同一实现
> ```typescript
> // apps/web/lib/crypto.ts
> // 与 apps/mirror-service/src/utils/crypto.ts 保持完全一致
> import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
>
> const ALGORITHM = 'aes-256-gcm';
> const KEY_LENGTH = 32;
> const IV_LENGTH = 16;
>
> function getEncryptionKey(): Buffer {
>   const secret = process.env.ENCRYPTION_SECRET;
>   if (!secret) {
>     throw new Error('ENCRYPTION_SECRET environment variable is required');
>   }
>   return scryptSync(secret, 'tg-back-salt', KEY_LENGTH);
> }
>
> export function encrypt(plaintext: string): string {
>   const key = getEncryptionKey();
>   const iv = randomBytes(IV_LENGTH);
>   const cipher = createCipheriv(ALGORITHM, key, iv);
>   let encrypted = cipher.update(plaintext, 'utf8', 'hex');
>   encrypted += cipher.final('hex');
>   const authTag = cipher.getAuthTag();
>   return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
> }
>
> export function decrypt(ciphertext: string): string {
>   // 同 mirror-service 实现...
> }
> ```
>
> **重要**：无论使用哪种方式，必须确保：
> 1. Web 和 mirror-service 使用相同的 `ENCRYPTION_SECRET` 环境变量
> 2. 加密算法和参数完全一致（盐值、算法、格式）

```typescript
// 使用示例：存储和读取 Telegram session
// apps/mirror-service/src/client/telegram.ts (部分)

import { encrypt, decrypt } from '../utils/crypto';

// 保存 session 时加密
async function saveSession(sessionString: string): Promise<void> {
  const encrypted = encrypt(sessionString);
  await db.insert(settings)
    .values({ key: 'telegram_session', value: encrypted })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: encrypted },
    });
}

// 读取 session 时解密
async function loadSession(): Promise<string> {
  const [row] = await db.select()
    .from(settings)
    .where(eq(settings.key, 'telegram_session'));

  if (!row?.value) {
    return '';
  }

  try {
    return decrypt(row.value as string);
  } catch {
    console.error('Failed to decrypt session, may need to re-login');
    return '';
  }
}
```

### 环境变量配置

```env
# .env.example

# 数据库
DATABASE_URL=postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres

# 认证（Web 访问控制）
ACCESS_PASSWORD=your-secure-password-here
AUTH_SECRET=random-32-char-string-for-jwt-signing

# 加密（Telegram 凭证保护）
ENCRYPTION_SECRET=another-random-32-char-string-for-encryption

# Telegram API（也可存数据库，但建议放环境变量）
TELEGRAM_API_ID=your-api-id
TELEGRAM_API_HASH=your-api-hash
```

---

## 预估存储使用

假设每条消息元数据约 1KB：

| 消息数量 | 存储使用 | 剩余空间 (500MB) |
|----------|----------|------------------|
| 10,000 | ~10MB | 490MB |
| 100,000 | ~100MB | 400MB |
| 500,000 | ~500MB | 接近上限 |

**优化建议**：
- 定期清理旧的同步事件日志
- 对于超大频道，考虑只保留最近 N 条消息的完整文本
- 媒体文件不存储，仅保留元数据
