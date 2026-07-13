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

当前安装包已包含可选 CUDA/cuFFT 声谱后端，但不随应用分发 CUDA Toolkit 或 cuFFT runtime。目标机器只有在 NVIDIA driver、cuFFT 动态库、CUDA context 和真实 R2C smoke 全部通过时才会报告 GPU ready；默认 auto 模式下初始化或执行失败会丢弃 GPU 中间结果并从头使用 CPU 重算，强制 CUDA 模式则 fail-closed。4090 当前只加速不超过 60 分钟短媒体的共享声谱 FFT；FFmpeg `-vn` 音频解码、长媒体 streaming coarse、全文件 SHA-256、landmark 配对、edit-aware DP、边界精修和项目级搜索仍使用 CPU，也尚未实现 GPU 批量相关。FFmpeg 显示 CUDA/NVDEC 硬件解码能力不等于音频匹配已获得这些加速。

## C137 安装级人工验证状态

人工 `verified` 的 HMAC-SHA256 secret 不会编入安装包，也不会写入 `.danmaku-project.json`。它在用户首次明确签发时由 Tauri 使用系统随机数生成，保存在该安装的应用本地数据目录；同目录还保存以原子 rename 提交的不可变签发/撤销事件。项目文件只携带可审计的签名元数据和撤销回执。

打开项目时，应用先把 signed map 当作 `review`，再查询本机事件注册表。把项目复制到另一台电脑、删除应用本地数据、丢失 secret、损坏注册表或更换 issuer 后，旧 record 都会 fail-closed，不能仅凭项目 JSON 恢复 `verified`；用户需要在新安装上重新连接同一媒体并重新完成 A/B 复核。卸载或清理应用数据前若需要保留项目，请注意项目文件本身不包含可迁移的信任根。

当前威胁边界是“项目 JSON 单独被修改或移机”：它不能伪造 HMAC，也不能在原安装上删除权威撤销状态。secret 目前依赖应用数据目录和系统账户权限，并非 Windows Credential Manager/TPM 密钥；具有同账户应用数据读写能力的恶意本地进程不在这一保证范围内。

## Windows 媒体工具进程边界

安装包内的 Windows 后端用共同 lifecycle Job Object 执行一次性 FFmpeg/FFprobe 与受控系统探测。每个子进程先以挂起状态创建，加入私有 kill-on-close Job 后才恢复；只允许显式标准流句柄继承，stdout/stderr、执行时间和收尾时间均有硬上限。取消、超时、输出溢出、读取/等待异常会终止整个 Job 并等待后代退出。若 Job 或 reader 不能在期限内可信清理，应用设置粘性 `blocked:process-cleanup`，作废当前结果并阻止后续媒体分析；benchmark session 会停留在 `cleanup-blocked`，不会把 lease 误报为已释放。

输出 reader 只在 root exit、Job empty、stdout/stderr 全部就绪后消费结果；先完成的流会保留到另一条流收尾，不会在轮询中被提前取走并误报 disconnected。普通 FFprobe 时间线探测最多运行 30 秒并保留 8 MiB stdout / 256 KiB stderr；音频逐帧/packet PTS 探测最多运行 5 分钟并保留 128 MiB 紧凑 stdout / 1 MiB stderr，只在 Job 全部退出且 expected/before/after 全文件身份严格一致后解析，单条记录和不同音频流分别受 1 MiB、256 条硬限制。安装包不会执行 Chocolatey `ShimGen` 作为媒体工具：只有规范 Chocolatey 路径、version resource、拒绝 reparse/symlink 的有界候选遍历全部通过，且恰好得到一个真实 exe 时，才对该真实二进制计算指纹并执行。路径、reparse、版本资源或唯一性存在异常时会 fail-closed，并提示配置真实工具路径。

