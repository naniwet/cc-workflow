# Roundtable File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 roundtable 新建表单能上传 UTF-8 文本文件(合计 ≤100KB),文件内容拼进 `Session.question` 喂给所有 派/synth/reviewer。

**Architecture:** 加 `POST /roundtable-uploads` 独立 endpoint(避免跟 `/uploads/{workspace}` 路由冲突)+ 独立顶层目录 `~/.cc-state/roundtable-uploads/<upload_id>/` + `NewRoundtableRequest.attachments` 字段 + `create_roundtable` 里读文件、stat 累加预算、拼进 question。

**Tech Stack:** Python 3.13 + FastAPI + Pydantic v2 + `unittest.TestCase` + 原生 JS。

**Spec:** [`docs/superpowers/specs/2026-05-25-roundtable-attachments-design.md`](../specs/2026-05-25-roundtable-attachments-design.md)

---

## File Structure

**Modified:**
- `backend/config.py` — 加 `ROUNDTABLE_UPLOADS_DIR = STATE_DIR / "roundtable-uploads"` 常量
- `backend/main.py` — 加 `POST /roundtable-uploads` endpoint;`NewRoundtableRequest.attachments` 字段;`create_roundtable` 里 enrich question
- `pwa/app.js` — 新建 roundtable form 加 file input + client-side 大小预校验 + 提交时 POST `/roundtable-uploads` + 把 paths 塞进 `/roundtables` body
- `CLAUDE.md` — §2 加 "2.5 roundtable 文件上传 namespace" 小节

**Created:**
- `tests/test_roundtable_attachments.py` — 7 integration test

---

## Task 1: 加 `ROUNDTABLE_UPLOADS_DIR` 常量 + `POST /roundtable-uploads` endpoint

**Files:**
- Modify: `backend/config.py`(line ~37,UPLOADS_DIR 之后加)
- Modify: `backend/main.py`(在 `post_uploads` 之后加新 endpoint)
- Create: `tests/test_roundtable_attachments.py`(2 个 upload-endpoint 测试)

- [ ] **Step 1: 加 config 常量**

`backend/config.py:37` 之后 append:

```python
# Roundtable 文件上传专属顶层目录。**不**在 UPLOADS_DIR 下,因为
# _WS_NAME_RE 允许下划线 / 包含 "roundtable" 的字符串作为 workspace 名,
# 共用 uploads/ 子目录会名字冲突。spec §2.3。
# 每周 cron 清 7 天以上(实现:加进 cc-loops cron 的 find 命令覆盖路径)。
ROUNDTABLE_UPLOADS_DIR = STATE_DIR / "roundtable-uploads"
```

- [ ] **Step 2: 写 2 个失败 upload-endpoint 测试**

新建 `tests/test_roundtable_attachments.py`:

```python
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from backend import main, auth, config


class RoundtableUploadEndpointTests(unittest.TestCase):
    """POST /roundtable-uploads — 接 multipart 文件,落到独立顶层目录。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.uploads_dir = self.tmp_path / "roundtable-uploads"
        self.patches = [
            patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.uploads_dir),
        ]
        for p in self.patches:
            p.start()
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_upload_writes_file_to_dest_dir(self):
        r = self.client.post(
            "/roundtable-uploads",
            files=[("files", ("hello.md", b"# hi\n", "text/markdown"))],
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("upload_id", body)
        self.assertEqual(len(body["paths"]), 1)
        # 文件真的落盘了
        path = Path(body["paths"][0])
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_text(encoding="utf-8"), "# hi\n")
        # 路径在 ROUNDTABLE_UPLOADS_DIR 下
        path.relative_to(self.uploads_dir)   # 抛 ValueError 测试失败

    def test_upload_empty_files_400(self):
        r = self.client.post("/roundtable-uploads", files=[])
        # FastAPI 422 (validation) 或 400 都接受 — 关键是不是 200
        self.assertNotEqual(r.status_code, 200)
        self.assertGreaterEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
```

注意:FastAPI 对 multipart `files: list[UploadFile] = File(...)` 的空列表行为是 422,不是 400。测试用 `assertNotEqual` 宽容这点。

- [ ] **Step 3: 跑测试,确认失败**(endpoint 不存在 → 404 / 405)

```bash
python3 -m unittest discover -s tests -p 'test_roundtable_attachments.py' -v 2>&1 | tail -10
```

