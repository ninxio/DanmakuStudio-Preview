import { formatTimecode } from "../shared/time";
import type { AlignmentProposal, CutCandidate } from "./types";

export function createAlignmentReviewReport(proposal: AlignmentProposal, generatedAt: Date = new Date()): string {
  const lines = [
    "# 对齐提案复核报告",
    "",
    `生成时间：${generatedAt.toISOString()}`,
    `整体置信度：${formatConfidence(proposal.confidence)}`,
    `同步锚点：${proposal.anchors.length} 个`,
    `候选补偿：${proposal.cutCandidates.length} 个`,
    "",
    "## 复核重点",
    ...createAlignmentReviewFocus(proposal).map((item) => `- ${item}`),
    "",
    "## 同步锚点",
    ...createAnchorLines(proposal),
    "",
    "## 候选补偿",
    ...createCutCandidateLines(proposal.cutCandidates),
    "",
    "## 诊断信息",
    ...createDiagnosticLines(proposal.diagnostics)
  ];
  return `${lines.join("\n")}\n`;
}

export function createAlignmentReviewFocus(proposal: AlignmentProposal): string[] {
  const focus: string[] = [];
  const lowConfidenceCuts = proposal.cutCandidates.filter((candidate) => candidate.confidence < 0.75);
  const rangedCuts = proposal.cutCandidates.filter(hasCompleteSourceRange);
  const invalidRangeCuts = rangedCuts.filter(
    (candidate) => candidate.sourceRangeStartMs > candidate.sourceRangeEndMs
  );

  if (proposal.cutCandidates.length === 0 && proposal.anchors.length === 0) {
    focus.push("提案没有同步锚点或候选补偿，需要重新生成或检查输入。");
  }
  if (lowConfidenceCuts.length > 0) {
    focus.push(`${lowConfidenceCuts.length} 个候选补偿置信度低于 75%，建议人工确认边界和缺失时长。`);
  }
  if (rangedCuts.length > 0) {
    focus.push(`${rangedCuts.length} 个候选补偿包含不确定区间，优先核对区间内的真实删减边界。`);
  }
  if (invalidRangeCuts.length > 0) {
    focus.push(`${invalidRangeCuts.length} 个候选补偿的不确定区间起止顺序异常，需要修正后再应用。`);
  }
  if (proposal.diagnostics.length === 0) {
    focus.push("没有诊断信息，复核时需要更多上下文判断提案来源。");
  }
  if (focus.length === 0) {
    focus.push("未发现明显风险项，仍建议抽查首个锚点和每个候选补偿的边界。");
  }
  return focus;
}

export function createAlignmentApplyBlockers(proposal: AlignmentProposal): string[] {
  const blockers: string[] = [];
  const emptyAnchorIdCount = proposal.anchors.filter((anchor) => anchor.id.trim().length === 0).length;
  const emptyCutIdCount = proposal.cutCandidates.filter((candidate) => candidate.id.trim().length === 0).length;
  const duplicateAnchorIdCount = countDuplicateIds(proposal.anchors.map((anchor) => anchor.id));
  const duplicateCutIdCount = countDuplicateIds(proposal.cutCandidates.map((candidate) => candidate.id));
  const invalidRangeCount = proposal.cutCandidates.filter(
    (candidate) => hasCompleteSourceRange(candidate) && candidate.sourceRangeStartMs > candidate.sourceRangeEndMs
  ).length;
  const sourceOutsideRangeCount = proposal.cutCandidates.filter(
    (candidate) =>
      hasCompleteSourceRange(candidate) &&
      candidate.sourceRangeStartMs <= candidate.sourceRangeEndMs &&
      (candidate.sourceAtMs < candidate.sourceRangeStartMs || candidate.sourceAtMs > candidate.sourceRangeEndMs)
  ).length;

  if (emptyAnchorIdCount > 0) {
    blockers.push(`${emptyAnchorIdCount} 个同步锚点缺少 ID，无法安全写入项目。`);
  }
  if (emptyCutIdCount > 0) {
    blockers.push(`${emptyCutIdCount} 个候选补偿缺少 ID，无法安全写入项目。`);
  }
  if (duplicateAnchorIdCount > 0) {
    blockers.push(`${duplicateAnchorIdCount} 个同步锚点 ID 在提案内重复，应用会丢失锚点。`);
  }
  if (duplicateCutIdCount > 0) {
    blockers.push(`${duplicateCutIdCount} 个候选补偿 ID 在提案内重复，应用会丢失补偿。`);
  }
  if (invalidRangeCount > 0) {
    blockers.push(`${invalidRangeCount} 个候选补偿的不确定区间起止顺序异常，请修正后再应用。`);
  }
  if (sourceOutsideRangeCount > 0) {
    blockers.push(`${sourceOutsideRangeCount} 个候选补偿的源时间不在不确定区间内，请修正后再应用。`);
  }
  return blockers;
}

