#!/usr/bin/env bash
#
# scripts/build-webview-apk.sh — 一键打 cc-workflow 的纯 WebView APK
# (彻底无 toolbar / URL bar 版本)。
#
# 跟 build-twa-apk.sh 的对照:
#
#   build-twa-apk.sh                  build-webview-apk.sh
#   ──────────────────────────────    ──────────────────────────────
#   用 bubblewrap                     不用 bubblewrap,自己写 80 行 Kotlin
#   TWA + WebView fallback 双模       只走 WebView,完全自己控制 UI
#   fallback 模式有反钓鱼 toolbar     全屏 immersive,无任何 toolbar
#                                     (向下边缘下拉时状态栏短暂出现,
#                                      Android 系统强制,改不掉)
#   APK 1-2 MB                        APK ~3 MB
#   先决条件:bubblewrap CLI          先决条件:已经跑过 build-twa-apk.sh
#                                     一次(复用其 SDK + gradle wrapper +
#                                     keystore — 不重新下 ~300MB 工具链)
#
# 什么时候用这个脚本(而不是 build-twa-apk):
#   - 国产 ROM 拦 Custom Tabs intent,build-twa-apk 的 WebView fallback 顶部
#     "✕ naniwet.top  share  ⋮" toolbar 让你不爽,想全屏无干扰
#   - 不在乎 TWA fast path —— 反正国产 ROM 用户接触不到
#   - 想要代码完全自己控制,不被 bubblewrap 上游变化影响
#
# 跟 build-twa-apk 共享什么(复用而不是重做):
#   - Android SDK    ~/.bubblewrap/android_sdk/(platforms / build-tools /
#                    cmdline-tools — 都是 build-twa-apk 装的)
#   - gradle wrapper ~/.cc-state/twa-build/project/gradlew + gradle/wrapper/
#                    (避免再下一份 ~150MB gradle)
#   - keystore       ~/.cc-state/twa-build/project/android.keystore
#                    (同一份 → APK 签名相同 → 跟 TWA 版无缝替换)
#   - packageId      读 ~/.cc-state/twa-build/project/twa-manifest.json
#                    (跟 TWA 版同一个 → 装到手机直接替换 TWA 版,不会并存)
#
# 用法:
#   bash scripts/build-webview-apk.sh https://your.domain.com
#
# 跑完:
#   APK 输出到 ~/.cc-state/webview-build/cc-workflow-webview.apk(~3 MB)
#
# Idempotent:重复跑安全,~30 秒出新 APK(gradle 缓存命中)。
#
set -euo pipefail

err()  { printf '\e[31m[build-wv]\e[0m %s\n' "$*" >&2; }
log()  { printf '\e[32m[build-wv]\e[0m %s\n' "$*"; }
warn() { printf '\e[33m[build-wv]\e[0m %s\n' "$*"; }
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

# ---------- 路径 ----------
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORK="${HOME}/.cc-state/webview-build"
PROJECT="$WORK/project"

TWA_WORK="${HOME}/.cc-state/twa-build"
TWA_PROJECT="$TWA_WORK/project"
BW_SDK="${HOME}/.bubblewrap/android_sdk"

PLATFORM_VERSION="android-36"
BUILD_TOOLS_VERSION="35.0.0"
APKSIGNER="$BW_SDK/build-tools/$BUILD_TOOLS_VERSION/apksigner"
ZIPALIGN="$BW_SDK/build-tools/$BUILD_TOOLS_VERSION/zipalign"

KEYSTORE="$TWA_PROJECT/android.keystore"
KEY_PASS_FILE="$TWA_WORK/.keystore-pass"
KEY_ALIAS="android"

mkdir -p "$WORK"

# ---------- 1/5 先决条件检查 ----------
log "[1/5] 检查先决条件"
for cmd in java keytool python3; do
    have "$cmd" || { err "缺 $cmd"; exit 1; }
done

[[ -d "$BW_SDK/platforms/$PLATFORM_VERSION" ]] && [[ -d "$BW_SDK/build-tools/$BUILD_TOOLS_VERSION" ]] || {
    err "Android SDK 组件没装齐:$BW_SDK/{platforms/$PLATFORM_VERSION,build-tools/$BUILD_TOOLS_VERSION}"
    err "先跑一次:bash $SCRIPT_DIR/build-twa-apk.sh $DOMAIN"
    err "(它会自动装 cmdline-tools + 接受 license + 装 platforms/build-tools)"
    exit 1
}

[[ -f "$KEYSTORE" && -f "$KEY_PASS_FILE" ]] || {
    err "TWA 脚本的 keystore 不存在:$KEYSTORE"
    err "先跑一次 build-twa-apk.sh 让它生成 keystore;两个脚本共享这份签名,以便"
    err "WebView APK 能直接替换 TWA APK,不会在桌面并存两个图标"
    exit 1
}
KEY_PASS=$(cat "$KEY_PASS_FILE")

[[ -x "$TWA_PROJECT/gradlew" ]] || {
    err "TWA project 的 gradlew 不存在:$TWA_PROJECT/gradlew"
    err "先跑一次 build-twa-apk.sh,本脚本会复用它的 gradle wrapper(省 ~150 MB 下载)"
    exit 1
}