- [ ] **Step 4: 实现 endpoint**

`backend/main.py` 找到 `post_uploads` 函数(`@app.post("/uploads/{workspace}")` 附近),在它之后 append:

```python
@app.post("/roundtable-uploads", dependencies=PROTECT)
async def post_roundtable_uploads(files: list[UploadFile] = File(...)) -> dict:
    """接 PWA 新建 roundtable 时上传的文本文件,落到
    ~/.cc-state/roundtable-uploads/<upload_id>/。

    返回 {"upload_id": <12-hex>, "paths": [<abs path>, ...]}。前端塞
    进 POST /roundtables 的 attachments 字段,backend 读文件内容拼
    进 question 喂给所有 派。

    跟 POST /uploads/{workspace} 完全独立路径,避免在 workspace 名 =
    "roundtable" 时 FastAPI 路由 shadow 掉它的真实路径(spec §2.3)。

    单请求合计 10 MB 上限。比 100KB 大,因为 multipart 上传不限内容是否
    能塞进 prompt — 那是 create_roundtable 阶段才 enforce(spec §2.4)。
    """
    if not files:
        raise HTTPException(status_code=400, detail={"error": "no_files"})

    upload_id = uuid.uuid4().hex[:12]
    dest_dir = config.ROUNDTABLE_UPLOADS_DIR / upload_id
    try:
        dest_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    except OSError as e:
        raise HTTPException(status_code=500, detail={"error": "mkdir_failed", "msg": str(e)})

    paths: list[str] = []
    total = 0
    seen_names: dict[str, int] = {}
    try:
        for upload in files:
            safe = _safe_filename(upload.filename or "file")
            count = seen_names.get(safe, 0) + 1
            seen_names[safe] = count
            if count > 1:
                stem = Path(safe).stem
                ext = Path(safe).suffix
                safe = f"{stem}-{count}{ext}"
            target = dest_dir / safe

            with open(target, "wb") as fh:
                while chunk := await upload.read(64 * 1024):
                    total += len(chunk)
                    if total > _UPLOAD_MAX_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail={
                                "error": "too_large",
                                "msg": f"上传文件合计超过 {_UPLOAD_MAX_BYTES // (1024*1024)} MB",
                                "hint": "拆几次小批量上传。",
                            },
                        )
                    fh.write(chunk)
            os.chmod(target, 0o600)
            paths.append(str(target))
    except HTTPException:
        # 半成品清掉避免占地方
        import shutil
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise
    except Exception as e:  # noqa: BLE001
        import shutil
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail={"error": "upload_failed", "msg": str(e)})

    return {"upload_id": upload_id, "paths": paths}
```

注意:基本是 mirror 了 `post_uploads` 的 streaming + cap + safe-name + cleanup-on-error 逻辑;没有 workspace 参数 + 用 `ROUNDTABLE_UPLOADS_DIR` 而非 `UPLOADS_DIR / workspace`。

- [ ] **Step 5: 跑测试 — 2/2 pass + 无回归**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable_attachments.py' -v 2>&1 | tail -10
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add backend/config.py backend/main.py tests/test_roundtable_attachments.py
git commit -m "$(cat <<'EOF'
feat(main): 加 POST /roundtable-uploads + 独立顶层目录

跟 /uploads/{workspace} 完全独立 path,避免 ws 名 = "roundtable"
时 FastAPI 路由 shadow。文件落到 ~/.cc-state/roundtable-uploads/<id>/
顶层目录(不在 uploads/ 下,因为 _WS_NAME_RE 允许下划线/roundtable
字符串作为合法 ws 名,namespace 隔离不靠)。

单请求 10MB 上限。100KB enriched-prompt 上限在 create_roundtable 阶段
enforce(下一个 task)。2 个 endpoint 测试覆盖落盘 + 空列表拒绝。

spec §2.3 + §3.1。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `NewRoundtableRequest.attachments` + `create_roundtable` enrich question

**Files:**
- Modify: `backend/main.py`(`NewRoundtableRequest` + `create_roundtable`)
- Modify: `tests/test_roundtable_attachments.py`(append 5 enrichment 测试)

- [ ] **Step 1: 写 5 个失败测试**

Append 到 `tests/test_roundtable_attachments.py`(新 class):

