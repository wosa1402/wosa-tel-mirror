# tg-back 问题清单与修复进度（技术债/安全/性能）

> 目的：把“发现的问题 + 修复状态 + 验收方法”记录在一个地方，方便你后续按优先级逐个完成。
>
> 最后更新：2026-02-28
>
> 状态说明：
> - [x] 已修复：代码已改完（并通过 `pnpm -r typecheck`）
> - [ ] 待修复：尚未开始或未完成
> - [~] 部分修复：做了一部分，但仍有缺口/需要进一步验证

---

## 0) 总览（我建议的修复顺序）

1) **性能类（低风险高收益）**：索引 / dashboard 并行 / channels 分页 / SSE 忙等优化  
2) **工程化/安全稳健**：错误信息对外收敛、限流升级为可持久化（如需要多实例）  
3) **重复代码/一致性**：抽公共 utils、统一常量、复用 crypto  
4) **类型安全**：减少 `as any`、引入 settings 运行时校验  
5) **架构重构 + 测试体系**：拆分 mirror-service、补测试框架与关键用例

---

## 1) 安全问题

- [x] **[高] ILIKE 通配符注入（`q=%` 匹配全部）**
  - 影响：搜索条件可被“绕过”，导致返回大量数据/误用筛选（不是传统意义的任意 SQL 拼接，但确实是高影响的查询绕过）。
  - 修复：对 `%` / `_` 做转义，并用 `ESCAPE`；统一封装 `ilikeContains()`。
  - 相关位置：`apps/web/lib/sql-like.ts`、`apps/web/app/api/events/route.ts`、`apps/web/app/api/messages/route.ts`、`apps/web/app/api/export/messages/route.ts`
  - 验收：在 `/events` 或 `/messages` 搜索 `q=%`，不应再等同于“全量匹配”。

- [x] **[中] 密码明文存储（`access_password` 存在 settings 表）**
  - 影响：数据库泄露/误备份时，Web 访问密码会被直接拿到。
  - 修复：保存时改为“加盐哈希（scrypt）”入库。
  - 相关位置：`apps/web/app/api/settings/route.ts`、`apps/web/lib/api-auth.ts`
  - 注意：如果你数据库里已经有历史明文，系统会在“成功登录一次”时自动升级为哈希（无须手动改库）。
  - 验收：重新设置一次密码或成功登录一次后，数据库里的 `access_password` 应变为 `scrypt$...` 形式。

- [x] **[中] 密码比较未用恒等时间**
  - 影响：理论上可能被利用进行时间侧信道猜测（现实难度取决于部署环境/网络噪声，但修复成本很低，应该修）。
  - 修复：登录改为恒等时间校验；并兼容旧明文自动升级。
  - 相关位置：`apps/web/app/api/auth/login/route.ts`、`apps/web/lib/api-auth.ts`
  - 验收：错误密码返回 401；正确密码能登录；历史明文会被自动升级为哈希。

- [x] **[低] 认证接口无速率限制（可被暴力破解）**
  - 影响：登录密码可被暴力尝试；发验证码接口可被滥用。
  - 修复：对“登录”和“发送验证码”加了 429 限流（含 `Retry-After`）。
  - 相关位置：`apps/web/lib/rate-limit.ts`、`apps/web/app/api/auth/login/route.ts`、`apps/web/app/api/telegram/login/send-code/route.ts`
  - 重要补充：为了避免“伪造 X-Forwarded-For 绕过限流”，默认**不信任** `X-Forwarded-For/X-Real-IP`。如果你确认 Web 在可信反向代理之后（Nginx/Caddy/Cloudflare），再在 `.env` 设置 `TG_BACK_TRUST_PROXY=true` 让限流按真实客户端 IP 生效；否则会落到 `ip=unknown`（所有人共用同一个限流桶）。
  - 现有限制（重要）：当前限流是“进程内内存版”，重启会清空；如果你未来做多实例/多进程，需要升级到 Redis/数据库版。
  - 验收：短时间内连续请求会收到 429，并带 `Retry-After`。

