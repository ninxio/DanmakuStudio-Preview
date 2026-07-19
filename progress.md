# Danmaku Studio 当前进度

更新时间：2026-07-20

当前分支：`codex/danmaku-studio-ux`

易用化方案起点：`09ddea4`

## 当前目标

Usability V2 阶段 0 已完成，下一步进入阶段 1：实现新的应用外壳、四步导航、项目侧栏、上下文面板和后台任务栏。

阶段 1 只替换信息层级和导航外壳，复用现有 store/action、领域模型和导出安全门；尚未迁移的旧功能必须继续可达。

## 最近完成

- 完成阶段 0 能力映射和防回退契约：`docs/USABILITY_BASELINE.md`。
- 新增纯 TypeScript `usabilityViewModel`，把现有项目事实翻译为“素材、智能匹配、校准、导出”的用户语言，不复制领域规则。
- 新增空项目、素材齐备、候选待复核和可导出四类 view model 测试。
- 新增 Playwright 性能基线，记录启动、四页切换和 10,000 条 XML 导入。
- 本机完整 E2E 基线：启动约 325 ms；10,000 条 XML 导入约 126.5 ms；四页切换约 54–113 ms。
- 修复人工接管方案在前端允许导出、原生写入器却拒绝落盘的双层规则冲突。
- 标准 release 已重新生成：
  - `src-tauri/target/release/danmaku_timeline_studio.exe`
  - `src-tauri/target/release/bundle/nsis/Danmaku Timeline Studio_0.1.0_x64-setup.exe`

## 最近验证

- `corepack pnpm verify`：通过。
- Vitest：94 files / 982 tests 通过，1 项真实媒体环境测试按设计跳过。
- Playwright：串行 7/7 通过，包含编辑、匹配、导出门禁和易用化性能基线。
- TypeScript/Vite production build：通过；主包仍有大于 500 kB 的拆包提示，阶段 1 需持续控制。
- Rust：444 passed / 24 ignored / 0 failed；strict Clippy `-D warnings` 通过。
- Tauri release 与 NSIS 打包：通过。

Rust/Clippy 数字沿用阶段 0 之前最近一次原生验证；本阶段没有修改 Rust。其余结果为本阶段当前工作区实测。

## 未完成

- 独立 Gold 数据仍未证明最终同步 P95 稳定达到目标。
- 还缺其余真实 1×5 Beta、真实负关系、真实编辑事件及重复性能/取消恢复验收。
- C137 尚不能标记完成；人工接管表示用户接受未验证错位风险，不代表算法已经准确。
- `usabilityViewModel` 目前尚未接入界面；安装包仍显示旧应用外壳。

## 下一步

1. 建立阶段 1 设计 token、应用框架和四步 `WorkflowStepper`。
2. 让顶栏和项目摘要消费 `usabilityViewModel`，不重复计算领域状态。
3. 加入项目/分集侧栏、按选择出现的上下文面板和后台任务栏骨架。
4. 保留旧四页内容作为内部页面，确保所有现有功能仍可进入。
5. 完成 1280×720、1920×1080、高 DPI、键盘与北极星走查后再迁移素材页。

## 历史

详细历史不再追加到本文件。旧的长篇进度、C134–C137 计划和每阶段实现可从 Git 提交与标签查看；命令见 `docs/DEVELOPMENT.md`。2026-07-20 之前的完整上下文保存在提交 `d6020af`。