```python
class CreateRoundtableAttachmentsTests(unittest.TestCase):
    """POST /roundtables with attachments — backend 读文件,拼进
    Session.question 喂给所有 派。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.uploads_dir = self.tmp_path / "roundtable-uploads"
        self.uploads_dir.mkdir()
        self.patches = [
            patch.object(config, "ROUNDTABLE_UPLOADS_DIR", self.uploads_dir),
        ]
        for p in self.patches:
            p.start()
        main.app.dependency_overrides[auth.require_user] = lambda: "test-user"
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def _create_attachment(self, name: str, content: bytes) -> str:
        sub = self.uploads_dir / "abc123"
        sub.mkdir(exist_ok=True)
        path = sub / name
        path.write_bytes(content)
        return str(path)

    def _capture_submit(self, body):
        """跑 POST /roundtables,返回 mock 收到的 kwargs。"""
        captured = {}
        def _fake_submit(*args, **kwargs):
            # args[0] 是 question
            captured["question_arg"] = args[0] if args else None
            captured.update(kwargs)
            return Path("/tmp/fake-session.jsonl")
        with patch("backend.main.roundtable_runner.submit", side_effect=_fake_submit):
            r = self.client.post("/roundtables", json=body)
        return r, captured

    def test_attachments_enriches_question(self):
        path = self._create_attachment("hello.md", b"# hi\n\ncontent here")
        r, captured = self._capture_submit(
            {"question": "看一下这个文件", "attachments": [path]},
        )
        self.assertEqual(r.status_code, 202, r.text)
        q = captured["question_arg"]
        # enriched question 含原始 + 文件内容
        self.assertIn("看一下这个文件", q)
        self.assertIn("参考文件:", q)
        self.assertIn("hello.md", q)
        self.assertIn("content here", q)

    def test_attachments_path_outside_uploads_rejected(self):
        # 路径不在 ROUNDTABLE_UPLOADS_DIR 下 → 400
        evil = self.tmp_path / "evil.txt"
        evil.write_text("oops", encoding="utf-8")
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [str(evil)]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("outside", r.text)

    def test_attachments_binary_rejected(self):
        path = self._create_attachment("evil.bin", b"\xff\xfe\x00\x01")
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [path]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("utf8", r.text.lower())

    def test_attachments_total_over_100kb_413(self):
        # 第一个 50KB,第二个 60KB → 总 110KB > 100KB
        p1 = self._create_attachment("a.txt", b"a" * (50 * 1024))
        p2 = self._create_attachment("b.txt", b"b" * (60 * 1024))
        r, _ = self._capture_submit(
            {"question": "Q?", "attachments": [p1, p2]},
        )
        self.assertEqual(r.status_code, 413, r.text)
        # hint 指明是加上 b.txt 超的(stat 阶段 fail)
        body = r.json()
        self.assertIn("b.txt", str(body))

    def test_empty_attachments_list_no_enrichment(self):
        r, captured = self._capture_submit(
            {"question": "Q?", "attachments": []},
        )
        self.assertEqual(r.status_code, 202)
        # question 没被改
        self.assertEqual(captured["question_arg"], "Q?")
        # 也没"参考文件:" 段
        self.assertNotIn("参考文件", captured["question_arg"])
```

- [ ] **Step 2: 跑测试,确认 5 个失败**

```bash
python3 -m unittest tests.test_roundtable_attachments.CreateRoundtableAttachmentsTests -v 2>&1 | tail -15
```

Expected: 422 errors(`attachments` 字段不在 schema)或 行为不对的 assertion 失败。

- [ ] **Step 3: 加 `attachments` 字段 + enrich 逻辑**

`backend/main.py:1546` 附近 `NewRoundtableRequest`,在现有字段下加:

```python
class NewRoundtableRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    role_models: Optional[dict[str, str]] = None
    critique_rounds: int = 1
    # 文件路径列表(从 POST /roundtable-uploads 拿到)。Backend 校验
    # 必须在 ROUNDTABLE_UPLOADS_DIR 子树下,读 UTF-8 内容,合计 ≤ 100KB,
    # 拼进 question 喂给所有 派。spec §3.2。
    attachments: Optional[list[str]] = Field(default=None, max_length=20)
```

`backend/main.py` 加一个常量(就近 NewRoundtableRequest 上方):

