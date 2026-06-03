# Workspace Git 区段 — Design

**Date:** 2026-06-03
**Status:** Drafted for user review
**Scope:** workspace detail 里一个**默认折叠、只读**的 Git 区段 —— 看当前分支 / ahead-behind / dirty 状态 + 改动文件 diff + 最近 N 条 commit + worktree 列表。后端一个只读 git 端点(`subprocess git → parse → dict`,parse 做纯函数)。本期**不做任何写操作**(merge / discard / commit / 文件编辑),也不做整仓文件树浏览。

---

## 1. Motivation

claude 在 PWA / 飞书 / cron 里跑完一轮,做了一堆 commit,但用户当前**只能在对话流里逐条 tool_use 看它改了什么**,看不到聚合视角:
- 这个 session 相对 base 净改了哪些文件?ahead 几个 commit?
- 工作区还有没有没 commit 的脏改动?
- 这个 workspace 现在挂着几个 worktree?

要看这些只能 ssh 进服务器敲 `git status` / `git log` / `git diff`。一个**只读**的聚合视图能省掉这趟 ssh —— 这是本功能的全部价值。

**不是要做 IDE。** 不做文件树、不做编辑器、不做从 UI 操作 git。只读、轻量、默认折叠不抢对话主体。

---

## 2. 通用语言(新术语,跟现有对齐)

| 术语 | 含义 | 跟现有术语的关系 |
|---|---|---|
| **Git 区段**(git section) | workspace detail pane 里那块默认折叠的只读 git 视图。UI 用户感知层叫 "Git";代码 identifier 用 `git-section` / `gitSection`。 | 挂在一个 pane = 一个 **session** 维度上(见 §6)。**不叫** "git panel" / "repo view" / "源代码管理"。 |
| **base** | ahead/behind 和 session-vs-base diff 的对比基准。= 当前 workspace 主目录 `HEAD` 所在分支名(`git rev-parse --abbrev-ref HEAD`,通常 `main`,可能 `master`)。 | 跟 `merge-session-branch` / `pull` 端点里取 `main_branch` 的逻辑**完全一致**(同一真相源,§3.5)。 |
| **session 分支** | auto 模式下某个非 default session 对应的 `cc/<ws>-<session_safe>` 分支。 | 命名规则 = `agent-run.sh:376` + `merge_session_branch` 已钉死的 `cc/<ws>-<session_safe>`,`session_safe = re.sub(r"[^A-Za-z0-9._-]","_", key)`。**本 spec 不新造命名,只读取。** |
| **diff_stat** | 一个改动文件的统计项 `{file, additions, deletions, status}`。 | 区别于现有对话流里 tool_use 的 inline diff(那是单个 Edit/Write 的 `old_string/new_string`,不是 git 层面的)。 |
| **hunk** | unified diff 里一段连续改动(`@@ ... @@` + 上下文 + +/- 行)。 | 现有 `_toolUseDiffHtml` **不解析 hunk**(见 §5.2 的 push back)。 |

`run` / `session` / `workspace` / `worktree` / `loop` / `provider` 沿用 CLAUDE.md §8 已钉死的定义,不引入新同义词。

---

## 3. 后端接口(几乎不可逆,重点锁死 §3.2)

### 3.1 两个端点(列表端点 + diff 懒加载端点)

```
GET /workspaces/{ws}/git?session=<key>        # 概览:branch/ahead/behind/dirty/commits/diff_stat/worktrees
GET /workspaces/{ws}/git/diff?session=<key>&file=<path>&uncommitted=0|1   # 单文件 hunks(懒加载)
```

**为什么拆两个端点(open question 1 的结论):** per-file hunks **懒加载**,概览端点只返回 diff_stat(文件名 + 增删行数),不带任何 hunk 正文。
- **收益:** 一个 session 改 80 个文件、单文件 diff 几千行时,概览端点不会一次把全部 hunk 拉爆(JSON 体积 / 渲染卡顿)。展开某个文件才打第二个端点。
- **代价:** 多一个端点 + 前端多一次请求。
- **反悔成本:2 级(模块边界)。** 真嫌请求多,后续可给概览端点加 `?inline_diff=1` 把小 diff 一次带回 —— 不破坏现有 schema(纯增字段)。
- **何时翻案:** 若实测 95% 的 session diff 都 < 200 行,懒加载收益不抵交互延迟,再合并。

