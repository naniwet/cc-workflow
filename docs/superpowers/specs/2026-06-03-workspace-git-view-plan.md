# Workspace Git 区段 — Implementation Plan

**基于 spec:** docs/superpowers/specs/2026-06-03-workspace-git-view.md

**前置(每个 code-dev 开工前必做):** 完整读一遍 spec 全文,尤其 §3.2 schema(1 级锁死)、§3.6 三层结构、§5.2 push back(取方案 A)、§6 cwd 退化表、§7 边缘 case 降级表。

---

## 复用坐标(spec 要求"复用"的真实位置,code-dev 抄这些不另起炉灶)

- **`_git` helper 形状:** `backend/main.py:1041` —— `_git(cwd, args, timeout=60)` → `(rc, stdout.strip(), stderr.strip())`;TimeoutExpired→`(124,"",...)`;OSError→`(127,"",...)`。`git_view.run_git` 沿用这个形状。
- **base 真相源:** `backend/main.py:1095/1199/1290` —— `rev-parse --abbrev-ref HEAD` 取 `head`,`base = head or "main"`。
- **session_safe + worktree 探测:** `backend/main.py:660`(`re.sub(r"[^A-Za-z0-9._-]","_", key)`)+ `:664`(`wt_root / f"{ws}-{session_safe}"`,`wt_root = WORKSPACES_DIR/".wt"`)。
- **workspace 白名单 / 404:** `backend/ui_cards.py:194` `_discover_workspaces()`(spec §3.7)。
- **前端挂载:** `.ws-col` 渲染体 `pwa/app.js:3201`,Git 区段插在 `_sessionBarHtml(name)`(:3209)之后、`ws-timeline`(:3210)之前;mobile 走 `renderMobileWorkspaceDetail`(:3542)同 `.ws-col` 结构;pane session = `activeSessionKey(ws)`(:602)/`workspaceActiveSession`(:590)。
- **现有 diff:** `_toolUseDiffHtml`(pwa/app.js:3955)/`_diffLinesHtml`(:3949)**不复用 JS**;CSS `.diff-del`(style.css:2493)/`.diff-add`(:2500)复用,`.diff-ctx` 新增。
- **SW:** `pwa/sw.js:21` `VERSION = 'cc-v126'` → bump 到 `cc-v127`。
- **前端纯函数测试位:** `pwa/ui_contract.mjs`(ESM export)+ `tests/pwa-ui-contract.test.mjs`(`node --test`)。

---

## Task 列表

> 后端拆成 6 个纯函数 parse(Task 2-7,**互相无依赖,全可并行**),它们只依赖 Task 1 的文件骨架。schema 在 Task 8/9 拼出后定稳 → 前端(Task 12+)才动。

### Task 1: 建 `backend/git_view.py` 骨架 + `run_git` IO 边界
- **做什么:** 新建 `backend/git_view.py`。先放 `run_git(cwd, args, timeout=60)`(照 main.py:1041 形状:subprocess.run `["git","-C",str(cwd),*args]`,capture text,124/127 兜底)。其余 `parse_*` 先留空 stub(`def parse_log(text): ...` 占位,Task 2-7 各自填),确保文件能 `py_compile`。
- **测试(RED→GREEN):** `run_git` 是 IO 边界,**不写 unit**(spec §9 明说)。GREEN 标准:`python3 -m py_compile backend/git_view.py` OK。
- **依赖:** 无
- **预估:** ~3 min
- **可并行:** 否(是地基,Task 2-11 都 import 这个文件)

### Task 2: `parse_log` 纯函数
- **做什么:** `parse_log(log_text) -> [{sha, subject, rel_date, author}]`。输入是 `git log -n N --pretty=format:'%h%x00%s%x00%cr%x00%an'` 的 stdout。按行 split,每行按 `\x00` (NUL) split 成 4 段(**不用空格 split**,spec §3.3)。空输入 → `[]`。
- **测试(RED→GREEN):** `tests/test_git_view.py` 新增 `TestParseLog`。先红:`test_subject_with_spaces`(subject 含空格不裂)、`test_subject_chinese`、`test_empty_returns_list`、`test_four_fields`。喂固定 NUL 分隔字符串。
- **依赖:** Task 1
- **预估:** ~4 min
- **可并行:** 与 Task 3/4/5/6/7 并行

