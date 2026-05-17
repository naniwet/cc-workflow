#!/usr/bin/env bash
#
# scripts/build-twa-apk.sh — 一键打 cc-workflow PWA 的 Android APK。
#
# 实际打的是 Bubblewrap 的"TWA + WebView fallback"双模 APK:
#   - 系统装了 Chromium 系浏览器(Chrome / Edge / Brave / Samsung Internet
#     等)且支持 TWA → 走 TWA 模式,Chrome Custom Tab 全屏渲染
#   - 上述任一不满足(国产 ROM 拦 Custom Tabs intent / 没装 Chromium 浏览
#     器 / Edge 在某些 OEM 系统被阉割 TWA capability)→ 自动降级到 WebView,
#     APK 内置 wrapper 直接 loadUrl,完全不依赖任何浏览器
#
# 为什么默认 fallbackType=webview(而不是上游默认的 customtabs):
#   实测在"卓易通"系统的 Edge 上 TWA 卡 splash 起不来(Custom Tabs intent
#   被 ROM 拦),只有 webview fallback 能保证 100% 启动。代价:
#     - 在 TWA 能跑的设备上,行为不变(还是先走 TWA)
#     - 在 fallback 触发时,用户向下拖会看到一个反钓鱼 URL bar
#       —— Bubblewrap / androidx.browser 的强制设计,关不掉
#   收益 >> 代价,所以默认 webview。
#
# APK 里到底装了什么:
#   - AndroidManifest.xml — 启动 intent + 目标 URL + assetlinks 引用
#   - LauncherActivity(几十行)— 启 TWA / 失败时 fallback 到 WebView
#   - res/drawable-*/icon.png(各分辨率,~200KB)
#   - androidx.browser TWA 运行时 + WebView wrapper(~1 MB)
#   - 签名块
#   总大小 1-2 MB。UI / JS / CSS 一点都不打包进去,每次启动从服务器拉
#   https://<host>/pwa/。前端改了不用重打 APK。
#
# 用法:
#   bash scripts/build-twa-apk.sh https://your.domain.com
#
# 跑完会:
#   1. APK 输出到 ~/.cc-state/twa-build/project/app-release-signed.apk
#   2. Digital Asset Links 写到 ~/.cc-state/twa-build/.well-known/assetlinks.json
#   3. 在 /etc/nginx/sites-available/cc-workflow 里加 /.well-known/assetlinks.json
#      location(若没加过),并 reload nginx
#   4. 提示怎么传到手机 + 输出 APK md5
#
# Idempotent:重复跑安全。首次跑 ~10 min(下 SDK + gradle),后续重打 1-3 min。
#
# 历史踩坑(都已经在本脚本里修死,这里只记原因):
#   * unzip / wget 系统没装 → 装新 cmdline-tools 解不开 / 下不到
#   * bubblewrap 自带的 tools/bin/sdkmanager 是 2017 年废弃版本,不认 android-36
#     → 必须先装 cmdline-tools 11076708 到 cmdline-tools/latest/
#   * SDK license 不接受 → 装组件被 skip → gradle build 报 "missing components"
#   * gradle wrapper 从 services.gradle.org 下 zip,阿里云出口不稳 → ZipException
#     → 必须 sed 改成腾讯镜像
#   * keystore 默认路径 = <project>/android.keystore,跟脚本原来生成位置不一致
#     → bubblewrap init 时被误导生成新 keystore,SHA256 跟 assetlinks 对不上
#     → 直接把 keystore 生成到 project 目录,跟 bubblewrap 默认一致
#   * fallbackType=customtabs(上游默认)在国产 ROM 上死活进不去
#     → 改 webview 之后必须 bubblewrap update 重新生成项目,update 又会覆盖
#       gradle-wrapper.properties 的镜像 → 需要 update 之后再 patch 一次
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
KEYSTORE="$PROJECT/android.keystore"   # 直接放 bubblewrap 默认位置,避免被误导
KEY_PASS_FILE="$WORK/.keystore-pass"
KEY_ALIAS="android"