# packageId 跟 TWA 一致(从 twa-manifest 读)
PACKAGE_ID=$(python3 -c "import json; print(json.load(open('$TWA_PROJECT/twa-manifest.json'))['packageId'])")
PACKAGE_PATH=$(echo "$PACKAGE_ID" | tr '.' '/')
log "      复用 TWA packageId: $PACKAGE_ID"
log "      复用 keystore: $KEYSTORE"
log "      复用 gradle wrapper: $TWA_PROJECT/gradlew"

# ---------- 2/5 生成项目骨架(每次重新生成,模板永远是最新版) ----------
log "[2/5] 生成 Android 项目骨架"
rm -rf "$PROJECT"
mkdir -p "$PROJECT/app/src/main/java/$PACKAGE_PATH"
mkdir -p "$PROJECT/app/src/main/res/values"
mkdir -p "$PROJECT/app/src/main/res/mipmap-xhdpi"

# --- settings.gradle ---
cat > "$PROJECT/settings.gradle" <<'EOF'
pluginManagement {
    repositories {
        maven { url 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/' }
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositories {
        // 腾讯镜像在前(国内拉 Google Maven / Maven Central 不稳定时兜底)
        maven { url 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/' }
        google()
        mavenCentral()
    }
}
rootProject.name = 'cc-workflow'
include ':app'
EOF

# --- build.gradle (root) ---
cat > "$PROJECT/build.gradle" <<'EOF'
plugins {
    id 'com.android.application' version '8.5.0' apply false
    id 'org.jetbrains.kotlin.android' version '1.9.0' apply false
}
EOF

# --- gradle.properties ---
cat > "$PROJECT/gradle.properties" <<'EOF'
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
EOF

# --- local.properties ---
echo "sdk.dir=$BW_SDK" > "$PROJECT/local.properties"

# --- app/build.gradle(把 keystore 路径 / 密码内联进去,signingConfigs.release) ---
cat > "$PROJECT/app/build.gradle" <<EOF
plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace '$PACKAGE_ID'
    compileSdk 36

    defaultConfig {
        applicationId "$PACKAGE_ID"
        minSdk 21
        targetSdk 36
        versionCode 100
        versionName "1.0-webview"
    }

    signingConfigs {
        release {
            storeFile file('$KEYSTORE')
            storePassword '$KEY_PASS'
            keyAlias '$KEY_ALIAS'
            keyPassword '$KEY_PASS'
        }
    }

    buildTypes {
        release {
            minifyEnabled false
            signingConfig signingConfigs.release
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.7.0'
    implementation 'androidx.core:core-ktx:1.13.1'
    implementation 'androidx.activity:activity-ktx:1.9.0'
}
EOF

# --- AndroidManifest.xml ---
cat > "$PROJECT/app/src/main/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.CCWorkflow"
        android:allowBackup="false"
        android:supportsRtl="true">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout|uiMode"
            android:launchMode="singleTop">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
EOF

# --- MainActivity.kt(URL 内联) ---
cat > "$PROJECT/app/src/main/java/$PACKAGE_PATH/MainActivity.kt" <<EOF
package $PACKAGE_ID

import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = WebViewClient()  // 阻止跳到外部浏览器
            loadUrl("https://$HOST/pwa/")
        }
        setContentView(webView)

        // 后退键:WebView 内部 goBack;到顶后退出 app
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onResume() {
        super.onResume()
        applyImmersive()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    // Immersive sticky:藏状态栏 + 导航栏。用户从屏幕边缘下拉时短暂出现 3 秒,
    // 然后自动隐藏。这是 Android 系统强制的安全设计("逃生口"),改不掉。
    private fun applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
EOF

# --- res/values/strings.xml ---
cat > "$PROJECT/app/src/main/res/values/strings.xml" <<'EOF'
<resources>
    <string name="app_name">cc-workflow</string>
</resources>
EOF

# --- res/values/themes.xml ---
cat > "$PROJECT/app/src/main/res/values/themes.xml" <<'EOF'
<resources>
    <style name="Theme.CCWorkflow" parent="Theme.AppCompat.NoActionBar">
        <item name="android:windowNoTitle">true</item>
        <item name="android:windowActionBar">false</item>
        <item name="android:windowFullscreen">true</item>
        <item name="android:windowContentOverlay">@null</item>
        <item name="android:windowBackground">@android:color/black</item>
        <item name="android:statusBarColor">@android:color/transparent</item>
        <item name="android:navigationBarColor">@android:color/transparent</item>
    </style>
</resources>
EOF

# --- 图标:优先用仓库根的 pwa/icon-512.png,fallback 到 bubblewrap project 的 ---
ICON_SRC=""
if [[ -f "$REPO_ROOT/pwa/icon-512.png" ]]; then
    ICON_SRC="$REPO_ROOT/pwa/icon-512.png"
elif [[ -f "$REPO_ROOT/pwa/icon-192.png" ]]; then
    ICON_SRC="$REPO_ROOT/pwa/icon-192.png"
else
    # 从 bubblewrap project 找
    ICON_SRC=$(find "$TWA_PROJECT/app/src/main/res" -name "ic_launcher.png" 2>/dev/null | head -1)
fi

if [[ -n "$ICON_SRC" && -f "$ICON_SRC" ]]; then
    cp "$ICON_SRC" "$PROJECT/app/src/main/res/mipmap-xhdpi/ic_launcher.png"
    log "      icon: $ICON_SRC"
else
    warn "找不到任何 icon 源,生成纯色占位 PNG"
    python3 -c "
import struct, zlib
w, h = 192, 192
img = b''.join(b'\\x00' + b'\\x1a\\x73\\xe8' * w for _ in range(h))
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = b'\\x89PNG\\r\\n\\x1a\\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(img))
png += chunk(b'IEND', b'')
open('$PROJECT/app/src/main/res/mipmap-xhdpi/ic_launcher.png', 'wb').write(png)
"
fi

# --- 复用 TWA 的 gradle wrapper(避免再下 gradle distribution) ---
cp -r "$TWA_PROJECT/gradle" "$PROJECT/"
cp "$TWA_PROJECT/gradlew" "$PROJECT/"
chmod +x "$PROJECT/gradlew"
# 镜像 patch(TWA 脚本已经 patch 过,但保险起见再 patch 一次)
sed -i 's|services.gradle.org/distributions|mirrors.cloud.tencent.com/gradle|g' \
    "$PROJECT/gradle/wrapper/gradle-wrapper.properties"

# ---------- 3/5 gradle build ----------
log "[3/5] gradle assembleRelease(首次 ~3 min,后续 30s)"
cd "$PROJECT"
./gradlew assembleRelease

# AGP signingConfig 已经签好,APK 落在 release 目录
SIGNED=$(find "$PROJECT/app/build/outputs/apk/release" -name "*-release.apk" 2>/dev/null | head -1)
[[ -n "$SIGNED" && -f "$SIGNED" ]] || { err "gradle build 没产出 APK"; exit 1; }

APK="$WORK/cc-workflow-webview.apk"
cp "$SIGNED" "$APK"

# ---------- 4/5 验证签名 ----------
log "[4/5] 验证 APK 签名"
if ! "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -q 'Signer'; then
    warn "gradle signingConfig 签名验证失败,手动 zipalign + apksigner v3 重签"
    UNSIGNED=$(find "$PROJECT/app/build/outputs/apk" -name "*-release-unsigned*.apk" | head -1)
    [[ -z "$UNSIGNED" ]] && UNSIGNED="$SIGNED"
    "$ZIPALIGN" -f -p 4 "$UNSIGNED" "${APK}.aligned"
    "$APKSIGNER" sign \
        --ks "$KEYSTORE" \
        --ks-key-alias "$KEY_ALIAS" \
        --ks-pass "pass:$KEY_PASS" \
        --key-pass "pass:$KEY_PASS" \
        --out "$APK" \
        "${APK}.aligned"
    rm -f "${APK}.aligned"
fi

APK_MD5=$(md5sum "$APK" | awk '{print $1}')
APK_SIZE=$(du -h "$APK" | awk '{print $1}')

# ---------- 5/5 完成 ----------
log "[5/5] 完成"
echo

cat <<EOF
✅ 完成

   APK:     $APK
   大小:    $APK_SIZE
   md5:     $APK_MD5
   package: $PACKAGE_ID(跟 TWA 版同一个)
   URL:     https://$HOST/pwa/

📱 装到手机:

   方法 A:scp 拉到本地
     scp \$SERVER:$APK ~/Downloads/

   方法 B:服务器临时起 http
     cd $WORK && python3 -m http.server 9000
     手机浏览器:http://\$SERVER_IP:9000/cc-workflow-webview.apk

📱 packageId 跟 TWA 版相同,装的时候 Android 会识别为"升级":
   - 直接装 → 替换原 TWA 版,桌面图标不变
   - 数据(WebView cookie / localStorage / SW cache)清空——是好事,
     旧版的 stale state 不会污染新版

📱 装完后预期:
   - 点图标 → 直接全屏 WebView,无 toolbar / 无 URL bar
   - 状态栏 / 导航栏自动隐藏(immersive sticky)
   - 从屏幕边缘下拉手势 → 状态栏短暂出现 3 秒,然后自动隐藏
     (Android 系统强制的安全设计,任何方案都改不掉)
   - 后退键 → WebView 内 goBack;到顶则退出 app

📦 前端代码改了不用重打 APK——APK 只是个 WebView 空壳,
   每次启动从 https://$HOST/pwa/ 拉最新 app.js / style.css。

🔁 后续重打:
     bash $0 https://$HOST
   keystore / SDK / gradle wrapper 都复用,~30 秒出 APK。

🗑  想完全重来:rm -rf $WORK && bash $0 https://$HOST
   (不会动 TWA 那份,两个脚本互不干扰)

⚖  对照:如果想换回 TWA 版(有 toolbar 但 TWA-capable 设备体验更好):
     bash $SCRIPT_DIR/build-twa-apk.sh https://$HOST
EOF
