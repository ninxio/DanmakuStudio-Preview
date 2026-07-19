# Danmaku Studio 当前进度

更新时间：2026-07-20

当前分支：`codex/danmaku-studio-ux`

基线提交：`3a4f718`（与 `origin/main` 同步）

## 当前目标

进入 Usability V2 易用化重构：保留已经可用的多素材导入、批量匹配、非破坏性 TimeMap 复核/编辑、人工接管和按原片分集导出 XML 核心，渐进替换用户外壳与信息架构。

用户侧目标是只展示任务、结果、问题和下一步，把算法、证据与内部验收信息收进按需展开的技术详情。C137 精度验证继续作为底层发布门槛，易用化不得把尚未证明的自动精度包装成产品承诺。

## 最近完成

- 存档项目文档审计与重写方案：`docs/plans/2026-07-20-documentation-audit.md`。
- 完成易用化重构总方案：`docs/plans/2026-07-20-danmaku-studio-usability-refactor.md`。
- 生成“智能匹配”概念图：`docs/images/danmaku-studio-usability-concept-v1.png`。
- 明确采用渐进式外壳替换，不重写领域模型、TimeMap、XML 管线、项目格式和原生对齐引擎。
- 修复人工接管方案在前端允许导出、原生写入器却拒绝落盘的双层规则冲突。
- 合法人工接管现在可在明确分类版本差异段后写出 XML；媒体身份、TimeMap 结构、签名和完整性校验仍失败关闭。
- 原 XML 超出当前已确认来源范围时，范围外弹幕不投影但不再按数量阻断整个分集导出。
- 标准 release 已重新生成：
  - `src-tauri/target/release/danmaku_timeline_studio.exe`
  - `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`

## 最近验证

- `corepack pnpm audit:source`：通过。
- ESLint、TypeScript/Vite production build：通过。
- Vitest：93 files / 978 tests 通过，1 项真实媒体环境测试按设计跳过。
- Playwright 北极星 E2E：串行 6/6 通过；并行运行曾出现一次时序超时。
- Rust：444 passed / 24 ignored / 0 failed；strict Clippy `-D warnings` 通过。
- Tauri release 与 NSIS 打包：通过。

以上是 2026-07-20 基线的已验证结果；新代码提交后必须重新验证，不能沿用为当前结论。

## 未完成

- 独立 Gold 数据仍未证明最终同步 P95 稳定达到目标。
- 还缺其余真实 1×5 Beta、真实负关系、真实编辑事件及重复性能/取消恢复验收。
- C137 尚不能标记完成；人工接管表示用户接受未验证错位风险，不代表算法已经准确。

## 下一步

1. 建立旧 UI → 新四页/组件/动作的功能对照表，确认没有核心能力被遗漏。
2. 固化现有素材 → 匹配 → 编辑 → 导出的北极星 E2E 基线。
3. 定义项目摘要、分集状态、复核问题和导出状态的 UI view model。
4. 实现新应用外壳与静态四步路由，暂不迁移或修改匹配算法。
5. 并行继续独立 Gold、Beta、负关系、性能和取消恢复验收。

## 历史

详细历史不再追加到本文件。旧的长篇进度、C134–C137 计划和每阶段实现可从 Git 提交与标签查看；命令见 `docs/DEVELOPMENT.md`。2026-07-20 之前的完整上下文保存在提交 `d6020af`。
