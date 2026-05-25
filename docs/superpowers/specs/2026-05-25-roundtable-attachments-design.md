# Roundtable File Attachments — Design

**Date:** 2026-05-25
**Status:** Approved for implementation (pending user review of this doc)
**Scope:** 让 roundtable 新建时能上传文本文件,文件内容拼进 question 喂给所有 派/synth/reviewer。仅文本类型,硬截断 100KB 总量,文件存到独立 `__roundtable__` namespace。

---

## 1. Motivation

当前 roundtable 只能基于 plain text 问题辩论。但很多决策问题需要参考具体材料 — 代码片段、设计文档、log、配置。现状用户只能把文件内容**手动复制粘贴**进 question textarea,文件越大越痛苦,且粘贴 binary / 大文件 PWA UI 体验差。

**目标:** PWA 新建 roundtable 表单加 📎 文件上传,后端把文件内容拼进 prompt,所有 派 看到 question + 参考文件。

---

## 2. Approach: 把文件内容拼进 `Session.question` 字符串

### 2.1 核心架构选择

| 选择 | 理由 |
|---|---|
| **文件内容拼进 question 字符串**(不加 schema 字段) | 现有 `run_session(question, ...)` + 各派 prompt 构造器全部基于 question 单参数,拼进去自动传播到 R1/R2/R3/synth/续问/reviewer 所有路径。零 schema 改动。 |
| **仅文本类型(.md/.txt/.py/.js/.json/.log + 任何 UTF-8 文件)** | 用 stdlib `path.read_text(encoding='utf-8')`;PDF / 图片走 vision 强烈不推荐起步(Q1=a) |
| **硬截断 100KB 总字节** | 简单 + 用户能预料(Q2=α)。超限直接 413 + hint "拆小 / 截关键段" |
| **`~/.cc-state/roundtable-uploads/<upload_id>/`** | **完全脱离 `uploads/` 子树**,跟 workspace `uploads/<ws>/` 物理隔离。原本想用 `uploads/__roundtable__/` 同根 + namespace 隔离,但 `_WS_NAME_RE` 允许下划线和 `__roundtable__` 作为合法 workspace 名,会有名字冲突,改成独立顶层目录(spec self-review 发现)|

### 2.2 数据流

```
PWA 新建 roundtable form
  + 📎 file input (新模式 — 见 §3.3 不复用 workspace _pendingUploads)
  + client-side 合计字节预校验(超 100KB 不让提交)
  ↓
[submit click]
  ↓
POST /roundtable-uploads                          ← 新 endpoint(独立 path,
                                                    避免跟 /uploads/{workspace}
                                                    在 workspace 名 = "roundtable"
                                                    时冲突)
  multipart files →
  ~/.cc-state/roundtable-uploads/<upload_id>/    ← 完全独立顶层目录
  ↓
  返回 {upload_id, paths: [...]}
  ↓
POST /roundtables 加 attachments: list[str]       ← 新字段
  ↓
backend 校验路径在 roundtable-uploads/ 子树下
  ↓
对每个 path:先 stat().st_size 累加预算(<= 100KB),通过才 read_text(避免一次性读 8MB 进 memory)
若超 → 413 with hint 指明是加上当前文件后超的
  ↓
构造 enriched question:
  原始问题:
  {user_question}

  参考文件:
  --- foo.md ({n} bytes) ---
  {foo.md content}
  --- bar.py ({n} bytes) ---
  {bar.py content}
  ↓
roundtable_runner.submit(enriched_question, ...)  ← 现有签名,无改动
  ↓
所有 派 / synth / reviewer 在 R1/R2/R3/synth 都能看到文件内容
```

### 2.3 几乎不可逆决策(§3.2 第 1 级,提前钉死)

| 决策 | 选择 | 理由 |
|---|---|---|
| 文件存储顶层目录 | `~/.cc-state/roundtable-uploads/<upload_id>/` —— **不在 `uploads/` 下** | 跟 workspace `uploads/<ws>/` 物理隔离。`_WS_NAME_RE = [A-Za-z0-9._-]{1,128}` 允许下划线 / 包含 `roundtable` 字符串作为合法 workspace 名,只用 `uploads/` 下面的子目录 namespace 隔离会有冲突,直接顶层独立目录最干净 |
| Backend endpoint | `POST /roundtable-uploads` —— **不在 `/uploads/*` 路由下** | 跟 `POST /uploads/{workspace}` 完全不同路径,FastAPI 路由不会因为 workspace 名 = "roundtable" 而误路由 |
| Total 字节上限 | 100 KB(可在 `config.toml` 加 `[roundtable] max_attachment_bytes` 重载,缺省 100KB) | 32k 上下文 model 也能塞下并留出 prompt 头空间;超出告诉用户拆 |
| 文件拼接结构 | 用 `--- {filename} ({n} bytes) ---` 分隔块 | 现有 workspace `(附件: {path})` 是给 claude CLI 用的,这里不同(LLM 直接读内容,所以要可读 markdown) |
| Session.question 是否落"原始 vs enriched" | **落 enriched** | 简单 + jsonl 自带 context,可重读;代价是 meta line 会变大,但单用户单机可接受 |

