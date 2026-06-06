"""Workspace 文件下载的路径解析 + 安全校验(2026-06-04)。

需求:AI 帮用户写了文档,落在 ~/workspaces/<ws>/(或 session worktree
~/workspaces/.wt/<ws>-<session>/)里,用户要下载回来。端点 GET
/workspaces/{ws}/file?path=<path> 用这里的 resolve_download_target 把请求路径
解析成一个"确实在该 workspace 树内的普通文件",再 FileResponse 流回去。

安全是这块的核心(反悔成本几乎不可逆):
- realpath 解析(.resolve())→ 顺带消 `..` + 跟随 symlink,任何越出 base 的
  路径(含 symlink 指向树外)都被 relative_to 检查挡掉。
- 只服务普通文件(is_file),目录 / 设备 / 不存在 → None。
- 绝对路径必须落在某个 base 内;相对路径对每个 base 试,取第一个命中的文件
  (这样 git 区的相对路径不管文件在主目录还是 worktree 都能下到)。
"""
import os
from pathlib import Path


def _resolved_bases(ws_root, worktree_dirs):
    """[ws_root] + worktree_dirs,各自 realpath。不可解析的丢弃。"""
    bases = []
    for b in [ws_root, *(worktree_dirs or [])]:
        try:
            bases.append(Path(b).resolve())
        except OSError:
            continue
    return bases


def _within(target, base):
    try:
        target.relative_to(base)
        return True
    except ValueError:
        return False


def resolve_download_target(ws_root, worktree_dirs, requested):
    """把 requested(绝对或相对路径字符串)解析成"在 ws_root 或某个
    worktree_dir 内的普通文件"的真实 Path;非法 / 越权 / 非文件 → None。

    - 绝对路径:.resolve() 后必须落在某个 base 内(消 .. + symlink 越权)。
    - 相对路径:对每个 base 拼 + .resolve(),取第一个是文件且在该 base 内的。
    """
    requested = str(requested or "").strip()
    if not requested:
        return None
    bases = _resolved_bases(ws_root, worktree_dirs)
    if not bases:
        return None

    if os.path.isabs(requested):
        try:
            target = Path(requested).resolve()
        except OSError:
            return None
        if target.is_file() and any(_within(target, b) for b in bases):
            return target
        return None

    # 相对路径:逐个 base 试
    for base in bases:
        try:
            cand = (base / requested).resolve()
        except OSError:
            continue
        if cand.is_file() and _within(cand, base):
            return cand
    return None


def list_worktree_dirs(workspaces_dir, ws):
    """该 ws 的 worktree 目录列表:~/workspaces/.wt/<ws>-* 。

    单用户场景:glob `<ws>-*` 足够(realpath/within 校验兜住越权);ws 名互为
    前缀的极端情况(foo vs foo-bar)可能多匹配,但都是用户自己的文件,无安全风险。
    """
    wt_dir = Path(workspaces_dir) / ".wt"
    if not wt_dir.is_dir():
        return []
    return sorted(p for p in wt_dir.glob(f"{ws}-*") if p.is_dir())
