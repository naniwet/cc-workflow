"""Workspace Git 区段后端 —— 只读 git 视图。

三层结构(spec §3.6,TDD 硬约束):
  - run_git(cwd, args)         唯一 IO 边界(沿用 main.py:1041 _git helper 形状),不写 unit
  - parse_*(text) -> dict/list 纯函数,吃 git stdout 字符串吐结构,纯内存可 unit
  - build_*(run_git, ...)      handler 组装层,注入 run_git,拼 spec §3.2 schema

路由仍留 backend/main.py(CLAUDE.md 不拆路由),这里只放 parse + 组装逻辑。
本期只读,不做任何写操作(merge / discard / commit / 文件编辑)。
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Optional


# ---------- IO 边界(唯一摸 subprocess 的地方,不写 unit)----------

def run_git(cwd, args, timeout=60):
    """跑 git -C <cwd> <args...>,返回 (rc, stdout, stderr)。

    形状照 backend/main.py:1041 的 _git helper:capture text、strip、
    TimeoutExpired → (124,"",msg)、OSError → (127,"",msg)。
    """
    try:
        p = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"git {args[0]} timed out ({timeout}s)"
    except OSError as e:
        return 127, "", f"git not runnable: {e}"


# ---------- 纯函数 parse(吃 git stdout 吐结构,不碰 IO)----------

def parse_log(log_text):
    """git log -n N --pretty=format:'%h%x00%s%x00%cr%x00%an' → 提交列表。

    按行 split,每行按 NUL(\\x00)拆 4 段 —— subject 含空格/中文不裂。
    空输入 → []。
    """
    out = []
    for line in log_text.splitlines():
        if not line:
            continue
        parts = line.split("\x00")
        if len(parts) < 4:
            continue
        out.append({
            "sha": parts[0],
            "subject": parts[1],
            "rel_date": parts[2],
            "author": parts[3],
        })
    return out


def parse_numstat(numstat_text):
    """git diff --numstat → [{file, additions, deletions, binary}]。

    每行 `<add>\\t<del>\\t<file>`。二进制行 `-\\t-\\t<file>` →
    additions/deletions=None + binary=True(spec §3.4/§7)。
    文件名在第 2 个 tab 后取整段(含空格/中文不再 split)。
    status 字母不在此(来自 git diff --name-status,handler 合并)。
    """
    out = []
    for line in numstat_text.splitlines():
        if not line:
            continue
        # 只 split 前两个 tab,文件名整段保留
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        add_s, del_s, fname = parts
        if add_s == "-" and del_s == "-":
            out.append({"file": fname, "additions": None, "deletions": None, "binary": True})
        else:
            out.append({
                "file": fname,
                "additions": int(add_s) if add_s.isdigit() else None,
                "deletions": int(del_s) if del_s.isdigit() else None,
                "binary": False,
            })
    return out


def parse_rev_list_count(text):
    """git rev-list --left-right --count <base>...<branch> 输出 → (ahead, behind)。

    输出格式 `<behind>\\t<ahead>`(left=base 独有=落后数,right=branch 独有
    =领先数)。这是 spec §3.2 要的 branch-vs-base 关系 —— status -sb 给的是
    相对 upstream,本地 cc/* 分支无 upstream,故必须用 rev-list 算。
    空/异常输出 → (0,0) 兜底。
    """
    parts = text.strip().split("\t")
    if len(parts) != 2 or not (parts[0].isdigit() and parts[1].isdigit()):
        return (0, 0)
    behind, ahead = int(parts[0]), int(parts[1])
    return (ahead, behind)


def parse_status(porcelain_text):
    """git status --porcelain → {dirty}。

    任意行(含 ?? untracked)→ dirty=True;空 → False。
    """
    return {"dirty": bool(porcelain_text.strip())}


def parse_branch(sb_line):
    """git status -sb 首行 → 分支名;detached / 空仓库 → None。

    `## cc/x...main [ahead 1]` → "cc/x";`## main` → "main";
    `## HEAD (no branch)` → None;
    `## No commits yet on main`(空仓库 0 commit)→ None(spec §7)。
    """
    if not sb_line.startswith("## "):
        return None
    rest = sb_line[3:].strip()
    if rest.startswith("HEAD ") or rest == "HEAD" or "(no branch)" in rest:
        return None
    # 空仓库:git status -sb 首行 = "## No commits yet on <X>" —— 不是分支名
    if rest.startswith("No commits yet"):
        return None
    # 分支名在 `...` 之前(有 upstream 时);没有 `...` 就整段
    name = rest.split("...", 1)[0]
    # 去掉可能尾随的 ` [ahead ...]`(无 upstream 但有别的标记的兜底)
    name = name.split(" ", 1)[0]
    return name or None


def parse_worktree_list(porcelain_text):
    """git worktree list --porcelain → [{path, branch, head_short}]。

    每条以 `worktree <path>` 起,`HEAD <sha>`,`branch refs/heads/<name>`
    或 `detached`。detached → branch=None。head_short 取 sha 前 7 位。
    is_current 不在此(handler 比 cwd 后填,Task 9)。
    """
    out = []
    cur = None
    for line in porcelain_text.splitlines():
        if line.startswith("worktree "):
            if cur is not None:
                out.append(cur)
            cur = {"path": line[len("worktree "):], "branch": None, "head_short": ""}
        elif cur is None:
            continue
        elif line.startswith("HEAD "):
            cur["head_short"] = line[len("HEAD "):][:7]
        elif line.startswith("branch "):
            ref = line[len("branch "):]
            cur["branch"] = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        elif line.strip() == "detached":
            cur["branch"] = None
    if cur is not None:
        out.append(cur)
    return out


def parse_unified_diff(diff_text, max_lines=2000):
    """unified diff → {hunks, truncated, binary}(spec §5.2 + §7)。

    `@@ ... @@` 起新 hunk;`+`→add、`-`→del、空格→ctx。
    `Binary files ... differ` → binary=True, hunks=[]。
    累计行超 max_lines → truncated=True 并停止收集。无改动 → hunks=[]。

    hunks: [{header, lines:[{kind:'add'|'del'|'ctx', text}]}]
    """
    if "Binary files" in diff_text and "differ" in diff_text:
        return {"hunks": [], "truncated": False, "binary": True}

    hunks = []
    cur = None
    total = 0
    truncated = False
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            cur = {"header": line, "lines": []}
            hunks.append(cur)
            continue
        if cur is None:
            # diff header(diff --git / index / --- / +++)在第一个 @@ 之前,跳过
            continue
        if line.startswith("+"):
            kind = "add"
        elif line.startswith("-"):
            kind = "del"
        elif line.startswith(" "):
            kind = "ctx"
        else:
            # `\ No newline at end of file` 等元信息,忽略
            continue
        if total >= max_lines:
            truncated = True
            break
        cur["lines"].append({"kind": kind, "text": line[1:]})
        total += 1

    return {"hunks": hunks, "truncated": truncated, "binary": False}


# ---------- cwd / base 推导(纯逻辑,worktree 存在性注入,不碰 filesystem)----------

def _session_safe(key):
    """跟 agent-run.sh SESSION_SAFE + main.py:660 一致:非 [A-Za-z0-9._-] 替 _。"""
    return re.sub(r"[^A-Za-z0-9._-]", "_", key)


def resolve_git_cwd(ws, session_key, worktree_mode, worktree_exists, workspaces_dir):
    """spec §6 退化表 → (cwd_path, cwd_kind, warnings)。

    - off / session_key=="default" → 主目录(cwd_kind="main")
    - auto + 非 default + worktree 存在 → worktree(cwd_kind="worktree")
    - auto + 非 default + worktree 不存在 → 退化主目录 + warning

    worktree 存在性由 caller 预探测后传 worktree_exists(bool),纯函数不碰
    filesystem(测试可注入)。worktree 路径段用 session_safe(对齐 main.py:664)。
    """
    main_dir = Path(workspaces_dir) / ws
    warnings = []

    if worktree_mode == "off" or session_key == "default":
        return (main_dir, "main", warnings)

    # auto + 非 default
    safe = _session_safe(session_key)
    wt_path = Path(workspaces_dir) / ".wt" / f"{ws}-{safe}"
    if worktree_exists:
        return (wt_path, "worktree", warnings)

    warnings.append(
        f"session '{session_key}' 还没建 worktree,退化到主目录显示"
    )
    return (main_dir, "main", warnings)


def resolve_base(run_git_fn, main_dir):
    """主目录 HEAD 分支名 = base(复用 main.py:1095 的 head or "main")。

    run_git_fn 注入(测试用 fake)。rev-parse 失败 / 空 → "main" 兜底。
    """
    rc, head, _ = run_git_fn(main_dir, ["rev-parse", "--abbrev-ref", "HEAD"])
    if rc != 0:
        return "main"
    return head or "main"


# ---------- handler 组装层(注入 run_git,拼 spec §3.2 schema)----------

_DIFF_STAT_CAP = 200  # diff_stat 文件数上限(spec §7,3 级可调)


def _merge_status_letters(diff_stat, name_status_text):
    """把 git diff --name-status 的状态字母按文件名合并进 diff_stat。

    name-status 行形如 `M\\tfile` / `A\\tfile` / `D\\tfile` /
    `R100\\told\\tnew`(rename)。status 取首字母(R100→R),不翻译(spec §3.2)。
    diff_stat 没匹配上的文件 status 留 None,由 caller 决定兜底。
    """
    letters = {}
    for line in name_status_text.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        code = parts[0]
        letter = code[0] if code else ""
        # rename / copy:`R100\told\tnew` —— 新路径是最后一段
        fname = parts[-1]
        letters[fname] = letter
    for d in diff_stat:
        d["status"] = letters.get(d["file"])
    return diff_stat


def build_git_overview(run_git_fn, ws, session_key, cwd, cwd_kind, base):
    """概览 handler —— 取 git 原文喂 parse_*,拼 spec §3.2 schema。

    run_git_fn 注入。所有子项失败都降级(spec §7),不抛 500:
    - 非 git(rc!=0)→ {is_git_repo: false, session}
    - 无 commit → recent_commits: []
    - base 不存在 → ahead/behind/diff_stat 略过 + warnings
    - off / cwd_kind=main + branch==base → ahead/behind=0,diff_stat 走
      git diff HEAD --numstat(工作区改动,spec §6 退化)

    diff_stat 三点 base...branch 是 session 净贡献(spec §3.4);main 目录
    (无 session 分支)退化成工作区 diff HEAD。
    """
    warnings = []

    # 1. 探测是否 git repo + 取 status -sb 首行
    rc, sb_out, sb_err = run_git_fn(cwd, ["status", "-sb"])
    if rc != 0:
        # 非 git / 路径不存在 / git 不可用 —— 整体降级
        return {"is_git_repo": False, "session": session_key}

    sb_lines = sb_out.splitlines()
    sb_first = sb_lines[0] if sb_lines else ""
    branch = parse_branch(sb_first)
    # 空仓库(git init 后 0 commit):首行 "## No commits yet on <X>" → branch=null
    # + warning + 无 HEAD(spec §7)。区别于 detached(detached 仍有 head_short)。
    is_empty_repo = sb_first.startswith("## No commits yet")
    if is_empty_repo:
        warnings.append("仓库还没有 commit")
    # ahead/behind 默认 0;有 session 分支时下面用 rev-list 相对 base 重算
    # (spec §3.2:branch 相对 base,不是相对 upstream —— status -sb 的
    #  bracket 给的是 upstream 关系,本地 cc/* 分支无 upstream)。
    ahead, behind = 0, 0

    # 2. head_short(detached 时唯一标识;空仓库无 HEAD → rev-parse 非零 → None)
    _, head_short, _ = run_git_fn(cwd, ["rev-parse", "--short", "HEAD"])

    # 3. dirty(独立 porcelain,untracked 也算)
    _, porc_out, _ = run_git_fn(cwd, ["status", "--porcelain"])
    dirty = parse_status(porc_out)["dirty"]

    # 4. recent_commits(空仓库 git log 非零 → [])
    rc_log, log_out, _ = run_git_fn(
        cwd, ["log", "-n", "20", "--pretty=format:%h%x00%s%x00%cr%x00%an"]
    )
    recent_commits = parse_log(log_out) if rc_log == 0 else []

    # 5. diff_stat:有 session 分支(branch != base 且 branch 非 None)→ 三点
    #    净贡献;否则(main 目录 / off / detached)退化工作区 diff HEAD。
    use_net = bool(branch) and branch != base
    if use_net:
        # base 存在性:rev-parse --verify base 失败 → 略过 ahead/behind/diff_stat
        rc_base, _, _ = run_git_fn(cwd, ["rev-parse", "--verify", base])
        if rc_base != 0:
            warnings.append(f"base '{base}' 不存在,ahead/behind/diff_stat 略过")
            ahead, behind = 0, 0
            diff_stat = []
            diff_truncated = False
        else:
            # ahead/behind = branch 相对 base(三点 symmetric difference)
            _, rl_out, _ = run_git_fn(
                cwd, ["rev-list", "--left-right", "--count", f"{base}...{branch}"]
            )
            ahead, behind = parse_rev_list_count(rl_out)
            _, num_out, _ = run_git_fn(
                cwd, ["diff", "--numstat", f"{base}...{branch}"]
            )
            _, ns_out, _ = run_git_fn(
                cwd, ["diff", "--name-status", f"{base}...{branch}"]
            )
            diff_stat = parse_numstat(num_out)
            _merge_status_letters(diff_stat, ns_out)
            diff_stat, diff_truncated = _cap_diff_stat(diff_stat)
    else:
        # 退化:工作区 vs HEAD(spec §6 off / main 目录)
        ahead, behind = 0, 0
        _, num_out, _ = run_git_fn(cwd, ["diff", "HEAD", "--numstat"])
        _, ns_out, _ = run_git_fn(cwd, ["diff", "HEAD", "--name-status"])
        diff_stat = parse_numstat(num_out)
        _merge_status_letters(diff_stat, ns_out)
        diff_stat, diff_truncated = _cap_diff_stat(diff_stat)

    # 6. worktrees(is_current = path == cwd)。git worktree list 返回 resolve
    #    后的真实路径(macOS /tmp→/private/tmp symlink),故两边都 resolve 再比。
    _, wt_out, _ = run_git_fn(cwd, ["worktree", "list", "--porcelain"])
    worktrees = parse_worktree_list(wt_out)
    cwd_real = str(Path(cwd).resolve())
    for w in worktrees:
        w["is_current"] = str(Path(w["path"]).resolve()) == cwd_real

    return {
        "is_git_repo": True,
        "branch": branch,
        "head_short": head_short or None,
        "base": base,
        "ahead": ahead,
        "behind": behind,
        "dirty": dirty,
        "session": session_key,
        "cwd_kind": cwd_kind,
        "recent_commits": recent_commits,
        "diff_stat": diff_stat,
        "diff_truncated": diff_truncated,
        "worktrees": worktrees,
        "warnings": warnings,
    }


def _cap_diff_stat(diff_stat):
    """文件数超 _DIFF_STAT_CAP → 截断 + diff_truncated=True(spec §7)。"""
    if len(diff_stat) > _DIFF_STAT_CAP:
        return diff_stat[:_DIFF_STAT_CAP], True
    return diff_stat, False


def build_git_file_diff(run_git_fn, cwd, base, branch, file, uncommitted):
    """单文件 diff handler → {file, binary, hunks, truncated}(spec §3.4/§5.2)。

    uncommitted=True → git diff HEAD -- <file>(工作区 vs HEAD);
    否则三点 git diff <base>...<branch> -- <file>(session 净贡献)。
    run_git_fn 注入。file 的路径安全校验在路由层(spec §3.7)。
    """
    if uncommitted:
        _, out, _ = run_git_fn(cwd, ["diff", "HEAD", "--", file])
    else:
        ref = f"{base}...{branch}" if branch else "HEAD"
        _, out, _ = run_git_fn(cwd, ["diff", ref, "--", file])
    parsed = parse_unified_diff(out)
    return {
        "file": file,
        "binary": parsed["binary"],
        "hunks": parsed["hunks"],
        "truncated": parsed["truncated"],
    }
