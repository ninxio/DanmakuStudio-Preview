import type { ProjectMediaReference } from "../project/types";

export interface MediaEpisodeHint {
  seasonNumber: number | null;
  episodeStart: number;
  episodeEnd: number;
  source: "projectMetadata" | "fileName";
}

export interface SmartBatchPair {
  sourceMediaId: string;
  targetMediaId: string;
  reason: string;
}

export interface SmartBatchPairingPlan {
  mode: "metadataGuided" | "fullCartesian";
  pairs: SmartBatchPair[];
  totalCartesianPairCount: number;
  excludedPairCount: number;
  summary: string;
  warnings: string[];
}

export function createSmartBatchPairingPlan(
  sources: readonly ProjectMediaReference[],
  targets: readonly ProjectMediaReference[]
): SmartBatchPairingPlan {
  const totalCartesianPairCount = sources.length * targets.length;
  if (totalCartesianPairCount === 0) {
    return {
      mode: "fullCartesian",
      pairs: [],
      totalCartesianPairCount,
      excludedPairCount: 0,
      summary: "请选择参考素材和原片。",
      warnings: []
    };
  }

  const sourceHints = new Map(
    sources.map((source) => [source.id, parseMediaEpisodeHint(source)] as const)
  );
  const targetHints = new Map(
    targets.map((target) => [target.id, parseMediaEpisodeHint(target)] as const)
  );
  const guidedPairs: SmartBatchPair[] = [];
  const warnings: string[] = [];

  for (const target of targets) {
    const targetHint = targetHints.get(target.id) ?? null;
    if (!targetHint || targetHint.episodeStart !== targetHint.episodeEnd) {
      warnings.push(`无法从“${target.name}”确认单集编号。`);
      return createFullCartesianPlan(sources, targets, warnings);
    }
    const candidates = sources.filter((source) => {
      const sourceHint = sourceHints.get(source.id) ?? null;
      if (!sourceHint) return false;
      if (
        sourceHint.seasonNumber !== null &&
        targetHint.seasonNumber !== null &&
        sourceHint.seasonNumber !== targetHint.seasonNumber
      ) {
        return false;
      }
      return (
        targetHint.episodeStart >= sourceHint.episodeStart &&
        targetHint.episodeStart <= sourceHint.episodeEnd
      );
    });
    if (candidates.length !== 1) {
      warnings.push(
        candidates.length === 0
          ? `没有参考素材明确覆盖“${target.name}”。`
          : `有多个参考素材都声称覆盖“${target.name}”。`
      );
      return createFullCartesianPlan(sources, targets, warnings);
    }
    const source = candidates[0];
    const sourceHint = sourceHints.get(source.id);
    guidedPairs.push({
      sourceMediaId: source.id,
      targetMediaId: target.id,
      reason: formatPairReason(sourceHint, targetHint)
    });
  }

  if (guidedPairs.length !== targets.length || guidedPairs.length === totalCartesianPairCount) {
    return createFullCartesianPlan(sources, targets, warnings);
  }

  const unusedSources = sources.filter(
    (source) => !guidedPairs.some((pair) => pair.sourceMediaId === source.id)
  );
  if (unusedSources.length > 0) {
    warnings.push(`有 ${unusedSources.length} 个参考素材没有覆盖任何所选原片。`);
    return createFullCartesianPlan(sources, targets, warnings);
  }

  const excludedPairCount = totalCartesianPairCount - guidedPairs.length;
  return {
    mode: "metadataGuided",
    pairs: guidedPairs,
    totalCartesianPairCount,
    excludedPairCount,
    summary: `根据季集范围建议分析 ${guidedPairs.length} 组，跳过 ${excludedPairCount} 组明显跨分组组合。`,
    warnings
  };
}

export function parseMediaEpisodeHint(media: ProjectMediaReference): MediaEpisodeHint | null {
  const metadataHint = parseProjectEpisodeMetadata(media);
  if (metadataHint) return metadataHint;
  const texts = [media.episodeLabel, media.episodeKey, media.name, media.fileName].filter(
    (value): value is string => Boolean(value?.trim())
  );
  for (const text of texts) {
    const parsed = parseEpisodeText(text);
    if (parsed) return { ...parsed, source: "fileName" };
  }
  return null;
}