### 2.4 跟 workspace `Run` 的关键差异

| | workspace Run | roundtable |
|---|---|---|
| attachments 语义 | "给 claude 这个路径,它自己 Read" | "**把文件内容嵌进 prompt**,LLM 走 /chat/completions 没有 Read tool" |
| Prompt 拼接 | `f"{prompt}\n\n(附件: {paths})"` 只贴路径 | `f"{prompt}\n\n参考文件:\n--- {name} ---\n{content}..."` 贴内容 |
| 总字节限制 | 10MB(单请求 multipart 合计;非单文件) | **100KB**(嵌进 prompt 的总内容;现实部署用 deepseek-chat 64k / kimi-k2.6 256k 上下文都够,不考虑 moonshot-v1-32k 这种 32k 窄窗模型) |
| 文件类型 | 任何(claude 自己处理 binary / image) | **仅 UTF-8 可解码的文本** |

---

## 3. Components

### 3.1 Backend:`POST /uploads/roundtable` 新 endpoint

**File:** `backend/main.py`(在现有 `post_uploads`(`@app.post("/uploads/{workspace}")`)之后新增)

```python
@app.post("/roundtable-uploads", dependencies=PROTECT)
async def post_roundtable_uploads(files: list[UploadFile] = File(...)) -> dict:
    """接 PWA 新建 roundtable 时上传的文本文件,落到
    ~/.cc-state/roundtable-uploads/<upload_id>/。

    返回 {"upload_id": <12-hex>, "paths": [<abs path>, ...]}。前端塞
    进 POST /roundtables 的 attachments 字段,backend 读文件内容拼
    进 question 喂给所有 派。

    跟 POST /uploads/{workspace} 完全独立路径,避免在 workspace 名 =
    "roundtable" 时 FastAPI 路由 shadow 掉它的真实路径。

    单请求合计 10 MB 上限(同 nginx 默认 client_max_body_size)。比
    100KB 大,因为 multipart 上传不限内容是否能塞进 prompt — 那是
    create_roundtable 阶段才 enforce(413 with hint "总内容超 100KB
    ,拆")。
    """
    if not files:
        raise HTTPException(status_code=400, detail={"error": "no_files"})

    upload_id = uuid.uuid4().hex[:12]
    dest_dir = config.ROUNDTABLE_UPLOADS_DIR / upload_id
    # ... 跟 post_uploads 一样的 streaming + safe filename + 10MB cap

    return {"upload_id": upload_id, "paths": [...]}
```

**配置常量(`backend/config.py`):**

```python
ROUNDTABLE_UPLOADS_DIR = CCSTATE_DIR / "roundtable-uploads"
```

**实现细节:** 复用 `_safe_filename`、`_UPLOAD_MAX_BYTES`;大部分逻辑 mirror `post_uploads`,只是没有 workspace 参数 + 落到独立顶层目录。代码重复约 50 行 — CLAUDE.md §3.3 2 处重复 OK,等真有 3 个上传端再抽 helper(YAGNI)。

### 3.2 Backend:`NewRoundtableRequest` 加 attachments 字段 + create_roundtable 读取

```python
class NewRoundtableRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    role_models: Optional[dict[str, str]] = None
    critique_rounds: int = 1
    # 文件路径列表(从 POST /uploads/roundtable 拿到)。Backend 验证
    # 必须在 __roundtable__ 子树下,然后读文件内容拼进 question。
    attachments: Optional[list[str]] = Field(default=None, max_length=20)
```

`create_roundtable` 函数体加一段(在 merge role_models 之后,submit 之前):

