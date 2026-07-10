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

- `localFile`：保存当前本地媒体引用的媒体 ID、显示名、文件名和运行时长。项目文件不保存浏览器对象 URL 或视频内容，重开项目后如本地视频未重新导入，会由导出前检查提示需要重新连接。
- `embyItem`：保存用户授权 Emby 媒体库中的条目 ID、标题、剧名、季集号、媒体源摘要、运行时长和服务器配置引用。项目文件不保存 Emby 密码、访问 token 或临时播放 URL。

Emby 绑定只代表“这个项目对应哪一集、哪个媒体源”，不等于已经具备播放授权流或下载能力。需要重新验证 Emby 条目时，UI 会通过当前应用设置和本次会话密码重新登录并读取条目元数据，失败时向用户提示需要重新连接。

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

- `HtmlVideoMediaAdapter`：支持浏览器可播放的 MP4/WebM。

预留：

- `NativeMpvMediaAdapter`：仅接口占位，不声明已支持 MKV。后续 Tauri 桌面模式可通过 sidecar 或 IPC 接入 mpv。

## 智能对齐扩展

`AlignmentProvider` 允许未来引入音频指纹、静音段、镜头切换、感知哈希、字幕时间、动态时间规整等算法。本阶段只有 `ManualAlignmentProvider`，不伪造自动匹配。