### 3.2 `GET /workspaces/{ws}/git` 响应 schema(**1 级,锁死**)

```jsonc
{
  "is_git_repo": true,             // false → 下面字段全省略,前端显"非 git 仓库"
  "branch": "cc/myrepo-pwa-myrepo",// 当前 cwd 的 HEAD 分支名;detached → null
  "head_short": "a4ac71d",         // 当前 HEAD 短 sha(detached 时唯一标识)
  "base": "main",                  // 对比基准分支名(§2)
  "ahead": 3,                      // branch 相对 base 领先几个 commit
  "behind": 0,                     // 落后几个
  "dirty": true,                   // 工作区有未提交改动(tracked 改动或 untracked 文件)
  "session": "pwa-myrepo",         // 回显请求的 session key(default 时为 "default")
  "cwd_kind": "worktree",          // "main" | "worktree" —— 这次 git 跑在哪(见 §6)
  "recent_commits": [              // 见 §3.3
    { "sha": "a4ac71d", "subject": "fix(pwa): 全局对齐失效设计 token", "rel_date": "2 hours ago", "author": "wet" }
  ],
  "diff_stat": [                   // session-vs-base 的净改动(见 §3.4)
    { "file": "pwa/app.js", "additions": 42, "deletions": 7, "status": "M", "binary": false }
  ],
  "diff_truncated": false,         // diff_stat 文件数超上限被截断(§7 超大 diff)
  "worktrees": [                   // 见 §3.5
    { "path": "/home/u/workspaces/.wt/myrepo-pwa-myrepo", "branch": "cc/myrepo-pwa-myrepo",
      "head_short": "a4ac71d", "is_current": true }
  ],
  "warnings": []                   // 非致命降级信息,如 ["base 'main' 不存在,ahead/behind 略过"]
}
```

非 git 仓库 / 路径不存在的特例:

```jsonc
{ "is_git_repo": false, "session": "pwa-myrepo" }   // 其余字段省略
```

**字段命名的钉死理由:**
- `ahead` / `behind`(不是 `commits_ahead` / `front`)—— 跟 `git status -sb` 的 `[ahead N, behind M]` 文案 + 用户直觉一致。
- `diff_stat`(不是 `changed_files` / `files`)—— 直接对应 `git diff --numstat` 的语义。
- `status` 取值 = git 的 porcelain 单字母:`M`(modified)/ `A`(added)/ `D`(deleted)/ `R`(renamed)/ `?`(untracked)。前端按字母上色,**不在后端翻译成中文**(§1 Unix:后端只 parse 不做 presentation)。
- `cwd_kind`:`"main"` = 跑在 `~/workspaces/<ws>/` 主目录;`"worktree"` = 跑在 `.wt/<ws>-<safe>/`。前端用它提示用户"你看的是主目录 / 某 worktree"。

### 3.3 `recent_commits` 取数(open question 1 子项)

`git log -n <N> --pretty=format:'%h%x00%s%x00%cr%x00%an'`(NUL 分隔,**不用空格 split** —— commit subject 含空格)。

- `N` 默认 **20**(实现细节,3 级,config 不需要加项)。
- 字段:`sha`(短)/ `subject` / `rel_date`(`%cr` = "2 hours ago")/ `author`。
- **理由:** 只读概览要的是"最近做了啥",4 个字段够。不要 full sha / commit body / 文件列表(那是 diff 端点的事)。
- 空仓库(0 commit):`git log` 非零退出 → `recent_commits: []` + 不报错(§7)。

### 3.4 `diff_stat` 取数(open question 2 + 4 的结论)

**默认基准:session 分支 vs base 的 merge-base(net contribution)。** 用 `git diff --numstat <base>...<branch>`(**三个点** = 对比 `branch` 相对 `merge-base(base, branch)` 的改动,即"这个 session 在自己分支上的净贡献",不含 base 自己后来的提交)。