```python
_MAX_ATTACHMENT_BYTES = 100 * 1024   # 100KB

enriched_question = req.question.strip()
if req.attachments:
    rt_uploads_root = config.ROUNDTABLE_UPLOADS_DIR.resolve()
    blocks: list[str] = []
    total_bytes = 0
    for p in req.attachments:
        try:
            path = Path(p).resolve(strict=True)
        except (OSError, RuntimeError) as e:
            raise HTTPException(400, {"error": "attachment_invalid", "msg": str(e)})
        try:
            path.relative_to(rt_uploads_root)
        except ValueError:
            raise HTTPException(400, {
                "error": "attachment_outside_uploads",
                "msg": f"attachment 必须在 {rt_uploads_root}/ 下",
            })
        if not path.is_file():
            raise HTTPException(400, {"error": "attachment_not_file", "msg": str(p)})

        # 先看 size 再决定要不要读 — 避免一次性把 8MB 文件读进 memory
        # 才发现超 100KB 预算。stat() 是 O(1) syscall。
        file_size = path.stat().st_size
        if total_bytes + file_size > _MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, {
                "error": "attachments_too_large",
                "msg": f"加上 {path.name}(约 {file_size} bytes)后超过 {_MAX_ATTACHMENT_BYTES} 字节上限",
                "hint": "拆小文件或者只贴关键段。",
            })

        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raise HTTPException(400, {
                "error": "attachment_not_utf8",
                "msg": f"{path.name} 不是 UTF-8 文本,roundtable 不支持二进制 / 图片",
            })
        # read_text 实际字节可能跟 st_size 略不等(BOM 等)— 重算
        total_bytes += len(content.encode("utf-8"))
        if total_bytes > _MAX_ATTACHMENT_BYTES:
            # 极小概率走到(BOM / 多字节 char 让 stat 低估实际),保守再 check
            raise HTTPException(413, {
                "error": "attachments_too_large",
                "msg": f"加上 {path.name} 后 UTF-8 编码总长超过 {_MAX_ATTACHMENT_BYTES} 字节",
                "hint": "拆小文件或者只贴关键段。",
            })
        blocks.append(f"--- {path.name} ({len(content)} chars) ---\n{content}")

    enriched_question = (
        f"{enriched_question}\n\n参考文件:\n\n" + "\n\n".join(blocks)
    )

# 后续 submit 用 enriched_question 替代 req.question
path = roundtable_runner.submit(enriched_question, ...)
```

### 3.3 PWA — 新建 roundtable 表单加 📎 上传

`pwa/app.js:4264` 附近的 `<dialog id="rt-new-dialog">` 表单。在 question textarea 之后加:

```html
<label class="rt-attach-row">
  <span>参考文件(可选,仅文本,合计 ≤ 100KB)</span>
  <input type="file" multiple accept="text/*"
         id="rt-attach-input">
</label>
<div id="rt-attach-list" class="muted" style="font-size:11px"></div>
```

`accept="text/*"` 比白名单具体扩展名(`.md,.txt,...`)更宽容 —— `.csv` / `.xml` / `.sh` / `.env` 等都是真实文本但容易遗漏;backend `read_text(encoding='utf-8')` 仍是 ground truth(非 UTF-8 直接 400)。

`onCreateRoundtable` 改造(`pwa/app.js:4361`):

```javascript
// 1. 收集 file input 里的文件
const attachInput = form.querySelector('#rt-attach-input');
const fileList = attachInput?.files || [];

// 2. Client-side 总字节预校验 — 避免用户选 50MB 文件后等到 backend 413
//    (100KB 是 backend hard limit;client-side 同步报错 + showError 比往返
//    一次更顺)
const totalBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);
if (totalBytes > 100 * 1024) {
    showError(`参考文件合计 ${(totalBytes/1024).toFixed(1)}KB,超过 100KB 上限。拆小或只贴关键段。`);
    btn.disabled = false; btn.textContent = '开始辩论';
    return;
}

// 3. 上传(如果有文件)
let attachments = [];
if (fileList.length > 0) {
    const formData = new FormData();
    for (const f of fileList) formData.append('files', f);
    const upResp = await fetch('/roundtable-uploads', {
        method: 'POST', body: formData, credentials: 'same-origin',
    });
    if (!upResp.ok) throw new Error(`upload 失败: ${await upResp.text()}`);
    const upData = await upResp.json();
    attachments = upData.paths;
}

// 4. body 里加 attachments
const body = { question: fd.question };
if (Object.keys(overrides).length > 0) body.role_models = overrides;
if (rounds === 2) body.critique_rounds = 2;
if (attachments.length > 0) body.attachments = attachments;
```

注意:不复用 workspace 那套 `_pendingUploads` 队列(它跟 workspace bound 太紧),用更简单的"提交瞬间收集 fileList + 一次性 POST"模式。

### 3.4 文档(`CLAUDE.md`)

在"3. 权限模式只有 4 个"之前加一小段:

```markdown
### 2.5 roundtable 文件上传 namespace

`~/.cc-state/roundtable-uploads/<upload_id>/` 是 roundtable 文件
上传的专属顶层目录,**跟 workspace `Run` 的 `~/.cc-state/uploads/<ws>/<turn>/`
完全物理隔离**(不是子目录 namespace,因为 _WS_NAME_RE 允许含
`roundtable` 字符串的 workspace 名)。每周 cron 清理脚本应当覆盖
这两条独立路径(实现细节)。
```

---

## 4. Error Handling

