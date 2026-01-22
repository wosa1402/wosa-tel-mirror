# mirror-service (PoC)

先验证 Telegram 侧是否能 **登录 + 拉取频道消息 + 镜像发送**。

除此之外，本包也包含最小可运行的 `mirror-service`：从数据库读取 `telegram_session`，执行 `sync_tasks`（resolve）并启动实时同步（realtime）。

## 运行

### 1) PoC（直接用本地 session 文件）

1. 在仓库根目录准备环境变量：

```bash
cp .env.example .env
```

2. 填写 `.env` 中的：
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_PHONE`（可选，不填会运行时提示输入）
- `TG_POC_SOURCE_CHAT`（必填，建议填频道 username，例如 `some_channel` 或 `@some_channel`）
- `TG_POC_TARGET_CHAT`（可选，默认 `me`）

3. 安装依赖并运行：

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm -C apps/mirror-service poc
```

首次运行会进行交互式登录，成功后会把 session 保存到 `apps/mirror-service/.telegram-session`（已在 `.gitignore` 中忽略）。

#### 快速测试：指定消息链接

如果你不想全量拉取历史，可以直接指定要镜像的消息链接（支持 `https://t.me/<username>/<msgId>` / `https://t.me/c/<id>/<msgId>`）：

```bash
TG_POC_MESSAGE_LINKS="https://t.me/some_channel/123" TG_POC_TARGET_CHAT="-100xxxxxxxxxx" pnpm -C apps/mirror-service poc
```

注意：每次运行都会在目标频道生成一条新消息（或一组媒体组 album），评论也会同步到该新消息对应的评论线程；请在 Telegram 里打开最新生成的那条镜像消息查看评论效果。

也可以把链接作为参数传入：

```bash
pnpm -C apps/mirror-service poc -- "https://t.me/some_channel/123"
```

可选：
- `TG_POC_SYNC_COMMENTS=true|false`：是否同步该 post 的评论（需要目标频道绑定讨论组）
- `TG_POC_MAX_COMMENTS=200`：评论同步上限

### 2) mirror-service（使用 Web 登录写入 DB 的 session）

前置条件：
- 数据库已迁移（根目录执行 `pnpm db:migrate`）
- `.env` 已配置：`DATABASE_URL`、`ENCRYPTION_SECRET`、`TELEGRAM_API_ID`、`TELEGRAM_API_HASH`
- Web 端已登录成功（会把 session 加密写入 `settings.telegram_session`）

运行：

```bash
pnpm -C apps/mirror-service dev
```

然后在 Web 端 `http://localhost:3000/channels` 添加源频道与镜像目标（默认 `me`），mirror-service 会自动 resolve 并开始实时转发。