每次本地对齐会在 run 开始前为参考/目标媒体各取得 `FILE_SHARE_READ` 只读 lease，并持有到 proposal 返回或失败。lease 期间文件不能被覆盖、删除、rename 或替换；run-start/run-final SHA-256、TimeMap 双端 identity、frame/packet PTS identity、音频/landmark/视觉 cache key 与 FFmpeg 后复核必须形成同一内容身份闭环。视觉验证必须与音频 TimeMap 属于同一 source/target 媒体世代，不能把不同文件的音画证据拼接。所有本地路径、token、工具 stderr 和身份摘要都不会进入用户可见错误或可下载 raw。

取消不仅终止受监督进程，也贯穿后续解析：FFprobe JSON 在反序列化前后和逐流归一化时检查，compact PTS 逐记录检查，V2 PCM 分块、legacy PCM/频谱分块、视觉特征逐帧检查。取消或身份变化发生后不会写缓存、返回部分 TimeMap 或继续生成性能结论。

这里的 Job 只负责进程树生命周期和有界清理，不是 C137 正式性能协议要求的 RSS sampler。当前 strict raw v2 仍如实声明 `windows-toolhelp-working-set-v1`；实际媒体卷已经由 native v2 固定句柄探测并形成 `workload-media-volumes` 回执，但安装包并未因此获得正式 Job 内存覆盖、终态 cleanup 或 attestation 证据。

## C137 benchmark 与完整验收边界

桌面包包含匹配页折叠的“高级：C137 精度基准”入口，其中 TimeMap 组件报告子区运行组件级开发验收，原生性能子区运行性能工程采集。用户导入本机 manifest v2 后，应用把完整清单投影成不含 gold、split、场景、复核者或仲裁答案的 blind `RunManifest`，并重新核验真实媒体的全文件身份及显式音视频流。`RunManifest` 使用 canonical JSON SHA-256 与通过的 preflight receipt 绑定；blind runner 随后调用与产品匹配相同的 Tauri `start/get/cancel_audio_alignment_job` 和 Rust Alignment V2，不使用测试预测或前端伪结果。

生产请求会显式传递参考/原片音轨和视频流。Rust 结果还会回报视觉 fallback/校验实际消费的视频流，runner 必须复核这些流，且视觉缓存按实际流索引隔离。每个 case 的 sealed receipt 记录成功、失败或取消、单调时钟 wall elapsed、engine/feature、实际视觉流和去敏参数摘要。只有所有真实 case 成功并与 blind SHA-256 一致时才揭示 gold 进行组件评估；失败、取消或未确认安全退出都会令 `evaluation=null`，超时任务未退出时也不会继续启动下一 case。

从高级入口下载的 JSON 采用独立 schema 和 validator，固定标记 `scope: "time-map-component"`、`releaseEligible: false`。报告不包含本地媒体路径、单媒体 SHA-256、生产参数 hash 或原始诊断；但其中的 manifest、dataset 与 evidence 稳定摘要仍可把同一数据集或多次运行关联起来，因此它是“移除直接本地标识的稳定报告”，不是不可关联的匿名报告。组件子闸门即使通过，也不等于 release 通过，不会改变项目的人工签发状态或授予 `verified`。

同一高级区内的性能工程采集复用已导入 manifest 中的媒体引用，不会再要求选择第二组路径。native v2 在任何工具探测前校验 canonical blind manifest，为全部 distinct 媒体取得会话级只读 pin，只完整哈希一次，并从固定句柄探测实际卷；每个 job 只能使用注册 case 的配对和显式流。随后严格按 cold → warmup → hot → cancel 计划运行生产对齐核心。导出的 strict raw v2 保存 path-free `workloadStorage`、Rust 单调时钟、阶段边界、缓存计数、ToolHelp RSS 和取消终态，并固定标记 `releaseEligible: false`、`trustStatus: "untrusted-raw-evidence"`。它不会保存路径、卷 GUID/serial 或单媒体 SHA，但稳定的 run manifest、workload、media-set 与 receipt 摘要仍可跨运行关联同一工作负载。组件报告里的协调器 wall time 不属于性能证据。