- [x] **[中] Settings PATCH 无速率限制（可被滥用；首次部署可能被抢先设置密码锁死）**
  - 影响：
    - 未设置访问密码时，攻击者可在你之前先设置一个随机密码，导致你无法登录（被锁死）。
    - settings PATCH 无限制也容易被恶意刷请求。
  - 修复：
    - `PATCH /api/settings` 增加 429 限流。
    - 生产环境下如果数据库里还没有 `access_password`（首次启动），Web 会自动生成一个“初始访问密码”并写入数据库，同时把密码打印到服务端日志（你可用它登录后再去 `/settings` 改成自己的密码）。
    - 也可以在 `.env` 里设置 `TG_BACK_BOOTSTRAP_ACCESS_PASSWORD` 来指定这个初始密码（推荐公网部署）。
  - 相关位置：`apps/web/app/api/settings/route.ts`、`apps/web/lib/api-auth.ts`、`.env.example`
  - 验收：生产环境首次启动时访问页面会提示需要访问密码；服务端日志能看到初始密码提示；登录后可在 `/settings` 修改。

---

## 2) 架构问题

 - [x] **[高] 巨型单文件：`apps/mirror-service/src/index.ts`（约 5551 行）**
  - 影响：维护成本高、改动风险大、定位问题慢。
  - 建议拆分方向：设置读取、Telegram 客户端封装、频道解析、历史同步、实时监听、消息转发、媒体处理、评论同步、重试/退避、健康检查等模块化（8–10 个文件）。
  - 进度：已完成拆分（`index.ts` 现约 211 行），主要模块如下：
    - settings 读取/缓存：`apps/mirror-service/src/lib/settings.ts`
    - DB 重试工具：`apps/mirror-service/src/lib/db-retry.ts`
    - 对象属性安全读取：`apps/mirror-service/src/lib/object-props.ts`
    - BigInt 转换工具：`apps/mirror-service/src/lib/bigint.ts`
    - Telegram 标识/链接工具：`apps/mirror-service/src/lib/telegram-identifiers.ts`
    - Telegram 错误解析：`apps/mirror-service/src/lib/telegram-errors.ts`
    - Telegram 客户端初始化：`apps/mirror-service/src/lib/telegram-client.ts`
    - Telegram peer 解析：`apps/mirror-service/src/lib/telegram-peer.ts`
    - Telegram 转发封装：`apps/mirror-service/src/lib/telegram-forward.ts`
    - Telegram spoiler（剧透）处理：`apps/mirror-service/src/lib/telegram-spoiler.ts`
    - Telegram 原文链接评论：`apps/mirror-service/src/lib/telegram-original-link.ts`
    - Telegram 评论同步：`apps/mirror-service/src/lib/telegram-comments.ts`
    - 消息/媒体工具：`apps/mirror-service/src/lib/mirror-message.ts`
    - 对象工具（omitUndefined）：`apps/mirror-service/src/lib/omit-undefined.ts`
    - Heartbeat（心跳写入）：`apps/mirror-service/src/lib/heartbeat.ts`
    - message_mappings 批量更新：`apps/mirror-service/src/lib/message-mappings.ts`
    - Telegram 元信息/健康检查解析：`apps/mirror-service/src/lib/telegram-metadata.ts`
    - 频道健康检查执行（单频道）：`apps/mirror-service/src/lib/healthcheck.ts`
    - 频道健康检查调度（批量/轮询）：`apps/mirror-service/src/lib/healthcheck-scheduler.ts`
    - FLOOD_WAIT 自动恢复（paused → pending）：`apps/mirror-service/src/lib/flood-wait-auto-resume.ts`
    - retry_failed 任务调度（创建/重排）：`apps/mirror-service/src/lib/retry-failed-scheduler.ts`
    - 任务变更通知（NOTIFY）：`apps/mirror-service/src/lib/tasks-notify.ts`
    - 同步事件写入：`apps/mirror-service/src/lib/sync-events.ts`
    - 任务生命周期（failed/paused）：`apps/mirror-service/src/lib/task-lifecycle.ts`
    - Pending 任务认领（pending → running）：`apps/mirror-service/src/lib/task-claimer.ts`
    - Telegram 自动建频道/讨论组/管理员：`apps/mirror-service/src/lib/telegram-auto-channel.ts`
    - resolve 任务处理：`apps/mirror-service/src/lib/task-resolve.ts`
    - retry_failed 任务处理：`apps/mirror-service/src/lib/task-retry-failed.ts`
    - history_full 任务处理：`apps/mirror-service/src/lib/task-history-full.ts`
    - realtime 实时监听/转发（RealtimeManager）：`apps/mirror-service/src/lib/realtime-manager.ts`
    - `apps/mirror-service/src/index.ts` 行数从 ~5542 → ~5018 → ~4740 → ~4687 → ~4475 → ~4414 → ~4253 → ~4192 → ~4168 → ~4127 → ~4005 → ~3903 → ~3803 → ~3747 → ~3646 → ~3600 → ~3465 → ~3397 → ~3111 → ~2890 → ~2290 → ~1450 → ~211（已完成拆分；后续可按需再细拆 realtime/history 模块）。
  - 验收：拆分后功能不变，`pnpm -C apps/mirror-service typecheck` 通过。

