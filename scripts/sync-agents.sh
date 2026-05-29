#!/usr/bin/env bash
# cc-workflow subagent 同步 — 把 repo 里版本控制的 .claude/agents/*.md
# per-file symlink 进 ~/.claude/agents/,让两个运行时消费者都看得到:
#
#   1. PWA #settings/agents CRUD(backend/agents_store.py 读 ~/.claude/agents/)
#   2. claude CLI dispatch subagent(读 ~/.claude/agents/ user scope,
#      跨所有 workspace 生效)
#
# 为什么 symlink 而不是 cp:
#   - 单一来源(repo) —— 编辑 repo 文件即生效,无 drift
#   - git 追踪 —— team 定义跟代码一起版本控制
#   - PWA 编辑会写穿到 repo 文件(然后你 git commit),不产生第二份真相
#
# 为什么 per-file 而不是整目录 symlink:
#   - 不 clobber ~/.claude/agents/ 里可能存在的机器本地 agent
#   - 只接管 repo 里有的那几个,其它不动
#
# 幂等:可反复跑。已经是正确 symlink 的跳过;指向别处的旧 symlink 重建;
# 是真文件(非 symlink)的**不覆盖**,只警告(避免吞掉用户手写的同名 agent)。
#
# 部署:拉新代码后,如果 .claude/agents/ 有增删,跑一次:
#   bash scripts/sync-agents.sh
# (deploy/INSTALL.md 里也提了)

set -eu

# repo 根 = 本脚本所在 scripts/ 的上一级
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/.claude/agents"
DST_DIR="${HOME}/.claude/agents"

if [[ ! -d "$SRC_DIR" ]]; then
    echo "ERROR: repo agents dir 不存在: $SRC_DIR" >&2
    exit 1
fi

mkdir -p "$DST_DIR"

linked=0 skipped=0 warned=0
shopt -s nullglob
for src in "$SRC_DIR"/*.md; do
    name="$(basename "$src")"
    dst="${DST_DIR}/${name}"

    if [[ -L "$dst" ]]; then
        # 已是 symlink:指向我们 repo 就跳过,指向别处就重建
        current="$(readlink "$dst")"
        if [[ "$current" == "$src" ]]; then
            skipped=$((skipped + 1))
            continue
        fi
        ln -sfn "$src" "$dst"
        echo "  relinked  $name  (was → $current)"
        linked=$((linked + 1))
    elif [[ -e "$dst" ]]; then
        # 真文件,非 symlink —— 不覆盖,警告让用户决定
        echo "  WARN      $name  已存在且非 symlink(机器本地 agent?)— 跳过,未覆盖" >&2
        warned=$((warned + 1))
    else
        ln -s "$src" "$dst"
        echo "  linked    $name"
        linked=$((linked + 1))
    fi
done

echo "---"
echo "synced: ${linked} linked, ${skipped} already ok, ${warned} skipped (non-symlink conflict)"
if [[ $warned -gt 0 ]]; then
    echo "有同名真文件未被覆盖。如果想用 repo 版本,先手动删 ~/.claude/agents/<name>.md 再重跑。" >&2
fi