完整 release 验收另需严格的 `C137AcceptanceBundle` 和外部信任。acceptance protocol v3 / performance report v3 只接受 formal raw schema v2，并独立检查当前冻结 manifest、实际媒体卷 receipt 的结构与工作负载绑定、Job memory receipt、terminal cleanup receipt 与 native attestation；storage 自摘要本身不证明原生来源，来源真实性仍依赖后两者及 authority。统计 evidence 还逐项核对协议 Top-K、calibration↔ranking decision、dataset gold 事件↔TimeMap 事件、全部 frozen time-stretch 漂移和跨报告 case metadata，重签摘要不能掩盖选择性漏报。当前 raw v2 的后三项 assurance 必须为 `null`，所以即使调用方改写 sampler 字符串、重算全部摘要并自建 `trustContext`，结果仍是 `incomplete-evidence`。`trustContext` 只是一份调用方提供的摘要快照，可用于发现内容变化，不能证明签发者身份；当前 `external-trust-authority` 检查固定为未完成，直到存在可独立验证的签名或受信封装。安装包默认也不携带审批白名单或可自行签发的外部 authority。

release 不携带真实媒体、gold、许可材料或 raw 性能记录。当前仓库已能生成冷/热缓存耗时、ToolHelp 进程树峰值 RSS、取消延迟和实际 workload 卷回执，但仍没有采集/冻结合法真实关系的生成器。正式证据还必须实现诚实限定覆盖范围的 Job working-set receipt、终态 cleanup receipt 与独立外部 attestation，再用真实授权数据按获批协议重新采集；实际媒体卷回执或 lifecycle Job 不能单独替代这些要求。

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
- 当前真实媒体关系数仍为 0，尚未完成统计校准、规定硬件性能报告、20 套北极星长合集验收。A/B v2 token 已要求共同内容和单侧差异达到 2000/1500 ms 有效/覆盖时长、边界达到 1500/1000 ms，但这些门槛也尚未在授权真实冻结集上完成充分性校准。因此现阶段安装包是 fail-closed 的工程预览，不能作为准确率、性能或人工观看充分性的验收证明。
- 当前 1×N、N×1 和 N×M 会作为一个原生 batch job 执行：worker 按计划中的 distinct media 节点各建立一次媒体 lease、完整身份、FFprobe timeline/逐帧 PTS、候选音轨与 coarse landmark，全部 pair 完成 coarse scoring 后，再用 exact branch-and-bound 选择项目级 Top-K 非冲突组合。candidate、状态或展开数超过硬上限，或任一可执行 pair 的 coarse 不完整时会整批 fail-closed，不会截断搜索后宣称全局最优。
- 超过 60 分钟的媒体可以用有界 CPU 流建立 coarse 索引，但窗口 fine 不是任意长媒体保证。候选必须存在完整分集级查询轴，且完整候选逆投影、全部 coarse inlier support、DP/边界 guard 都能同时装入两侧各自不超过 60 分钟的窗口，活动内存预算也必须通过；双侧都超过 60 分钟且没有完整短轴只是其中一个阻断分支。4090 仅在 capability probe 通过后加速不超过 60 分钟短媒体的共享声谱 FFT，不能把它理解为整条匹配流水线或长合集已经 GPU 化。
- V2.1 在进程内保留最多 768 MiB 的 PCM/landmark/fine 制品 LRU，自动候选的活动制品上限为 1 GiB，native 同时只运行一个普通重型对齐任务；结束应用会释放这些内存，benchmark 的 cold reset 与 session release 也会清空同一缓存槽。普通产品 batch 尚未像 benchmark session 一样固定整批 FFmpeg/FFprobe 二进制并把 tool digest 纳入普通缓存键；同一物理文件若以不同 `mediaId` 或路径别名重复提交，也仍会被当作不同计划节点而不会合并。