- [x] **[高] 零测试（无测试框架/无测试用例）**
  - 影响：每次改动都容易“修一处坏一处”，尤其是 mirror-service。
  - 修复：引入 Vitest，并增加最小单元测试覆盖（settings 解析 / 加解密 / LIKE 转义）。
  - 相关位置：`package.json`（`pnpm test`）、`packages/db/tests/settings-parse.test.ts`、`packages/crypto/tests/crypto.test.ts`、`apps/web/tests/sql-like.test.ts`
  - 验收：本地执行 `pnpm test` 通过；后续可继续补“密码哈希/限流”等更关键路径的测试。

- [x] **[高] 无 React Error Boundary（错误会白屏）**
  - 修复：新增 `apps/web/app/error.tsx`。
  - 验收：故意制造客户端错误时，页面显示“重试/刷新”而不是白屏。

---

## 3) 代码重复

- [x] **[高] 工具函数重复（应抽到共享 utils）**
  - 修复：新增 `apps/web/lib/utils.ts`，并把 API 路由与前端组件统一改为复用该文件导出的工具函数。
  - 补充收敛：`toStringOrNull / formatTime / calcProgressPct / isMirrorMode` 等也已收敛到 `apps/web/lib/utils.ts`；`api-error.ts` 复用 `getErrorMessage()` 避免重复实现。
  - 验收：上述工具函数在代码中只保留一份实现（其它地方仅 import 使用）。

- [x] **[中] 加密函数重复：`decrypt` 在 web 与 mirror-service 各一份**
  - 修复：新增共享包 `packages/crypto`（`@tg-back/crypto`），两端统一引用。
  - 相关位置：`packages/crypto/src/index.ts`、`apps/web/lib/crypto.ts`、`apps/mirror-service/src/index.ts`
  - 验收：仅保留一份加解密实现；两端功能一致。

- [x] **[低] NOTIFY 频道名常量重复：`tg_back_sync_tasks_v1`**
  - 修复：抽到共享常量 `packages/db/src/constants.ts` 并从 `@tg-back/db` 导出。
  - 相关位置：`packages/db/src/constants.ts`、`packages/db/src/index.ts`
  - 验收：字符串只定义一次，其它地方引用常量。

---

## 4) 类型安全

- [x] **[高] 大量 `as any`（主要在 mirror-service）**
  - 影响：类型系统失效，容易隐藏运行时 bug。
  - 修复：mirror-service 生产代码（不含 `poc.ts`）已无 `as any`；主要通过“安全属性读取 + 更明确的参数类型（如 `EntityLike`/`FileLike`）”替代原来的 `as any`。
  - 备注：`apps/mirror-service/src/poc.ts` 仍保留 `as any`（仅用于 PoC/实验代码，不影响生产路径）。

- [x] **[中] Settings 值无统一运行时验证**
  - 修复：在 `@tg-back/db` 引入 Zod 并集中定义 settings 的运行时校验/解析（带默认值兜底）。
  - 相关位置：`packages/db/src/settings-parse.ts`（`parseSettingValue/parseSettingsRows`），并在 web/mirror-service 的 settings 读取处统一复用。
  - 验收：settings 表中某些 key/value 缺失或类型异常时，系统会回退到默认值；不再需要在每个消费者里手写一套 `typeof` 判断。

---

## 5) 性能问题

- [x] **[中] Dashboard 多次串行查询（可并行）**
  - 位置：`apps/web/app/api/dashboard/route.ts`
  - 修复：改为 `Promise.all()` 并行执行互不依赖的查询，减少接口耗时。

