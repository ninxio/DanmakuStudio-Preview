import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  SyncAnchor
} from "../danmaku/types";
import type { Milliseconds } from "../shared/time";

export const CURRENT_SCHEMA_VERSION = 2;

export interface MediaReference {
  id: string;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
}

export interface TimelineViewState {
  pixelsPerSecond: number;
  scrollMs: Milliseconds;
  playheadMs: Milliseconds;
}

export interface PreviewSettings {
  danmakuVisible: boolean;
  safeAreaVisible: boolean;
  opacity: number;
}

export interface EditorProject {
  schemaVersion: number;
  id: string;
  name: string;
  media: MediaReference | null;
  assets: DanmakuAsset[];
  clips: DanmakuClip[];
  globalOffsetMs: Milliseconds;
  cutMarkers: CutMarker[];
  syncAnchors: SyncAnchor[];
  itemTimeAdjustments: Record<string, Milliseconds>;
  disabledItemIds: string[];
  timeline: TimelineViewState;
  preview: PreviewSettings;
  createdAt: string;
  updatedAt: string;
}

export type SelectionKind = "none" | "danmaku" | "clip" | "cut" | "anchor";

export interface EditorSelection {
  kind: SelectionKind;
  ids: string[];
}

export interface ProjectValidationResult {
  ok: boolean;
  version: number | null;
  message: string;
}