### Task 3: `parse_numstat` 纯函数
- **做什么:** `parse_numstat(numstat_text) -> [{file, additions, deletions, status, binary}]`。输入 `git diff --numstat` stdout(`<add>\t<del>\t<file>`)。二进制行 `-\t-\t<file>` → `additions/deletions: null` + `binary: true`(spec §3.4/§7)。文件名在第 2 个 tab 后**取整段不再 split**(含空格/中文)。空 → `[]`。**注:** `status` 字母来自单独的 `git diff --name-status`,本函数若只吃 numstat 则 status 留 None,由 handler 合并(或本函数额外吃 name-status 文本合并 —— code-dev 按 spec §3.2 schema 决定,在 commit message 写清口径)。
- **测试(RED→GREEN):** `TestParseNumstat`:`test_normal_row`、`test_binary_dash_dash`、`test_filename_with_spaces`、`test_empty`。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 与 Task 2/4/5/6/7 并行

### Task 4: `parse_ahead_behind` 纯函数
- **做什么:** `parse_ahead_behind(sb_line) -> (ahead, behind)`。输入 `git status -sb` 首行(`## cc/x...main [ahead 3, behind 1]`)。无 bracket → `(0,0)`;单边 `[ahead 2]` → `(2,0)`;`[behind 1]` → `(0,1)`(spec §9 unit 清单)。
- **测试(RED→GREEN):** `TestParseAheadBehind`:`test_both`、`test_no_bracket`、`test_ahead_only`、`test_behind_only`、`test_detached`(detached 首行 `## HEAD (no branch)` → `(0,0)`)。
- **依赖:** Task 1
- **预估:** ~4 min
- **可并行:** 与 Task 2/3/5/6/7 并行

### Task 5: `parse_status` 纯函数(dirty + detached branch 判定)
- **做什么:** `parse_status(porcelain_text) -> {dirty}`(吃 `git status --porcelain`)。有任意行(含 untracked `??`)→ `dirty: true`;空 → `false`。**branch / head_short / detached 的解析**:从 `git status -sb` 首行或 `rev-parse --abbrev-ref HEAD` 推导 —— 若 spec §3.2 的 `branch`(detached→null)逻辑也归这层纯函数,加 `parse_branch(sb_line) -> branch_or_none`(detached → None)。code-dev 决定拆几个 helper,但都要纯函数 + 有 unit。
- **测试(RED→GREEN):** `TestParseStatus`:`test_dirty_with_modification`、`test_untracked_is_dirty`、`test_clean_empty`;`TestParseBranch`(若拆):`test_normal_branch`、`test_detached_returns_none`。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 与 Task 2/3/4/6/7 并行

### Task 6: `parse_worktree_list` 纯函数
- **做什么:** `parse_worktree_list(porcelain_text) -> [{path, branch, head_short}]`。输入 `git worktree list --porcelain`(每条以 `worktree <path>` 起,`HEAD <sha>`,`branch refs/heads/<name>` 或 `detached`)。detached worktree → `branch: null`。`head_short` 取 sha 前 7 位。**`is_current` 不在纯函数里**(它要比 cwd,由 handler 在 Task 9 填)。
- **测试(RED→GREEN):** `TestParseWorktreeList`:`test_multiple`、`test_detached_branch_null`、`test_head_short_truncated`、`test_empty`。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 与 Task 2/3/4/5/7 并行

### Task 7: `parse_unified_diff` 纯函数 + 单文件 2000 行截断
- **做什么:** `parse_unified_diff(diff_text, max_lines=2000) -> {hunks:[{header, lines:[{kind:'add'/'del'/'ctx', text}]}], truncated:bool, binary:bool}`(spec §5.2 结构 + §7 截断/二进制)。`@@ ... @@` 起新 hunk;`+`→add、`-`→del、空格→ctx;`Binary files ... differ` → `binary:true, hunks:[]`;累计行超 `max_lines` → `truncated:true` 末尾标记。无改动 → `hunks:[]`。
- **测试(RED→GREEN):** `TestParseUnifiedDiff`:`test_single_hunk_three_kinds`、`test_multiple_hunks`、`test_binary`、`test_empty`、`test_truncate_over_max`(喂 >max_lines 的 diff,断言 truncated)。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 与 Task 2/3/4/5/6 并行

