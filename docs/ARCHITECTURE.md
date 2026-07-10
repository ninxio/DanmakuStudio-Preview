# 架构概览

Danmaku Timeline Studio 使用非破坏性编辑模型。原始 XML 解析为资源，资源放入时间轴后成为片段，所有时间调整、禁用、版本差异映射和单条微调都作为编辑状态保存，不修改 `DanmakuItem.sourceTimeMs`。

## 分层

- `src/domain`：纯领域逻辑，不依赖 React。包含弹幕模型、XML 无关的时间计算、时间桶索引、项目 schema、历史命令、对齐扩展接口。
- `src/infrastructure`：浏览器文件、媒体适配器、XML 解析/序列化、项目持久化。
- `src/stores`：Zustand 编辑器状态和命令入口。
- `src/features`：业务 UI，包含导入、导出、资源、预览、检查器和时间轴。
- `src/components`：通用 UI 组件。
- `src-tauri`：Tauri 2 桌面壳配置。当前 Web Demo 使用浏览器文件 API，桌面模式后续可替换为原生文件系统能力。

## 时间模型

内部统一使用整数毫秒。最终弹幕时间由纯函数计算：

```ts
clipRelative = item.sourceTimeMs - clip.sourceInMs
clipTime = clip.timelineStartMs + clipRelative + clip.localOffsetMs
adjusted = clipTime + itemAdjustments[item.id] + project.globalOffsetMs
resolved = applyCutMapping(adjusted, cutMarkers)
```

版本差异表示“当前视频播放到某点时，完整版额外存在或少了一段内容”。对于该点之后的弹幕，累计 `targetGapMs`。

## 历史模型

编辑历史使用命令快照模型。每次核心操作保存编辑前后的轻量项目状态，历史上限为 120 步。支持移动片段、移动弹幕、禁用/恢复、版本差异、同步锚点和全局偏移。

## 目标原片绑定

项目 schema v4 新增 `mediaBinding`，用于表达当前项目最终要对齐到哪一份目标原片。绑定模型位于 `src/domain/project`，不依赖 React，后续匹配评分、预览、对齐和导出检查都应读取同一份项目状态。

当前支持两类绑定：

- `localFile`：保存当前本地媒体引用的媒体 ID、显示名、文件名、运行时长，以及用户主动选择的本地路径引用。项目文件不保存浏览器对象 URL 或视频内容；如果只有浏览器对象 URL，重开项目后会由导出前检查提示需要重新连接。如果保存了真实本地路径，桌面端 mpv 后端可用该路径重新播放。
- `embyItem`：保存用户授权 Emby 媒体库中的条目 ID、标题、剧名、季集号、媒体源摘要、运行时长和服务器配置引用。项目文件不保存 Emby 密码、访问 token 或临时播放 URL。

Emby 绑定只代表“这个项目对应哪一集、哪个媒体源”，不等于已经具备播放授权流或下载能力。需要重新验证 Emby 条目时，UI 会通过当前应用设置和本次会话密码重新登录并读取条目元数据，失败时向用户提示需要重新连接。

## 匹配评分

`src/domain/project/matchAssessment.ts` 从项目状态生成可解释匹配评分，不依赖 React。评分输入包括目标原片绑定、项目和 XML 文件名、Emby 季集信息、目标运行时长、XML 弹幕时间范围、弹幕密度、已应用同步锚点、当前对齐提案，以及提案诊断中的音频/视觉线索。

评分结论只分三类：很可能匹配、需要确认、看起来不是同一集。没有运行音频或视觉分析时，评分器会把对应项标为“尚未运行”，不伪造媒体识别结果。总时长差只能作为风险证据；在没有定位删减点前，不会直接生成会影响导出时间的版本差异。

评分器可生成 `AlignmentProposal` 进入现有时间轴预览和复核流程。当前自动生成的同步线索只用于帮助用户核对片尾时间关系；会改变导出结果的版本差异仍必须来自人工标记、锚点校准、音频/视觉对齐提案，或其他可追溯规则。

## XML 策略

导入时解析 Bilibili XML 的 `<d p="">` 节点：

- 第一项秒数转换为整数毫秒；
- 保存完整原始 `p` 字段数组；
- 已知字段解析为结构化字段；
- 未知字段留在 `rawPFields`；
- 非法节点产生 `ImportWarning`，不阻断整个文件。

导出时按最终时间排序，相同时间按原始顺序排序，负时间限制为 0，并重新解析验证。

## 导出文件策略

导出服务根据本机应用设置中的默认目录和导出弹窗的本次选择决定去向。桌面端通过 Tauri 命令把单集 XML、分集 ZIP 和报告写入用户指定的已有目录；目录不存在、无权限或同名文件过多会返回普通用户可理解的错误。网页模式不能伪装成可写真实目录，因此回退为浏览器下载。

默认导出目录只保存在本机应用设置，不进入项目文件，也不会写入导出的 XML、ZIP 或报告内容。同名文件默认自动追加编号，避免覆盖用户已有文件。

## 媒体抽象

当前实现：

- `HtmlVideoMediaAdapter`：支持浏览器可播放的 MP4/WebM，作为轻量预览 fallback。预览区根据项目媒体引用和加载结果展示未导入、正在载入、可播放、格式不支持、需要重新连接等状态；加载失败会明确提示 HTML Video 限制和后续 mpv 方向。
- `TauriMpvMediaAdapter`：桌面端 mpv 后端，需要用户在设置中心配置 mpv 路径，并在目标原片中选择真实本地媒体路径。前端通过 `src/infrastructure/media/tauriMpvPlayer.ts` 调用 Tauri 命令；后端 `src-tauri/src/media_tools.rs` 负责检测 FFmpeg/mpv 版本、启动/停止 mpv sidecar、查询状态和通过 mpv IPC 发送播放、暂停、seek、倍率和属性读取命令。没有 mpv 路径或只有浏览器 blob URL 时不会启用该后端。

预留：

- mpv 画面嵌入、Emby 授权流媒体播放、截图/缩略图采样和更完整的硬解/字幕状态诊断仍属于后续播放器化阶段。

## 智能对齐扩展

`AlignmentProvider` 允许未来引入音频指纹、静音段、镜头切换、感知哈希、字幕时间、动态时间规整等算法。本阶段只有 `ManualAlignmentProvider`，不伪造自动匹配。
