# 打包说明

## Windows 桌面版

本项目使用 Tauri 2 打包桌面应用。Windows 本机需要安装：

- Node.js 20.x 或更高版本。
- Corepack。
- Rustup / Rust MSVC 工具链。
- Visual Studio 2022 Build Tools，并安装 C++ build tools workload。

本机已验证可用的打包命令：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
corepack pnpm tauri build
```

成功后产物位于：

- `src-tauri/target/release/danmaku_timeline_studio.exe`
- `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Danmaku Timeline Studio_0.1.0_x64_en-US.msi`

优先分发 NSIS `setup.exe`。MSI 可用于企业或系统级安装流程。

## Web 生产构建

仅构建 Web 静态文件：

```powershell
corepack pnpm build
```

产物位于 `dist/`。该版本仍运行在浏览器环境中，Emby 订阅库请求可能受到 CORS 限制。

## 注意事项

- Tauri 配置中的构建命令使用 `corepack pnpm ...`，避免调用全局 pnpm 导致 Node 版本不兼容。
- 当前 Windows 安装包未签名，首次运行或安装时可能出现 Windows SmartScreen 提示。
- 当前桌面壳仍使用前端直连 Emby，尚未实现 Tauri 后端代理。
