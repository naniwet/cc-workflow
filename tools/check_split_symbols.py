#!/usr/bin/env python3
"""拆分安全闸:跨模块导出符号的 import 完整性检查(2026-06-09)。

app.js 拆成多个原生 ESM 模块时,最危险的失败是「某模块导出的符号 X,在文件 F
里被引用,但 F 忘了 import X」——node --check 抓不到(ESM 自由变量是运行时
ReferenceError),且常常只在点击某个 handler 时才炸。

这个脚本专抓这一类:
  1. 扫 pwa/ 下所有 .mjs + app.js,建「导出符号 → 来源模块」表。
  2. 对每个文件,扒出它 import 了哪些名字、顶层声明了哪些名字。
  3. 对每个「导出符号 E(来自模块 M)」:任何在 import 语句之外引用了 E 的文件
     F(F≠M),必须要么 import 了 E,要么自己顶层声明了同名 E,否则报错。

只检查「模块导出符号」这一窄集合 —— 避开 params/局部变量的误报泥潭。

设计要点(教训):**不要用正则剥 JS 注释/字符串**。JS 有 regex 字面量(/.../)
和模板串,里面的 /* '" 等会把"剥注释/剥字符串"的正则配对搞乱,re.S 一路吃掉
整段(实测:本文件 char 107 的 /* 在某 regex 里,和 char 2578 的 */ 配对,把
import 区整段吞了)。所以这里**完全在裸源上做**:import/export 用结构化正则抓
(它们结构简单、可靠),引用检测先把 import 语句整条删掉再扫(避免把 import 行
里的名字当成"使用")。残余风险只剩:注释或字符串里碰巧提到某未 import 的导出
符号名 → 误报。罕见,报出来人工瞄一眼即可。

用法:python3 tools/check_split_symbols.py   (仓库根跑;退出码非 0 = 有问题)
"""
import re
import sys
from pathlib import Path

PWA = Path(__file__).resolve().parents[1] / "pwa"

# import/export 一律行首锚定(^ + re.M):真 ESM import 在语句位置=行首;注释里
# 的示例 `import { X }`(mid-line)不会被误匹配 —— 否则非贪婪 [\s\S]*? 会从注释
# 的 import { 一路吃到真 import,把整段捕获弄乱(踩过)。
IMPORT_BLOCK = re.compile(r"^import\s*\{([\s\S]*?)\}\s*from\s*['\"][^'\"]+['\"]\s*;?", re.M)
IMPORT_DEFAULT = re.compile(r"^import\s+([A-Za-z_$][\w$]*)\s+from\s*['\"][^'\"]+['\"]\s*;?", re.M)
EXPORT_DECL = re.compile(r"^export\s+(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)
TOPLEVEL_DECL = re.compile(r"^\s*(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)", re.M)
# 函数参数 = 本地声明(纯函数模块如 ui_contract 把 esc 当参数注入,不是漏 import)
FUNC_PARAMS = re.compile(r"function\s+[\w$]*\s*\(([^)]*)\)")
ARROW_PARAMS = re.compile(r"\(([^)]*)\)\s*=>")
ARROW_SINGLE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>")


def _names_from_clause(clause: str) -> set:
    out = set()
    for part in clause.split(","):
        name = part.strip().split(" as ")[-1].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name or ""):
            out.add(name)
    return out


def exported_names(src: str) -> set:
    names = set(EXPORT_DECL.findall(src))
    for clause in EXPORT_LIST.findall(src):
        names |= _names_from_clause(clause)
    return names


def imported_names(src: str) -> set:
    names = set()
    for clause in IMPORT_BLOCK.findall(src):
        names |= _names_from_clause(clause)
    names |= set(IMPORT_DEFAULT.findall(src))
    return names


def remove_imports(src: str) -> str:
    src = IMPORT_BLOCK.sub(" ", src)
    src = IMPORT_DEFAULT.sub(" ", src)
    # 剥 // 行注释:避免注释里提到的导出符号名(我插的指针注释 / 别人文档)被当成
    # "使用"。只剥 //(到行尾),不碰 /* */(块注释里的 /* 可能在 regex 字面量里,
    # 会把整段吃掉 —— 见模块 docstring)。URL/regex 里的 // 极少正好带某导出符号名,
    # 误剥的影响仅限"少看一处引用",可接受。
    src = re.sub(r"//[^\n]*", "", src)
    return src


def param_names(src: str) -> set:
    names = set()
    for rx in (FUNC_PARAMS, ARROW_PARAMS):
        for clause in rx.findall(src):
            names |= set(re.findall(r"[A-Za-z_$][\w$]*", clause))
    names |= set(ARROW_SINGLE.findall(src))
    return names


def referenced(name: str, body: str) -> bool:
    # 不以 . / 字母数字开头(剔属性访问 obj.X 与 yX)
    return re.search(r"(?<![.\w$])" + re.escape(name) + r"\b", body) is not None


IMPORT_FROM = re.compile(r"^import\s*\{([\s\S]*?)\}\s*from\s*['\"]([^'\"]+)['\"]", re.M)


def import_pairs(src: str):
    """[(orig_name, modpath)] —— 每个 import 在【来源模块】里的原名 + 来源路径。
    `X as Y`:校验来源是否导出要用 X(as 左边),不是本地别名 Y。"""
    out = []
    for m in IMPORT_FROM.finditer(src):
        mod = m.group(2)
        for part in m.group(1).split(","):
            orig = part.strip().split(" as ")[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", orig or ""):
                out.append((orig, mod))
    return out


def main():
    files = sorted(list(PWA.glob("*.mjs")) + [PWA / "app.js"])
    files = [f for f in files if f.exists()]
    src = {f: f.read_text() for f in files}   # 裸源:不剥注释/字符串(见模块 docstring)

    export_home = {}
    for f in files:
        if f.suffix == ".mjs":
            for name in exported_names(src[f]):
                export_home[name] = f

    imports = {f: imported_names(src[f]) for f in files}
    decls = {f: set(TOPLEVEL_DECL.findall(src[f])) | param_names(src[f]) for f in files}
    bodies = {f: remove_imports(src[f]) for f in files}
    # 每个本仓模块的导出名(按文件名查):用于校验 import 的名字真存在
    file_exports = {f.name: exported_names(src[f]) for f in files if f.suffix == ".mjs"}

    errors = []
    # 检查 1:引用了某导出符号却没 import(漏 import)
    for f in files:
        for name, home in export_home.items():
            if f == home:
                continue
            if name in imports[f] or name in decls[f]:
                continue
            if referenced(name, bodies[f]):
                errors.append(f"{f.name}: 引用了 {name}(由 {home.name} 导出)但未 import,也未本地声明")
    # 检查 2:import 了一个来源模块根本没导出的名字(bogus import —— ESM 加载期
    # SyntaxError,node --check 抓不到,曾漏到 harness 才暴露)。
    for f in files:
        for name, mod in import_pairs(src[f]):
            base = mod.rsplit("/", 1)[-1]
            if base in file_exports and name not in file_exports[base]:
                errors.append(f"{f.name}: import 了 {name} from {base},但 {base} 并未导出它(bogus import)")

    if errors:
        print("✗ 静态符号闸:发现漏 import")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print(f"✓ 静态符号闸通过({len(files)} 文件,{len(export_home)} 个跨模块导出符号 import 完整)")


if __name__ == "__main__":
    main()
