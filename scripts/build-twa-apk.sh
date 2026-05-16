#!/usr/bin/env bash
#
# scripts/build-twa-apk.sh — 一键打 cc-workflow PWA 的 TWA APK。
#
# 为什么 TWA(Trusted Web Activity)而不是 WebView 套壳:
#   - PWA 已经齐全(manifest.json + service worker + 全屏 display),TWA 是
#     Google 官方推荐的最薄套壳,APK 大小 1-2 MB,UI/JS/CSS 一点都不打包进去,
#     全部 runtime 从服务器拉 https://<host>/pwa/。前端改了不用重打 APK。
#   - WebView 套壳渲染引擎是系统 WebView(碎片化),TWA 用用户手机的 Chrome
#     (自动跟版本),SW / Push 兼容性都更好。
#   - 单用户单机工具用不上原生功能(蓝牙 / NFC / sensor 等),WebView 套壳
#     带来的"自由度"是负资产。
#
# APK 里到底装了什么:
#   - AndroidManifest.xml(几 KB)— 声明启动 intent + 目标 URL + assetlinks 引用
#   - LauncherActivity.java(几十行)— 继承 androidx.browser.trusted 启动 Chrome
#   - res/drawable-*/icon.png(各分辨率,共 ~200KB)
#   - res/values/strings.xml — app name / 目标 URL / asset_statements JSON
#   - androidx.browser TWA 运行时 jar(~1 MB)
#   - 签名块
#
# 用法:
#   bash scripts/build-twa-apk.sh https://your.domain.com
#
# 跑完会:
#   1. APK 输出到 ~/.cc-state/twa-build/project/app-release-signed.apk
#   2. Digital Asset Links 写到 ~/.cc-state/twa-build/.well-known/assetlinks.json
#   3. 在 /etc/nginx/sites-available/cc-workflow 里加 /.well-known/assetlinks.json
#      location(若没加过),并 reload nginx
#   4. 提示怎么传到手机
#
# 后续重打(域名 / packageId 不变):再跑一次,keystore / nginx 配置都复用,
# 只重新 build APK。
#
# Idempotent:重复跑安全。
#
set -euo pipefail