# Bubblewrap 把 Android SDK 装在这,我们追加 cmdline-tools/latest/ 子目录用新 sdkmanager
BW_SDK="${HOME}/.bubblewrap/android_sdk"
SDK_NEW="$BW_SDK/cmdline-tools/latest"

# 装组件版本(跟着 bubblewrap 当前默认走;升级 bubblewrap 后需要核对一次)
PLATFORM_VERSION="android-36"
BUILD_TOOLS_VERSION="35.0.0"

# Android cmdline-tools 版本(2024 latest)
CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
CMDLINE_TOOLS_URL_TENCENT="https://mirrors.cloud.tencent.com/AndroidSDK/$CMDLINE_TOOLS_ZIP"
CMDLINE_TOOLS_URL_GOOGLE="https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"

# Gradle 镜像(腾讯,国内最稳)
GRADLE_MIRROR="mirrors.cloud.tencent.com/gradle"
GRADLE_OFFICIAL="services.gradle.org/distributions"

mkdir -p "$WORK"

# ---------- 1/7 依赖 ----------
log "[1/7] 检查依赖"
[[ "$(uname -s)" == "Linux" ]] || warn "建议在 Linux 服务器跑;Mac 也能跑但需 JDK 17 + Node"

# apt 装得起来的依赖,缺了就自动装(root 才行,非 root 提示让用户跑)
auto_apt=()
for cmd in unzip wget; do
    have "$cmd" || auto_apt+=("$cmd")