function createAnchorLines(proposal: AlignmentProposal): string[] {
  if (proposal.anchors.length === 0) {
    return ["- 暂无同步锚点。"];
  }
  return proposal.anchors.map((anchor, index) => {
    const offsetMs = anchor.targetMs - anchor.sourceMs;
    const confidence = anchor.confidence === undefined ? "未提供" : formatConfidence(anchor.confidence);
    return [
      `- ${index + 1}. [${anchor.id}] ${anchor.origin === "automatic" ? "自动" : "手动"}`,
      `  源时间：${formatTime(anchor.sourceMs)}`,
      `  目标时间：${formatTime(anchor.targetMs)}`,
      `  偏移：${formatSignedDuration(offsetMs)} (${offsetMs} ms)`,
      `  置信度：${confidence}`
    ].join("\n");
  });
}

function createCutCandidateLines(candidates: CutCandidate[]): string[] {
  if (candidates.length === 0) {
    return ["- 暂无候选补偿。"];
  }
  return candidates.map((candidate, index) => {
    const sourceRangeLine = createSourceRangeLine(candidate);
    return [
      `- ${index + 1}. [${candidate.id}] ${candidate.name}`,
      `  源时间：${formatTime(candidate.sourceAtMs)}`,
      `  ${sourceRangeLine}`,
      `  补偿：${formatSignedDuration(candidate.targetGapMs)} (${Math.round(candidate.targetGapMs)} ms)`,
      `  置信度：${formatConfidence(candidate.confidence)}`,
      `  说明：${candidate.note || "未提供"}`
    ].join("\n");
  });
}

function createSourceRangeLine(candidate: CutCandidate): string {
  if (!hasCompleteSourceRange(candidate)) {
    return "不确定区间：未提供";
  }
  const label =
    candidate.sourceRangeStartMs <= candidate.sourceRangeEndMs
      ? "不确定区间"
      : "不确定区间（起止需复核）";
  return `${label}：${formatTime(candidate.sourceRangeStartMs)} - ${formatTime(candidate.sourceRangeEndMs)}`;
}

function createDiagnosticLines(diagnostics: string[]): string[] {
  if (diagnostics.length === 0) {
    return ["- 暂无诊断信息。"];
  }
  return diagnostics.map((diagnostic, index) => `- ${index + 1}. ${diagnostic}`);
}

function hasCompleteSourceRange(
  candidate: CutCandidate
): candidate is CutCandidate & { sourceRangeStartMs: number; sourceRangeEndMs: number } {
  return candidate.sourceRangeStartMs !== undefined && candidate.sourceRangeEndMs !== undefined;
}

function countDuplicateIds(ids: string[]): number {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rawId of ids) {
    const id = rawId.trim();
    if (id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }
  return duplicates.size;
}

function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(1)}%`;
}

function formatTime(milliseconds: number): string {
  const rounded = Math.round(milliseconds);
  return `${formatTimecode(rounded)} (${rounded} ms)`;
}

function formatSignedDuration(milliseconds: number): string {
  const rounded = Math.round(milliseconds);
  const sign = rounded >= 0 ? "+" : "-";
  return `${sign}${formatTimecode(Math.abs(rounded))}`;
}
