# tg-back 稳定性与运维记录

> 目标：这是给“个人长期跑”的备忘录。你不需要懂代码，只要照着做就能更稳定、更省心。

---

## 你现在的运行方式：systemd（你贴出来的 wosa-tel.service）

你现在是把 tg-back 当成一个“系统服务”在跑（systemd 就像一个看门人）：

- 服务正常：它就一直跑着
- 服务崩了：systemd 会按你配置的 `Restart=always` 自动重启

你贴出来的配置（核心点）：

- `WorkingDirectory=/root/wosa-tel-mirror`
- `ExecStart=/usr/bin/pnpm start:all`
- `Restart=always` + `RestartSec=10`

这套方式本身没问题，而且对“长期稳定”是加分项。

### 建议你把 service 再增强一点点（更稳）

你可以参考下面这个“更稳的模板”（保留你的思路，只做小增强）：

```ini
[Unit]
Description=Wosa Tel Mirror Service
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/wosa-tel-mirror

# 可选：明确告诉 systemd 读取环境变量（如果你已经用 .env 且代码能读到，也可以不加）
# EnvironmentFile=/root/wosa-tel-mirror/.env

# 建议：关掉 Next 遥测（不影响功能，少一点“无用请求”）
Environment=NEXT_TELEMETRY_DISABLED=1

ExecStart=/usr/bin/pnpm start:all
Restart=always
RestartSec=10

# 建议：优雅退出时多给一点时间（避免半截退出导致状态不一致）
TimeoutStopSec=30
KillSignal=SIGTERM
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

你不需要完全懂上面每一行，你只要知道：
- `network-online.target`：确保网络真起来了再启动（对云数据库更稳）
- `TimeoutStopSec/KillSignal/KillMode`：停止服务时更“温柔”，减少异常

### systemd 常用命令（你实际最常用的）

- 看状态：`systemctl status wosa-tel.service`
- 看实时日志：`journalctl -u wosa-tel.service -f`
- 重启：`systemctl restart wosa-tel.service`
- 改了 service 文件后：`systemctl daemon-reload && systemctl restart wosa-tel.service`

### 访问密码（首次启动很重要，避免“被别人抢先设置锁死”）

- **推荐公网部署**：在 `.env` 里设置 `TG_BACK_BOOTSTRAP_ACCESS_PASSWORD`，首次启动会自动把它（加盐哈希）写入数据库并开启访问控制。
- 如果你没设置这个变量、数据库里也没有 `access_password`：生产环境会**自动生成一个初始访问密码**，并打印到服务端日志里。  
  你只需要去 systemd 日志里找那行提示，然后用这个密码登录，之后再到 `/settings` 改成你自己的密码即可。

### 日志怎么看（推荐 systemd 日志；可选文件日志）

你有两种选择：

1) **只用 systemd 日志（推荐，最省事）**
- 优点：不需要你配置文件日志；系统会自动做日志管理。
- 看日志：`journalctl -u wosa-tel.service -f`

2) **同时写一份“文件日志”（可选）**
- 适合：你想在 Web 页面 `/logs` 里直接看 mirror-service 的运行日志。
- 做法：在项目 `.env` 里配置 `MIRROR_LOG_FILE=./logs/mirror-service.log`，然后重启服务。
- 重要：文件日志会一直变大，建议配 logrotate（见“计划 3：日志轮转”）。

### 更新代码时，推荐这样做（最不容易出事）

```bash
cd /root/wosa-tel-mirror
git pull
corepack enable
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm -C apps/web build
systemctl restart wosa-tel.service
```

说明：
- `pnpm -C apps/web build` 很关键：没 build 的话，Web 可能起不来。
- `pnpm db:migrate` 会把数据库结构升级到最新（没跑的话容易“缺字段/报错”）。

---

## 你现在说的“build 后运行”大概是什么（它其实是被 systemd 托管在跑）

通常是这类流程：

1) 构建 Web（Next.js）：
- `pnpm -C apps/web build`

2) 启动两个常驻进程：
- Web：`pnpm -C apps/web start`
- mirror-service：`pnpm -C apps/mirror-service start`

说明：
- Web 的 `build → start` 是标准做法。
- mirror-service 目前是用 `tsx` 直接跑 TypeScript（也能跑，但更“工程化”的生产方式是：先编译成 JS 再用 node 跑，见下面“计划 2”）。

---

## 已做的稳定性优化（记录）

### 2026-02-27：启动更耐断、更不容易卡死

1) mirror-service 启动“会等你”
- 如果数据库短暂连不上、或你还没在 Web 首页完成 Telegram 登录（`settings.telegram_session` 为空），mirror-service 不会退出，会自动等待并重试。
- 可用环境变量控制等待间隔：`MIRROR_START_RETRY_INTERVAL_SEC`（默认 10 秒）。

2) Telegram 连接更抗波动
- 连接失败会做多次重试。
- 如果 Telegram session 失效，会提示你回到 Web 重新登录，然后它会继续重试等待。

3) 数据库断线重试更“聪明”
- 能识别更多常见断线/限连错误，并带一点随机等待（抖动），减少“大家一起重连又一起挂”的情况。

4) history_full（历史同步）完成判定更稳
- 历史同步结束前，会再确认“后面是不是真的没消息了”，并对短暂网络抖动/限流做重试，减少误判导致任务暂停。

5) 文件日志更安全
- 配了 `MIRROR_LOG_FILE` 时：如果日志文件写入失败，会自动关闭文件日志（避免把进程弄崩），并在终端提示。
- 遇到严重未捕获错误时，会先尽量把原因写进日志再退出（方便你排查）。

---

## 你之前提到的 3 项（计划/待办）

> 这几项是“建议/待办”。我会在这里同步是否已完成，方便你长期跑的时候对照。

### 已完成：mirror-service 拆分（可维护性 → 间接更稳定）

为什么要做：
- 现在核心逻辑集中在一个超大的文件里，未来你遇到“偶发卡住/报错”，排查和修复会慢，风险也更高。

怎么做（方向）：
- 把“任务调度 / 历史同步 / 实时同步 / Telegram 封装 / DB 操作 / 重试限流 / 日志”分成多个文件。

完成标准：
- 功能不变；`pnpm -C apps/mirror-service typecheck` 通过；日常问题定位更快。

完成情况：
- 2026-02-28：已完成（`apps/mirror-service/src/index.ts` 已拆分为多个模块，维护成本显著降低）。

### 计划 2：生产启动方式更标准（更适合服务器长期跑）

为什么要做：
- 现在 mirror-service 用 `tsx` 直接跑 TS：能用，但不是最省心的生产形态（升级/依赖/冷启动等方面更难控）。

怎么做（推荐）：
- mirror-service 增加 build：`tsc` 编译到 `dist/`
- 生产启动改为：`node dist/index.js`

完成标准：
- 服务器只需要 node，启动更快更稳定；升级时更可控。

### 计划 3：日志轮转（避免日志无限变大把磁盘写满）

为什么要做：
- 如果你把日志写到文件（`MIRROR_LOG_FILE`），日志会一直变大；长期跑最怕“磁盘满 → 数据库/服务各种异常”。

怎么做（两种常见方案，选其一就行）：
- 方案 A（推荐，最省事）：用系统 `logrotate` 做轮转与保留天数。
- 方案 B：在 Node 里做“按大小/按天切分”。

如果你选方案 A（logrotate），可以参考下面这个示例（按你的路径改一下）：

1) 新建文件：`/etc/logrotate.d/wosa-tel-mirror`

2) 写入内容（示例）：

```conf
/root/wosa-tel-mirror/logs/mirror-service.log {
  daily
  rotate 7
  compress
  missingok
  notifempty

  # 重要：因为进程会一直占用这个日志文件，所以用 copytruncate 最省事
  copytruncate
}
```

完成标准：
- 日志文件大小可控；保留最近 N 天；不会把磁盘打满。

---

## 推荐执行顺序（更贴合“个人长期跑”）

1) 先做“日志轮转”（最能防大事故：磁盘写满）
2) 再做“生产启动方式标准化”（让升级/重启更稳）
3) mirror-service 拆分（已完成 ✅）

---

## 其他建议（不改代码也能更稳、更省服务器资源）

1) 给进程“上保险”（很关键）
- 用 Docker 的话：建议设置容器自动重启（例如 `restart: always`）。
- 不用 Docker 的话：建议用 `systemd`/`pm2` 之类的“守护”，进程崩了能自动拉起。

2) 省服务器资源的推荐设置（个人使用）
- `/settings` 里把并发保持为 1（`concurrent_mirrors=1`）。
- 把发送间隔调大一点（`mirror_interval_ms` 例如 1500～3000）：更省 CPU/更不容易触发 Telegram 限流。

3) 不需要评论就关掉（能省不少请求）
- 环境变量：`MIRROR_SYNC_COMMENTS=false`

4) 如果你用 Supabase 连接池（pooler）
- 建议额外配置一个“直连”的 `DATABASE_URL_LISTEN`（更稳），否则实时推送偶发断线会多一点。