```python
_ROUNDTABLE_ATTACHMENT_MAX_BYTES = 100 * 1024   # 100 KB,spec §2.3
```

修改 `create_roundtable`,在合并 role_models 之后、调 `roundtable_runner.submit` 之前,加 enrichment 逻辑:

```python
@app.post("/roundtables", dependencies=PROTECT, status_code=202)
def create_roundtable(req: NewRoundtableRequest) -> dict:
    """Kick off a new roundtable session. role_models 解析三层:
    per-session > persistent > hardcode。attachments(文件路径)被
    读 UTF-8 + 校验 ≤ 100KB + 拼进 question(spec §3.2)。
    """
    persistent = role_models_store.load()
    merged = {**persistent, **(req.role_models or {})}

    if req.role_models:
        valid_roles = _all_role_names()
        for role_name, model_name in req.role_models.items():
            if role_name not in valid_roles:
                raise HTTPException(400, {"error": f"unknown role: {role_name!r}"})
            if model_name not in roundtable_model.MODEL_ENDPOINTS:
                raise HTTPException(400, {
                    "error": f"unknown model: {model_name!r}",
                    "known": sorted(roundtable_model.MODEL_ENDPOINTS),
                })

    # === enrich question 拼文件内容(spec §3.2) ===
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

            # 先 stat 累加预算 — 避免一次性读 8MB 文件入 memory 才发现超(spec §3.2 fix #4)
            file_size = path.stat().st_size
            if total_bytes + file_size > _ROUNDTABLE_ATTACHMENT_MAX_BYTES:
                raise HTTPException(413, {
                    "error": "attachments_too_large",
                    "msg": f"加上 {path.name}(约 {file_size} bytes)后超过 {_ROUNDTABLE_ATTACHMENT_MAX_BYTES} 字节上限",
                    "hint": "拆小文件或者只贴关键段。",
                })

            try:
                content = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                raise HTTPException(400, {
                    "error": "attachment_not_utf8",
                    "msg": f"{path.name} 不是 UTF-8 文本,roundtable 不支持二进制 / 图片",
                })
            # 防御性 re-check:UTF-8 编码后字节数可能跟 st_size 略不等(BOM 等)
            total_bytes += len(content.encode("utf-8"))
            if total_bytes > _ROUNDTABLE_ATTACHMENT_MAX_BYTES:
                raise HTTPException(413, {
                    "error": "attachments_too_large",
                    "msg": f"加上 {path.name} 后 UTF-8 编码总长超过 {_ROUNDTABLE_ATTACHMENT_MAX_BYTES} 字节",
                    "hint": "拆小文件或者只贴关键段。",
                })
            blocks.append(f"--- {path.name} ({len(content)} chars) ---\n{content}")

        enriched_question = (
            f"{enriched_question}\n\n参考文件:\n\n" + "\n\n".join(blocks)
        )

    path = roundtable_runner.submit(
        enriched_question,
        role_models=merged,
        critique_rounds=req.critique_rounds,
    )
    return {"id": path.stem, "status": "queued", "question": req.question}
```

注意:`return` 的 `question` 字段保留 user 输入的原始 question 字符串(不带文件块),这样 PWA toast / list 显示用 user 输入的精简版本;真正喂给 LLM 的是 enriched 版本(已经传给 submit)。

- [ ] **Step 4: 跑测试 — 7/7 全过 + 无回归**

```bash
python3 -m unittest discover -s tests -p 'test_roundtable_attachments.py' -v 2>&1 | tail -15
python3 -m unittest discover -s tests 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_roundtable_attachments.py
git commit -m "$(cat <<'EOF'
feat(main): create_roundtable 接 attachments + enrich question 拼文件内容

NewRoundtableRequest 加 attachments: list[str](路径在 ROUNDTABLE_
UPLOADS_DIR/ 子树下)。create_roundtable 对每个 path 先 stat 累加
预算(避免一次性读 8MB 入 memory),通过才 read_text(encoding=utf-8),
然后拼进 enriched_question 喂给 submit。

100KB 总上限 enforce 在两处:stat 阶段 fast-fail(常见情况);UTF-8
编码后 re-check(防御性,处理 BOM 等)。binary file → 400 not_utf8。

5 个 endpoint 测试:enrich / 路径越界 / binary 拒 / 总超限 413 /
空 list 不动 question。

spec §3.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: PWA — 新建 roundtable 表单加 file input + client-side 预校验 + 提交流程

**Files:**
- Modify: `pwa/app.js`(`<dialog id="rt-new-dialog">` form + `onCreateRoundtable` handler)

PWA 无自动化测试 — `node --check` + ssh 实测。

- [ ] **Step 1: 表单加 file input**

`pwa/app.js:4264` 附近 `<dialog id="rt-new-dialog">` 内,找到 question textarea(`<textarea name="question" ...>`),在它**之后**、`<div class="rt-rounds-row">` **之前**加:

```html
<label class="rt-attach-row">
  <span>参考文件(可选,仅文本,合计 ≤ 100KB)</span>
  <input type="file" multiple accept="text/*"
         id="rt-attach-input">
