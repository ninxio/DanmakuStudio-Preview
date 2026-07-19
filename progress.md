# Danmaku Timeline Studio 当前进度

更新时间：2026-07-20

当前分支：`codex/danmaku-studio-ux`

基线提交：`3a4f718`（与 `origin/main` 同步）

## 当前目标

C137 高精度时间映射仍在进行中。产品已具备多素材导入、批量匹配、非破坏性 TimeMap 复核/编辑、人工接管和按原片分集导出 XML 的完整主流程。

当前开发重点不是继续增加入口，而是用独立真实媒体样本证明自动对齐、删减边界和延迟估计达到可发布精度，并保持人工接管与导出安全门一致。

## 最近完成

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

1. 用独立且未参与调参的 Gold 样本验证边界和同步误差。
2. 补齐 Beta、负关系和编辑事件矩阵，统一保存最小必要证据。
3. 重复冷热性能、取消与恢复测试。
4. 达到退出门槛后更新本页、提交并创建新的 `checkpoint/...` 标签。

## 历史

详细历史不再追加到本文件。旧的长篇进度、C134–C137 计划和每阶段实现可从 Git 提交与标签查看；命令见 `docs/DEVELOPMENT.md`。2026-07-20 之前的完整上下文保存在提交 `d6020af`。
