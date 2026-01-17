# mirror-service (PoC)

先验证 Telegram 侧是否能 **登录 + 拉取频道消息 + 镜像发送**。

## 运行

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

