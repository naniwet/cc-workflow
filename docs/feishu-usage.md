# 飞书端使用说明

cc-workflow 的飞书集成:**在群里 @机器人发 prompt → 服务器跑 Claude Code → 结果以飞书卡片回到群里**。也支持 cron loop 远程操作、圆桌会议远程发起。

部署 / 飞书后台怎么填,看 [deploy/INSTALL.md §2.5 + §8](../deploy/INSTALL.md)。本文档讲**配好之后日常怎么用**。

---

## 1. 触发一次 agent 跑

在群里 `@机器人` 写 prompt:

```
@bot daily-digest 总结一下昨天的 commit
```

**workspace 解析优先级**(高 → 低):

| # | 来源 | 说明 |
|---|---|---|
| 1 | 消息开头 `[workspace-name]` 前缀 | 临时指定,**只这一条生效**,不改默认 |
| 2 | `/use <name>` 设的 per-chat 默认 | 持久化在 `~/.cc-workflow/feishu_chats.json` |
| 3 | `secrets.toml [feishu].default_workspace` | 全局默认 |
| 4 | `"test-repo"` | 硬兜底 |

三种典型用法:

```
@bot daily-digest 总结昨天提交           ← 临时指定 workspace = daily-digest
@bot 跑一下测试                          ← 走默认 workspace
@bot [other-repo] 看一下 PR 列表        ← 临时切到 other-repo,默认不变
```

**Session 续约:** 同一聊天里连续发多条 = **自动使用同一个 Claude session**(`session_key = feishu-<chat_id>`)。多轮对话天然连续,不需要 reset。换 workspace(打 `[prefix]` 切了)= 自动开新 session。

---

## 2. Slash 命令清单

写在消息开头,**不需要 @bot**(slash 命令是飞书原生路径,机器人收到就直接处理)。

### 帮助

| 命令 | 行为 |
|---|---|
| `/help` | 列出本表(任何时候忘了都能查) |

### Workspace 管理

| 命令 | 行为 |
|---|---|
| `/ws` (alias `/workspaces`) | 列所有 workspace + 每个的 engine / provider / trust。✓ 标当前聊天默认,文末提示切换方法 |
| `/use <name>` | 把这个聊天的默认 workspace 改成 `<name>`。持久化 |
| `/where` | 查当前聊天的默认 workspace(chat 设的 / 全局兜底) |

### 历史 / 卡片视图

| 命令 | 行为 |
|---|---|
| `/sessions` | active + 最近 N 个 run 的卡片视图 |
| `/loops` | 所有 cron loop 列表卡片 |
| `/run` | 手动填表单触发一次 run(workspace + prompt) |

### Cron loop 操作(无需进 PWA)

| 命令 | 行为 |
|---|---|
| `/loops new <name> <自然语言描述>` | 用自然语言新建 loop。LLM parse 出 cron 后**预览**给你看,要求 `/loops confirm` 二次确认才生效 |
| `/loops confirm` | 确认上一个待建 loop(10 分钟内有效) |
| `/loops cancel` | 取消上一个待建 loop |
| `/loops run <name>` | 立即跑一次该 loop。**不影响**它原本的 cron 调度 |
| `/loops pause <name>` | 暂停该 loop(cron 不再触发它,但定义还在) |
| `/loops resume <name>` | 恢复暂停的 loop |

**新建示例:**

```
/loops new daily-digest 每天9点拉一下最新代码并跑测试
```

机器人回:

```
待建 loop 预览(10 分钟内 /loops confirm 生效):
  name      : daily-digest
  cron      : 0 9 * * *
  workspace : test-repo
  prompt    : 拉一下最新代码并跑测试

确认: /loops confirm   取消: /loops cancel
```

你检查无误,回 `/loops confirm` → 成功创建。`workspace` 用的是这个聊天的当前默认(`/use` 设的 / 全局兜底);要把 loop 建在另一个 workspace 下,先 `/use <ws>` 切过去再 `/loops new`。

**删除 loop 走 PWA**(避免误删风险)。

### 圆桌会议(多 agent 辩论)

| 命令 | 行为 |
|---|---|
| `/rt` | 列最近 5 场圆桌(状态 + 问题摘要) |
| `/rt <问题>` | 新开一场。约 1-2 分钟后,**R3 整理员的结果会主动推回原聊天**(共识点 / 分歧轴 / 关键判断 / 条件性结论 / 下一步行动) |

例:

```
/rt 个人 side project 一开始就上严格 TDD,还是先 spike 验证可行性?
```

可以多行(飞书消息允许 Shift+Enter 换行)。

回执形如:

