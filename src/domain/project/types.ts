import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  SyncAnchor
} from "../danmaku/types";
import type { AlignmentProposal } from "../alignment/types";
import type { Milliseconds } from "../shared/time";

export const CURRENT_SCHEMA_VERSION = 6;

export interface MediaReference {
  id: string;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
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

export interface DanmakuSourceSegment {
  id: string;
  label: string;
  kind: DanmakuSourceSegmentKind;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
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
  mediaBinding: MediaBinding | null;
  seasonEpisodeBindings: SeasonEpisodeBinding[];
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
