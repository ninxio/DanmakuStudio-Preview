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

## C137 安装级人工验证状态

人工 `verified` 的 HMAC-SHA256 secret 不会编入安装包，也不会写入 `.danmaku-project.json`。它在用户首次明确签发时由 Tauri 使用系统随机数生成，保存在该安装的应用本地数据目录；同目录还保存以原子 rename 提交的不可变签发/撤销事件。项目文件只携带可审计的签名元数据和撤销回执。

打开项目时，应用先把 signed map 当作 `review`，再查询本机事件注册表。把项目复制到另一台电脑、删除应用本地数据、丢失 secret、损坏注册表或更换 issuer 后，旧 record 都会 fail-closed，不能仅凭项目 JSON 恢复 `verified`；用户需要在新安装上重新连接同一媒体并重新完成 A/B 复核。卸载或清理应用数据前若需要保留项目，请注意项目文件本身不包含可迁移的信任根。

当前威胁边界是“项目 JSON 单独被修改或移机”：它不能伪造 HMAC，也不能在原安装上删除权威撤销状态。secret 目前依赖应用数据目录和系统账户权限，并非 Windows Credential Manager/TPM 密钥；具有同账户应用数据读写能力的恶意本地进程不在这一保证范围内。

## C137 benchmark 与完整验收边界

桌面包包含匹配页折叠的“高级：C137 精度基准”入口，但它只运行 TimeMap 组件级开发验收。用户导入本机 manifest v2 后，应用把完整清单投影成不含 gold、split、场景、复核者或仲裁答案的 blind `RunManifest`，并重新核验真实媒体的全文件身份及显式音视频流。`RunManifest` 使用 canonical JSON SHA-256 与通过的 preflight receipt 绑定；blind runner 随后调用与产品匹配相同的 Tauri `start/get/cancel_audio_alignment_job` 和 Rust Alignment V2，不使用测试预测或前端伪结果。

生产请求会显式传递参考/原片音轨和视频流。Rust 结果还会回报视觉 fallback/校验实际消费的视频流，runner 必须复核这些流，且视觉缓存按实际流索引隔离。每个 case 的 sealed receipt 记录成功、失败或取消、单调时钟 wall elapsed、engine/feature、实际视觉流和去敏参数摘要。只有所有真实 case 成功并与 blind SHA-256 一致时才揭示 gold 进行组件评估；失败、取消或未确认安全退出都会令 `evaluation=null`，超时任务未退出时也不会继续启动下一 case。

从高级入口下载的 JSON 采用独立 schema 和 validator，固定标记 `scope: "time-map-component"`、`releaseEligible: false`。报告不包含本地媒体路径、媒体 SHA-256、生产参数 hash 或原始诊断。组件子闸门即使通过，也不等于 release 通过，不会改变项目的人工签发状态或授予 `verified`。

完整 release 验收另需严格的 `C137AcceptanceBundle` 和外部 `trustContext`。外部信任根必须对受信 protocol、数据审批/preflight/prediction receipts 及每类 raw report evidence 提供 canonical SHA-256；内嵌 evidence digest 不能自我批准。安装包默认不携带任何审批白名单或 trust context，因此缺少外部受信摘要时必定返回 `incomplete-evidence`，保持 fail-closed。

release 不携带真实媒体、gold、许可材料或 raw 性能记录。当前仓库也没有用于采集和冻结真实关系的生成器，亦没有在规定硬件上生成冷/热缓存耗时、进程树峰值 RSS、取消延迟等性能 evidence 的生成器；安装包中的 UI 与 evaluator 不能替代这些外部数据生产和审批步骤。

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
- Web 构建没有安装级 secret、签发命令或权威撤销注册表，因此只能展示/编辑复核状态，不能签发、恢复或撤销人工 `verified`。
- release 不打包真实媒体 benchmark。仓库中的 manifest v2 文件是 `isExample=true` 的 placeholder；实际数据集路径、全文件身份和授权说明由评测者保留在本机，运行前通过 Tauri preflight 重新核对媒体身份和显式流索引。
- 当前真实媒体关系数仍为 0，尚未完成统计校准、规定硬件性能报告、20 套北极星长合集验收；A/B token 也尚无最小播放时长门槛。因此现阶段安装包是 fail-closed 的工程预览，不能作为准确率、性能或人工观看充分性的验收证明。
