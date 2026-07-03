import type { Milliseconds } from "../shared/time";

export type ImportWarningSeverity = "info" | "warning" | "error";

export interface ImportWarning {
  id: string;
  assetId: string;
  originalIndex: number | null;
  severity: ImportWarningSeverity;
  message: string;
  rawSnippet: string;
}

export interface DanmakuItem {
  id: string;
  assetId: string;
  originalIndex: number;
  sourceTimeMs: Milliseconds;
  mode: number | null;
  fontSize: number | null;
  color: number | null;
  timestamp: number | null;
  pool: number | null;
  userHash: string | null;
  rowId: string | null;
  text: string;
  rawPFields: string[];
  enabled: boolean;
}

export interface DanmakuAsset {
  id: string;
  name: string;
  fileName: string;
  color: string;
  items: DanmakuItem[];
  warnings: ImportWarning[];
  importedAt: string;
}

export interface DanmakuClip {
  id: string;
  assetId: string;
  name: string;
  timelineStartMs: Milliseconds;
  sourceInMs: Milliseconds;
  sourceOutMs: Milliseconds;
  localOffsetMs: Milliseconds;
  enabled: boolean;
}

export interface CutMarker {
  id: string;
  name: string;
  sourceAtMs: Milliseconds;
  targetGapMs: Milliseconds;
  note: string;
}

export interface SyncAnchor {
  id: string;
  sourceMs: Milliseconds;
  targetMs: Milliseconds;
  confidence?: number;
  origin: "manual" | "automatic";
}

export interface ResolvedDanmakuEvent {
  id: string;
  item: DanmakuItem;
  clip: DanmakuClip;
  asset: DanmakuAsset;
  finalTimeMs: Milliseconds;
  originalIndex: number;
  enabled: boolean;
}
