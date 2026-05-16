# TWA(Trusted Web Activity)打包成 Android APK

> 把 PWA 套一层 Chrome WebView 壳 → APK 装到手机 → 桌面图标点开 = 全屏沉浸,
> 没浏览器 URL bar、没底部 nav。**Web 代码 0 改动**,以后改 PWA 也不用
> 重打 APK(TWA 是动态加载 `https://naniwet.top/pwa/`)。
>
> 为啥不直接装 Chrome 然后 "Install app":中国常见浏览器(夸克/QQ/UC)
> PWA install 体验残废,不想强迫装 Chrome 就走 TWA;或者纯粹想要个
> "桌面图标 + 应用列表里有 cc-workflow"的仪式感。

---

## 0. 前置条件

- HTTPS 必须可用:`https://naniwet.top/pwa/manifest.json` 能 `curl` 到 200
  + valid TLS。**TWA 不接受 HTTP** —— Chrome 拒绝
- 域名外部可达(本机能开但 SSL Labs / 别的 IP 打不开 → TWA 装上后白屏)
- Mac dev box(写指南时假定 macOS,Linux 类似)

## 1. 装依赖(一次性,~10 min)

```bash
# JDK 17(Bubblewrap 要求 ≥ 17,Bubblewrap doctor 会校验)
brew install openjdk@17
echo 'export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
java -version    # 期望:openjdk version "17.x.x"

# Bubblewrap CLI(Google 官方 TWA 打包工具)
npm install -g @bubblewrap/cli
bubblewrap --version

# 第一次跑会让你装 Android SDK + build tools,跟 prompt 走即可:
bubblewrap doctor
# 提示缺啥就 Y 装啥。装完会写到 ~/.bubblewrap/llama.config.json
```

## 2. 从 manifest 生成 Android 项目

```bash
mkdir -p ~/twa-cc-workflow && cd ~/twa-cc-workflow
bubblewrap init --manifest=https://naniwet.top/pwa/manifest.json
```

互动 prompt 会问:

| 字段 | 建议值 |
|---|---|
| Domain | `naniwet.top` |
| URL path | `/pwa/` |
| Application name | `cc-workflow` |
| Short name | `cc-workflow` |
| Display mode | `fullscreen`(跟 manifest 一致) |
| Orientation | `default` |
| Status bar color | `#1a73e8`(跟 theme-color 一致) |
| Background color | `#0b0b0d` |
| Icon URL | 用默认(从 manifest 的 192/512 png 抓) |
| Maskable icon URL | 留空(没就没了) |
| Notification icon | 留空 |
| **App package name** | `com.naniwet.ccworkflow`(随便,符合反域名规范即可,**装完一旦确定就别再改**) |
| **Signing key path** | 默认 `./android.keystore`(本地生成的 keystore,务必备份!丢了以后改 APK 就装不上去) |
| Key alias | `android` |
| Key password / store password | 设一个,记好 |

成功后输出 SHA256 fingerprint,类似:
```
SHA256 Fingerprint: AA:BB:CC:DD:...:99
```

**这串记下来,下一步要用。**(忘了可以 `bubblewrap fingerprint` 重新查。)

## 3. 在服务器部署 `assetlinks.json`(关键 —— 没这步 TWA 会顶部多一条 "naniwet.top" address bar)

### 3.1 文件内容

把上一步的 SHA256 填进去,放到服务器某路径,比如 `/etc/cc-workflow/well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.naniwet.ccworkflow",
    "sha256_cert_fingerprints": [
      "AA:BB:CC:DD:...:99"
    ]
  }
}]
```

### 3.2 nginx 加一条 location 把 well-known 暴露出来

编辑 `/etc/nginx/sites-available/cc-workflow`,在已有 location 之上加:

```nginx
# Digital Asset Links — Chrome / TWA fetch this at app launch to verify
# the APK's signing key matches the domain owner. 没这条 TWA 显示 URL
# bar(degraded mode)。
location = /.well-known/assetlinks.json {
    alias /etc/cc-workflow/well-known/assetlinks.json;
    default_type application/json;
    add_header Access-Control-Allow-Origin "*" always;
}
```