```
✓ 圆桌已开 · ID 2026-05-14_xxxxx
4 角色 × R1+R2 + 整理员 R3,约 1-2 分钟。
完成后我把 R3 整理员结果发回这里;失败也会通知你。
```

完成时会自动收到一张卡片,包含:

```
🎙 圆桌 R3 · 2026-05-14_xxxxx

**问题** ...

## 共识点
- ...

## 分歧轴
- ...

## 关键判断
- ...

## 条件性结论
- ...

## 下一步行动
- ...

[在 PWA 看完整 R1/R2 transcript](https://your-domain/pwa/#roundtables/...)
```

> **限制:** 圆桌跑到一半 backend 重启 → on_complete 回调丢失,这次不会主动推送。但 jsonl 还在,你 `/rt` 重列或去 PWA 都能看到。

### 未识别命令

写错命令(如 `/sesions`)→ 回复 "未识别的命令: /sesions,试试 /help 看支持的命令"。**不**会被当作 prompt 转给 LLM(避免拼错命令浪费 LLM 调用)。

---

## 3. 输出截断逻辑

Claude 跑完输出可能很长,飞书一条消息上限约 4000 字符。超长时:

- 飞书消息显示**前 N 行** + 截断提示
- 末尾附 `https://<your-domain>/pwa/#runs/<run_id>` 链接 → 点进 PWA 看完整版

这就是 `secrets.toml [feishu].pwa_base_url` 配置存在的原因。如果没设,会显示 `(已截断)` 但**没链接** —— 强烈建议配上。

---

## 4. 配置(`/root/.cc-workflow/secrets.toml`)

```toml
[feishu]
app_id            = "cli_xxxxxxxxxxxx"   # 飞书开放平台 → 凭证与基础信息
app_secret        = "xxx"
encrypt_key       = "xxx"                # 飞书 → 事件订阅 → 加密策略
verification_token = "xxx"               # 同上(用于初次 url_verification)
default_workspace = "test-repo"          # 不打 [prefix] 时落到哪
pwa_base_url      = "https://your-domain.com"   # 截断时拼完整 link,圆桌 R3 也用
```

**飞书后台两个 URL:**

| 用途 | 路径 |
|---|---|
| 事件订阅 → 请求地址 | `https://<your-domain>/im/feishu/webhook` |
| 卡片回调(审批 + form 提交) | `https://<your-domain>/im/feishu/card_callback` |

---

## 5. 排错速查

| 现象 | 排查方向 |
|---|---|
| @bot 没反应 | nginx 接到了吗?后端 `journalctl -u cc-workflow --since "5 min ago"` 看有没有 `/im/feishu/webhook` POST 进来 |
| 飞书后台 challenge 验证失败 | `encrypt_key` 没填 / 跟飞书后台不一致 |
| 卡片回复没出现,但有文本回复 | `app_id` / `app_secret` 错(获取 `tenant_access_token` 失败)。文本路径不需要 token,卡片路径需要 |
| `/use` 不生效,下一条还是默认 | 看 `~/.cc-workflow/feishu_chats.json` 有没有写进去(权限 / 磁盘空间) |
| 输出截断后链接打不开 | `pwa_base_url` 没设或设错 |
| `/rt <问题>` 启动了但永远没收到 R3 | 大概率是 backend 重启把回调丢了。`/rt` 重列看状态 / 去 PWA Roundtable tab 看 |
| `/loops run <name>` 报"找不到 loop" | `name` 拼错了,先 `/loops` 看完整列表 |

---

## 6. 设计要点(给以后想改的人)

- **单一进入点:** 所有飞书消息走 `POST /im/feishu/webhook` → `_handle_message` → 要么 dispatch slash,要么 build `run_intent` 交给 runner
- **认证模型:** Feishu 自己的签名(`X-Lark-Signature` = sha256(ts + nonce + encrypt_key + body));不是 cc-workflow 的 HMAC session cookie
- **加密体:** 启用 Encrypt Key 后 body 是 AES-256-CBC,key = sha256(encrypt_key),IV = blob 前 16 字节
- **回调 push 推送:** 圆桌主动推 R3 用的是 `runner.submit(..., on_complete=...)` 的 callback hook。callback 闭包了 `chat_id`,完成时读 jsonl 决定推什么。**不**维持 `chat_id ↔ roundtable_id` 的持久化映射表(YAGNI)
- **未识别 slash:** 不 fall-through 到 LLM —— 防止拼错命令浪费 token。代价:用户偶尔想发 `/X` 当 prompt 的时候不行(可以用 `\/X` 或加 @bot 前缀绕开,但目前没实测)