- **为什么三点不是两点:** 两点 `base..branch` 会把 base 上 branch fork 之后的新 commit 也算进 behind 那侧噪声;三点只显 branch 自己加的,正是"这一会儿 claude 的净贡献"(已拍死方向 4)。
- **ahead/behind 取数(实现期修正,见 §9):** 用 `git rev-list --left-right --count <base>...<branch>`(三点 symmetric difference),输出 `<behind>\t<ahead>` 解析成 `(ahead, behind)`。**不用 `git status -sb` 的 `[ahead N, behind M]`** —— 那个 bracket 给的是相对 **upstream** 的关系,而本地 `cc/*` session 分支没有 upstream,status -sb 算不出相对 base 的 ahead/behind。rev-list 三点直接对 base 算,跟上面 diff_stat 的三点口径一致。
- **含未提交开关(已拍死方向 4):** 概览端点默认不含工作区未提交改动;`diff` 端点带 `uncommitted=1` 时,单文件 diff 改用 `git diff HEAD -- <file>`(工作区 vs HEAD)。概览的 diff_stat 是否也要随开关切换 → 见 open question Q3 结论(默认概览只显 net contribution 那套,uncommitted 在 diff 端点维度生效)。
- **numstat 的二进制文件:** numstat 对二进制文件输出 `-\t-\t<file>` → `additions/deletions` 记 `null` + `binary: true`(§7)。

### 3.5 `worktrees` + base 取数(open question 2 的结论 + §3.4 base 真相源)

- `base` = `git -C <主目录> rev-parse --abbrev-ref HEAD`。**复用 `pull` / `merge_session_branch` 已有的同一逻辑**(那两处都 `head or "main"`)—— §3.4 通用语言:base 怎么算只能有一个真相源,新代码抄旧逻辑不另起炉灶。
- `worktrees` = `git worktree list --porcelain` parse。每项 `{path, branch, head_short, is_current}`。`is_current` = path == 这次 git 跑的 cwd。
- **base 不存在的降级:** repo 没有 `main`/`master`(裸新仓)→ ahead/behind/diff_stat 略过 + `warnings` 记一条,不报 500(§7)。

### 3.6 git 输出解析 = 纯函数(TDD 硬约束,§5)

后端**不把 subprocess 调用和 parse 混在一起**。结构:

```
backend/git_view.py
  ├─ run_git(cwd, args) -> (rc, stdout, stderr)        # 唯一 IO 边界(沿用 main.py 现有 _git helper 形状)
  ├─ parse_status(porcelain_text) -> {dirty, ...}      # 纯函数
  ├─ parse_rev_list_count(text) -> (ahead, behind)     # 纯函数(rev-list --left-right --count base...branch)
  ├─ parse_log(log_text) -> [commit...]                # 纯函数(NUL split)
  ├─ parse_numstat(numstat_text) -> [diff_stat...]     # 纯函数
  ├─ parse_worktree_list(porcelain_text) -> [worktree] # 纯函数
  └─ parse_unified_diff(diff_text) -> [hunk...]        # 纯函数(diff 端点用,§5.2)
```

`run_git` 是唯一摸 subprocess 的地方;所有 `parse_*` 吃字符串吐 dict/list,**不碰 IO** → 5 分钟可写 unit、纯内存、< 10ms。端点 handler = `run_git` 取原文 → 喂对应 `parse_*` → 拼 dict。

**新建 `backend/git_view.py` 而不是塞进 `main.py`** 的理由:`main.py` 是 ~1300 行 HTTP 路由单文件(CLAUDE.md 明令不拆路由),但 parse 纯函数**不是路由**,放进去既污染路由文件又没法独立 unit。这跟"不拆 main.py"不冲突 —— 路由仍留 main.py,只是 import `git_view` 的纯函数。**(请 review 确认这个边界判断。)**

### 3.7 路径安全 + workspace 校验(复用现有)

- workspace 存在性 + path-traversal:**复用** `ui_cards._discover_workspaces()` 白名单(`pull`/`merge`/`pr` 三个端点的现成模式),不存在 → 404。`_WS_NAME_RE` 由该 helper 间接保证。
- `?file=<path>` 参数(diff 端点):必须在 repo 内。用 `git diff -- <file>` 时 git 自身会拒绝 repo 外路径,但 spec 仍要求**先做一道 `Path(file)` 不含 `..` 且不以 `/` 开头的校验**,再交给 git(纵深防御,1 级安全相关)。

---

## 4. UX