### Task 8: cwd 推导 + base 解析 helper(handler 组装第一半)
- **做什么:** 在 `git_view.py` 加 `resolve_git_cwd(ws, session_key, worktree_mode) -> (cwd_path, cwd_kind, warnings)`:照 spec §6 退化表 —— off / default → 主目录(`cwd_kind="main"`);auto + 非 default + worktree 存在(`session_safe = re.sub(r"[^A-Za-z0-9._-]","_", key)`,探测 `WORKSPACES_DIR/.wt/<ws>-<safe>`)→ worktree;auto + 非 default + worktree 不存在 → 退化主目录 + warning。**复用 main.py:660/664 的 session_safe + 探测逻辑**(同真相源)。再加 `resolve_base(run_git, main_dir) -> base`:`run_git(main_dir, ["rev-parse","--abbrev-ref","HEAD"])` → `head or "main"`(复用 main.py:1095 逻辑)。
- **测试(RED→GREEN):** cwd 推导是纯函数(给 worktree_mode + session_key + 一个"worktree 是否存在"的注入判定)→ `TestResolveGitCwd`:`test_off_mode_main`、`test_auto_default_main`、`test_auto_nondefault_worktree`、`test_auto_nondefault_no_worktree_degrades`(断言 warning)。把"worktree 存在性"做成可注入参数(传 `exists_fn` 或预探测 bool),不在纯函数里碰 filesystem。`resolve_base` 注入 fake `run_git` 测 `head or "main"`。
- **依赖:** Task 1
- **预估:** ~5 min
- **可并行:** 与 Task 2-7 并行(只依赖 Task 1)

### Task 9: 概览 handler `build_git_overview` + `GET /workspaces/{ws}/git` 路由
- **做什么:** `git_view.build_git_overview(run_git, ws, session_key, cwd, cwd_kind, base) -> dict`(组装层,纯逻辑 + 注入 run_git):调 run_git 取 status -sb / log / numstat(三点 `base...branch`)/ worktree list,喂 Task 2-8 的 parse,拼出**严格按 spec §3.2 的 schema**(is_git_repo / branch / head_short / base / ahead / behind / dirty / session / cwd_kind / recent_commits / diff_stat / diff_truncated / worktrees / warnings)。diff_stat 文件数 cap 200 → `diff_truncated`。worktrees 的 `is_current` 在此填(比 path == cwd)。边缘 case 全降级(非 git → `{is_git_repo:false, session}`;无 commit → `recent_commits:[]`;base 不存在 → ahead/behind/diff_stat 略过 + warning;off 退化走 `git diff HEAD --numstat`,spec §6)。然后在 `backend/main.py` 加 `@app.get("/workspaces/{ws}/git")` 路由:`_discover_workspaces` 校验 ws → 404;取 worktree_mode → `resolve_git_cwd` → `resolve_base` → `build_git_overview`,返回 dict。**路由薄,逻辑在 git_view。**
- **测试(RED→GREEN):** **integration**(`tests/test_main.py` 扩展,`tmp_path` 建真 git repo + 几个 commit,真跑 git,mac 可跑):`test_git_overview_schema`(全字段在 + 类型对)、`test_non_git_repo_returns_false`、`test_empty_repo_no_commits`(`recent_commits:[]` 不报错)、`test_off_mode_degrades`(diff_stat 走工作区 diff)。
- **依赖:** Task 1, 2, 3, 4, 5, 6, 8(概览不依赖 Task 7 的 unified diff parse)
- **预估:** ~5 min(组装薄,主要是接线)
- **可并行:** 否(汇聚点)

### Task 10: diff handler `build_git_file_diff` + `GET /workspaces/{ws}/git/diff` 路由
- **做什么:** `git_view.build_git_file_diff(run_git, cwd, base, branch, file, uncommitted) -> dict`:`uncommitted=1` → `git diff HEAD -- <file>`(工作区 vs HEAD,spec §3.4);否则三点 `git diff <base>...<branch> -- <file>`。取 stdout 喂 `parse_unified_diff`,返回 `{file, binary, hunks, truncated}`。路由 `@app.get("/workspaces/{ws}/git/diff")`:`_discover_workspaces` 校验 + **`?file` 路径校验**(不含 `..`、不以 `/` 开头 → 400,spec §3.7 纵深防御)→ resolve cwd/base → `build_git_file_diff`。
- **测试(RED→GREEN):** integration:`test_file_diff_hunks`(改一个文件 commit 后拉 diff,断言 hunks 结构)、`test_path_traversal_rejected`(`?file=../etc/passwd` → 400)、`test_uncommitted_flag`(改工作区不 commit,`uncommitted=1` 拉到改动)。
- **依赖:** Task 1, 7, 8(diff 端点要 Task 7 的 parse_unified_diff + Task 8 的 cwd/base)
- **预估:** ~5 min
- **可并行:** 与 Task 9 并行(两个端点独立,但都汇聚 Task 1-8)

