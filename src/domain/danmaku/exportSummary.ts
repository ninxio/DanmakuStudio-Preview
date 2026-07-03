import type { ResolvedDanmakuEvent } from "./types";
import type { CutMarker } from "./types";
import type { Milliseconds } from "../shared/time";

export interface ExportSummary {
  originalCount: number;
  enabledCount: number;
  disabledCount: number;
  earliestFinalTimeMs: Milliseconds;
  latestFinalTimeMs: Milliseconds;
  cutMarkerCount: number;
  hasImportWarnings: boolean;
  negativeClampCount: number;
}

export function createExportSummary(
  allEvents: ResolvedDanmakuEvent[],
  cutMarkers: CutMarker[],
  hasImportWarnings: boolean,
  negativeClampCount: number
): ExportSummary {
  const enabled = allEvents.filter((event) => event.enabled);
  const times = enabled.map((event) => Math.max(0, event.finalTimeMs));
  return {
    originalCount: allEvents.length,
    enabledCount: enabled.length,
    disabledCount: allEvents.length - enabled.length,
    earliestFinalTimeMs: times.length > 0 ? Math.min(...times) : 0,
    latestFinalTimeMs: times.length > 0 ? Math.max(...times) : 0,
    cutMarkerCount: cutMarkers.length,
    hasImportWarnings,
    negativeClampCount
  };
}