### 4.1 落点(已拍死方向 6)

Git 区段插进 `.ws-col`(`pwa/app.js:3201`)的 `_sessionBarHtml(name)` **之后、`ws-timeline` 之前**:

```
ws-head (标题 + provider)
ws-session-bar (session chips)
👉 git-section  ← 新增,默认折叠
ws-timeline (对话流)
queue
composer
```

- **默认折叠**:一行 header `▸ Git`,右侧有改动时显 `±N` 角标(N = diff_stat 文件数)。**折叠态不打任何 git 端点**(角标 N 怎么来 → 见 Q5 结论:折叠态不显精确 N,只显一个 dot,展开才拉数;或概览随 sessions poll 捎一个 cheap dirty bit —— 取 default,见 Q5)。
- **展开**:`▾ Git` → 打 `GET /workspaces/{ws}/git?session=<当前 pane session>` 拉一次,渲染 4 块:branch 状态行 / commits / 改动文件 / worktrees。
- 每块标题极简,信息密度优先(跟现有 token 体系一致,复用 `.diff-del`/`.diff-add` 等已有 class)。

### 4.2 四块内容

| 块 | 内容 | 交互 |
|---|---|---|
| **状态行** | `cc/myrepo-pwa-myrepo ↑3 ↓0 · dirty` + `base: main` | 无 |
| **Commits** | 最近 N 条 `<short sha> <subject> <rel_date>` 单行列表 | 无(只读,不点开 commit) |
| **改动文件** | diff_stat 每行 `<status字母> <file> +A -D` | **点文件 → 懒加载 hunks**,inline 展开 diff(§5.2) |
| **Worktrees** | 每项 `<branch> @ <head_short>` + 当前那条高亮 | 无(本期不做 merge/remove,§8) |

### 4.3 拉取时机(open question 5 的结论)

- **不进 refreshAll 轮询。** git subprocess 不该每 3s 跑。
- **展开时按需拉一次** + Git header 右侧一个手动 ⟳ 刷新按钮。
- run 跑完(turn 状态 running→done)**不自动刷 git** —— 用户想看新状态自己点 ⟳(避免每条 run 结束都 fork git)。

### 4.4 mobile(open question 7 的结论)

desktop + mobile **都有**,复用同一套渲染函数(`renderMobileWorkspaceDetail` 也走 `.ws-col` 同结构)。Git 区段 HTML 由一个纯函数 `_gitSectionHtml(name, sessionKey)` 生成,两端共用。**理由:** 不为 mobile 单写一套 = 维护一份;mobile 屏幕窄,折叠态默认收起正合适。

---

## 5. 复用现有 diff 渲染器 —— 这里有个 push back

### 5.1 现状核查结论

现有 `_toolUseDiffHtml(name, input)`(`pwa/app.js:3955`)+ `_diffLinesHtml(text, cls)` 的**输入是 tool_use 的 `{old_string, new_string}` 整块字符串**,行为是"old_string 每行 `.diff-del`、new_string 每行 `.diff-add`"—— **它不解析 unified diff,不认 `@@` hunk header,没有上下文行概念**(代码注释明说"全删旧 + 全增新,精确 LCS 留后")。

### 5.2 push back:git diff 喂不进现有渲染器,要么后端转形状,要么前端加薄 parse

任务书说"复用这套,不重写,看能不能直接喂 git diff 解析结果"。**核查后:不能直接喂。** 两条路:

| 方案 | 做法 | trade-off | 反悔成本 |
|---|---|---|---|
| **A.(推荐)前端加薄 hunk parser** | 后端 `diff` 端点返回 `parse_unified_diff` 的结构化 hunks(`[{header, lines:[{kind:'add'/'del'/'ctx', text}]}]`);前端新增一个**薄**渲染函数把每行按 kind 套 `.diff-add`/`.diff-del`/`.diff-ctx` class —— **复用现有 CSS class,不复用现有 JS 函数**(因为函数语义不对) | 复用了视觉层(CSS token 一致),JS 多 ~15 行;诚实(hunk 有上下文行,现有函数没有) | parse 在后端纯函数(§3.6)= 1 级锁死;前端渲染函数 = 3 级 |
| **B. 后端把 hunk 拍成"删块+增块"喂现有函数** | 后端把每个 hunk 的 - 行拼成 old_string、+ 行拼成 new_string,丢上下文,喂 `_diffLinesHtml` | 真复用现有 JS;但**丢上下文行** = 看 diff 时不知道改动在哪段代码里,体验退化 | 丢上下文不可接受,否决 |