function parseProjectEpisodeMetadata(media: ProjectMediaReference): MediaEpisodeHint | null {
  const seasonNumber = media.emby?.seasonNumber ?? null;
  const episodeNumber = media.emby?.episodeNumber ?? null;
  if (episodeNumber !== null && isValidEpisodeNumber(episodeNumber)) {
    return {
      seasonNumber: isValidSeasonNumber(seasonNumber) ? seasonNumber : null,
      episodeStart: episodeNumber,
      episodeEnd: episodeNumber,
      source: "projectMetadata"
    };
  }
  if (media.episodeKey) {
    const parsed = parseEpisodeText(media.episodeKey);
    if (parsed) return { ...parsed, source: "projectMetadata" };
  }
  return null;
}

function parseEpisodeText(
  text: string
): Omit<MediaEpisodeHint, "source"> | null {
  const normalized = text
    .normalize("NFKC")
    .replace(/[‐‑‒–—﹣－~～至到]/g, "-")
    .replace(/\s+/g, " ");

  const se = normalized.match(
    /\bS(\d{1,3})\s*E(\d{1,4})(?:\s*-\s*(?:S\d{1,3}\s*)?E?(\d{1,4}))?\b/i
  );
  if (se) {
    return createHint(Number(se[1]), Number(se[2]), Number(se[3] ?? se[2]));
  }

  const chineseSeason = normalized.match(
    /第?([零〇一二三四五六七八九十百两\d]{1,6})\s*季\s*第?\s*([零〇一二三四五六七八九十百两\d]{1,6})(?:\s*-\s*第?\s*([零〇一二三四五六七八九十百两\d]{1,6}))?\s*集?/i
  );
  if (chineseSeason) {
    const season = parseChineseOrArabicNumber(chineseSeason[1]);
    const start = parseChineseOrArabicNumber(chineseSeason[2]);
    const end = parseChineseOrArabicNumber(chineseSeason[3] ?? chineseSeason[2]);
    if (season !== null && start !== null && end !== null) {
      return createHint(season, start, end);
    }
  }

  const episodeOnly = normalized.match(/\bE(?:P)?\s*(\d{1,4})\b/i);
  if (episodeOnly) {
    return createHint(null, Number(episodeOnly[1]), Number(episodeOnly[1]));
  }
  return null;
}

function createHint(
  seasonNumber: number | null,
  first: number,
  last: number
): Omit<MediaEpisodeHint, "source"> | null {
  if (
    !isValidSeasonNumber(seasonNumber) ||
    !isValidEpisodeNumber(first) ||
    !isValidEpisodeNumber(last) ||
    last < first
  ) {
    return null;
  }
  return { seasonNumber, episodeStart: first, episodeEnd: last };
}

function parseChineseOrArabicNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digitValues: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (digitValues[character] !== undefined) {
      current = digitValues[character];
    } else {
      return null;
    }
  }
  return total + current;
}

function createFullCartesianPlan(
  sources: readonly ProjectMediaReference[],
  targets: readonly ProjectMediaReference[],
  warnings: string[]
): SmartBatchPairingPlan {
  const pairs = sources.flatMap((source) =>
    targets.map((target) => ({
      sourceMediaId: source.id,
      targetMediaId: target.id,
      reason: "季集信息不足，交给媒体证据判断"
    }))
  );
  return {
    mode: "fullCartesian",
    pairs,
    totalCartesianPairCount: pairs.length,
    excludedPairCount: 0,
    summary: `季集信息不足或存在冲突，将安全分析全部 ${pairs.length} 组组合。`,
    warnings
  };
}

function formatPairReason(
  source: MediaEpisodeHint | null | undefined,
  target: MediaEpisodeHint
): string {
  const season = target.seasonNumber === null ? "" : `第 ${target.seasonNumber} 季`;
  const range =
    source && source.episodeStart !== source.episodeEnd
      ? `，参考文件标记覆盖第 ${source.episodeStart}–${source.episodeEnd} 集`
      : "";
  return `${season}第 ${target.episodeStart} 集${range}`;
}

function isValidSeasonNumber(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 999);
}

function isValidEpisodeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_999;
}