- [x] **[中] 缺少数据库索引：`source_channels` 常用过滤字段**
  - 修复：新增 `channel_identifier` / `group_name` / `sync_status` 的 btree 索引。
  - 相关位置：`packages/db/src/schema/source-channels.ts`、`packages/db/drizzle/migrations/0007_ordinary_talos.sql`
  - 部署提示：服务器上需要执行一次 `pnpm db:migrate` 才会真正把索引建到数据库。
  - 验收：列表/筛选接口明显更快；数据库 CPU 降低。

- [x] **[低] 频道列表无分页（频道多时慢）**
  - 位置：`apps/web/app/api/channels/route.ts`
  - 修复：API 支持 `limit/offset`；前端（频道管理页）按分页分批加载，避免一次性拉取超大响应。
  - 相关位置：`apps/web/app/api/channels/route.ts`、`apps/web/components/channels/ChannelsManager.tsx`

- [x] **[低] SSE busy-wait 轮询（250ms）**
  - 位置：`apps/web/app/api/stream/tasks/route.ts`
  - 修复：移除 250ms 轮询，改为等待 `request.signal` abort（事件驱动），减少空转。

- [x] **[中] 跨频道消息列表分页缺少复合索引（大数据量会慢）**
  - 背景：消息列表支持“跨频道”按 `sent_at DESC, source_channel_id DESC, source_message_id DESC` 翻页；没有覆盖该排序的复合索引时，数据量大可能触发全表排序。
  - 修复：为 `message_mappings(sent_at, source_channel_id, source_message_id)` 增加 btree 索引。
  - 相关位置：`packages/db/src/schema/message-mappings.ts`、`packages/db/drizzle/migrations/0008_huge_shotgun.sql`
  - 部署提示：服务器上需要执行一次 `pnpm db:migrate` 才会真正把索引建到数据库。

---

## 6) 依赖管理

- [x] **[中] TypeScript 版本不一致（web: `^5`，其它包: `^5.9.2`）**
  - 修复：已把 `apps/web` 的 TypeScript 版本对齐到 `^5.9.2`。
  - 相关位置：`apps/web/package.json`

- [x] **[中] `@types/node` 大版本不一致（web: `^20`，其它包: `^24`）**
  - 修复：已把 `apps/web` 的 `@types/node` 版本对齐到 `^24.1.0`。
  - 相关位置：`apps/web/package.json`

---

## 7) 其他问题/稳健性

- [x] **[低] 内部错误消息直接返回客户端（信息泄露风险）**
  - 修复：`NODE_ENV=production` 时，API 500 错误只返回“简短友好提示”，不直接回显内部异常详情；详细信息仍会 `console.error` 留在服务端日志（开发环境仍保留详细错误文本）。
  - 相关位置：`apps/web/lib/api-error.ts`（各 API route 调用）

- [x] **[中] `sync_tasks` 缺唯一约束导致并发竞态（可能插入重复任务）**
  - 影响：并发请求（或多进程/多实例）下可能创建重复任务，导致 mirror-service 调度混乱。
  - 修复：新增唯一索引 `(source_channel_id, task_type)`，并把相关 insert 改为 `ON CONFLICT DO NOTHING`（幂等）。
  - 相关位置：`packages/db/src/schema/sync-tasks.ts`、`packages/db/drizzle/migrations/0008_huge_shotgun.sql`、`apps/web/app/api/channels/route.ts`、`apps/web/app/api/tasks/retry/route.ts`、`apps/mirror-service/src/lib/retry-failed-scheduler.ts`
  - 部署提示：服务器上需要执行一次 `pnpm db:migrate` 才会真正把约束建到数据库。

- [x] **[中] mirror-service 致命错误后进程不退出（可能出现“僵尸进程”）**
  - 修复：顶层 `loop().catch()` 在捕获到不可恢复异常时直接 `process.exit(1)`，让 systemd/容器按策略拉起。
  - 相关位置：`apps/mirror-service/src/index.ts`

- [x] **[中] mirror-service 中存在较多 `catch { ... }` 兜底/忽略错误**
  - 修复：对关键路径的空 catch 改为记录最小错误摘要；对高频路径做了限频（避免刷屏）。
  - 相关位置：`apps/mirror-service/src/lib/realtime-manager.ts`、`apps/mirror-service/src/lib/task-history-full.ts`、`apps/mirror-service/src/lib/task-retry-failed.ts`、`apps/mirror-service/src/lib/settings.ts`、`apps/mirror-service/src/lib/telegram-metadata.ts`

