# 架构概览

Danmaku Timeline Studio 使用非破坏性编辑模型。原始 XML 解析为资源，资源放入时间轴后成为片段，所有时间调整、禁用、删减映射和单条微调都作为编辑状态保存，不修改 `DanmakuItem.sourceTimeMs`。

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

删减标记表示“源版本播放到某点时，目标完整版额外存在一段内容”。对于该点之后的弹幕，累计 `targetGapMs`。

## 历史模型

编辑历史使用命令快照模型。每次核心操作保存编辑前后的轻量项目状态，历史上限为 120 步。支持移动片段、移动弹幕、禁用/恢复、删减标记、同步锚点和全局偏移。

## XML 策略

导入时解析 Bilibili XML 的 `<d p="">` 节点：

- 第一项秒数转换为整数毫秒；
- 保存完整原始 `p` 字段数组；
- 已知字段解析为结构化字段；
- 未知字段留在 `rawPFields`；
- 非法节点产生 `ImportWarning`，不阻断整个文件。

导出时按最终时间排序，相同时间按原始顺序排序，负时间限制为 0，并重新解析验证。

## 媒体抽象

当前实现：

- `HtmlVideoMediaAdapter`：支持浏览器可播放的 MP4/WebM。

预留：

- `NativeMpvMediaAdapter`：仅接口占位，不声明已支持 MKV。后续 Tauri 桌面模式可通过 sidecar 或 IPC 接入 mpv。

## 智能对齐扩展

`AlignmentProvider` 允许未来引入音频指纹、静音段、镜头切换、感知哈希、字幕时间、动态时间规整等算法。本阶段只有 `ManualAlignmentProvider`，不伪造自动匹配。
