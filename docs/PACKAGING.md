# 打包说明

## Windows 桌面版

本项目使用 Tauri 2 打包桌面应用。以下依赖只面向开发者或 CI 构建机，最终用户不需要安装：

- Node.js 20.x 或更高版本。
- Corepack。
- Rustup / Rust MSVC 工具链。
- Visual Studio 2022 Build Tools，并安装 C++ build tools workload。

本机已验证可用的打包命令：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
corepack pnpm tauri:build
```

默认成功后产物位于：

- `src-tauri/target/release/danmaku_timeline_studio.exe`
- `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`

如果构建环境设置了 `CARGO_TARGET_DIR`，产物会输出到该目录下的 `release/bundle/nsis/`。当前配置只生成 NSIS `setup.exe`，优先用于普通 Windows 用户分发；MSI 可在后续企业分发阶段再启用。

最终用户安装和运行 NSIS 包时不需要 Node.js、pnpm、Rust 或 Visual Studio Build Tools。Windows 10/11 通常已预装 WebView2 Runtime；若目标机器缺失 WebView2，应按安装器提示或微软官方运行时安装指引补齐。

## Web 生产构建

仅构建 Web 静态文件：

```powershell
corepack pnpm build
```

产物位于 `dist/`。该版本仍运行在浏览器环境中，Emby 订阅库请求可能受到 CORS 限制。

## 注意事项

- Tauri 配置中的构建命令使用 `corepack pnpm ...`，避免调用全局 pnpm 导致 Node 版本不兼容。
- `src-tauri/icons/` 中的图标由 `src-tauri/app-icon.svg` 生成，若更新图标源，可运行 `corepack pnpm tauri icon src-tauri/app-icon.svg` 后重新打包。
- 当前 Windows 安装包未签名，首次运行或安装时可能出现 Windows SmartScreen 提示。
- 桌面端 Emby 元数据请求通过 Tauri `emby_http_request` 后端代理，并限制协议、方法和可转发请求头；Web 构建仍可能受浏览器 CORS 限制。
- C137 的正式分集导出只在桌面端可用：写盘命令会再次计算所有依赖媒体的全文件 SHA-256，并拒绝浏览器下载降级。未经真实校准的 `review/blocked/legacy-unverified` 时间图不会进入该写盘路径。
