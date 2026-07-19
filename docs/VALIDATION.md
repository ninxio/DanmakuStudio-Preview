# 验证说明

## 自动测试层级

- 领域单元测试保护 XML 解析、时间映射、投影、项目迁移和序列化。
- React 组件测试保护真实动作、空状态、阻断、撤销与结果反馈。
- Playwright 北极星流程保护素材 → 匹配 → 校准 → 导出，以及旧项目打开和单 XML 兼容路径。
- Rust 测试保护媒体进程、身份、缓存、原生任务、签名与原子写盘。

常用命令：

```powershell
corepack pnpm verify
corepack pnpm test:e2e
corepack pnpm tauri:build
corepack pnpm verify:release
```

## 易用性验收

每个 UI 阶段至少检查：

- 1280×720 下主要动作可见；
- 键盘可达与焦点样式；
- 空、加载、取消、错误和成功状态；
- 默认层只出现任务、结果、问题和下一步；
- 高级信息折叠后仍有真实入口；
- 从空项目到分集 XML 的结果不减少。

`tests/e2e/usability-baseline.spec.ts` 记录启动、切页、一万条 XML 导入和 DOM 节点数。数字只用于同机同环境比较，不是跨机器性能承诺。

## 发布边界

自动测试通过只说明代码契约和已覆盖流程没有回退，不证明任意现实视频都能达到固定准确率。

正式精度结论还需要获授权的真实冻结样本、独立标注与仲裁、规定硬件、完整长合集观察和外部信任材料。工程用 benchmark、人工接管或自洽签名不能自行升级为发布级准确率证明。

## 回退

每个易用化阶段都有 `checkpoint/usability-stage-...` 标签。查看或恢复方法见 [开发与恢复](DEVELOPMENT.md)。