done
if [[ ${#auto_apt[@]} -gt 0 ]]; then
    if [[ $(id -u) -eq 0 ]] && have apt-get; then
        log "      自动 apt 装:${auto_apt[*]}"
        apt-get update -qq && apt-get install -y -qq "${auto_apt[@]}"
    else
        err "缺 ${auto_apt[*]},请先装:sudo apt install -y ${auto_apt[*]}"
        exit 1
    fi
fi

# 这些没法 auto 装(自己装 JDK / Node 太复杂,给提示就行)
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
    log "      装 Bubblewrap CLI(Google 官方 TWA 打包工具)"
    sudo npm install -g @bubblewrap/cli 2>/dev/null || npm install -g @bubblewrap/cli
fi

# ---------- 2/7 keystore(直接放 project 默认位置) ----------
mkdir -p "$PROJECT"
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
# 兼容旧脚本:旧 keystore 在 $WORK/android.keystore,自动 cp 到新位置
if [[ -f "$WORK/android.keystore" && ! -f "$KEYSTORE" ]]; then
    log "      迁移旧 keystore:$WORK/android.keystore → $KEYSTORE"
    cp "$WORK/android.keystore" "$KEYSTORE"
fi
KEY_PASS=$(cat "$KEY_PASS_FILE")

# ---------- 3/7 bubblewrap init(首次) ----------
if [[ ! -f "$PROJECT/build.gradle" ]]; then
    log "[3/7] 首次 init bubblewrap 项目(半交互,~5 个问题大部分回车默认即可)"
    log "      被问到 'Signing key' 时直接回车——脚本已经把 keystore 放在默认路径"
    log "      被问到密码时,粘贴:$KEY_PASS"
    cd "$WORK"
    bubblewrap init --manifest="https://$HOST/pwa/manifest.json" --directory="$PROJECT"
else
    log "[3/7] 复用已有 bubblewrap 项目:$PROJECT"
fi

# ---------- 4/7 Android SDK 准备(cmdline-tools + 组件 + license) ----------
# bubblewrap init 会自己装老版 tools/bin/sdkmanager —— 它认不出 android-36。
# 必须装新 cmdline-tools 才能装新 SDK 组件。
if [[ ! -x "$SDK_NEW/bin/sdkmanager" ]]; then
    log "[4/7] 装新版 Android cmdline-tools 到 $SDK_NEW"
    cd /tmp
    if [[ ! -f "$CMDLINE_TOOLS_ZIP" ]]; then
        log "      下 $CMDLINE_TOOLS_ZIP(~150 MB,腾讯镜像)"
        wget -q --show-progress "$CMDLINE_TOOLS_URL_TENCENT" \
            || { warn "腾讯镜像失败,试 Google 直链"; wget -q --show-progress "$CMDLINE_TOOLS_URL_GOOGLE"; }
    fi
    rm -rf /tmp/cmdline-tools   # 清掉上次没解完的残留
    unzip -q "$CMDLINE_TOOLS_ZIP"
    mkdir -p "$BW_SDK/cmdline-tools"
    rm -rf "$SDK_NEW"   # 万一上次解了一半
    mv /tmp/cmdline-tools "$SDK_NEW"
    rm -f "$CMDLINE_TOOLS_ZIP"
else
    log "[4/7] 复用已装的 cmdline-tools:$SDK_NEW"
fi

# 检查 SDK 组件是否齐(避免每次都跑 sdkmanager,慢)
if [[ ! -d "$BW_SDK/platforms/$PLATFORM_VERSION" ]] || [[ ! -d "$BW_SDK/build-tools/$BUILD_TOOLS_VERSION" ]]; then
    log "      接受 SDK license + 装 $PLATFORM_VERSION / build-tools;$BUILD_TOOLS_VERSION / platform-tools"
    yes | "$SDK_NEW/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
    yes | "$SDK_NEW/bin/sdkmanager" \
        "platforms;$PLATFORM_VERSION" \
        "build-tools;$BUILD_TOOLS_VERSION" \
        "platform-tools"
else
    log "      SDK 组件已齐:platforms/$PLATFORM_VERSION + build-tools/$BUILD_TOOLS_VERSION"
fi

# ---------- 5/7 fallback=webview + gradle 镜像 patch + bubblewrap update ----------
log "[5/7] 配 fallbackType=webview + gradle 镜像 + update 项目"

TWA_MANIFEST="$PROJECT/twa-manifest.json"
GRADLE_WRAPPER="$PROJECT/gradle/wrapper/gradle-wrapper.properties"

# 改 fallbackType(只在不是 webview 时改 + update,避免每次重跑都 update)
need_update=0
if ! grep -q '"fallbackType": "webview"' "$TWA_MANIFEST"; then
    log "      改 fallbackType: customtabs → webview(国产 ROM TWA 不通的兜底)"
    sed -i 's/"fallbackType": "customtabs"/"fallbackType": "webview"/' "$TWA_MANIFEST"
    need_update=1
fi

if [[ "$need_update" == "1" ]]; then
    log "      bubblewrap update(把 fallbackType 写进生成的 Java 代码)"
    cd "$PROJECT"
    bubblewrap update
fi

# patch gradle 镜像(必须在 update 之后,因为 update 会覆盖 gradle-wrapper.properties)
if grep -q "$GRADLE_OFFICIAL" "$GRADLE_WRAPPER" 2>/dev/null; then
    log "      patch gradle wrapper 镜像 → 腾讯"
    sed -i "s|$GRADLE_OFFICIAL|$GRADLE_MIRROR|g" "$GRADLE_WRAPPER"
fi
grep distributionUrl "$GRADLE_WRAPPER"

# ---------- 6/7 bubblewrap build ----------
log "[6/7] bubblewrap build(首次 ~5 min,后续 1-3 min)"
log "      若被问到 keystore 密码 — 输入(或粘贴):$KEY_PASS"
cd "$PROJECT"
{ echo "$KEY_PASS"; echo "$KEY_PASS"; } | bubblewrap build || bubblewrap build

APK=$(ls -t "$PROJECT"/*-release-signed.apk 2>/dev/null | head -1 || true)
[[ -n "${APK:-}" && -f "$APK" ]] || { err "build 没产出 APK,看上面日志"; exit 1; }
APK_MD5=$(md5sum "$APK" | awk '{print $1}')
log "      APK: $APK ($(du -h "$APK" | awk '{print $1}'),md5=$APK_MD5)"

# ---------- 7/7 SHA256 + assetlinks + nginx + 完事 ----------
log "[7/7] 生成 assetlinks + patch nginx + 完成"

SHA256=$(
    keytool -list -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" -storepass "$KEY_PASS" 2>/dev/null \
        | awk '/SHA256:/ {print $2; exit}'
)
[[ -n "$SHA256" ]] || { err "提取 SHA256 失败"; exit 1; }
PACKAGE_ID=$(python3 -c "import json; print(json.load(open('$TWA_MANIFEST'))['packageId'])")
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
log "      assetlinks → $WELLKNOWN/assetlinks.json"
log "      package: $PACKAGE_ID"
log "      sha256:  $SHA256"

# patch nginx
NGINX_CONF="/etc/nginx/sites-available/cc-workflow"
if [[ ! -f "$NGINX_CONF" ]]; then
    warn "      $NGINX_CONF 不存在,跳过 nginx patch(自己加 location 块)"
elif grep -q "well-known/assetlinks" "$NGINX_CONF"; then
    log "      nginx 已经配过 assetlinks,跳过"
else
    log "      patch nginx 加 /.well-known/assetlinks.json location"
    # 用 python 在 server { ... } 块的最后一个 } 之前插入。
    # 比 sed/awk 可靠(server_name 后面可能有多层 location 嵌套)。
    sudo python3 - "$NGINX_CONF" "$WELLKNOWN/assetlinks.json" <<'PY'
import sys, pathlib, re
path = pathlib.Path(sys.argv[1])
asset_file = sys.argv[2]
text = path.read_text()
snippet = f"""
    # Digital Asset Links — TWA APK 通过这个文件验证它有权"无 URL bar 全屏"
    # 打开本站。WebView fallback 模式下这个文件也用得上(虽然 fallback 自己
    # 不校验 assetlinks,但 TWA-capable 设备上还是优先走 TWA 路径)。
    location = /.well-known/assetlinks.json {{
        alias {asset_file};
        default_type application/json;
        add_header Access-Control-Allow-Origin "*";
    }}
"""
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

# ---------- 完成提示 ----------
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
✅ 完成

   APK:     $APK
   大小:    $(du -h "$APK" | awk '{print $1}')
   md5:     $APK_MD5
   package: $PACKAGE_ID
   sha256:  $SHA256

📱 把 APK 传到手机(任选其一):

   方法 A:scp 拉到本地后 AirDrop / USB
     scp \$SERVER:$APK ~/Downloads/

   方法 B:服务器临时起 http(同 wifi 时方便)
     cd $(dirname "$APK") && python3 -m http.server 9000
     手机浏览器打开 http://\$SERVER_IP:9000/$(basename "$APK")

   装的时候手机会提示"未知来源",允许即可。

📱 装完后的预期:

   设备有支持 TWA 的 Chromium 系浏览器(Chrome / Brave / Samsung Internet
   等)→ 全屏无 URL bar(走 TWA 模式)
   设备没有 / 国产 ROM 拦 Custom Tabs → 自动降级 WebView 渲染,平时全屏,
   用户下拉时会短暂出现 URL bar(Bubblewrap 反钓鱼设计,关不掉)

   两种行为都是正常的。

🔁 后续重打(域名 / packageId 不变):
     bash $0 https://$HOST
   keystore / SDK / cmdline-tools / nginx 配置都会复用,只重新 build APK
   (1-3 min)。注意 bubblewrap update 会覆盖 gradle 镜像配置,脚本会自动
   重新 patch。

📦 前端代码改了不用重打 APK——APK 只是空壳,每次启动从
   https://$HOST/pwa/ 拉最新 app.js。

🗑  想完全重来:rm -rf $WORK $BW_SDK && bash $0 https://$HOST
EOF