### ⛳ REVIEW CHECKPOINT A(Task 9 + 10 后)
- **dispatch code-review** 审:后端拼出的 `GET .../git` JSON schema 是否**逐字段对齐 spec §3.2**(1 级几乎不可逆,反悔成本最高,spec §10 标了);三层分离是否守住(run_git 是唯一 IO、parse 全纯);边缘 case 是否全降级不报 500(spec §7 逐条)。**Block 修完再继续前端。**

---

### Task 11: 前端纯函数下沉到 `ui_contract.mjs` + `node --test`
- **做什么:** 在 `pwa/ui_contract.mjs` 新增并 export 几个**纯函数**(spec §4 信息所需,不碰 DOM):`gitBadgeText(diffStat, diffTruncated)`(算 `±N` 角标文案,truncated 时 `±200+`)、`diffStatSummary(diffStat)`(汇总 totals,可选)、`hunkLineClass(kind)`(`'add'→'diff-add'` / `'del'→'diff-del'` / `'ctx'→'diff-ctx'`)、`hunksToHtml(hunks, esc)`(吃后端结构化 hunks 吐 html,每行套 class —— 这是 spec §5.2 方案 A 的薄渲染器核心,**不复用 `_toolUseDiffHtml`**)。
- **测试(RED→GREEN):** `tests/pwa-ui-contract.test.mjs` 扩展:`gitBadgeText` 各分支、`hunkLineClass` 三 kind、`hunksToHtml`(给固定 hunks 断言含 `.diff-add`/`.diff-del`/`.diff-ctx` + esc 生效)。`node --test tests/pwa-ui-contract.test.mjs` GREEN。
- **依赖:** Task 9(schema 定稳后才知道 hunks/diff_stat 确切形状),Review Checkpoint A 通过
- **预估:** ~5 min
- **可并行:** 与 Task 12 并行(都依赖 schema,但一个管纯函数一个管 DOM 接线)

### Task 12: `_gitSectionHtml(name, sessionKey)` 渲染折叠 Git 区段(desktop + mobile 共用)
- **做什么:** `pwa/app.js` 新增 `_gitSectionHtml(name, sessionKey)`:默认折叠态一行 header `▸ Git`(展开后 `▾ Git ±N`,N 用 Task 11 的 `gitBadgeText`)+ 右侧手动 ⟳ 按钮。展开渲 4 块(spec §4.2):状态行(`branch ↑A ↓B · dirty` + `base:`)/ commits 单行列表 / 改动文件(每行 `<status字母> <file> +A -D`,点文件懒加载)/ worktrees(当前那条高亮)。挂载:在 `.ws-col` 渲染体把 `_gitSectionHtml(name, sessionKey)` 插进 `_sessionBarHtml(name)`(app.js:3209)之后、`ws-timeline`(:3210)之前;mobile 走同一 `.ws-col` 自动覆盖(spec §4.4)。**折叠态不打 git 端点**(spec §4.3 / Q5 default:折叠态 header 不带精确 N)。
- **测试(RED→GREEN):** 纯渲染 + DOM,无独立 unit(纯函数已在 Task 11)。GREEN 标准:`node --check pwa/app.js` OK + harness 截图(留到收尾走查)。
- **依赖:** Task 11
- **预估:** ~5 min(初版只渲折叠态 + 展开骨架,fetch 接线在 Task 13)
- **可并行:** 与 Task 11 并行起步,但 fetch 部分依赖它

### Task 13: 展开/刷新 fetch 接线 + 单文件 diff 懒加载
- **做什么:** `pwa/app.js` 绑定:点 `▸ Git` 展开 → `GET /workspaces/{ws}/git?session=<sessionKey>` 拉一次,渲到区段;⟳ 按钮重拉(spec §4.3:**不进 refreshAll 3s 轮询**,run 跑完不自动刷)。点改动文件行 → `GET /workspaces/{ws}/git/diff?session=&file=&uncommitted=0` 懒加载,用 Task 11 的 `hunksToHtml` inline 展开(spec §4.2/§5.2)。session = `activeSessionKey(ws)`(无 active → `default`,spec §6)。错误/降级文案:`is_git_repo:false` → "非 git 仓库"。绑定挂进 `.ws-col` 现有 handler 绑定流程(参照 app.js:1716 / bindWorkspaceColHandlers 风格,匹配现有写法)。
- **测试(RED→GREEN):** `node --check pwa/app.js`;真实交互留收尾 harness 走查。
- **依赖:** Task 12
- **预估:** ~5 min
- **可并行:** 否