err()  { printf '\e[31m[build-twa]\e[0m %s\n' "$*" >&2; }
log()  { printf '\e[32m[build-twa]\e[0m %s\n' "$*"; }
warn() { printf '\e[33m[build-twa]\e[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 参数 ----------
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
    cat >&2 <<EOF
用法:$0 https://your.domain.com

示例:$0 https://cc.example.com
EOF
    exit 1
fi
HOST="${DOMAIN#https://}"; HOST="${HOST#http://}"; HOST="${HOST%/}"

WORK="${HOME}/.cc-state/twa-build"
PROJECT="$WORK/project"
KEYSTORE="$WORK/android.keystore"
KEY_PASS_FILE="$WORK/.keystore-pass"
KEY_ALIAS="android"
mkdir -p "$WORK"

# ---------- 1/7 依赖 ----------
log "[1/7] 检查依赖"
[[ "$(uname -s)" == "Linux" ]] || warn "建议在 Linux 服务器跑;Mac 也能跑但需 JDK 17 + Node"

for cmd in java keytool node npm openssl python3; do
    have "$cmd" || { err "缺 $cmd"; need_install=1; }
done
if [[ "${need_install:-0}" == "1" ]]; then
    err "Debian/Ubuntu 装法:"
    err "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    err "  sudo apt install -y openjdk-17-jdk nodejs"
    exit 1
fi

java_major=$(java -version 2>&1 | awk -F'"' '/version/ {split($2, a, "."); print a[1]}')
[[ "$java_major" -ge 17 ]] || { err "需要 JDK 17+,当前 $java_major"; exit 1; }

if ! have bubblewrap; then
    log "装 Bubblewrap CLI(Google 官方 TWA 打包工具)"
    sudo npm install -g @bubblewrap/cli || npm install -g @bubblewrap/cli
fi

# ---------- 2/7 keystore ----------
KEYSTORE_NEW=0
if [[ ! -f "$KEYSTORE" ]]; then
    log "[2/7] 首次生成签名 keystore(20 年有效)"
    PASS=$(openssl rand -hex 16)
    echo "$PASS" > "$KEY_PASS_FILE"
    chmod 600 "$KEY_PASS_FILE"
    keytool -genkeypair \
        -keystore "$KEYSTORE" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA \
        -keysize 2048 \
        -validity 7300 \
        -storepass "$PASS" \
        -keypass "$PASS" \
        -dname "CN=cc-workflow, O=self, C=CN"
    KEYSTORE_NEW=1
else
    log "[2/7] 复用已有 keystore:$KEYSTORE"
fi
KEY_PASS=$(cat "$KEY_PASS_FILE")

# ---------- 3/7 bubblewrap init(首次) ----------
if [[ ! -f "$PROJECT/build.gradle" ]]; then
    log "[3/7] 首次 init bubblewrap 项目(交互式,大部分回车默认即可)"
    log "      被问到 signing key 时,选 'Use existing',然后填:"
    log "        Key store path: $KEYSTORE"
    log "        Key alias:      $KEY_ALIAS"
    log "        密码 / alias 密码:都用同一个,见 $KEY_PASS_FILE"
    cd "$WORK"
    bubblewrap init --manifest="https://$HOST/pwa/manifest.json" --directory="$PROJECT"
else
    log "[3/7] 复用已有 bubblewrap 项目:$PROJECT"
fi

# ---------- 4/7 build ----------
log "[4/7] bubblewrap build"
log "      若被问到 keystore 密码 — 输入(或粘贴)以下密码两次:"
log "      ⌨  $KEY_PASS"
cd "$PROJECT"
# bubblewrap 不同版本对 stdin 喂密码的兼容性不一,所以提示用户必要时手动输入。
# 先试 stdin 喂(老版本兼容),失败则用户被提示手动输入。
{ echo "$KEY_PASS"; echo "$KEY_PASS"; } | bubblewrap build || bubblewrap build

APK=$(ls -t "$PROJECT"/*-release-signed.apk 2>/dev/null | head -1 || true)
[[ -n "${APK:-}" && -f "$APK" ]] || { err "build 没产出 APK,看上面日志"; exit 1; }
log "      APK: $APK ($(du -h "$APK" | awk '{print $1}'))"

# ---------- 5/7 SHA256 + assetlinks ----------
log "[5/7] 生成 Digital Asset Links"
SHA256=$(
    keytool -list -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -storepass "$KEY_PASS" 2>/dev/null \
        | awk '/SHA256:/ {print $2; exit}'
)
[[ -n "$SHA256" ]] || { err "提取 SHA256 失败"; exit 1; }
PACKAGE_ID=$(python3 -c "import json; print(json.load(open('$PROJECT/twa-manifest.json'))['packageId'])")
WELLKNOWN="$WORK/.well-known"
mkdir -p "$WELLKNOWN"
cat > "$WELLKNOWN/assetlinks.json" <<EOF
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "$PACKAGE_ID",
    "sha256_cert_fingerprints": ["$SHA256"]
  }
}]
EOF
log "      $WELLKNOWN/assetlinks.json"
log "      package: $PACKAGE_ID"
log "      sha256:  $SHA256"

# ---------- 6/7 patch nginx ----------
log "[6/7] patch nginx 配置"
NGINX_CONF="/etc/nginx/sites-available/cc-workflow"
if [[ ! -f "$NGINX_CONF" ]]; then
    warn "      $NGINX_CONF 不存在,跳过(自己加 location 块)"
elif grep -q "well-known/assetlinks" "$NGINX_CONF"; then
    log "      nginx 已经配过 assetlinks,跳过"
else
    # 用 python 在 server { ... } 块的最后一个 } 之前插入 location 块。
    # 比 sed/awk 可靠(server_name 后面可能有多层 location 嵌套,直接 sed 容易插错位置)。
    sudo python3 - "$NGINX_CONF" "$WELLKNOWN/assetlinks.json" <<'PY'
import sys, pathlib, re
path = pathlib.Path(sys.argv[1])
asset_file = sys.argv[2]
text = path.read_text()
snippet = f"""
    # Digital Asset Links — TWA APK 通过这个文件验证它有权"全屏不显示 URL bar"
    # 打开本站。删了或路径错了,Chrome 会回退成顶部有 URL bar 的样子。
    location = /.well-known/assetlinks.json {{
        alias {asset_file};
        default_type application/json;
        add_header Access-Control-Allow-Origin "*";
    }}
"""
# 找文件末尾最后一个 } (server 块结束)
m = re.search(r'\n}\s*$', text)
if not m:
    sys.exit("nginx conf 末尾没找到 server 块的 }")
new_text = text[:m.start()] + snippet + text[m.start():]
backup = path.with_suffix(path.suffix + '.bak-twa')
backup.write_text(text)
path.write_text(new_text)
print(f"  备份原配置到 {backup}")
PY
    sudo nginx -t && sudo systemctl reload nginx
    log "      nginx 已 reload"
fi

# ---------- 7/7 完事 ----------
log "[7/7] 完成"
echo

if [[ "$KEYSTORE_NEW" == "1" ]]; then
    cat <<EOF
⚠️  首次跑生成了新 keystore,必须备份这两个文件:
   $KEYSTORE
   $KEY_PASS_FILE

   建议:加密后传到云盘 / 1Password / 移动硬盘。
   丢了 = 这个 packageId 的 APK 永远无法升级,只能换 packageId 重发。

EOF
fi

cat <<EOF
📱 把 APK 传到手机(任选其一):

   方法 A:scp 拉到本地后 AirDrop / USB
     scp \$SERVER:$APK ~/Downloads/

   方法 B:服务器临时起 http(同 wifi 时方便)
     cd $(dirname "$APK") && python3 -m http.server 9000
     手机浏览器打开 http://\$SERVER_IP:9000/$(basename "$APK")

   装的时候手机会提示"未知来源",允许即可。

📱 装完后验证 TWA 模式生效:
   1. 点 cc-workflow 图标,应该全屏打开 PWA,没有顶部 Chrome URL bar
   2. 如果还有 URL bar,说明 Chrome 没拉到 assetlinks,debug:
        curl https://$HOST/.well-known/assetlinks.json
        # 应返回 JSON,sha256 = $SHA256

🔁 后续重打(域名 / packageId 不变):
     bash $0 https://$HOST
   keystore 和 nginx 配置都会复用,只重新 build APK。

📦 前端代码改了不用重打 APK——TWA 套壳是个空壳,
   每次启动从 https://$HOST/pwa/ 拉最新 app.js。
EOF
