# Danmaku Studio 易用化概念图 V1 生成记录

生成方式：OpenAI 内置图像生成（`imagegen`）

资产类型：UI mockup

生成日期：2026-07-20

输出文件：`danmaku-studio-usability-concept-v1.png`

## 最终提示词

```text
Use case: ui-mockup. Create a high-fidelity desktop application concept mockup for product planning, landscape 16:10 at approximately 1440x900. Product: “Danmaku Studio”, a Windows desktop app that aligns danmaku XML from reference videos to high-quality original episodes. This is a brand-new concept, not a screenshot and not a code editor.

Visual direction: restrained modern native Windows 11 / PowerToys / OpenAI Codex-inspired dark desktop shell, original design rather than a copy. Charcoal and slate surfaces, subtle 1px borders, small-to-medium Windows-style rounded corners, low-saturation cyan-blue accent, muted green success, amber review warning. Crisp spacing and typography, dense enough for a serious media tool but calm and approachable. No glossy marketing style, no neon, no glassmorphism, no oversized cards, no decorative gradients.

Show the “智能匹配” (Smart Matching) workspace as the active page. Overall layout:
- Compact native title bar at the top with product name “Danmaku Studio”, project name “孤独摇滚”, a quiet saved-status indicator, undo/redo icons, and standard Windows window controls.
- Under the title bar, a clear four-step horizontal workflow stepper with exact short Chinese labels: “1 素材”, “2 智能匹配”, “3 校准”, “4 导出”. Step 2 active in cyan, step 1 completed with a subtle check, steps 3 and 4 inactive.
- Slim left sidebar titled “分集”, with E01–E05 rows. E01, E02, E04, E05 show green dot and “已匹配”; E03 shows amber dot and “需复核”. Include a small project summary near the bottom: “5 集原片 · 1 个参考视频 · 5 个 XML”.
- Main center header: large but not huge title “智能匹配”; beneath it a result summary “已找到 5 集，1 项需要复核”. The one clearly dominant primary button says “重新分析”. Include a small secondary filter “只看问题”.
- Central content has a selected E03 match review card. At top of the card use plain-language labels: amber badge “需要复核”, explanation “参考视频中可能多出一段内容”. Beneath it are two synchronized video preview panels side by side, labeled exactly “参考视频” and “原片”, each showing restrained anime-like abstract placeholder frames without recognizable copyrighted characters. Timecodes are visible but subtle. Between them a small link/sync icon.
- Below previews, a wide precise dual audio waveform and time-mapping timeline. Upper waveform labeled “参考”, lower waveform labeled “原片”. Show several aligned cyan segments, one amber segment labeled “额外内容 00:36”, a vertical playhead, compact timestamps, and two visible sync point markers. The mapping is visually understandable without engineering jargon.
- Right context inspector titled “复核建议”. Show three concise items: “片头多出约 36 秒”, “正片匹配良好”, “片尾需要试听确认”. Add one emphasized action button “接受建议”, secondary text button “手动调整”, and a collapsed disclosure row “技术详情”.
- Bottom slim background/status bar: green check “4 集已完成”, amber “1 项待复核”, and quiet playback/analysis status.

Typography: Simplified Chinese UI text should be clean and legible; use only the exact labels listed above and minimal extra text. Use familiar icons with tooltips implied. Provide clear keyboard focus and selected states. The screenshot should feel immediately usable, intelligent, smooth, trustworthy, and user-friendly, while preserving the depth of a professional timeline tool. Avoid terminal panes, source code, debug logs, algorithm names, confidence percentages, hashes, test identifiers, dense property tables, or any English engineering jargon.
```