### Task 14: CSS —— `.diff-ctx` + Git 区段样式
- **做什么:** `pwa/style.css` 新增 `.diff-ctx`(上下文行,跟 `.diff-add`/`.diff-del` 同形)+ Git 区段折叠/展开/4 块布局样式。**只用主设计 token**(spec 任务要点 + commit 历史警告:`--bg-surface`/`--text-secondary`/`--text-tertiary`/`--border-subtle`/`--text-micro`/`--accent-blue` 等,**不引失效 token**,刚做完 token 对齐)。
- **测试(RED→GREEN):** 无可执行测试;harness 截图走查确认视觉。
- **依赖:** Task 12(class 名定了才好写样式),可与 Task 13 并行
- **预估:** ~4 min
- **可并行:** 与 Task 13 并行

### ⛳ REVIEW CHECKPOINT B(Task 11-14 后)
- **dispatch code-review** 审:前端是否落实 spec §5.2 方案 A(复用 CSS 视觉层、**没**复用语义不符的 `_toolUseDiffHtml`);折叠态确实不打端点(§4.3);desktop + mobile 共用一个 `_gitSectionHtml`(§4.4);CSS 全用主 token 没引失效 token;纯函数确实下沉到 ui_contract.mjs。

### Task 15: SW bump + 整体 smoke + commit
- **做什么:** `pwa/sw.js` `VERSION` `cc-v126` → `cc-v127`。跑全套 smoke。git add + commit(中文 message)。
- **测试(整体 smoke):**
  - `python3 -m py_compile backend/*.py`
  - `python3 -m unittest tests.test_git_view`(全部 parse + cwd unit 绿)
  - `python3 -m unittest tests.test_main`(新增 integration 绿,真 git)
  - `node --check pwa/app.js pwa/ui_contract.mjs`
  - `node --test tests/pwa-ui-contract.test.mjs`
  - **交接主会话用 render harness 截图走查**(mock `GET .../git` 返固定 schema + mock diff 端点):折叠态 / 展开态 / `±N` 角标 / 4 块 / 点文件 hunk inline 展开 / desktop + mobile / 非 git 降级文案(spec §9 E2E 清单)。
  - **(本期不改 `agent-run.sh`)** → 不需要 ssh 服务器跑 `test_agent_run.sh`。
- **依赖:** Task 13, 14,Review Checkpoint B 通过
- **预估:** ~5 min
- **可并行:** 否(收尾)

---

## 依赖图

```
Task 1 (骨架+run_git)
  ├─→ Task 2 (parse_log)        ┐
  ├─→ Task 3 (parse_numstat)    │
  ├─→ Task 4 (parse_ahead_behind)│ 全可并行(纯函数)
  ├─→ Task 5 (parse_status)     │
  ├─→ Task 6 (parse_worktree)   │
  ├─→ Task 7 (parse_unified_diff)┘
  └─→ Task 8 (cwd/base 推导)     ┘
        │
        ├─→ Task 9  (概览 handler + /git 路由)   [需 2,3,4,5,6,8]
        └─→ Task 10 (diff handler + /git/diff)   [需 7,8]   ← 9/10 可并行
              │
        ⛳ REVIEW CHECKPOINT A (审 schema 对齐 spec §3.2)
              │
        ├─→ Task 11 (ui_contract.mjs 纯函数 + node --test)
        └─→ Task 12 (_gitSectionHtml 渲染)   ← 11/12 可并行起步
              │
        ├─→ Task 13 (fetch 接线 + diff 懒加载)  [需 12]
        └─→ Task 14 (CSS .diff-ctx + 区段)      [需 12]  ← 13/14 可并行
              │
        ⛳ REVIEW CHECKPOINT B (审方案 A / token / 共用渲染)
              │
        Task 15 (SW bump + smoke + commit)
```

## 并行总结(单用户单机,并行收益有限,标了供参考)

- **后端纯函数 Task 2-8** —— 7 个全互不依赖,只共享 Task 1 的文件骨架(注意都改同一个 `git_view.py`,真并行 dispatch 会有 edit 冲突 → 建议顺序做或拆文件区段;逻辑上无依赖)。
- **Task 9 / 10** —— 两个端点逻辑独立,可并行。
- **Task 11 / 12** —— 纯函数 vs DOM 骨架,可并行起步。
- **Task 13 / 14** —— fetch 接线 vs CSS,可并行。
