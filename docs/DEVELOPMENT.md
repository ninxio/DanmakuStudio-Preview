# 开发记录与恢复

本项目把“当前上下文”和“历史记录”分开管理：

- `AGENTS.md`：长期有效的产品边界和工程规则，保持短小。
- `progress.md`：只写当前目标、最近一次验证、未完成项和下一步；每个阶段覆盖更新，不追加完整流水账。
- Git 提交：保存每个可验收阶段的源码、文档和当时的 `progress.md`。
- `checkpoint/...` 标签：标记重要且适合直接回退查看的里程碑。
- `artifacts/`：仅提交不可轻易重建、且被某个提交或进度结论明确引用的证据。普通测试输出、缓存和日志不提交。

## Codex 默认读取范围

开始任务时只需要读取：

1. `AGENTS.md`
2. `progress.md`
3. 与任务直接相关的源码或文档

不要默认遍历 `artifacts/`、Git 历史、旧目标文档、构建目录或测试结果。只有在核实历史结论、复现问题或用户明确要求时才按需读取。

涉及界面时，再读取 `docs/ux-charter.md`；涉及架构或打包时，分别按需读取 `docs/ARCHITECTURE.md` 或 `docs/PACKAGING.md`。

## 阶段结束记录

一个可验收阶段结束时：

1. 将 `progress.md` 更新为当前快照，控制在约 100 行以内。
2. 写明验证命令和结果；不要粘贴完整日志。
3. 提交本阶段相关文件，不混入无关改动。
4. 关键里程碑创建 `checkpoint/<主题>-<日期>` 标签。
5. 清理 `dist/`、`test-results/`、`playwright-report/`、临时 `target-*` 和未采用的实验输出。

如需长期保留详细设计，创建一份主题明确的 `docs/` 文档并从源码或 `progress.md` 链接；任务结束后不保留多个互相重复的计划文件。

## 查看与恢复历史

```powershell
# 查看提交和里程碑
git log --oneline --decorate --all
git tag --list 'checkpoint/*' --sort=-creatordate

# 查看某个提交当时的进度，不改动工作区
git show <commit>:progress.md

# 查看某个里程碑的文件树，不切换当前分支
git ls-tree -r --name-only <tag>
git show <tag>:<path>

# 临时查看旧版本；完成后切回原分支
git switch --detach <tag>
git switch codex/danmaku-studio-ux
```

恢复单个文件或整个版本会改动工作区，执行前先确认 `git status` 并创建提交或临时分支。不要用 `git reset --hard` 清理普通工作区。

## 已归档的旧上下文

2026-07-20 之前的长篇 `progress.md`、阶段计划和 C134–C137 目标文档仍可从 `d6020af` 及其父提交查看。例如：

```powershell
git show d6020af:progress.md
git show d6020af:docs/goals/C137-execution-plan.md
```