**结论:取方案 A** —— "复用 diff 渲染器"落实为**复用 CSS 视觉层(`.diff-del`/`.diff-add` + 新增 `.diff-ctx`)**,而非复用那个语义不匹配的 JS 函数。请用户确认这个口径(任务书原话是"复用这套",我把它精确化为"复用视觉层")。

---

## 6. session 维度 vs workspace 维度(open question 6 的结论)

**Git 区段挂 session 维度**(一个 pane = 一个 session)。`?session=<key>` 决定 git 跑在哪个 cwd:

| worktree_mode | session key | git cwd | cwd_kind |
|---|---|---|---|
| auto | 非 default(如 `pwa-myrepo`)| `.wt/<ws>-<session_safe>/`(存在时)| `worktree` |
| auto | 非 default 但 worktree 还没建(session 刚新建没跑过)| 退化到主目录 | `main` + warning |
| auto / off | `default` | `~/workspaces/<ws>/` 主目录 | `main` |
| **off**(任何 key)| runner 已把 key 压成 default | 主目录 | `main` |

- cwd 推导**复用** `get_workspace_sessions` 已有的 `session_safe` + `.wt/<ws>-<safe>` 探测逻辑(§3.4 真相源唯一)。
- pane 当前 session = 前端 `activeSessionKey(ws)` / `workspaceActiveSession[ws]`;"全部"chip(无 active)→ 默认看**主目录**(`session=default`)。

### worktree_mode=off 的退化路径(已拍死方向 3,硬要求写清)

off 模式下所有 session 压成 default、跑主目录、**无 per-session 分支** → "session-vs-base diff" 的 branch == base → ahead=0/behind=0、diff_stat 走 `git diff HEAD`(工作区改动)那套退化:

- `branch` == `base`(主分支)→ `ahead/behind` 都 0。
- diff_stat 退化成**只显工作区未提交 diff**(`git diff HEAD --numstat`),因为没有 session 分支可对比。
- commits 显主分支 `git log`。
- worktrees 列表仍可显(off 模式 worktree 列表通常只有主目录一条)。
- 前端 `worktree_mode === 'off'` 时 Git 区段照常显示(不像 session-bar 那样隐藏)—— off 仓库也需要看 git 状态,只是看的是主目录。

---

## 7. 边缘 case(open question 4,全部降级不报 500)

| case | 处理 |
|---|---|
| workspace 不存在 / 路径越界 | `_discover_workspaces()` 白名单未命中 → 404(复用现有) |
| `?file` 含 `..` 或绝对路径 | 400 reject(§3.7 纵深防御) |
| 非 git 目录(无 `.git/`) | `{is_git_repo: false}`,前端显"非 git 仓库",不报错 |
| repo 一个 commit 都没有 | `git log` 非零 → `recent_commits: []`;无 HEAD → `branch: null` + warning |
| detached HEAD | `branch: null` + `head_short` 给短 sha;ahead/behind 用 head_short 对 base 算 |
| base 分支不存在(无 main/master) | ahead/behind/diff_stat 略过 + warnings 一条 |
| 超大 diff(文件数 / 行数) | diff_stat 文件数 cap **200**(`diff_truncated: true`);单文件 hunk diff 行数 cap **2000 行**,超了截断 + 末尾标记(实现细节 3 级,阈值可调) |
| 二进制文件 | numstat `-\t-` → `additions/deletions: null` + `binary: true`;diff 端点对二进制返回 `{binary: true, hunks: []}` |
| 改动文件名含空格 / 中文 | log 用 NUL 分隔(§3.3);numstat 文件名在 tab 后取整段不 split |
| git 命令超时 | 沿用现有 `_git` 的 timeout → rc=124 → 该块降级 + warning,不挂整个端点 |
| git 不可用(OSError) | rc=127 → `{is_git_repo: false}` 兜底 + warning |

**原则:Git 区段是只读 nice-to-have,任何子项失败都降级显示,绝不让一个块的错误炸掉整个端点 / 整个 workspace detail。**

