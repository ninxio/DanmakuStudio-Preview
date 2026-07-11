import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  SyncAnchor
} from "../danmaku/types";
import type { AlignmentProposal } from "../alignment/types";
import type { Milliseconds } from "../shared/time";

export const CURRENT_SCHEMA_VERSION = 8;

export interface MediaReference {
  id: string;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
}

export type ProjectMediaRole = "targetOriginal" | "bilibiliReference";
export type ProjectMediaReferenceKind = "browserFile" | "localPath" | "embyItem";
export type ProjectMediaConnectionState = "connected" | "needsReconnect" | "metadataOnly";

export interface ProjectMediaEmbyReference {
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export interface ProjectMediaReference {
  id: string;
  role: ProjectMediaRole;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
  referenceKind: ProjectMediaReferenceKind;
  connectionState: ProjectMediaConnectionState;
  sourceSummary: string;
  localPath: string | null;
  emby: ProjectMediaEmbyReference | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmbyServerReference {
  serverUrl: string;
  pathPrefix: string;
  username: string;
}

export interface EmbyMediaSourceSummary {
  id: string | null;
  name: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  sizeBytes: number | null;
  runtimeMs: Milliseconds | null;
}

interface MediaBindingBase {
  id: string;
  displayName: string;
  runtimeMs: Milliseconds | null;
  linkedAt: string;
}

export interface LocalFileMediaBinding extends MediaBindingBase {
  kind: "localFile";
  fileName: string;
  mediaId: string | null;
  localPath: string | null;
}

export interface EmbyItemMediaBinding extends MediaBindingBase {
  kind: "embyItem";
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export type MediaBinding = LocalFileMediaBinding | EmbyItemMediaBinding;

export interface SeasonEpisodeBinding {
  id: string;
  episodeKey: string;
  episodeLabel: string;
  targetBinding: MediaBinding;
  linkedAt: string;
}

export type DanmakuSourceSegmentKind = "content" | "ignored";

export interface DanmakuSourceBinding {
  id: string;
  assetId: string;
  sourceMediaId: string;
  linkedAt: string;
  updatedAt: string;
}

/**
 * 段内时间修正规则：参考时间轴（B 站/XML 时间）到达 sourceAtMs 之后，
 * 目标原片相对参考版累计多出 gapMs 内容（参考版在此处被删减）。
 * 投影时对该点之后的弹幕整体加上 gapMs。
 */
export interface SegmentTimingRule {
  id: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  note: string;
}

export interface DanmakuSourceSegment {
  id: string;
  label: string;
  kind: DanmakuSourceSegmentKind;
  assetId: string | null;
  sourceMediaId: string | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetMediaId: string | null;
  /** 该段开头对应目标原片时间轴上的时间；null 表示 0（段首对齐原片开头）。 */
  targetStartMs: Milliseconds | null;
  /** 段内删减修正规则，sourceAtMs 使用参考时间轴。 */
  timingRules: SegmentTimingRule[];
  episodeKey: string | null;
  episodeLabel: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
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
  mediaLibrary: ProjectMediaReference[];
  mediaBinding: MediaBinding | null;
  seasonEpisodeBindings: SeasonEpisodeBinding[];
  danmakuSourceBindings: DanmakuSourceBinding[];
  danmakuSourceSegments: DanmakuSourceSegment[];
  assets: DanmakuAsset[];
  clips: DanmakuClip[];
  globalOffsetMs: Milliseconds;
  cutMarkers: CutMarker[];
  syncAnchors: SyncAnchor[];
  alignmentProposal: AlignmentProposal | null;
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
