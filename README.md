# tg-back

一个“Telegram 频道备份系统”：

- **mirror-service**：使用 Telegram 账号（MTProto）把源频道消息镜像到备份频道（历史 + 实时），并把同步状态写入数据库
- **Web**：频道/任务管理、消息浏览、导出（JSONL）、事件中心（关键事件，不会按每条消息刷屏）

文档：
- 设计文档：`DESIGN.md`
- 实现细节：`IMPLEMENTATION.md`

> 说明：请只用于备份你有权限访问的频道消息；源频道开启“保护内容/禁止转发”时，Telegram 会限制转发/复制，这不是代码能绕过的。

---

## 功能概览

- 频道管理：添加源频道（支持 `@username` / `t.me` 链接 / 邀请链接 / `-100...`）、分组、优先级、自动创建镜像频道
- 同步：resolve → 历史同步（`history_full`）→ 实时监听（`realtime`）→ 失败重试（`retry_failed`）
- 消息浏览：按频道/分组/多条件筛选查看，支持跳转 Telegram 原文/镜像，支持导出 JSONL
- 事件中心：记录“关键事件”（不会按每条消息刷屏）
- 访问控制：Web 密码
- 过滤：广告/垃圾消息过滤（全局 + 每频道单独配置，命中则标记 `skipped=filtered`）

---

## 仓库结构

- `apps/web`：Web 管理界面（Next.js）
- `apps/mirror-service`：同步服务（读取 DB 里的 Telegram session + 任务队列）
- `packages/db`：数据库 schema 与迁移（drizzle）

---

## 环境要求

- Node.js（建议 22/24）
- pnpm（仓库使用 `corepack` 管理）
- Postgres（本地或云端均可）

---

## 本机开发（推荐按这个顺序）

### 1) 配置环境变量

```bash
cp .env.example .env
```

最少需要：
- `DATABASE_URL`：Postgres 连接串
- `ENCRYPTION_SECRET`：加密/签名用的固定密钥（部署后不要随意更换）
- `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`：Telegram API 凭证

可选：
- `DATABASE_URL_LISTEN`：用于 LISTEN/NOTIFY（更好的实时推送）。如果使用 Supabase pooler（6543 端口），建议提供一个直连（5432 端口）的连接串。

### 2) 安装依赖 + 迁移数据库

```bash
corepack enable
pnpm install
pnpm db:migrate
```

### 3) 启动 Web（先）

```bash
pnpm dev:web
```

打开 `http://localhost:3000`：
- 在首页完成 Telegram 登录（会把 session **加密**写入数据库）

### 4) 启动 mirror-service（再）

```bash
pnpm dev:mirror
```

然后在 Web：
- `频道管理` (`/channels`) 添加源频道
- 首页查看“同步服务在线/离线”，在 `事件中心` (`/events`) 查看关键日志

---

## 生产部署（推荐：Git 拉取 + 构建 + 进程保活）

本项目是“两个常驻进程”：
- Web：提供管理界面与 API
- mirror-service：执行同步任务（历史/实时/重试）

### 1) 服务器首次部署

1) 安装依赖：`git`、Node.js（建议 22/24）  
2) 拉代码 + 配置 `.env`：

```bash
git clone <仓库地址>
cd tg-back
cp .env.example .env
```

3) 安装/迁移/构建：

```bash
corepack enable
pnpm install
pnpm db:migrate
pnpm -C apps/web build
```

4) 启动两个进程（建议用 pm2/systemd 做保活）：

```bash
pnpm -C apps/web start
pnpm -C apps/mirror-service start
```

5) 第一次使用：
- 打开 Web 首页，完成 Telegram 登录（把 session 写入 DB）
- 再去 `/channels` 添加频道（任务会自动开始）

### 2) 服务器更新（以后每次发布）

```bash
git pull
pnpm install
pnpm db:migrate
pnpm -C apps/web build
```

然后用进程管理器重启 Web 与 mirror-service。

---

## 常用页面

- `/`：仪表盘 + 最近事件 + Telegram 登录
- `/channels`：频道管理（添加/筛选/查看详情）
- `/channels/[id]`：频道详情（任务/进度/镜像方式/导出等）
- `/messages`：消息浏览（筛选/跳转/导出 JSONL）
- `/tasks`：任务管理（暂停/恢复/重排队/重启）
- `/events`：事件中心（按频道/级别/关键词筛选）
- `/settings`：系统设置（重试、媒体、受保护内容策略、过滤等）

---

## 常见问题

### 1) 为什么“没有同步/没变化”？
通常是 mirror-service 没跑起来或没拿到 session：
- 去首页看“同步服务”是不是“在线”
- 去 `/events` 看有没有关键报错
- 确认已经在 Web 首页登录过 Telegram（session 会写入 DB）

### 2) 为什么提示受保护/禁止转发？
源频道如果开启了 Telegram 的“保护内容/禁止转发”，Telegram 会直接阻止转发/复制：
- 这不是代码 bug，是 Telegram 的限制
- 你可以在 `/settings` 里选择“跳过受保护内容”或让任务暂停（按你的策略）

### 3) 为什么更新代码后 Web 报错“缺字段/缺枚举”？
大概率是没跑迁移：

```bash
pnpm db:migrate
```

---

## 安全提示

- `.env` 里有数据库连接串/密钥，千万别提交到 GitHub
- `ENCRYPTION_SECRET` 改了会导致 DB 里旧的 Telegram session 解密失败：需要重新在 Web 登录一次
- Web 如果要暴露公网，建议套一层反向代理（Nginx/Caddy）并开启 HTTPS，密码要设置强一些

---

## 开发与贡献

- 代码规范：保持变更小而清晰；避免无关重构
- 常用检查：`pnpm typecheck`
- 数据库变更：修改 `packages/db/src/schema.ts` 后，记得生成/迁移并更新 `.env.example` 的说明

---

## 路线图与测试

- 后续功能清单：`ROADMAP.md`
- 待验证功能清单：`TEST_TODO.md`

> 提示：如果准备开源发布，建议补充 `LICENSE`（例如 MIT/Apache-2.0）与基础的 GitHub Actions（typecheck/lint）。