| 场景 | 处理 |
|---|---|
| `POST /roundtable-uploads` 上传 binary 文件 | endpoint 不校验内容(单纯落盘),100KB / UTF-8 校验在 create_roundtable 阶段做 |
| `POST /roundtable-uploads` 超 10MB | 跟现有 post_uploads 相同:413 with hint(单请求上限) |
| `POST /roundtables` 带 attachments 但路径不在 `roundtable-uploads/` 子树 | 400 "attachment_outside_uploads" |
| `POST /roundtables` 文件读出来不是 UTF-8 | 400 "attachment_not_utf8" with filename |
| `POST /roundtables` 总内容 > 100KB(stat 阶段超限) | 413 "attachments_too_large" with hint "加上 {filename} 后超过 N 字节" |
| `POST /roundtables` UTF-8 实际字节比 stat 大(BOM 等)致超限 | 同上 413(防御性 re-check after read_text) |
| 文件被并发删了 | `path.resolve(strict=True)` 或 `path.stat()` 抛 → 400 |
| `attachments=[]`(空 list) | 走"无 attachments" 路径,question 不被修改 |

---

## 5. Testing

### 5.1 Integration(`tests/test_roundtable_attachments.py` 新文件)

- `POST /roundtable-uploads` 接 1 个文件 → 返回路径 + 文件落到 `roundtable-uploads/<id>/`
- `POST /roundtable-uploads` 空 files → 400
- `POST /roundtables` with attachments 在 `roundtable-uploads/` 下 → 202 + question 被 enriched(用 mock submit 验证)
- `POST /roundtables` with attachments 路径在 `roundtable-uploads/` 外 → 400
- `POST /roundtables` with binary attachment → 400 "not_utf8"
- `POST /roundtables` 总字节超 100KB(用 stat() 触发的 fast-fail 路径) → 413
- `POST /roundtables` with attachments=[] → 走无 attachments 路径(question 不被改)

7 个 integration 测试。10MB upload cap 不单独测(直接复用 post_uploads 的同款逻辑,信赖现有测试覆盖)。

### 5.2 不测

- PWA UI(无 jsdom)— 靠 node --check + ssh 实测
- 文件大小逐字节边界 — 95KB / 99.9KB 这种边缘 case 不细测,只测明显超限场景
- 跨 workspace + roundtable 路径串污染 — `resolve(strict=True) + relative_to` 已经覆盖,不重复测

---

## 6. Migration & Rollout

- **零迁移:** 老 PWA 不发 attachments 字段 → backend Optional[None] → 现状路径
- **回滚:** 删 `POST /uploads/roundtable` endpoint + 删 NewRoundtableRequest.attachments 字段 + 删 PWA 表单的 file input。`__roundtable__/` 目录留盘上(用户可手删)
- **每周清理:** 现有 cron 清 `~/.cc-state/uploads/` 7 天以上的应当覆盖到 `__roundtable__/` 子树(等价行为,无需新脚本)

---

## 7. Non-Goals (YAGNI)

- ❌ PDF / docx / 图片支持(Q1=a 起步,以后真要再单独 spec)
- ❌ 文件 summary 预处理(Q2=α 起步,先用硬截断验产品价值再说)
- ❌ 跨 session 的"共享 attachment"(单 session 一次性上传,简单)
- ❌ PWA 端 attachment chips 拖拽重排序(YAGNI)
- ❌ 服务器端 chunk + resume 大文件上传(100KB 上限根本用不上)
- ❌ workspace `Run` 那套 `_pendingUploads` 队列复用(roundtable 是 dialog 提交一次性流程,没有"输入框 long-lived" 概念)

---

## 8. 工程方法论自检(CLAUDE.md §4)

| 原则 | 检查 |
|---|---|
| §0 沟通 | 3 个关键决策(Q1=a / Q2=α / Q3=a)已 Q&A;workspace vs roundtable 的语义差异显式拉清(§2.4) |
| §1 Unix | 文件读 / 路径校验 / question 拼接是 3 个独立单元;没有引入 BaseAttachmentHandler 之类的抽象 |
| §2 TDD | endpoint 测试都基于 TestClient + 真实临时目录,纯 IO,不依赖 LLM 调用,5 分钟可写 |
| §3.1 trade-off | §2.4 对比 workspace 路径 vs 嵌内容,§2.1 列了选哪个的理由 |
| §3.2 反悔成本 | namespace `__roundtable__` 字符串 / endpoint URL `POST /uploads/roundtable` / 100KB 上限 / 文件拼接 markdown 格式 — 几乎不可逆,spec 钉死 |
| §3.3 复杂度 | 1 新 endpoint + 1 字段 + 1 段 enrichment 逻辑 + 1 PWA 表单 input;~80 backend + ~60 PWA 行 + 8 测试 |
| §3.4 通用语言 | `attachments` 字段名跟 workspace `RunRequest.attachments` 一致 — 同名表"传给 LLM 的参考文件路径";即使语义不同(workspace 是"路径给 claude",roundtable 是"读出来嵌内容"),从外部 API 一致性看用同一术语 |