</label>
```

`accept="text/*"` 比白名单 `.md,.txt,...` 更宽容(`.csv` `.xml` `.sh` 等都被涵盖);backend 仍校验 UTF-8 是 ground truth。

- [ ] **Step 2: 改 onCreateRoundtable 加 client-side 预校验 + POST /roundtable-uploads + body 加 attachments**

`pwa/app.js:4361` `onCreateRoundtable` 函数,改造主流程。当前函数大致结构:

```javascript
async function onCreateRoundtable(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form).entries());
  const overrides = _loadRtRoleModels();
  const rounds = parseInt(fd.critique_rounds || '1', 10);
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '开始中…';
  try {
    const body = { question: fd.question };
    if (Object.keys(overrides).length > 0) body.role_models = overrides;
    if (rounds === 2) body.critique_rounds = 2;
    const r = await api('/roundtables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // ...
  } catch (err) {
    showError(`创建失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '开始辩论';
  }
}
```

改成(把 `const body = ...` 之前加 attachments 收集 + 上传):

```javascript
async function onCreateRoundtable(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form).entries());
  const overrides = _loadRtRoleModels();
  const rounds = parseInt(fd.critique_rounds || '1', 10);
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '开始中…';
  try {
    // === Client-side attachments handling(spec §3.3) ===
    const attachInput = form.querySelector('#rt-attach-input');
    const fileList = attachInput?.files || [];
    // 总字节预校验 — 100KB hard limit,跟 backend 一致。避免上传 50MB
    // 才到 413(spec suggestion #6)。
    const totalBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > 100 * 1024) {
      showError(`参考文件合计 ${(totalBytes/1024).toFixed(1)}KB,超过 100KB 上限。拆小或只贴关键段。`);
      return;     // finally 段重置 button
    }

    let attachments = [];
    if (fileList.length > 0) {
      const formData = new FormData();
      for (const f of fileList) formData.append('files', f);
      const upResp = await fetch('/roundtable-uploads', {
        method: 'POST', body: formData, credentials: 'same-origin',
      });
      if (!upResp.ok) {
        throw new Error(`upload 失败 (HTTP ${upResp.status}): ${await upResp.text()}`);
      }
      const upData = await upResp.json();
      attachments = upData.paths || [];
    }
    // === End attachments ===

    const body = { question: fd.question };
    if (Object.keys(overrides).length > 0) body.role_models = overrides;
    if (rounds === 2) body.critique_rounds = 2;
    if (attachments.length > 0) body.attachments = attachments;

    const r = await api('/roundtables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    form.closest('dialog')?.close();
    showToast('success', `圆桌已开:${r.id}`, { ttl: 2000 });
    location.hash = `#roundtables/${encodeURIComponent(r.id)}`;
  } catch (err) {
    showError(`创建失败: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '开始辩论';
  }
}
```

- [ ] **Step 3: 语法 check**

```bash
node --check pwa/app.js && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add pwa/app.js
git commit -m "$(cat <<'EOF'
feat(pwa): 新建 roundtable 表单加 📎 文件上传

question textarea 下加 multiple file input(accept="text/*")。提交
时:client-side 校验合计 ≤ 100KB → POST /roundtable-uploads 拿
绝对路径 → 塞进 /roundtables body 的 attachments 字段。

backend 读 UTF-8 内容拼进 question,所有 派 都能看到文件参考。

spec §3.3。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 更新 `CLAUDE.md` § "状态分散在两个目录"

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 找到 state 路径表**

```bash
grep -n "uploads/<ws>/<turn>\|状态分散\|~/.cc-state/" CLAUDE.md | head
```

应该能找到 §2"状态分散在两个目录"的表(`~/.cc-workflow/` vs `~/.cc-state/`)。

- [ ] **Step 2: 加 roundtable-uploads 一条**

在那张表的 `uploads/<ws>/<turn>/*` 行旁边或下面加一条解释:

```
`~/.cc-state/roundtable-uploads/<upload_id>/*`(新)— roundtable 文件
上传专属顶层目录,跟 `uploads/<ws>/<turn>/` 物理隔离(因为 _WS_NAME_RE
允许下划线 / "roundtable" 字符串作为合法 workspace 名,共用 uploads/
子目录会冲突)。每周 cron 也覆盖到这条路径。
```

(具体格式按现有表 / 注释风格调整,见 `CLAUDE.md` § 状态分散在两个目录 那段)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude): 加 roundtable-uploads 路径说明

`~/.cc-state/roundtable-uploads/<id>/` 是新加的 roundtable 文件上传
专属顶层目录(跟 uploads/<ws>/ 物理隔离 — _WS_NAME_RE 允许下划线 /
roundtable 字符串作合法 ws 名,namespace 隔离不靠)。每周 cron 也
覆盖。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 整体 smoke + final review

- [ ] **Step 1: Full test battery**

```bash
python3 -m py_compile backend/*.py backend/roundtable/*.py && echo "py_compile OK"
python3 -m unittest discover -s tests 2>&1 | tail -5
node --check pwa/app.js && echo "pwa OK"
node --test tests/pwa-ui-contract.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)" | head
```

Expected:
- py_compile OK
- 60+ tests pass (~56 prior + 7 new)
- node check OK
- 18 PWA contract tests pass

- [ ] **Step 2: 服务器端实测说明(用户做)**

ssh 上服务器:
1. `git pull && systemctl restart cc-workflow`
2. 浏览器打开 PWA,点"+ 新开一场"
3. 输入问题 + 选 1 个小文本文件(<100KB)
4. 看 ssh `~/.cc-state/roundtable-uploads/` 下出现 upload_id 子目录 + 文件
5. roundtable 跑完,看 session.jsonl 的 meta line 的 question 字段含 "参考文件:" 段 + 文件内容
6. 4 派的 R1 答案应该 reference 文件中的具体内容(quality 验证 — 看 LLM 真的"看见"了文件)

边界场景手测:
- 上传一个 200KB 文件 → PWA 应该 client-side 弹错(不让 POST)
- 上传一个 .png 图片 → backend 应该 400 not_utf8
- 上传 2 个 60KB 文件 → 413 attachments_too_large

---

## Self-Review

**Spec coverage check:**

| Spec 章节 | Plan task |
|---|---|
| §2.3 namespace `~/.cc-state/roundtable-uploads/` | Task 1 + 4 |
| §3.1 POST /roundtable-uploads endpoint | Task 1 |
| §3.2 NewRoundtableRequest.attachments + create_roundtable enrich + stat-then-read 流程 | Task 2 |
| §3.3 PWA form file input + client-side 校验 + POST 流程 | Task 3 |
| §3.4 CLAUDE.md namespace 文档段 | Task 4 |
| §4 错误处理(各 400 / 413 / 502 路径)| Task 2 测试覆盖 |
| §5.1 7 integration 测试 | Task 1(2)+ Task 2(5)|

✓ 全覆盖。

**Placeholder scan:** 无 TBD/TODO/"add appropriate error handling" 之类。每段都有完整可粘贴代码。

**Type consistency:**

- `attachments: Optional[list[str]]` — Task 2 schema + Task 3 PWA `body.attachments` 都用 list of strings ✓
- `ROUNDTABLE_UPLOADS_DIR` — Task 1 加 config.py,Task 2 在 create_roundtable 用,Task 4 文档引用 ✓
- `_ROUNDTABLE_ATTACHMENT_MAX_BYTES = 100 * 1024` — Task 2 backend 用;Task 3 PWA `100 * 1024` 同样 magic number(可接受 — 这是 KISS / DRY trade-off:在 PWA 跟 backend 同步硬编码,YAGNI 抽 config)✓
- endpoint URL `/roundtable-uploads` — Task 1 backend + Task 3 PWA fetch + Task 2 测试 setUp 路径一致 ✓