---

## 8. Out of Scope / Future(明确不做 + 为什么)

### 本期非目标(已拍死方向 1/2/3)

- ❌ **整仓文件树浏览 / 任意文件查看** —— "File view" 只看改动文件 + diff,不是仓库浏览器。
- ❌ **文件编辑 / 暂存 / 从 UI commit** —— 只读。
- ❌ **语法高亮编辑器 / blame / 分支图 / 交互式 rebase** —— 不做 IDE。
- ❌ **git 区段进 refreshAll 轮询** —— 按需拉(§4.3)。
- ❌ **commit 详情点开 / commit 内 diff** —— recent_commits 只列不点。

### 紧跟的第二步(有意延后,不是遗漏)

**worktree 面板加 merge / discard 按钮:**
- "Merge to main" → 复用**已有** `POST /workspaces/<ws>/merge-session-branch`(rebase + ff-merge + push,保留 cc/* 分支)。
- "Discard worktree" → 需要一个新的 `POST /workspaces/<ws>/worktrees/<key>/remove`(包 `git worktree remove`),目前是用户手动 ssh `git worktree remove`(CLAUDE.md §4.5)。
- **为什么延后:** 写操作(尤其 discard = 删 worktree)反悔成本高、要 confirm UX、要处理 dirty worktree 拒删等。先把只读视图做稳、用户用上有了反馈,再加写操作。本只读 MVP 的 schema 已为它留位(`worktrees[].path` + `branch` 够 discard 用,`is_current` 够"不能删当前那条"判断)。

### 不做的复杂度(CLAUDE.md §3.3)

- ❌ git 状态 cache 层(每次展开 fork git,单用户单机 fork 成本可接受,不引缓存失效复杂度)。
- ❌ WebSocket 推 git 变更(按需拉 + 手动刷够用)。
- ❌ 抽象 `BaseVcsProvider`(只有 git,if-else 都用不上)。

---

## 9. Test Plan(本项目验证基线)

> 本机 mac 跑不了后端(缺 flock + claude)。验证三层:`py_compile` 语法 + git parse 纯函数 unit + 前端 `node --check` + render harness 截图走查。

### Unit(~80%,纯内存 < 10ms)— 重点

`tests/test_git_view.py`(新增,unittest),**全部喂固定 git 输出字符串,先红后绿:**

- `parse_log`:NUL 分隔 → 4 字段;subject 含空格 / 中文不裂;空输入 → `[]`。
- `parse_numstat`:正常行 → `{file, additions, deletions}`;二进制 `-\t-` → `binary: true` + null;文件名含空格不裂;空 → `[]`。
- `parse_rev_list_count`:`git rev-list --left-right --count base...branch` 输出 `<behind>\t<ahead>` → `(ahead, behind)`;`"0\t2"` → `(2, 0)`;空/异常输出 → `(0, 0)` 兜底。(取代早期 spec 的 `parse_ahead_behind` 吃 `git status -sb` —— 见 §3.4 取数修正。)
- `parse_branch`:`## main` → `"main"`;`## cc/x...main [ahead 1]` → `"cc/x"`;`## HEAD (no branch)` → `None`;`## No commits yet on main`(空仓库)→ `None`。
- `parse_status`:有改动 → `dirty: true`;含 untracked `??` → dirty;空 porcelain → `dirty: false`。
- `parse_worktree_list`:`git worktree list --porcelain` 多条 → 每条 `{path, branch, head_short}`;detached worktree → branch null。
- `parse_unified_diff`:`@@` header + +/- / 上下文行 → `[{header, lines:[{kind,text}]}]`;多 hunk;无改动空 diff → `[]`;二进制 diff → 标记。
- **截断逻辑**:diff_stat 超 200 文件 → 截断 + `diff_truncated`;单文件超 2000 行 → 截断标记。

**`run_git` 不写 unit**(它是 IO 边界)—— 端点组装逻辑放 integration。

### Integration(~15%,< 1s)

`tests/test_main.py`(扩展)—— 用 `tmp_path` 建临时 git repo(真 `git init` + 几个 commit),打两个端点:
- 正常 repo → schema 全字段在、类型对。
- 非 git 目录 → `{is_git_repo: false}`。
- 空仓库(0 commit)→ `recent_commits: []` 不报错。
- `?file=../etc/passwd` → 400。
- off 模式 workspace → 退化路径(diff_stat 走工作区 diff)。
- (此层依赖真 git 二进制,mac 上能跑;不依赖 claude / flock。)

### E2E(~5%)

render harness(repo 根 index.html mock fetch `GET .../git` 返回固定 schema + http.server + Claude Preview MCP)截图走查:
- 折叠态 / 展开态 / `±N` 角标。
- 四块渲染(状态行 / commits / 改动文件 / worktrees)。
- 点文件 → hunk inline 展开(mock diff 端点)。
- desktop pane + mobile 两种布局。
- 非 git 仓库的降级文案。

### 语法层(每次保存)

- `python3 -m py_compile backend/*.py`
- `node --check pwa/app.js`

---

## 10. Self-Review(CLAUDE.md §4 四问)

| 问 | 检查 |
|---|---|
| **0 沟通** | 假设显式:base = 主目录 HEAD 分支(§2)、diff 默认 net contribution 三点(§3.4)、折叠态 N 角标策略走 default(Q5)。push back 显式:现有 diff JS 函数喂不进 git diff,精确化"复用"为复用 CSS 视觉层(§5.2),已请用户确认口径。open questions 全列(§11)。 |
| **1 Unix** | 端点只读不改状态;`run_git`(唯一 IO)/ `parse_*`(纯)/ handler(组装)三层分离;parse 吃字符串吐 dict,可 pipeline。Git 区段 HTML 一个纯函数两端共用。 |
| **2 TDD** | parse 全是纯函数,固定字符串输入 → 5 分钟可写 unit、可先红后绿(§9);IO 边界 `run_git` 隔离不进 unit;integration 用真 git + tmp_path(mac 可跑)。 |
| **3 架构** | trade-off 显式:懒加载 vs 一次拉(§3.1)、三点 vs 两点 diff(§3.4)、方案 A vs B 渲染(§5.2)。反悔成本分级:schema 字段名 1 级锁死、端点拆分 2 级、阈值/N 3 级。术语:base / diff_stat / session 分支 跟现有 `worktree`/`session`/`cc/*` 命名对齐,不造同义词。 |

---

## 11. Open Questions(等用户拍板,不阻塞实施)

- **Q1(折叠态角标 `±N` 怎么来):** 折叠态不该打 git 端点(§4.3 不进轮询),但 `±N` 又想在折叠时就显。
  - **我的 default:** 折叠态**不显精确 N**,只在 Git header 显一个静态 ▸ Git(不带数字);展开拉数后才把 header 更新成 `▾ Git ±N`。**理由:** 为一个折叠角标去 fork git(或在 sessions poll 里捎 dirty bit)都是为小信息加复杂度,YAGNI。若用户坚持要折叠时就看到 N,备选:`get_workspace_sessions` 返回里给每个 session 加一个 cheap `dirty: bool`(只跑 `git status --porcelain` 不跑 diff),折叠态显 dot 不显精确 N。
- **Q2(diff_stat 是否随 uncommitted 开关切换):** 概览 diff_stat 默认显 net contribution(三点);"含未提交"开关目前定义在 `diff` 端点(单文件)维度。
  - **我的 default:** 开关只影响**单文件 diff 端点**(展开某文件时切"看 net diff / 看工作区 diff");概览 diff_stat 固定显 net contribution + 另用 `dirty: true` 一个 bit 提示"还有未提交改动,展开文件可切看"。**理由:** 概览同时维护两套 stat(net + working tree)信息密度过载,一个 dirty bit + 文件级切换够。
- **Q3(`recent_commits` 的 N=20 是否合适):** 3 级可逆,先定 20,用着嫌少改常量。
- **Q4(diff 文件数 cap 200 / 单文件 2000 行是否合适):** 3 级可逆,凭直觉定,实测调。
- **Q5(`git_view.py` 新文件 vs 塞 main.py 工具区):** 我倾向新文件(§3.6 理由:parse 纯函数不是路由,要独立 unit)。若用户更想保持"后端就这几个文件",备选:parse 纯函数放 `git_view.py`,但只 import 不拆路由 —— 这正是我的 default,列出来确认无异议。