- [x] **[高] Settings cache 模式重复多处**
  - 修复：抽了通用“带过期的 settings 缓存加载器”，把多处重复的缓存/容错逻辑收敛到一处。
  - 相关位置：`apps/mirror-service/src/lib/settings.ts`

- [x] **[中] 环境变量在请求中读取（telegram login routes）**
  - 修复：Telegram API ID/HASH、代理配置改为“模块初始化时读取一次”，避免每次请求重复读取/解析。
  - 相关位置：`apps/web/app/api/telegram/login/send-code/route.ts`、`apps/web/app/api/telegram/dialogs/route.ts`

---

## 8) 修复记录（流水账）

- 2026-02-27：修复 ILIKE 通配符注入、access_password 哈希化、恒等时间登录校验、登录/发码限流、补 `error.tsx`
- 2026-02-27：新增 source_channels 索引迁移、dashboard 查询并行化、频道列表分页加载、移除 SSE 250ms busy-wait
- 2026-02-27：生产环境 API 错误回显收敛（隐藏内部异常详情）、Telegram 登录相关路由环境变量读取优化
- 2026-02-27：抽公共 `utils`（去重多处工具函数）、统一 `TASKS_NOTIFY_CHANNEL` 常量、共享 `decrypt/encrypt` 到 `packages/crypto`
- 2026-02-27：Settings 运行时校验集中到 `@tg-back/db`（Zod），并开始减少 mirror-service 的 `as any`
- 2026-02-27：引入 Vitest（`pnpm test`）并补最小单元测试（settings/crypto/sql-like）
- 2026-02-27：开始拆分 `apps/mirror-service/src/index.ts`：抽离 settings 与 DB retry 模块
- 2026-02-28：新增 GitHub Actions CI：自动跑 `pnpm typecheck` + `pnpm test`（推送/PR 自动检查）
- 2026-02-28：安全/一致性补强：限流默认不信任 XFF、settings PATCH 限流 + 生产环境首次启动自动生成初始访问密码、sync_tasks 唯一约束与消息分页复合索引、channels API 迁移保护逻辑去重、mirror-service 致命错误直接退出

---

## 9) 后续可选增强（不影响当前功能）

- [x] **[低] GitHub Actions CI（自动 typecheck + test）**
  - 作用：以后你每次 push/提 PR，都会自动跑一遍 `pnpm typecheck` 和 `pnpm test`，避免“改着改着把项目改坏了还不知道”。
  - 相关位置：`.github/workflows/ci.yml`
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离 Telegram 标识/错误/客户端初始化模块
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离对象安全读取与 BigInt 工具函数
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离 peer 解析与消息转发模块（resolvePeer/forwardMessagesAsCopy）
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离 spoiler（剧透）处理模块
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离原文链接评论与评论同步模块
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离消息/媒体工具函数与 omitUndefined
- 2026-02-27：继续拆分 `apps/mirror-service/src/index.ts`：抽离 heartbeat（心跳写入）模块
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 message_mappings 批量更新模块（updateMessageMappingsByIds）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 Telegram 元信息/健康检查解析模块
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离频道健康检查执行模块（settings + runChannelHealthCheck）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离频道健康检查调度模块（reloadHealthChannels + ensureChannelHealthChecks）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 FLOOD_WAIT 自动恢复模块（paused tasks auto-resume）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 retry_failed 调度模块（ensureRetryFailedTasks）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离任务变更通知与事件写入模块（notifyTasksChanged/logSyncEvent）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离任务生命周期模块（markTaskFailed/pauseTask）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 pending 任务认领模块（claimPendingTask）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 Telegram 自动建频道/讨论组/管理员模块
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 resolve 任务处理模块（processResolveTask）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 retry_failed 任务处理模块（processRetryFailedTask）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 history_full 任务处理模块（processHistoryFullTask）
- 2026-02-28：继续拆分 `apps/mirror-service/src/index.ts`：抽离 realtime 实时监听/转发模块（RealtimeManager）
- 2026-02-28：依赖对齐：统一 `apps/web` 的 TypeScript 与 `@types/node` 版本
- 2026-02-28：mirror-service settings：抽通用 settings 缓存加载器（减少重复）
- 2026-02-28：mirror-service 稳健性：关键空 catch 补最小日志（含限频）
- 2026-02-28：类型安全：移除 mirror-service 生产代码的 `as any`（不含 `poc.ts`：47 → 0）