```bash
sudo mkdir -p /etc/cc-workflow/well-known
sudo $EDITOR /etc/cc-workflow/well-known/assetlinks.json   # 粘贴上面 JSON
sudo nginx -t && sudo systemctl reload nginx
```

### 3.3 验证

```bash
curl -s https://naniwet.top/.well-known/assetlinks.json | jq .
# 期望返回上面的 JSON,Content-Type: application/json
```

Google 官方还有个 Statement List Tester:
https://developers.google.com/digital-asset-links/tools/generator

## 4. 打包 APK

```bash
cd ~/twa-cc-workflow
bubblewrap build
```

10-30 秒后输出 `app-release-signed.apk` 在当前目录。

## 5. 装到手机

### 5.1 传输

任选其一:
- USB 数据线 + `adb install app-release-signed.apk`(需先在手机开发者选项里开 USB 调试)
- 或者把 APK 上传到云盘 / 微信传给自己,手机下载

### 5.2 装

手机弹"未知来源应用"警告 → 允许 → 装。

(Android 8+:在系统设置 → 应用与通知 → 高级 → 特殊应用访问 → 安装未知应用 → 给"文件管理器"或"浏览器"放行。)

### 5.3 验证

打开桌面 cc-workflow 图标:
- **没** URL bar(顶部不应该有 naniwet.top 横条)
- **没** 底部 ← → +
- 启动画面用了 `theme-color` 蓝
- 进入 → 像原生 app

如果顶部仍有 URL 横条 → assetlinks 没生效,回到 3.3 用 curl 复查。

## 6. 升级 PWA 时怎么办

**99% 情况:啥都不用动。** TWA 是个 thin wrapper,运行时去 `https://naniwet.top/pwa/` 加载,你改 PWA 代码 → 用户下次打开自动拿新版(走 SW 缓存策略)。

**1% 情况下需要重打 APK:**
- 改 PWA manifest 里的 `name` / `start_url` / `display` / `theme_color`
- 改 app icon
- 换 package name(本来就不能改)
- 升 Android target SDK

重打就是 `bubblewrap update && bubblewrap build`,版本号自动 +1,重新 sideload 一次。

## 常见坑

| 现象 | 排查 |
|---|---|
| APK 装上打开白屏 | 域名外部不可达 / HTTPS cert 过期。手机 4G 网络 `curl https://naniwet.top` 看是不是返回 200 |
| 顶部有 URL bar 横条 | `assetlinks.json` 没部署 / SHA256 写错 / Content-Type 不是 application/json。`curl -I https://.../.well-known/assetlinks.json` 检查 |
| 升级 PWA 后 APK 仍显示老版 | Chrome WebView 的 SW 缓存。手机里"应用 → cc-workflow → 存储 → 清除数据" |
| Bubblewrap doctor 抱怨 JDK 版本 | macOS 默认 java 是 Apple 自己那个,brew 装的 17 没加 PATH。重 source `~/.zshrc` |
| 微信 / QQ 内传 APK 收到的是 `.1` / 重命名后缀 | 改回 `.apk` 再装 |

## 7. 备份重要文件

**`android.keystore` 一旦丢:这个 package_name 永远没法发新版 APK**(Android 用 signing key 校验 update,key 不匹配等于"另一个 app")。

```bash
# 至少备一份到云盘 / 1Password / 别的不一起丢的地方
cp ~/twa-cc-workflow/android.keystore ~/Backup/cc-workflow-android.keystore
# 同时记下 store password / key password
```

`assetlinks.json` 也跟着 keystore 走 —— 重打 APK key 没变就不用重发 assetlinks。

---

## 卸载 / 回退

- 手机长按 cc-workflow 图标 → 卸载
- 服务器删 `/etc/cc-workflow/well-known/assetlinks.json`(可选,留着无害)
- 删本地 `~/twa-cc-workflow/`(可选,留着以后还能 `bubblewrap build`)

回退后 PWA 还是能在 https://naniwet.top/pwa/ 用,任何浏览器都能访问。
