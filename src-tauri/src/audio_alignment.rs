use crate::{
    alignment_v2::{
        align_features_edit_aware_with_cancel, extract_fine_features_with_cancel,
        extract_landmarks_and_fine_features_with_cancel, match_landmarks_affine_with_cancel,
        refine_boundary_by_correlation_with_cancel,
        refine_boundary_by_one_sided_correlation_with_cancel, AffineHypothesis, AffineMatchConfig,
        BoundaryContextSide, BoundaryRefinementConfig, EditAlignmentConfig, EditAlignmentMode,
        EditPathKind, EditTimeSpan, FineFeatureConfig, FineFeatureFrame, LandmarkConfig,
        SpectralLandmark,
    },
    media_probe::{
        probe_audio_decode_timelines_with_ffprobe_cancellable,
        probe_media_content_identity_cancellable, probe_media_timeline_with_ffprobe_cancellable,
        resolve_ffprobe_path, select_audio_stream, AudioDecodeTimelineProbe, AudioStreamProbe,
        MediaContentIdentity, MediaProbeSnapshot, VideoStreamProbe,
    },
    process_supervision::{
        process_supervision_cleanup_faulted, resolve_supervised_executable, SupervisedCommand,
        SupervisedOutput, SupervisedOutputLimits, SupervisedProcessErrorKind,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::{
    fs::OpenOptions,
    io::{Seek, SeekFrom},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
};

const DEFAULT_SAMPLE_RATE: u32 = 8_000;
const DEFAULT_WINDOW_MS: u64 = 1_000;
const DEFAULT_MATCH_THRESHOLD: f64 = 0.18;
const DEFAULT_MIN_GAP_MS: u64 = 1_000;
const DEFAULT_MAX_CELLS: usize = 16_000_000;
const DEFAULT_VISUAL_SAMPLE_INTERVAL_MS: u64 = 5_000;
const VISUAL_SAMPLE_WIDTH: usize = 32;
const VISUAL_SAMPLE_HEIGHT: usize = 18;
const VISUAL_GRID_COLUMNS: usize = 8;
const VISUAL_GRID_ROWS: usize = 6;
const VISUAL_MATCH_THRESHOLD: f64 = 0.16;
const ALIGNMENT_V2_VISUAL_FEATURE_VERSION: &str = "visual-dct-gradient-pts-v1";
const ALIGNMENT_V2_VISUAL_MIN_SAMPLE_INTERVAL_MS: u64 = 1_000;
const ALIGNMENT_V2_VISUAL_MAX_SAMPLE_INTERVAL_MS: u64 = 10_000;
const ALIGNMENT_V2_VISUAL_MAX_DURATION_MS: u64 = 6 * 60 * 60 * 1_000;
const ALIGNMENT_V2_VISUAL_MAX_FRAMES: usize = 10_000;
const ALIGNMENT_V2_VISUAL_MAX_RAW_BYTES: usize =
    VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT * ALIGNMENT_V2_VISUAL_MAX_FRAMES;
const ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD: f64 = 0.42;
const ALIGNMENT_V2_VISUAL_MIN_INFORMATION: f64 = 0.018;
const ALIGNMENT_V2_VISUAL_MIN_INLIERS: usize = 6;
const ALIGNMENT_V2_VISUAL_MIN_COVERAGE: f64 = 0.55;
const ALIGNMENT_V2_VISUAL_MIN_MARGIN: f64 = 0.12;
const ALIGNMENT_V2_VISUAL_MAX_CANDIDATES_PER_SOURCE: usize = 8;
const ALIGNMENT_V2_VISUAL_MAX_SEEDS: usize = 128;
const ALIGNMENT_V2_VISUAL_MAX_MATCH_FRAMES: usize = 2_400;
const AUDIO_ALIGNMENT_CANCELLED: &str = "音频对齐任务已取消。";
const MAX_JOB_LOGS: usize = 80;
const MAX_AUDIO_FEATURE_CACHE_ENTRIES: usize = 12;
const MAX_VISUAL_FEATURE_CACHE_ENTRIES: usize = 12;
const MERGE_NEARBY_CANDIDATE_MS: u64 = 2_000;
const FINGERPRINT_BUCKET_MS: i64 = 1_000;
const MAX_COMPLETE_FINGERPRINTS_PER_KEY: usize = 32;
const MAX_SPARSE_MATCH_CANDIDATES: usize = 80_000;
const MIN_SPARSE_MATCHES: usize = 3;
const MIN_SPARSE_COVERAGE: f64 = 0.25;
const AUDIO_ALIGNMENT_STAGE_COUNT: u8 = 9;
const OFFSET_PATH_TARGET_BLOCK_FRAMES: usize = 24;
const OFFSET_PATH_MIN_BLOCK_FRAMES: usize = 4;
const OFFSET_PATH_MIN_SOURCE_FRAMES: usize = 32;
const OFFSET_PATH_STEP_DIVISOR: usize = 4;
const OFFSET_PATH_SEARCH_MARGIN_MS: i64 = 60_000;
const OFFSET_PATH_MAX_SEARCH_MS: i64 = 240_000;
const OFFSET_PATH_MIN_OBSERVATIONS: usize = 2;
const OFFSET_PATH_STABLE_OBSERVATIONS: usize = 5;
const OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER: usize = 3;
const OFFSET_PATH_STABLE_SUPPORT_RATIO: f64 = 0.7;
const TIME_MAPPING_MIN_STABLE_SPAN_MS: u64 = 10_000;
const SPECTRAL_FREQUENCIES_HZ: [f64; 6] = [120.0, 240.0, 480.0, 960.0, 1_600.0, 2_800.0];
const ALIGNMENT_V2_ENGINE_VERSION: &str = "alignment-v2.1-rust";
const ALIGNMENT_V2_FEATURE_VERSION: &str =
    "pcm-s16le-16k-pts-shared-spectrum-artifact-cache-dual-boundary-v4";
const ALIGNMENT_V2_SAMPLE_RATE: u32 = 16_000;
const ALIGNMENT_V2_LANDMARK_HOP_MS: u32 = 50;
const ALIGNMENT_V2_FINE_HOP_MS: u32 = 50;
const ALIGNMENT_V2_DP_CHUNK_MS: i64 = 45_000;
const ALIGNMENT_V2_DP_BAND_RADIUS_MS: i64 = 30_000;
const ALIGNMENT_V2_RECURSIVE_LOOKAHEAD_MS: i64 = 0;
const ALIGNMENT_V2_MAX_DP_CELLS: usize = 4_000_000;
const ALIGNMENT_V2_MAX_DURATION_MS: u64 = 60 * 60 * 1_000;
const ALIGNMENT_V2_MAX_PCM_BYTES: usize =
    ALIGNMENT_V2_SAMPLE_RATE as usize * (ALIGNMENT_V2_MAX_DURATION_MS as usize / 1_000) * 2;
const ALIGNMENT_V2_MAX_STDERR_BYTES: usize = 1024 * 1024;
const ALIGNMENT_V2_MIN_TRACK_MARGIN: f64 = 0.10;
const ALIGNMENT_V2_MIN_TEMPORAL_COVERAGE: f64 = 0.20;
const ALIGNMENT_V2_MAX_UNSELECTED_STREAMS: usize = 12;
// The V2 cache owns decoded mono PCM as well as landmarks/fine features. Bound it by
// resident artifact bytes instead of entry count: one hour of 16 kHz mono i16 PCM is
// about 110 MiB, while a 20-minute episode is about 37 MiB. 768 MiB retains the common
// one-long-reference + episode-batch working set without granting the process an
// unbounded media cache; larger sets degrade by per-entry LRU eviction.
const MAX_V2_MEDIA_ARTIFACT_CACHE_BYTES: usize = 768 * 1024 * 1024;
// Candidate PCM must remain alive until track-pair selection finishes, otherwise the
// winning cold-path track would have to be decoded a second time. Fail closed before a
// pathological multi-track input can make that transient working set unbounded.
const MAX_V2_ACTIVE_ARTIFACT_BYTES: usize = 1024 * 1024 * 1024;
// Product orchestration is deliberately sequential today. Enforce the same boundary in native
// code so multiple callers cannot each reserve the per-run 1 GiB artifact budget and exhaust the
// machine. A future batch engine may replace this with one global byte reservation ledger.
const MAX_ORDINARY_ALIGNMENT_RUNS: usize = 1;
const DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS: u64 = 20;
const MIN_BENCHMARK_SAMPLE_INTERVAL_MS: u64 = 10;
const MAX_BENCHMARK_SAMPLE_INTERVAL_MS: u64 = 1_000;
const BENCHMARK_RESIDUAL_GRACE_MS: u64 = 2_000;
const BENCHMARK_TELEMETRY_VERSION: &str = "alignment-benchmark-native-v2-artifact-cache-v1";
const ALIGNMENT_BENCHMARK_MAX_CASES: usize = 1_000;
const ALIGNMENT_BENCHMARK_MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const ALIGNMENT_BENCHMARK_MAX_ID_BYTES: usize = 512;
const ALIGNMENT_BENCHMARK_MAX_NOTE_BYTES: usize = 4 * 1024;
const ALIGNMENT_BENCHMARK_MAX_PATH_UTF16_UNITS: usize = 32_767;
const ALIGNMENT_BENCHMARK_MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const BENCHMARK_PROCESS_CLEANUP_REASON: &str =
    "受监督媒体进程未能可信收尾；lease 与工具 pin 按 fail-closed 保持占用。";
const BENCHMARK_TOOL_VERSION_TIMEOUT_MS: u64 = 10_000;
const BENCHMARK_TOOL_VERSION_MAX_BYTES: usize = 64 * 1024;
const CHILD_OUTPUT_DRAIN_TIMEOUT_MS: u64 = 2_000;
const CHILD_PROCESS_TREE_TERMINATION_TIMEOUT_MS: u64 = 2_000;
const MEDIA_TOOL_EXECUTION_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
const LEGACY_MAX_PCM_BYTES: usize =
    DEFAULT_SAMPLE_RATE as usize * (ALIGNMENT_V2_MAX_DURATION_MS as usize / 1_000) * 4;
const V2_PCM_PARSE_CANCEL_CHECK_SAMPLES: usize = 64 * 1024;
const LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES: usize = 4 * 1024;

const DIRECTION_SKIP_COMPLETE: u8 = 1;
const DIRECTION_SKIP_SOURCE: u8 = 2;
const DIRECTION_MATCH: u8 = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentRequest {
    complete_path: String,
    source_path: String,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    complete_audio_stream_index: Option<u32>,
    source_audio_stream_index: Option<u32>,
    complete_video_stream_index: Option<u32>,
    source_video_stream_index: Option<u32>,
    sample_rate: Option<u32>,
    window_ms: Option<u64>,
    match_threshold: Option<f64>,
    min_gap_ms: Option<u64>,
    max_cells: Option<usize>,
    enable_visual_evidence: Option<bool>,
    visual_sample_interval_ms: Option<u64>,
    localization_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFeatureFrame {
    time_ms: u64,
    values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualFeatureFrame {
    time_ms: u64,
    values: Vec<f64>,
}

#[derive(Debug, Clone)]
struct AudioFeatureMatch {
    complete_time_ms: u64,
    source_time_ms: u64,
    distance: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAnchorDto {
    id: String,
    source_ms: u64,
    target_ms: u64,
    confidence: f64,
    origin: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutCandidateDto {
    id: String,
    name: String,
    source_at_ms: u64,
    source_range_start_ms: u64,
    source_range_end_ms: u64,
    target_gap_ms: u64,
    confidence: f64,
    note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentEvidenceSummary {
    algorithm: String,
    complete_fingerprint_count: usize,
    source_fingerprint_count: usize,
    fingerprint_match_count: usize,
    monotonic_match_count: usize,
    strong_anchor_count: usize,
    weak_anchor_count: usize,
    offset_cluster_count: usize,
    refined_candidate_count: usize,
    low_confidence_region_count: usize,
    quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_mapping_segment_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confirmed_change_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signals: Option<Vec<AlignmentEvidenceSignalSummary>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentEvidenceSignalSummary {
    kind: &'static str,
    status: &'static str,
    label: &'static str,
    observations: usize,
    weight: f64,
    note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentProposal {
    anchors: Vec<SyncAnchorDto>,
    cut_candidates: Vec<CutCandidateDto>,
    confidence: f64,
    diagnostics: Vec<String>,
    evidence: Option<AlignmentEvidenceSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    match_range: Option<AlignmentMatchRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_map: Option<AudioAlignmentTimeMapDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentMatchRange {
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    coverage: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioTimeMapSpanKind {
    Matched,
    SourceOnly,
    TargetOnly,
    Ambiguous,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTimeMapSpanDto {
    kind: AudioTimeMapSpanKind,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTimeMapStreamIdentityDto {
    #[serde(rename = "type")]
    stream_type: &'static str,
    index: u32,
    codec: Option<String>,
    start_ms: Option<i64>,
    timeline_offset_ms: Option<i64>,
    time_base: Option<String>,
    sample_rate: Option<u32>,
    channels: Option<u32>,
    frame_rate: Option<f64>,
    language: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTimeMapQualityDto {
    level: &'static str,
    metric_source: &'static str,
    probability: Option<f64>,
    coverage: Option<f64>,
    p50_residual_ms: Option<u64>,
    p95_residual_ms: Option<u64>,
    max_residual_ms: Option<u64>,
    boundary_uncertainty_ms: Option<u64>,
    alternative_margin: Option<f64>,
    anchor_count: usize,
    held_out_anchor_count: usize,
    reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlternativeTrackScoreDto {
    source_stream_index: u32,
    target_stream_index: u32,
    score: f64,
    scale: f64,
    offset_ms: i64,
    inlier_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTimeMapEvidenceDto {
    types: Vec<&'static str>,
    audio_anchor_count: usize,
    visual_anchor_count: usize,
    held_out_anchor_count: usize,
    top1_top2_margin: Option<f64>,
    unique_content_coverage: Option<f64>,
    repeated_content_only: bool,
    selected_track_reason: String,
    alternative_track_scores: Vec<AudioAlternativeTrackScoreDto>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentTimeMapDto {
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    spans: Vec<AudioTimeMapSpanDto>,
    quality: AudioTimeMapQualityDto,
    evidence: AudioTimeMapEvidenceDto,
    source_stream: Option<AudioTimeMapStreamIdentityDto>,
    target_stream: Option<AudioTimeMapStreamIdentityDto>,
    source_visual_stream: Option<AudioTimeMapStreamIdentityDto>,
    target_visual_stream: Option<AudioTimeMapStreamIdentityDto>,
    source_identity: Option<MediaContentIdentity>,
    target_identity: Option<MediaContentIdentity>,
    engine_version: &'static str,
    feature_version: &'static str,
    parameters_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioAlignmentJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentJobSnapshot {
    job_id: String,
    status: AudioAlignmentJobStatus,
    progress: f64,
    message: String,
    stage_key: String,
    stage_label: String,
    stage_index: u8,
    stage_count: u8,
    stage_progress: f64,
    logs: Vec<String>,
    proposal: Option<AudioAlignmentProposal>,
    error: Option<String>,
    updated_at_ms: u64,
}

const ALIGNMENT_BENCHMARK_SCHEMA_VERSION: u8 = 2;
const ALIGNMENT_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlignmentBenchmarkSessionStatus {
    Active,
    CleanupBlocked,
    Released,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginAlignmentBenchmarkSessionRequest {
    schema_version: u8,
    run_manifest_canonical_json: String,
    run_manifest_digest: String,
    workload_digest: String,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    memory_sample_interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentBenchmarkBlindRunManifest {
    schema_version: u8,
    manifest_id: String,
    dataset_version: String,
    cases: Vec<AlignmentBenchmarkBlindCase>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentBenchmarkBlindCase {
    case_id: String,
    source: AlignmentBenchmarkBlindMediaInput,
    target: AlignmentBenchmarkBlindMediaInput,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentBenchmarkBlindMediaInput {
    path: String,
    audio_stream_index: u32,
    video_stream_index: Option<u32>,
    content_identity: AlignmentBenchmarkBlindContentIdentity,
    version_note: String,
    license_note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignmentBenchmarkBlindContentIdentity {
    algorithm: String,
    size_bytes: u64,
    digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AlignmentBenchmarkBindingSide {
    Source,
    Target,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkWorkloadBindingReceipt {
    binding_ordinal: usize,
    case_ordinal: usize,
    side: AlignmentBenchmarkBindingSide,
    volume_ordinal: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkWorkloadVolumeReceipt {
    volume_ordinal: usize,
    binding_count: usize,
    drive_type: &'static str,
    seek_penalty: &'static str,
    measurement_status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkWorkloadStorageReceipt {
    schema_version: u8,
    run_manifest_digest: String,
    workload_digest: String,
    binding_count: usize,
    unique_media_count: usize,
    volume_count: usize,
    media_set_digest: String,
    bindings: Vec<AlignmentBenchmarkWorkloadBindingReceipt>,
    volumes: Vec<AlignmentBenchmarkWorkloadVolumeReceipt>,
    receipt_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkToolFingerprint {
    version: String,
    binary_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkEnvironmentReceipt {
    schema_version: u8,
    collector_version: &'static str,
    measurement_status: &'static str,
    issues: Vec<String>,
    operating_system: String,
    operating_system_version: String,
    architecture: String,
    cpu_model: String,
    physical_core_count: u32,
    logical_core_count: u32,
    total_memory_bytes: u64,
    storage_scope: &'static str,
    storage_kind: String,
    workload_storage: AlignmentBenchmarkWorkloadStorageReceipt,
    power_profile: String,
    ffmpeg: AlignmentBenchmarkToolFingerprint,
    ffprobe: AlignmentBenchmarkToolFingerprint,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkSessionSnapshot {
    schema_version: u8,
    session_id: String,
    status: AlignmentBenchmarkSessionStatus,
    session_origin_tick_ns: String,
    cache_generation: u64,
    memory_scope: &'static str,
    memory_sample_interval_ms: u64,
    environment: AlignmentBenchmarkEnvironmentReceipt,
    active_job_id: Option<String>,
    cleanup_issue: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheCounts {
    audio_feature_entries: usize,
    landmark_entries: usize,
    visual_feature_entries: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheCounters {
    hits: u64,
    misses: u64,
    writes: u64,
    evictions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheTelemetry {
    generation: u64,
    before: AlignmentBenchmarkCacheCounts,
    after: AlignmentBenchmarkCacheCounts,
    audio_features: AlignmentBenchmarkCacheCounters,
    landmarks: AlignmentBenchmarkCacheCounters,
    visual_features: AlignmentBenchmarkCacheCounters,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkStageTiming {
    stage_key: String,
    occurrence: u32,
    start_tick_ns: String,
    end_tick_ns: String,
    elapsed_ms: f64,
    status: AudioAlignmentJobStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkMemoryTelemetry {
    scope: &'static str,
    sampler: &'static str,
    sample_interval_ms: u64,
    sample_count: u64,
    failed_sample_count: u64,
    maximum_sample_gap_ms: f64,
    peak_process_tree_rss_bytes: Option<u64>,
    coverage_complete: bool,
    process_tree_empty_at_terminal: bool,
    residual_process_count: usize,
}

impl AlignmentBenchmarkMemoryTelemetry {
    fn new(sample_interval_ms: u64) -> Self {
        Self {
            scope: "application-process-tree",
            sampler: if cfg!(windows) {
                "windows-toolhelp-working-set-v1"
            } else {
                "unsupported"
            },
            sample_interval_ms,
            sample_count: 0,
            failed_sample_count: 0,
            maximum_sample_gap_ms: 0.0,
            peak_process_tree_rss_bytes: None,
            coverage_complete: cfg!(windows),
            process_tree_empty_at_terminal: false,
            residual_process_count: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCancellationTelemetry {
    request_tick_ns: String,
    terminal_tick_ns: String,
    latency_ms: f64,
    command_accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkJobTelemetry {
    schema_version: u8,
    clock: &'static str,
    start_tick_ns: String,
    end_tick_ns: Option<String>,
    elapsed_ms: f64,
    stages: Vec<AlignmentBenchmarkStageTiming>,
    cache: AlignmentBenchmarkCacheTelemetry,
    memory: AlignmentBenchmarkMemoryTelemetry,
    cancellation: Option<AlignmentBenchmarkCancellationTelemetry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkJobSnapshot {
    schema_version: u8,
    session_id: String,
    job_id: String,
    status: AudioAlignmentJobStatus,
    stage_key: String,
    stage_label: String,
    proposal: Option<AudioAlignmentProposal>,
    error_code: Option<String>,
    telemetry: AlignmentBenchmarkJobTelemetry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentBenchmarkCacheResetReceipt {
    schema_version: u8,
    session_id: String,
    reset_tick_ns: String,
    previous_generation: u64,
    cache_generation: u64,
    before: AlignmentBenchmarkCacheCounts,
    after: AlignmentBenchmarkCacheCounts,
    all_caches_empty: bool,
}

struct AudioAlignmentOptions {
    sample_rate: u32,
    window_ms: u64,
    match_threshold: f64,
    min_gap_ms: u64,
    max_cells: usize,
    ffmpeg_path: String,
    ffprobe_path: PathBuf,
    enable_visual_evidence: bool,
    visual_sample_interval_ms: u64,
    localization_mode: bool,
}

#[derive(Debug, Clone)]
struct AlignmentAudioInput {
    presentation_origin_ms: i64,
    media_duration_ms: Option<u64>,
    content_identity: Option<MediaContentIdentity>,
    decode_timeline: Option<AudioDecodeTimelineProbe>,
    audio_stream_count: usize,
    explicit_stream_selection: bool,
    stream: AudioStreamProbe,
}

struct AlignmentMediaReadLease {
    _source: File,
    _target: File,
}

#[derive(Debug, Clone)]
struct CachedAudioFeatures {
    frames: Vec<AudioFeatureFrame>,
    cache_hit: bool,
}

#[derive(Debug, Clone)]
struct CachedV2Landmarks {
    landmarks: Arc<Vec<SpectralLandmark>>,
    pcm: Arc<Vec<i16>>,
    fine_features: Option<Arc<Vec<FineFeatureFrame>>>,
    cache_key: String,
    cache_hit: bool,
}

#[derive(Debug)]
struct DecodedV2Audio {
    pcm: Arc<Vec<i16>>,
    fine_features: Arc<Vec<FineFeatureFrame>>,
}

#[derive(Debug, Clone)]
struct V2MediaArtifact {
    pcm: Arc<Vec<i16>>,
    landmarks: Arc<Vec<SpectralLandmark>>,
    fine_features: Option<Arc<Vec<FineFeatureFrame>>>,
}

#[derive(Debug, Clone)]
struct V2MediaArtifactCacheEntry {
    artifact: V2MediaArtifact,
    resident_bytes: usize,
    last_access: u64,
}

#[derive(Debug)]
struct V2MediaArtifactCache {
    entries: HashMap<String, V2MediaArtifactCacheEntry>,
    resident_bytes: usize,
    access_clock: u64,
    max_resident_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct V2MediaArtifactCacheInsert {
    stored: bool,
    new_entry: bool,
    eviction_count: usize,
}

impl V2MediaArtifactCache {
    fn new(max_resident_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            resident_bytes: 0,
            access_clock: 0,
            max_resident_bytes,
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.resident_bytes = 0;
        self.access_clock = 0;
    }

    fn get(&mut self, cache_key: &str) -> Option<V2MediaArtifact> {
        self.access_clock = self.access_clock.saturating_add(1);
        let entry = self.entries.get_mut(cache_key)?;
        entry.last_access = self.access_clock;
        Some(entry.artifact.clone())
    }

    fn insert(
        &mut self,
        cache_key: String,
        artifact: V2MediaArtifact,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<V2MediaArtifactCacheInsert, String> {
        check_cancelled(cancel_flag)?;
        let previous = self.entries.remove(&cache_key);
        let new_entry = previous.is_none();
        if let Some(previous) = previous {
            self.resident_bytes = self.resident_bytes.saturating_sub(previous.resident_bytes);
        }

        let resident_bytes = v2_media_artifact_resident_bytes(&cache_key, &artifact);
        if resident_bytes > self.max_resident_bytes {
            return Ok(V2MediaArtifactCacheInsert {
                stored: false,
                new_entry,
                eviction_count: 0,
            });
        }

        let mut eviction_count = 0;
        while self.resident_bytes.saturating_add(resident_bytes) > self.max_resident_bytes {
            let Some(lru_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&lru_key) {
                self.resident_bytes = self.resident_bytes.saturating_sub(evicted.resident_bytes);
                eviction_count += 1;
            }
        }

        self.access_clock = self.access_clock.saturating_add(1);
        self.resident_bytes = self.resident_bytes.saturating_add(resident_bytes);
        self.entries.insert(
            cache_key,
            V2MediaArtifactCacheEntry {
                artifact,
                resident_bytes,
                last_access: self.access_clock,
            },
        );
        Ok(V2MediaArtifactCacheInsert {
            stored: true,
            new_entry,
            eviction_count,
        })
    }
}

#[derive(Debug, Clone)]
struct V2TrackPairCandidate {
    source_input: AlignmentAudioInput,
    target_input: AlignmentAudioInput,
    hypothesis: AffineHypothesis,
    score: f64,
    temporal_coverage: f64,
    intrinsic_margin: f64,
    repeated_content_only: bool,
    observation_count: usize,
    source_landmark_count: usize,
    target_landmark_count: usize,
}

#[derive(Debug)]
struct V2ChunkAlignment {
    spans: Vec<AudioTimeMapSpanDto>,
    matched_step_count: usize,
    ambiguous_step_count: usize,
}

#[derive(Debug, Default)]
struct V2BoundarySummary {
    attempted_count: usize,
    refined_count: usize,
    ambiguous_count: usize,
    max_uncertainty_ms: Option<u64>,
    evidence_notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedVisualFeatures {
    frames: Vec<VisualFeatureFrame>,
    cache_hit: bool,
}

#[derive(Debug, Clone)]
struct AlignmentVisualInput {
    presentation_origin_ms: i64,
    media_duration_ms: Option<u64>,
    content_identity: Option<MediaContentIdentity>,
    stream: VideoStreamProbe,
}

#[derive(Debug, Clone)]
struct VisualAffineObservation {
    target_index: usize,
    source_time_ms: u64,
    target_time_ms: u64,
    distance: f64,
}

#[derive(Debug, Clone)]
struct VisualAffineHypothesis {
    scale: f64,
    offset_ms: i64,
    score: f64,
    coverage: f64,
    temporal_span_coverage: f64,
    mean_distance: f64,
    p50_residual_ms: u64,
    p95_residual_ms: u64,
    max_residual_ms: u64,
    matches: Vec<VisualAffineObservation>,
}

#[derive(Debug)]
struct VisualAffineMatchResult {
    hypotheses: Vec<VisualAffineHypothesis>,
    informative_source_count: usize,
    informative_target_count: usize,
    candidate_count: usize,
    top1_top2_margin: f64,
}

struct VisualTimeMappingEvidence {
    observations: usize,
    supported_observations: usize,
    mean_distance: f64,
}

#[derive(Debug, Clone)]
struct AudioFingerprint {
    key: u64,
    frame_index: usize,
    time_ms: u64,
}

#[derive(Debug, Clone)]
struct SparseAudioCandidate {
    complete_index: usize,
    source_index: usize,
    complete_time_ms: u64,
    source_time_ms: u64,
    distance: f64,
    offset_ms: i64,
    offset_bucket: i64,
}

#[derive(Debug, Clone)]
struct OffsetPathObservation {
    source_time_ms: u64,
    offset_ms: i64,
    distance: f64,
}

#[derive(Debug, Clone)]
struct TimeMappingSegment {
    source_start_ms: u64,
    source_end_ms: u64,
    offset_ms: i64,
    observation_count: usize,
    mean_distance: f64,
}

#[derive(Debug, Clone)]
struct TimeMappingChangePoint {
    source_at_ms: u64,
    source_range_start_ms: u64,
    source_range_end_ms: u64,
    target_gap_ms: u64,
    confidence: f64,
    support_count: usize,
}

struct TimeMappingResult {
    observations: Vec<OffsetPathObservation>,
    segments: Vec<TimeMappingSegment>,
    change_points: Vec<TimeMappingChangePoint>,
    diagnostics: Vec<String>,
}

struct SparseAudioAlignmentResult {
    matches: Vec<AudioFeatureMatch>,
    complete_fingerprint_count: usize,
    source_fingerprint_count: usize,
    fingerprint_match_count: usize,
    offset_cluster_count: usize,
    low_confidence_region_count: usize,
    diagnostics: Vec<String>,
    time_mapping_segment_count: Option<usize>,
    change_points: Option<Vec<TimeMappingChangePoint>>,
}

struct MultistageAudioAlignmentResult {
    algorithm: String,
    matches: Vec<AudioFeatureMatch>,
    complete_fingerprint_count: usize,
    source_fingerprint_count: usize,
    fingerprint_match_count: usize,
    offset_cluster_count: usize,
    low_confidence_region_count: usize,
    diagnostics: Vec<String>,
    time_mapping_segment_count: Option<usize>,
    change_points: Option<Vec<TimeMappingChangePoint>>,
}

struct AudioAlignmentStageSnapshot {
    key: &'static str,
    label: &'static str,
    index: u8,
    count: u8,
    progress: f64,
}

struct AudioAlignmentJobEntry {
    snapshot: AudioAlignmentJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy)]
enum BenchmarkCacheKind {
    AudioFeatures,
    V2Landmarks,
    VisualFeatures,
}

#[derive(Debug, Clone, Copy)]
enum BenchmarkCacheEvent {
    Hit,
    Miss,
    Write,
    Eviction,
}

struct AlignmentBenchmarkRunTelemetry {
    session_origin: Instant,
    state: Mutex<AlignmentBenchmarkRunTelemetryState>,
}

struct AlignmentBenchmarkRunTelemetryState {
    stages: Vec<AlignmentBenchmarkStageTiming>,
    current_stage: Option<AlignmentBenchmarkActiveStage>,
    cache: AlignmentBenchmarkCacheTelemetry,
    memory: AlignmentBenchmarkMemoryTelemetry,
    started_tick_ns: u128,
    cancel_requested_tick_ns: Option<u128>,
    terminal_tick_ns: Option<u128>,
    last_memory_sample_at: Option<Instant>,
    memory_last_error: Option<String>,
}

struct AlignmentBenchmarkActiveStage {
    key: String,
    label: String,
    occurrence: u32,
    started_tick_ns: u128,
}

#[derive(Debug, Clone)]
struct AlignmentBenchmarkOutstandingReceipt {
    generation: u64,
    reset_tick_ns: u128,
    used: bool,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct AlignmentBenchmarkWindowsFileIdentity {
    volume_serial_number: u32,
    file_index: u64,
    file_size: u64,
    last_write_time: u64,
}

struct AlignmentBenchmarkPinnedTool {
    path: PathBuf,
    expected_digest: String,
    #[cfg(windows)]
    file: File,
    #[cfg(windows)]
    identity: AlignmentBenchmarkWindowsFileIdentity,
}

struct AlignmentBenchmarkPinnedMedia {
    canonical_path: PathBuf,
    expected_digest: String,
    expected_size_bytes: u64,
    expected_content_identity: MediaContentIdentity,
    #[cfg(windows)]
    file: File,
    #[cfg(windows)]
    identity: AlignmentBenchmarkWindowsFileIdentity,
}

#[derive(Debug, Clone)]
struct AlignmentBenchmarkRegisteredBinding {
    binding_ordinal: usize,
    pin_index: usize,
    audio_stream_index: u32,
    video_stream_index: Option<u32>,
}

#[derive(Debug, Clone)]
struct AlignmentBenchmarkRegisteredCase {
    case_ordinal: usize,
    source: AlignmentBenchmarkRegisteredBinding,
    target: AlignmentBenchmarkRegisteredBinding,
}

struct AlignmentBenchmarkRegisteredWorkload {
    pins: Vec<AlignmentBenchmarkPinnedMedia>,
    cases: Vec<AlignmentBenchmarkRegisteredCase>,
    receipt: AlignmentBenchmarkWorkloadStorageReceipt,
}

struct AlignmentBenchmarkSessionEntry {
    session_id: String,
    status: AlignmentBenchmarkSessionStatus,
    origin: Instant,
    sample_interval_ms: u64,
    cache_generation: u64,
    environment: AlignmentBenchmarkEnvironmentReceipt,
    ffmpeg_tool: AlignmentBenchmarkPinnedTool,
    ffprobe_tool: AlignmentBenchmarkPinnedTool,
    workload: AlignmentBenchmarkRegisteredWorkload,
    toolchain_integrity_failed: bool,
    workload_integrity_failed: bool,
    baseline_descendants: HashSet<u32>,
    active_job_id: Option<String>,
    cleanup_reason: Option<String>,
    outstanding_receipt: Option<AlignmentBenchmarkOutstandingReceipt>,
    jobs: HashMap<String, AlignmentBenchmarkJobEntry>,
}

struct AlignmentBenchmarkJobEntry {
    snapshot: AlignmentBenchmarkJobSnapshot,
    cancel_flag: Arc<AtomicBool>,
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    pending_terminal: Option<AlignmentBenchmarkPendingTerminal>,
}

struct AlignmentBenchmarkPendingTerminal {
    status: AudioAlignmentJobStatus,
    proposal: Option<AudioAlignmentProposal>,
    error_code: Option<String>,
}

struct PreparedAlignmentBenchmarkJob {
    session_id: String,
    job_id: String,
    request: AudioAlignmentRequest,
    expected_source_identity: MediaContentIdentity,
    expected_target_identity: MediaContentIdentity,
    cancel_flag: Arc<AtomicBool>,
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    sample_interval_ms: u64,
    baseline_descendants: HashSet<u32>,
    initial_snapshot: AlignmentBenchmarkJobSnapshot,
}

#[derive(Default)]
struct AlignmentBenchmarkCoordinator {
    session: Option<AlignmentBenchmarkSessionEntry>,
    initializing: bool,
    ordinary_active_runs: usize,
    sequence: u64,
    cache_generation: u64,
}

#[derive(Debug, Clone)]
struct ProcessTreeMemorySample {
    working_set_bytes: u64,
    descendants: HashSet<u32>,
}

thread_local! {
    static ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY: RefCell<Option<Arc<AlignmentBenchmarkRunTelemetry>>> = const { RefCell::new(None) };
    #[cfg(test)]
    static TEST_V2_PCM_DECODE_INVOCATIONS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

static AUDIO_ALIGNMENT_JOBS: OnceLock<Mutex<HashMap<String, AudioAlignmentJobEntry>>> =
    OnceLock::new();
static AUDIO_ALIGNMENT_JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static AUDIO_FEATURE_CACHE: OnceLock<Mutex<HashMap<String, Vec<AudioFeatureFrame>>>> =
    OnceLock::new();
// This remains the benchmark's `landmarks` cache slot for schema compatibility, but the
// entry is the complete V2 media/track artifact. Consequently a cold reset cannot leave
// hidden decoded PCM or fine features behind.
static V2_LANDMARK_CACHE: OnceLock<Mutex<V2MediaArtifactCache>> = OnceLock::new();
static VISUAL_FEATURE_CACHE: OnceLock<Mutex<HashMap<String, Vec<VisualFeatureFrame>>>> =
    OnceLock::new();
static ALIGNMENT_BENCHMARK_COORDINATOR: OnceLock<Mutex<AlignmentBenchmarkCoordinator>> =
    OnceLock::new();

#[tauri::command]
pub async fn align_audio_files(
    request: AudioAlignmentRequest,
) -> Result<AudioAlignmentProposal, String> {
    let permit = acquire_ordinary_alignment_run()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        align_audio_files_inner(request)
    })
    .await
    .map_err(|error| format!("本地音频对齐任务启动失败：{error}"))?
}

#[tauri::command]
pub async fn start_audio_alignment_job(
    request: AudioAlignmentRequest,
) -> Result<AudioAlignmentJobSnapshot, String> {
    let permit = acquire_ordinary_alignment_run()?;
    let job_id = next_audio_alignment_job_id();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    insert_audio_alignment_job(job_id.clone(), cancel_flag.clone())?;
    let worker_job_id = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        run_audio_alignment_job(worker_job_id, cancel_flag, request);
    });
    get_audio_alignment_job(job_id)
}

#[tauri::command]
pub fn get_audio_alignment_job(job_id: String) -> Result<AudioAlignmentJobSnapshot, String> {
    let jobs = audio_alignment_jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    jobs.get(&job_id)
        .map(|entry| entry.snapshot.clone())
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))
}

#[tauri::command]
pub fn cancel_audio_alignment_job(job_id: String) -> Result<AudioAlignmentJobSnapshot, String> {
    let mut jobs = audio_alignment_jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(&job_id)
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))?;
    entry.cancel_flag.store(true, Ordering::Relaxed);
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        // Keep the job non-terminal until the worker has actually left FFmpeg and all CPU loops.
        // The worker changes it to Cancelled after observing the token.
        entry.snapshot.message = "正在取消音频对齐任务，等待当前算法安全退出。".to_string();
        append_audio_alignment_log(&mut entry.snapshot.logs, "已请求取消；任务仍在退出中。");
        entry.snapshot.updated_at_ms = current_time_ms();
    }
    Ok(entry.snapshot.clone())
}

#[tauri::command]
pub async fn begin_alignment_benchmark_session(
    request: BeginAlignmentBenchmarkSessionRequest,
) -> Result<AlignmentBenchmarkSessionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || begin_alignment_benchmark_session_inner(request))
        .await
        .map_err(|error| format!("原生对齐基准会话初始化失败：{error}"))?
}

#[tauri::command]
pub fn get_active_alignment_benchmark_session(
) -> Result<Option<AlignmentBenchmarkSessionSnapshot>, String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    if process_supervision_cleanup_faulted() {
        if let Some(session) = coordinator.session.as_mut() {
            mark_alignment_benchmark_process_cleanup_blocked(session);
        }
    }
    Ok(coordinator
        .session
        .as_ref()
        .map(create_alignment_benchmark_session_snapshot))
}

#[tauri::command]
pub fn reset_alignment_benchmark_caches(
    session_id: String,
) -> Result<AlignmentBenchmarkCacheResetReceipt, String> {
    reset_alignment_benchmark_caches_inner(&session_id)
}

#[tauri::command]
pub async fn start_alignment_benchmark_job(
    session_id: String,
    request: AudioAlignmentRequest,
) -> Result<AlignmentBenchmarkJobSnapshot, String> {
    let prepared = prepare_alignment_benchmark_job(&session_id, request)?;
    let initial = prepared.initial_snapshot.clone();
    tauri::async_runtime::spawn_blocking(move || run_alignment_benchmark_job(prepared));
    Ok(initial)
}

#[tauri::command]
pub fn get_alignment_benchmark_job(
    session_id: String,
    job_id: String,
) -> Result<AlignmentBenchmarkJobSnapshot, String> {
    refresh_alignment_benchmark_cleanup(&session_id, &job_id)?;
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, &session_id)?;
    if let Some(entry) = session.jobs.get_mut(&job_id) {
        refresh_alignment_benchmark_job_snapshot(entry)?;
    }
    session
        .jobs
        .get(&job_id)
        .map(|entry| entry.snapshot.clone())
        .ok_or_else(|| format!("基准会话中不存在任务：{job_id}"))
}

#[tauri::command]
pub fn cancel_alignment_benchmark_job(
    session_id: String,
    job_id: String,
) -> Result<AlignmentBenchmarkJobSnapshot, String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, &session_id)?;
    let entry = session
        .jobs
        .get_mut(&job_id)
        .ok_or_else(|| format!("基准会话中不存在任务：{job_id}"))?;
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) && entry.pending_terminal.is_none()
    {
        let cancel_tick = entry.telemetry.record_cancel_request()?;
        entry.cancel_flag.store(true, Ordering::Release);
        entry.snapshot.telemetry.cancellation = Some(AlignmentBenchmarkCancellationTelemetry {
            request_tick_ns: cancel_tick.to_string(),
            terminal_tick_ns: String::new(),
            latency_ms: 0.0,
            command_accepted: true,
        });
    }
    refresh_alignment_benchmark_job_snapshot(entry)?;
    Ok(entry.snapshot.clone())
}

#[tauri::command]
pub fn finish_alignment_benchmark_session(
    session_id: String,
) -> Result<AlignmentBenchmarkSessionSnapshot, String> {
    finish_alignment_benchmark_session_inner(&session_id)
}

struct OrdinaryAlignmentRunPermit;

impl Drop for OrdinaryAlignmentRunPermit {
    fn drop(&mut self) {
        if let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() {
            coordinator.ordinary_active_runs = coordinator.ordinary_active_runs.saturating_sub(1);
        }
    }
}

struct AlignmentBenchmarkInitializationLease {
    armed: bool,
}

impl Drop for AlignmentBenchmarkInitializationLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() {
            coordinator.initializing = false;
        }
    }
}

fn alignment_benchmark_coordinator() -> &'static Mutex<AlignmentBenchmarkCoordinator> {
    ALIGNMENT_BENCHMARK_COORDINATOR
        .get_or_init(|| Mutex::new(AlignmentBenchmarkCoordinator::default()))
}

fn acquire_ordinary_alignment_run() -> Result<OrdinaryAlignmentRunPermit, String> {
    ensure_alignment_process_supervision_clean()?;
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    validate_ordinary_alignment_run_availability(
        coordinator.initializing,
        coordinator.session.is_some(),
        coordinator.ordinary_active_runs,
    )?;
    coordinator.ordinary_active_runs = coordinator
        .ordinary_active_runs
        .checked_add(1)
        .ok_or_else(|| "普通音频对齐任务计数溢出。".to_string())?;
    Ok(OrdinaryAlignmentRunPermit)
}

fn validate_ordinary_alignment_run_availability(
    initializing: bool,
    has_benchmark_session: bool,
    ordinary_active_runs: usize,
) -> Result<(), String> {
    if initializing || has_benchmark_session {
        return Err("原生性能独占会话正在运行；结束该会话后才能启动普通音频对齐任务。".to_string());
    }
    if ordinary_active_runs >= MAX_ORDINARY_ALIGNMENT_RUNS {
        return Err("已有一个媒体对齐任务正在运行；请等待它完成或取消后再启动下一批。".to_string());
    }
    Ok(())
}

fn acquire_alignment_benchmark_initialization_lease(
) -> Result<AlignmentBenchmarkInitializationLease, String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    validate_alignment_benchmark_lease_availability(
        coordinator.session.is_some(),
        coordinator.initializing,
        coordinator.ordinary_active_runs,
        has_active_audio_alignment_jobs()?,
    )?;
    coordinator.initializing = true;
    Ok(AlignmentBenchmarkInitializationLease { armed: true })
}

fn parse_alignment_benchmark_run_manifest(
    canonical_json: &str,
    run_manifest_digest: &str,
    workload_digest: &str,
) -> Result<AlignmentBenchmarkBlindRunManifest, String> {
    if canonical_json.len() > ALIGNMENT_BENCHMARK_MAX_MANIFEST_BYTES {
        return Err("runManifestCanonicalJson 超过 16 MiB 上限。".to_string());
    }
    if !is_canonical_alignment_benchmark_sha256(run_manifest_digest)
        || !is_canonical_alignment_benchmark_sha256(workload_digest)
    {
        return Err("runManifestDigest 与 workloadDigest 必须是规范小写 sha256 摘要。".to_string());
    }
    if run_manifest_digest != workload_digest {
        return Err("workloadDigest 必须与 blind run manifest 摘要完全一致。".to_string());
    }
    let value: serde_json::Value = serde_json::from_str(canonical_json)
        .map_err(|_| "runManifestCanonicalJson 不是有效 JSON。".to_string())?;
    validate_alignment_benchmark_manifest_json_shape(&value)?;
    let recanonicalized = canonicalize_alignment_benchmark_json(&value)?;
    if canonical_json != recanonicalized {
        return Err("runManifestCanonicalJson 不是规范 canonical JSON。".to_string());
    }
    let observed_digest = format!(
        "sha256:{}",
        sha256_alignment_benchmark_bytes(recanonicalized.as_bytes())
    );
    if observed_digest != run_manifest_digest {
        return Err("blind run manifest canonical JSON 与声明摘要不一致。".to_string());
    }
    let manifest: AlignmentBenchmarkBlindRunManifest = serde_json::from_value(value)
        .map_err(|_| "blind run manifest 字段类型无效或含未知字段。".to_string())?;
    validate_alignment_benchmark_run_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_alignment_benchmark_manifest_json_shape(
    value: &serde_json::Value,
) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "blind run manifest 必须是对象。".to_string())?;
    require_exact_alignment_benchmark_json_keys(
        root,
        &["schemaVersion", "manifestId", "datasetVersion", "cases"],
        "blind run manifest",
    )?;
    let cases = root
        .get("cases")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "blind run manifest cases 必须是数组。".to_string())?;
    for (case_ordinal, case) in cases.iter().enumerate() {
        let case = case
            .as_object()
            .ok_or_else(|| format!("blind run case {case_ordinal} 必须是对象。"))?;
        require_exact_alignment_benchmark_json_keys(
            case,
            &["caseId", "source", "target"],
            "blind run case",
        )?;
        for side in ["source", "target"] {
            let media = case
                .get(side)
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| format!("blind run case {case_ordinal} 的媒体字段无效。"))?;
            require_exact_alignment_benchmark_json_keys(
                media,
                &[
                    "path",
                    "audioStreamIndex",
                    "videoStreamIndex",
                    "contentIdentity",
                    "versionNote",
                    "licenseNote",
                ],
                "blind run media",
            )?;
            let identity = media
                .get("contentIdentity")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| "blind run media contentIdentity 无效。".to_string())?;
            require_exact_alignment_benchmark_json_keys(
                identity,
                &["algorithm", "sizeBytes", "digest"],
                "blind run media contentIdentity",
            )?;
        }
    }
    Ok(())
}

fn require_exact_alignment_benchmark_json_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    expected: &[&str],
    label: &str,
) -> Result<(), String> {
    if object.len() != expected.len()
        || expected.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !expected.iter().any(|expected| key == expected))
    {
        return Err(format!("{label} 缺少必需字段或含未知字段。"));
    }
    Ok(())
}

fn validate_alignment_benchmark_run_manifest(
    manifest: &AlignmentBenchmarkBlindRunManifest,
) -> Result<(), String> {
    if manifest.schema_version != ALIGNMENT_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION {
        return Err("blind run manifest schemaVersion 必须为 1。".to_string());
    }
    if manifest.manifest_id.trim().is_empty()
        || manifest.dataset_version.trim().is_empty()
        || manifest.manifest_id.len() > ALIGNMENT_BENCHMARK_MAX_ID_BYTES
        || manifest.dataset_version.len() > ALIGNMENT_BENCHMARK_MAX_ID_BYTES
    {
        return Err("blind run manifestId 与 datasetVersion 不能为空。".to_string());
    }
    if manifest.cases.is_empty() || manifest.cases.len() > ALIGNMENT_BENCHMARK_MAX_CASES {
        return Err(format!(
            "blind run manifest 必须包含 1–{ALIGNMENT_BENCHMARK_MAX_CASES} 个 case。"
        ));
    }
    let mut case_ids = HashSet::with_capacity(manifest.cases.len());
    for benchmark_case in &manifest.cases {
        if benchmark_case.case_id.trim().is_empty()
            || benchmark_case.case_id.len() > ALIGNMENT_BENCHMARK_MAX_ID_BYTES
            || !case_ids.insert(benchmark_case.case_id.clone())
        {
            return Err("blind run manifest caseId 不能为空或重复。".to_string());
        }
        validate_alignment_benchmark_blind_media(&benchmark_case.source)?;
        validate_alignment_benchmark_blind_media(&benchmark_case.target)?;
    }
    Ok(())
}

fn validate_alignment_benchmark_blind_media(
    media: &AlignmentBenchmarkBlindMediaInput,
) -> Result<(), String> {
    let path = media.path.trim();
    if path.is_empty()
        || path.encode_utf16().count() > ALIGNMENT_BENCHMARK_MAX_PATH_UTF16_UNITS
        || is_remote_media_input(path)
        || alignment_benchmark_path_uses_unsupported_remote_namespace(path)
    {
        return Err("blind run manifest 仅接受非空本地媒体路径。".to_string());
    }
    if media.version_note.trim().is_empty()
        || media.license_note.trim().is_empty()
        || media.version_note.len() > ALIGNMENT_BENCHMARK_MAX_NOTE_BYTES
        || media.license_note.len() > ALIGNMENT_BENCHMARK_MAX_NOTE_BYTES
    {
        return Err("blind run media 必须包含非空版本和许可说明。".to_string());
    }
    if media.content_identity.algorithm != "sha256-full-file-v2"
        || media.content_identity.size_bytes == 0
        || media.content_identity.size_bytes > ALIGNMENT_BENCHMARK_MAX_JSON_SAFE_INTEGER
        || !is_lowercase_alignment_benchmark_sha256_hex(&media.content_identity.digest)
    {
        return Err("blind run media 必须包含非空 sha256-full-file-v2 全文件身份。".to_string());
    }
    Ok(())
}

fn is_canonical_alignment_benchmark_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(is_lowercase_alignment_benchmark_sha256_hex)
}

fn is_lowercase_alignment_benchmark_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_alignment_benchmark_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonicalize_alignment_benchmark_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            serde_json::to_string(value).map_err(|_| "canonical JSON 标量序列化失败。".to_string())
        }
        serde_json::Value::String(_) => serde_json::to_string(value)
            .map_err(|_| "canonical JSON 字符串序列化失败。".to_string()),
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(canonicalize_alignment_benchmark_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let key_json = serde_json::to_string(key)
                        .map_err(|_| "canonical JSON 对象键序列化失败。".to_string())?;
                    let value_json = canonicalize_alignment_benchmark_json(&object[key])?;
                    Ok(format!("{key_json}:{value_json}"))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn begin_alignment_benchmark_session_inner(
    request: BeginAlignmentBenchmarkSessionRequest,
) -> Result<AlignmentBenchmarkSessionSnapshot, String> {
    if process_supervision_cleanup_faulted() {
        return Err(
            "blocked:process-cleanup：先前的受监督媒体进程未能可信收尾，不能创建基准会话。"
                .to_string(),
        );
    }
    if request.schema_version != ALIGNMENT_BENCHMARK_SCHEMA_VERSION {
        return Err(format!(
            "原生对齐基准 begin schemaVersion 必须为 {ALIGNMENT_BENCHMARK_SCHEMA_VERSION}。"
        ));
    }
    let manifest = parse_alignment_benchmark_run_manifest(
        &request.run_manifest_canonical_json,
        &request.run_manifest_digest,
        &request.workload_digest,
    )?;
    let sample_interval_ms = request
        .memory_sample_interval_ms
        .unwrap_or(DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS);
    if !(MIN_BENCHMARK_SAMPLE_INTERVAL_MS..=MAX_BENCHMARK_SAMPLE_INTERVAL_MS)
        .contains(&sample_interval_ms)
    {
        return Err(format!(
            "内存采样间隔必须在 {MIN_BENCHMARK_SAMPLE_INTERVAL_MS}–{MAX_BENCHMARK_SAMPLE_INTERVAL_MS} ms 之间。"
        ));
    }
    let ffmpeg_request = request.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    let ffprobe_request = request
        .ffprobe_path
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_ffprobe_path(ffmpeg_request));
    let mut initialization_lease = acquire_alignment_benchmark_initialization_lease()?;
    // Pin and hash every workload file before ToolHelp, tool-version, power, registry or storage
    // environment probes run. A failed initialization drops all local pins before the exclusive
    // initialization lease is released and never publishes a partial session.
    let workload = prepare_alignment_benchmark_workload(
        &manifest,
        &request.run_manifest_digest,
        &request.workload_digest,
    )?;
    let workload_receipt = workload.receipt.clone();
    let (baseline_descendants, (environment, ffmpeg_tool, ffprobe_tool)) =
        collect_alignment_benchmark_baseline_before_probe(
            || sample_process_tree_memory(std::process::id()).map(|sample| sample.descendants),
            || {
                collect_alignment_benchmark_environment(
                    ffmpeg_request,
                    &ffprobe_request,
                    workload_receipt,
                )
            },
        )?;

    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    if !coordinator.initializing || coordinator.session.is_some() {
        return Err("原生性能 initializing lease 在环境采集期间失效。".to_string());
    }
    coordinator.sequence = coordinator.sequence.saturating_add(1);
    let session_id =
        create_alignment_benchmark_id("alignment-benchmark-session", coordinator.sequence)?;
    let (status, cleanup_reason) =
        alignment_benchmark_initial_lifecycle_state(process_supervision_cleanup_faulted());
    let session = AlignmentBenchmarkSessionEntry {
        session_id,
        status,
        origin: Instant::now(),
        sample_interval_ms,
        cache_generation: coordinator.cache_generation,
        environment,
        ffmpeg_tool,
        ffprobe_tool,
        workload,
        toolchain_integrity_failed: false,
        workload_integrity_failed: false,
        baseline_descendants,
        active_job_id: None,
        cleanup_reason,
        outstanding_receipt: None,
        jobs: HashMap::new(),
    };
    let snapshot = create_alignment_benchmark_session_snapshot(&session);
    coordinator.initializing = false;
    coordinator.session = Some(session);
    initialization_lease.armed = false;
    Ok(snapshot)
}

fn collect_alignment_benchmark_baseline_before_probe<T>(
    capture_baseline: impl FnOnce() -> Result<HashSet<u32>, String>,
    probe_environment: impl FnOnce() -> Result<T, String>,
) -> Result<(HashSet<u32>, T), String> {
    // The process baseline must predate every executable probe. Otherwise a wrapper can spawn a
    // persistent helper during `-version` and have that helper incorrectly grandfathered into the
    // session baseline, bypassing residual-process cleanup for the rest of the lease.
    let baseline = capture_baseline()?;
    let environment = probe_environment()?;
    Ok((baseline, environment))
}

fn validate_alignment_benchmark_lease_availability(
    has_session: bool,
    initializing: bool,
    ordinary_active_runs: usize,
    has_active_job_snapshot: bool,
) -> Result<(), String> {
    if has_session || initializing {
        return Err("已有原生性能独占会话；不能重复取得 lease。".to_string());
    }
    if ordinary_active_runs != 0 || has_active_job_snapshot {
        return Err("仍有普通音频对齐任务在运行；基准会话未取得 lease。".to_string());
    }
    Ok(())
}

fn has_active_audio_alignment_jobs() -> Result<bool, String> {
    let jobs = audio_alignment_jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    Ok(jobs.values().any(|entry| {
        matches!(
            entry.snapshot.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        )
    }))
}

fn create_alignment_benchmark_session_snapshot(
    session: &AlignmentBenchmarkSessionEntry,
) -> AlignmentBenchmarkSessionSnapshot {
    AlignmentBenchmarkSessionSnapshot {
        schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
        session_id: session.session_id.clone(),
        status: session.status,
        session_origin_tick_ns: "0".to_string(),
        cache_generation: session.cache_generation,
        memory_scope: "application-process-tree",
        memory_sample_interval_ms: session.sample_interval_ms,
        environment: session.environment.clone(),
        active_job_id: session.active_job_id.clone(),
        cleanup_issue: session.cleanup_reason.clone(),
    }
}

fn require_alignment_benchmark_session<'a>(
    coordinator: &'a AlignmentBenchmarkCoordinator,
    session_id: &str,
) -> Result<&'a AlignmentBenchmarkSessionEntry, String> {
    let session = coordinator
        .session
        .as_ref()
        .ok_or_else(|| "没有活动的原生性能会话。".to_string())?;
    if session.session_id != session_id {
        return Err("性能任务与当前独占会话不匹配。".to_string());
    }
    Ok(session)
}

fn require_alignment_benchmark_session_mut<'a>(
    coordinator: &'a mut AlignmentBenchmarkCoordinator,
    session_id: &str,
) -> Result<&'a mut AlignmentBenchmarkSessionEntry, String> {
    let session = coordinator
        .session
        .as_mut()
        .ok_or_else(|| "没有活动的原生性能会话。".to_string())?;
    if session.session_id != session_id {
        return Err("性能任务与当前独占会话不匹配。".to_string());
    }
    Ok(session)
}

fn reset_alignment_benchmark_caches_inner(
    session_id: &str,
) -> Result<AlignmentBenchmarkCacheResetReceipt, String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    {
        let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
        ensure_alignment_benchmark_supervision_clean(session)?;
        if session.status != AlignmentBenchmarkSessionStatus::Active {
            return Err("基准会话处于 cleanup-blocked，不能重置缓存。".to_string());
        }
        if session.active_job_id.is_some() {
            return Err("基准任务运行期间不能重置缓存。".to_string());
        }
    }

    let mut audio = audio_feature_cache()
        .lock()
        .map_err(|_| "音频特征缓存锁已损坏。".to_string())?;
    let mut landmarks = v2_landmark_cache()
        .lock()
        .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
    let mut visual = visual_feature_cache()
        .lock()
        .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
    let before = AlignmentBenchmarkCacheCounts {
        audio_feature_entries: audio.len(),
        landmark_entries: landmarks.len(),
        visual_feature_entries: visual.len(),
    };
    audio.clear();
    landmarks.clear();
    visual.clear();
    let after = AlignmentBenchmarkCacheCounts::default();
    let previous_generation = coordinator.cache_generation;
    coordinator.cache_generation = coordinator.cache_generation.saturating_add(1);
    let generation = coordinator.cache_generation;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    session.cache_generation = generation;
    let reset_tick_ns = session.origin.elapsed().as_nanos().max(1);
    session.outstanding_receipt = Some(AlignmentBenchmarkOutstandingReceipt {
        generation,
        reset_tick_ns,
        used: false,
    });
    Ok(AlignmentBenchmarkCacheResetReceipt {
        schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        reset_tick_ns: reset_tick_ns.to_string(),
        previous_generation,
        cache_generation: generation,
        before,
        after,
        all_caches_empty: true,
    })
}

fn prepare_alignment_benchmark_job(
    session_id: &str,
    mut request: AudioAlignmentRequest,
) -> Result<PreparedAlignmentBenchmarkJob, String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    coordinator.sequence = coordinator.sequence.saturating_add(1);
    let sequence = coordinator.sequence;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    if session.status != AlignmentBenchmarkSessionStatus::Active {
        return Err("基准会话处于 cleanup-blocked，不能启动新任务。".to_string());
    }
    ensure_alignment_benchmark_supervision_clean(session)?;
    if session.active_job_id.is_some() {
        return Err("同一基准会话一次只能运行一个任务。".to_string());
    }
    if verify_alignment_benchmark_session_toolchain(session).is_err() {
        block_alignment_benchmark_session_for_toolchain(session);
        return Err("基准媒体工具在任务启动前未通过固定身份复核。".to_string());
    }
    if session.workload_integrity_failed {
        block_alignment_benchmark_session_for_workload(session);
        return Err("固定 workload media 在任务启动前未通过身份复核。".to_string());
    }
    let (expected_source_identity, expected_target_identity) =
        match validate_alignment_benchmark_registered_job_request(&session.workload, &mut request) {
            Ok(identities) => identities,
            Err(error) => {
                if error.starts_with("blocked:workload-media-integrity") {
                    block_alignment_benchmark_session_for_workload(session);
                }
                return Err("benchmark job 未匹配同一个已注册 blind case。".to_string());
            }
        };
    let receipt_generation = consume_alignment_benchmark_reset_receipt(
        session.outstanding_receipt.as_mut(),
        session.cache_generation,
    )?;
    request.ffmpeg_path = Some(session.ffmpeg_tool.path.to_string_lossy().into_owned());
    request.ffprobe_path = Some(session.ffprobe_tool.path.to_string_lossy().into_owned());
    let job_id = create_alignment_benchmark_id("alignment-benchmark-job", sequence)?;
    let before = read_alignment_benchmark_cache_counts()?;
    let telemetry = Arc::new(AlignmentBenchmarkRunTelemetry::new(
        session.origin,
        session.sample_interval_ms,
        session.cache_generation,
        before,
    ));
    if receipt_generation.is_some() {
        telemetry.verify_reset_generation(receipt_generation, session.cache_generation)?;
    }
    let initial_snapshot =
        create_initial_alignment_benchmark_job_snapshot(session_id, &job_id, &telemetry)?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    session.active_job_id = Some(job_id.clone());
    session.jobs.insert(
        job_id.clone(),
        AlignmentBenchmarkJobEntry {
            snapshot: initial_snapshot.clone(),
            cancel_flag: cancel_flag.clone(),
            telemetry: telemetry.clone(),
            pending_terminal: None,
        },
    );
    Ok(PreparedAlignmentBenchmarkJob {
        session_id: session_id.to_string(),
        job_id,
        request,
        expected_source_identity,
        expected_target_identity,
        cancel_flag,
        telemetry,
        sample_interval_ms: session.sample_interval_ms,
        baseline_descendants: session.baseline_descendants.clone(),
        initial_snapshot,
    })
}

fn verify_alignment_benchmark_session_toolchain(
    session: &AlignmentBenchmarkSessionEntry,
) -> Result<(), String> {
    if session.toolchain_integrity_failed {
        return Err("基准媒体工具此前已发生身份漂移。".to_string());
    }
    verify_alignment_benchmark_pinned_tool("ffmpeg", &session.ffmpeg_tool)?;
    verify_alignment_benchmark_pinned_tool("ffprobe", &session.ffprobe_tool)
}

fn ensure_alignment_benchmark_supervision_clean(
    session: &mut AlignmentBenchmarkSessionEntry,
) -> Result<(), String> {
    if !process_supervision_cleanup_faulted() {
        return Ok(());
    }
    mark_alignment_benchmark_process_cleanup_blocked(session);
    Err("blocked:process-cleanup：受监督媒体进程存在粘性清理故障。".to_string())
}

fn alignment_benchmark_initial_lifecycle_state(
    cleanup_faulted: bool,
) -> (AlignmentBenchmarkSessionStatus, Option<String>) {
    if cleanup_faulted {
        (
            AlignmentBenchmarkSessionStatus::CleanupBlocked,
            Some(BENCHMARK_PROCESS_CLEANUP_REASON.to_string()),
        )
    } else {
        (AlignmentBenchmarkSessionStatus::Active, None)
    }
}

fn mark_alignment_benchmark_process_cleanup_blocked(session: &mut AlignmentBenchmarkSessionEntry) {
    session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
    session.cleanup_reason = Some(BENCHMARK_PROCESS_CLEANUP_REASON.to_string());
}

fn block_alignment_benchmark_session_for_toolchain(session: &mut AlignmentBenchmarkSessionEntry) {
    session.toolchain_integrity_failed = true;
    session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
    session.cleanup_reason =
        Some("固定媒体工具身份复核失败；lease 与只读 pin 保持占用。".to_string());
}

fn block_alignment_benchmark_session_for_workload(session: &mut AlignmentBenchmarkSessionEntry) {
    session.workload_integrity_failed = true;
    session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
    session.cleanup_reason =
        Some("固定 workload media 身份复核失败；lease、媒体与工具 pin 保持占用。".to_string());
}

fn validate_alignment_benchmark_registered_job_request(
    workload: &AlignmentBenchmarkRegisteredWorkload,
    request: &mut AudioAlignmentRequest,
) -> Result<(MediaContentIdentity, MediaContentIdentity), String> {
    if workload.pins.is_empty() || workload.cases.is_empty() {
        return Err("benchmark workload 注册为空。".to_string());
    }
    let source_pin_index =
        resolve_alignment_benchmark_registered_request_pin(&workload.pins, &request.source_path)?;
    let target_pin_index =
        resolve_alignment_benchmark_registered_request_pin(&workload.pins, &request.complete_path)?;
    let source_audio_stream_index = request
        .source_audio_stream_index
        .ok_or_else(|| "benchmark job 必须显式声明 source audio stream。".to_string())?;
    let target_audio_stream_index = request
        .complete_audio_stream_index
        .ok_or_else(|| "benchmark job 必须显式声明 target audio stream。".to_string())?;
    let registered_index = find_alignment_benchmark_registered_case(
        &workload.cases,
        source_pin_index,
        target_pin_index,
        source_audio_stream_index,
        target_audio_stream_index,
        request.source_video_stream_index,
        request.complete_video_stream_index,
    )?;
    let registered = &workload.cases[registered_index];
    verify_alignment_benchmark_pinned_media(&workload.pins[registered.source.pin_index])
        .and_then(|_| {
            verify_alignment_benchmark_pinned_media(&workload.pins[registered.target.pin_index])
        })
        .map_err(|_| {
            "blocked:workload-media-integrity：当前 case 媒体 pin 身份复核失败。".to_string()
        })?;
    request.source_path = workload.pins[registered.source.pin_index]
        .canonical_path
        .to_string_lossy()
        .into_owned();
    request.complete_path = workload.pins[registered.target.pin_index]
        .canonical_path
        .to_string_lossy()
        .into_owned();
    Ok((
        workload.pins[registered.source.pin_index]
            .expected_content_identity
            .clone(),
        workload.pins[registered.target.pin_index]
            .expected_content_identity
            .clone(),
    ))
}

fn find_alignment_benchmark_registered_case(
    cases: &[AlignmentBenchmarkRegisteredCase],
    source_pin_index: usize,
    target_pin_index: usize,
    source_audio_stream_index: u32,
    target_audio_stream_index: u32,
    source_video_stream_index: Option<u32>,
    target_video_stream_index: Option<u32>,
) -> Result<usize, String> {
    let matching = cases
        .iter()
        .enumerate()
        .filter(|(_, benchmark_case)| {
            benchmark_case.source.pin_index == source_pin_index
                && benchmark_case.target.pin_index == target_pin_index
                && benchmark_case.source.audio_stream_index == source_audio_stream_index
                && benchmark_case.target.audio_stream_index == target_audio_stream_index
                && benchmark_case.source.video_stream_index == source_video_stream_index
                && benchmark_case.target.video_stream_index == target_video_stream_index
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err("benchmark job 的媒体、配对或显式流不属于唯一已注册 case。".to_string());
    }
    Ok(matching[0])
}

#[cfg(windows)]
fn resolve_alignment_benchmark_registered_request_pin(
    pins: &[AlignmentBenchmarkPinnedMedia],
    path: &str,
) -> Result<usize, String> {
    if path.trim().is_empty()
        || is_remote_media_input(path)
        || alignment_benchmark_path_uses_unsupported_remote_namespace(path)
    {
        return Err("benchmark job 媒体路径不是已注册本地路径。".to_string());
    }
    let file = open_alignment_benchmark_media_read_pin(Path::new(path.trim()))?;
    let identity = windows_alignment_benchmark_file_identity(&file)?;
    let final_path = windows_alignment_benchmark_final_path(&file)?;
    let matching = pins
        .iter()
        .enumerate()
        .filter(|(_, pinned)| pinned.identity == identity && pinned.canonical_path == final_path)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err("benchmark job 媒体 canonical final path 未注册或不唯一。".to_string());
    }
    Ok(matching[0])
}

#[cfg(not(windows))]
fn resolve_alignment_benchmark_registered_request_pin(
    _pins: &[AlignmentBenchmarkPinnedMedia],
    _path: &str,
) -> Result<usize, String> {
    Err("unsupported：benchmark workload 注册校验当前只支持 Windows。".to_string())
}

fn verify_alignment_benchmark_session_toolchain_by_id(session_id: &str) -> Result<(), String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    ensure_alignment_benchmark_supervision_clean(session)?;
    if verify_alignment_benchmark_session_toolchain(session).is_err() {
        block_alignment_benchmark_session_for_toolchain(session);
        return Err("固定媒体工具身份复核失败。".to_string());
    }
    Ok(())
}

fn block_alignment_benchmark_session_for_workload_by_id(session_id: &str) -> Result<(), String> {
    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    block_alignment_benchmark_session_for_workload(session);
    Ok(())
}

fn consume_alignment_benchmark_reset_receipt(
    receipt: Option<&mut AlignmentBenchmarkOutstandingReceipt>,
    current_generation: u64,
) -> Result<Option<u64>, String> {
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    if receipt.used {
        return Ok(None);
    }
    if receipt.generation != current_generation {
        return Err("缓存 reset receipt 与当前 generation 不匹配。".to_string());
    }
    if receipt.reset_tick_ns == 0 {
        return Err("缓存 reset receipt 缺少单调时钟签发点。".to_string());
    }
    receipt.used = true;
    Ok(Some(receipt.generation))
}

impl AlignmentBenchmarkRunTelemetry {
    fn new(
        session_origin: Instant,
        sample_interval_ms: u64,
        generation: u64,
        before: AlignmentBenchmarkCacheCounts,
    ) -> Self {
        Self {
            session_origin,
            state: Mutex::new(AlignmentBenchmarkRunTelemetryState {
                stages: Vec::new(),
                current_stage: None,
                cache: AlignmentBenchmarkCacheTelemetry {
                    generation,
                    before: before.clone(),
                    after: before,
                    audio_features: AlignmentBenchmarkCacheCounters::default(),
                    landmarks: AlignmentBenchmarkCacheCounters::default(),
                    visual_features: AlignmentBenchmarkCacheCounters::default(),
                },
                memory: AlignmentBenchmarkMemoryTelemetry::new(sample_interval_ms),
                started_tick_ns: 0,
                cancel_requested_tick_ns: None,
                terminal_tick_ns: None,
                last_memory_sample_at: None,
                memory_last_error: None,
            }),
        }
    }

    fn verify_reset_generation(
        &self,
        receipt_generation: Option<u64>,
        current_generation: u64,
    ) -> Result<(), String> {
        if receipt_generation != Some(current_generation) {
            return Err("cold cache reset receipt 未被严格绑定到当前任务。".to_string());
        }
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state.cache.generation != current_generation
            || state.cache.before != AlignmentBenchmarkCacheCounts::default()
        {
            return Err("cold cache receipt 已签发，但任务开始时三类缓存并非全空。".to_string());
        }
        Ok(())
    }

    fn mark_started(&self) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state.started_tick_ns == 0 {
            state.started_tick_ns = tick.max(1);
        }
        Ok(state.started_tick_ns)
    }

    fn transition_stage(&self, key: &str, label: &str) -> Result<(), String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        if state
            .current_stage
            .as_ref()
            .is_some_and(|stage| stage.key == key)
        {
            return Ok(());
        }
        close_alignment_benchmark_stage(&mut state, tick, AudioAlignmentJobStatus::Completed);
        let occurrence = state
            .stages
            .iter()
            .filter(|stage| stage.stage_key == key)
            .count()
            .saturating_add(1) as u32;
        state.current_stage = Some(AlignmentBenchmarkActiveStage {
            key: key.to_string(),
            label: label.to_string(),
            occurrence,
            started_tick_ns: tick,
        });
        Ok(())
    }

    fn record_cache_event(
        &self,
        kind: BenchmarkCacheKind,
        event: BenchmarkCacheEvent,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        let counters = match kind {
            BenchmarkCacheKind::AudioFeatures => &mut state.cache.audio_features,
            BenchmarkCacheKind::V2Landmarks => &mut state.cache.landmarks,
            BenchmarkCacheKind::VisualFeatures => &mut state.cache.visual_features,
        };
        match event {
            BenchmarkCacheEvent::Hit => counters.hits = counters.hits.saturating_add(1),
            BenchmarkCacheEvent::Miss => counters.misses = counters.misses.saturating_add(1),
            BenchmarkCacheEvent::Write => counters.writes = counters.writes.saturating_add(1),
            BenchmarkCacheEvent::Eviction => {
                counters.evictions = counters.evictions.saturating_add(1)
            }
        }
        Ok(())
    }

    fn record_cancel_request(&self) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        Ok(*state.cancel_requested_tick_ns.get_or_insert(tick))
    }

    fn record_memory_sample(
        &self,
        sampled_at: Instant,
        result: Result<ProcessTreeMemorySample, String>,
        baseline_descendants: &HashSet<u32>,
    ) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(previous) = state.last_memory_sample_at {
            let gap_ms = sampled_at.duration_since(previous).as_secs_f64() * 1_000.0;
            state.memory.maximum_sample_gap_ms = state.memory.maximum_sample_gap_ms.max(gap_ms);
            if gap_ms > state.memory.sample_interval_ms as f64 * 4.0 {
                state.memory.coverage_complete = false;
                state.memory_last_error =
                    Some("内存采样间隔出现超过配置值四倍的缺口。".to_string());
            }
        }
        state.last_memory_sample_at = Some(sampled_at);
        match result {
            Ok(sample) => {
                state.memory.sample_count = state.memory.sample_count.saturating_add(1);
                state.memory.peak_process_tree_rss_bytes = Some(
                    state
                        .memory
                        .peak_process_tree_rss_bytes
                        .unwrap_or(0)
                        .max(sample.working_set_bytes),
                );
                state.memory.residual_process_count =
                    sample.descendants.difference(baseline_descendants).count();
            }
            Err(error) => {
                state.memory.failed_sample_count =
                    state.memory.failed_sample_count.saturating_add(1);
                state.memory.coverage_complete = false;
                state.memory_last_error = Some(error);
            }
        }
    }

    fn set_cache_after(&self, after: AlignmentBenchmarkCacheCounts) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        state.cache.after = after;
        Ok(())
    }

    fn set_residual_process_count(&self, residual_count: usize) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        state.memory.residual_process_count = residual_count;
        state.memory.process_tree_empty_at_terminal = residual_count == 0;
        Ok(())
    }

    fn finish(&self, status: AudioAlignmentJobStatus) -> Result<u128, String> {
        let tick = self.session_origin.elapsed().as_nanos();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        close_alignment_benchmark_stage(&mut state, tick, status);
        state.terminal_tick_ns = Some(tick);
        state.memory.process_tree_empty_at_terminal = state.memory.residual_process_count == 0;
        Ok(tick)
    }

    fn current_stage(&self) -> Result<(String, String), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        Ok(state
            .current_stage
            .as_ref()
            .map(|stage| (stage.key.clone(), stage.label.clone()))
            .unwrap_or_else(|| ("queued".to_string(), "排队".to_string())))
    }

    fn snapshot(&self) -> Result<AlignmentBenchmarkJobTelemetry, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "基准任务 telemetry 锁已损坏。".to_string())?;
        let now = self.session_origin.elapsed().as_nanos();
        let end = state.terminal_tick_ns;
        let elapsed_end = end.unwrap_or(now);
        let elapsed_ms = elapsed_end.saturating_sub(state.started_tick_ns) as f64 / 1_000_000.0;
        let cancellation = state.cancel_requested_tick_ns.map(|request_tick| {
            let terminal_tick = end.unwrap_or(0);
            AlignmentBenchmarkCancellationTelemetry {
                request_tick_ns: request_tick.to_string(),
                terminal_tick_ns: end.map(|tick| tick.to_string()).unwrap_or_default(),
                latency_ms: if terminal_tick == 0 {
                    0.0
                } else {
                    terminal_tick.saturating_sub(request_tick) as f64 / 1_000_000.0
                },
                command_accepted: true,
            }
        });
        Ok(AlignmentBenchmarkJobTelemetry {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            clock: "rust-std-instant-session-relative-v1",
            start_tick_ns: state.started_tick_ns.to_string(),
            end_tick_ns: end.map(|tick| tick.to_string()),
            elapsed_ms,
            stages: state.stages.clone(),
            cache: state.cache.clone(),
            memory: state.memory.clone(),
            cancellation,
        })
    }
}

fn close_alignment_benchmark_stage(
    state: &mut AlignmentBenchmarkRunTelemetryState,
    end_tick_ns: u128,
    status: AudioAlignmentJobStatus,
) {
    let Some(stage) = state.current_stage.take() else {
        return;
    };
    state.stages.push(AlignmentBenchmarkStageTiming {
        stage_key: stage.key,
        occurrence: stage.occurrence,
        start_tick_ns: stage.started_tick_ns.to_string(),
        end_tick_ns: end_tick_ns.to_string(),
        elapsed_ms: end_tick_ns.saturating_sub(stage.started_tick_ns) as f64 / 1_000_000.0,
        status,
    });
}

fn create_initial_alignment_benchmark_job_snapshot(
    session_id: &str,
    job_id: &str,
    telemetry: &AlignmentBenchmarkRunTelemetry,
) -> Result<AlignmentBenchmarkJobSnapshot, String> {
    Ok(AlignmentBenchmarkJobSnapshot {
        schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
        session_id: session_id.to_string(),
        job_id: job_id.to_string(),
        status: AudioAlignmentJobStatus::Queued,
        stage_key: "queued".to_string(),
        stage_label: "排队".to_string(),
        proposal: None,
        error_code: None,
        telemetry: telemetry.snapshot()?,
    })
}

fn benchmark_stage(key: &str, label: &str) {
    ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
        if let Some(telemetry) = slot.borrow().as_ref() {
            let _ = telemetry.transition_stage(key, label);
        }
    });
}

fn benchmark_cache_event(kind: BenchmarkCacheKind, event: BenchmarkCacheEvent) {
    ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
        if let Some(telemetry) = slot.borrow().as_ref() {
            let _ = telemetry.record_cache_event(kind, event);
        }
    });
}

fn with_alignment_benchmark_telemetry<T>(
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    action: impl FnOnce() -> T,
) -> T {
    let previous = ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| slot.replace(Some(telemetry)));
    let _guard = ActiveAlignmentBenchmarkTelemetryGuard { previous };
    action()
}

struct ActiveAlignmentBenchmarkTelemetryGuard {
    previous: Option<Arc<AlignmentBenchmarkRunTelemetry>>,
}

impl Drop for ActiveAlignmentBenchmarkTelemetryGuard {
    fn drop(&mut self) {
        ACTIVE_ALIGNMENT_BENCHMARK_TELEMETRY.with(|slot| {
            slot.replace(self.previous.take());
        });
    }
}

fn run_alignment_benchmark_job(prepared: PreparedAlignmentBenchmarkJob) {
    let _ = prepared.telemetry.mark_started();
    benchmark_update_job_snapshot(
        &prepared.session_id,
        &prepared.job_id,
        AudioAlignmentJobStatus::Running,
        None,
        None,
    );
    let sampler_stop = Arc::new(AtomicBool::new(false));
    prepared.telemetry.record_memory_sample(
        Instant::now(),
        sample_process_tree_memory(std::process::id()),
        &prepared.baseline_descendants,
    );
    let sampler = match spawn_alignment_benchmark_memory_sampler(
        prepared.telemetry.clone(),
        sampler_stop.clone(),
        prepared.sample_interval_ms,
        prepared.baseline_descendants.clone(),
    ) {
        Ok(sampler) => sampler,
        Err(error) => {
            prepared.telemetry.record_memory_sample(
                Instant::now(),
                Err(error),
                &prepared.baseline_descendants,
            );
            let _ = verify_alignment_benchmark_session_toolchain_by_id(&prepared.session_id);
            complete_or_block_alignment_benchmark_job(
                &prepared.session_id,
                &prepared.job_id,
                AlignmentBenchmarkPendingTerminal {
                    status: AudioAlignmentJobStatus::Failed,
                    proposal: None,
                    error_code: Some("memory-sampler-start-failed".to_string()),
                },
                &prepared.baseline_descendants,
            );
            return;
        }
    };
    let cancel_flag = prepared.cancel_flag.clone();
    let mut update = |_progress: f64, _message: &str| Ok(());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        with_alignment_benchmark_telemetry(prepared.telemetry.clone(), || {
            align_audio_files_with_progress(
                prepared.request,
                &mut update,
                Some(cancel_flag.as_ref()),
            )
        })
    }))
    .unwrap_or_else(|_| Err("原生对齐基准 worker 异常退出。".to_string()));
    sampler_stop.store(true, Ordering::Release);
    if sampler.join().is_err() {
        prepared.telemetry.record_memory_sample(
            Instant::now(),
            Err("内存采样线程异常退出。".to_string()),
            &prepared.baseline_descendants,
        );
    }
    prepared.telemetry.record_memory_sample(
        Instant::now(),
        sample_process_tree_memory(std::process::id()),
        &prepared.baseline_descendants,
    );
    let cache_telemetry_complete = read_alignment_benchmark_cache_counts()
        .and_then(|after| prepared.telemetry.set_cache_after(after))
        .is_ok();
    let toolchain_telemetry_complete =
        verify_alignment_benchmark_session_toolchain_by_id(&prepared.session_id).is_ok();

    let (result, workload_identity_failed) = match result {
        Ok(proposal) => bind_alignment_benchmark_proposal_to_workload(
            proposal,
            &prepared.expected_source_identity,
            &prepared.expected_target_identity,
        ),
        Err(error) => (Err(error), false),
    };
    if workload_identity_failed {
        let _ = block_alignment_benchmark_session_for_workload_by_id(&prepared.session_id);
    }

    let pending = if !toolchain_telemetry_complete {
        AlignmentBenchmarkPendingTerminal {
            status: AudioAlignmentJobStatus::Failed,
            proposal: None,
            error_code: Some("toolchain-integrity-failed".to_string()),
        }
    } else if workload_identity_failed {
        AlignmentBenchmarkPendingTerminal {
            status: AudioAlignmentJobStatus::Failed,
            proposal: None,
            // Keep the existing bridge contract while the session lifecycle carries the
            // path-free workload-integrity reason and retains all pins fail-closed.
            error_code: Some("alignment-failed".to_string()),
        }
    } else if !cache_telemetry_complete {
        AlignmentBenchmarkPendingTerminal {
            status: AudioAlignmentJobStatus::Failed,
            proposal: None,
            error_code: Some("cache-telemetry-incomplete".to_string()),
        }
    } else {
        match result {
            Ok(proposal) => AlignmentBenchmarkPendingTerminal {
                status: AudioAlignmentJobStatus::Completed,
                proposal: Some(proposal),
                error_code: None,
            },
            Err(error)
                if prepared.cancel_flag.load(Ordering::Acquire)
                    || error == AUDIO_ALIGNMENT_CANCELLED =>
            {
                AlignmentBenchmarkPendingTerminal {
                    status: AudioAlignmentJobStatus::Cancelled,
                    proposal: None,
                    error_code: None,
                }
            }
            Err(_) => AlignmentBenchmarkPendingTerminal {
                status: AudioAlignmentJobStatus::Failed,
                proposal: None,
                error_code: Some("alignment-failed".to_string()),
            },
        }
    };
    complete_or_block_alignment_benchmark_job(
        &prepared.session_id,
        &prepared.job_id,
        pending,
        &prepared.baseline_descendants,
    );
}

fn spawn_alignment_benchmark_memory_sampler(
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    stop: Arc<AtomicBool>,
    sample_interval_ms: u64,
    baseline_descendants: HashSet<u32>,
) -> Result<thread::JoinHandle<()>, String> {
    thread::Builder::new()
        .name("alignment-benchmark-memory".to_string())
        .spawn(move || loop {
            let sampled_at = Instant::now();
            telemetry.record_memory_sample(
                sampled_at,
                sample_process_tree_memory(std::process::id()),
                &baseline_descendants,
            );
            if stop.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(sample_interval_ms));
        })
        .map_err(|error| format!("内存采样线程启动失败：{error}"))
}

fn benchmark_update_job_snapshot(
    session_id: &str,
    job_id: &str,
    status: AudioAlignmentJobStatus,
    proposal: Option<AudioAlignmentProposal>,
    error_code: Option<String>,
) {
    let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() else {
        return;
    };
    let Ok(session) = require_alignment_benchmark_session_mut(&mut coordinator, session_id) else {
        return;
    };
    let Some(entry) = session.jobs.get_mut(job_id) else {
        return;
    };
    let Ok((stage_key, stage_label)) = entry.telemetry.current_stage() else {
        return;
    };
    let Ok(telemetry) = entry.telemetry.snapshot() else {
        return;
    };
    entry.snapshot.status = status;
    entry.snapshot.stage_key = stage_key;
    entry.snapshot.stage_label = stage_label;
    entry.snapshot.proposal = proposal;
    entry.snapshot.error_code = error_code;
    entry.snapshot.telemetry = telemetry;
}

fn refresh_alignment_benchmark_job_snapshot(
    entry: &mut AlignmentBenchmarkJobEntry,
) -> Result<(), String> {
    if matches!(
        entry.snapshot.status,
        AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
    ) {
        let (stage_key, stage_label) = entry.telemetry.current_stage()?;
        entry.snapshot.stage_key = stage_key;
        entry.snapshot.stage_label = stage_label;
    }
    entry.snapshot.telemetry = entry.telemetry.snapshot()?;
    Ok(())
}

fn complete_or_block_alignment_benchmark_job(
    session_id: &str,
    job_id: &str,
    pending: AlignmentBenchmarkPendingTerminal,
    baseline_descendants: &HashSet<u32>,
) {
    let deadline = Instant::now() + Duration::from_millis(BENCHMARK_RESIDUAL_GRACE_MS);
    loop {
        match sample_process_tree_memory(std::process::id()) {
            Ok(sample) => {
                let residual = sample.descendants.difference(baseline_descendants).count();
                if let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() {
                    if let Ok(session) =
                        require_alignment_benchmark_session_mut(&mut coordinator, session_id)
                    {
                        if let Some(entry) = session.jobs.get_mut(job_id) {
                            entry.telemetry.record_memory_sample(
                                Instant::now(),
                                Ok(sample),
                                baseline_descendants,
                            );
                            let _ = entry.telemetry.set_residual_process_count(residual);
                        }
                    }
                }
                if residual == 0 {
                    finalize_alignment_benchmark_job(session_id, job_id, pending);
                    return;
                }
            }
            Err(error) => {
                if let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() {
                    if let Ok(session) =
                        require_alignment_benchmark_session_mut(&mut coordinator, session_id)
                    {
                        if let Some(entry) = session.jobs.get_mut(job_id) {
                            entry.telemetry.record_memory_sample(
                                Instant::now(),
                                Err(error),
                                baseline_descendants,
                            );
                        }
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS));
    }
    if let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() {
        if let Ok(session) = require_alignment_benchmark_session_mut(&mut coordinator, session_id) {
            session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
            session.cleanup_reason = Some(
                "基准算法已退出，但仍检测到会话开始后出现的后代进程；lease 保持占用。".to_string(),
            );
            if let Some(entry) = session.jobs.get_mut(job_id) {
                entry.pending_terminal = Some(pending);
                entry.snapshot.status = AudioAlignmentJobStatus::Running;
                entry.snapshot.error_code = Some("cleanup-blocked".to_string());
                if let Ok(telemetry) = entry.telemetry.snapshot() {
                    entry.snapshot.telemetry = telemetry;
                }
            }
        }
    }
}

fn finalize_alignment_benchmark_job(
    session_id: &str,
    job_id: &str,
    pending: AlignmentBenchmarkPendingTerminal,
) {
    let Ok(mut coordinator) = alignment_benchmark_coordinator().lock() else {
        return;
    };
    let Ok(session) = require_alignment_benchmark_session_mut(&mut coordinator, session_id) else {
        return;
    };
    let Some(entry) = session.jobs.get_mut(job_id) else {
        return;
    };
    let _ = entry.telemetry.set_residual_process_count(0);
    let _ = entry.telemetry.finish(pending.status);
    let (stage_key, stage_label) = match pending.status {
        AudioAlignmentJobStatus::Completed => ("completed", "已完成"),
        AudioAlignmentJobStatus::Failed => ("failed", "失败"),
        AudioAlignmentJobStatus::Cancelled => ("cancelled", "已取消"),
        _ => ("reporting", "生成复核数据"),
    };
    entry.snapshot.status = pending.status;
    entry.snapshot.stage_key = stage_key.to_string();
    entry.snapshot.stage_label = stage_label.to_string();
    entry.snapshot.proposal = pending.proposal;
    entry.snapshot.error_code = pending.error_code;
    if let Ok(telemetry) = entry.telemetry.snapshot() {
        entry.snapshot.telemetry = telemetry;
    }
    session.active_job_id = None;
    if process_supervision_cleanup_faulted() {
        mark_alignment_benchmark_process_cleanup_blocked(session);
    } else if session.toolchain_integrity_failed {
        session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
        session.cleanup_reason =
            Some("固定媒体工具身份复核失败；lease 与只读 pin 保持占用。".to_string());
    } else if session.workload_integrity_failed {
        block_alignment_benchmark_session_for_workload(session);
    } else {
        session.status = AlignmentBenchmarkSessionStatus::Active;
        session.cleanup_reason = None;
    }
}

fn refresh_alignment_benchmark_cleanup(session_id: &str, job_id: &str) -> Result<(), String> {
    let (baseline, has_pending) = {
        let coordinator = alignment_benchmark_coordinator()
            .lock()
            .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
        let session = require_alignment_benchmark_session(&coordinator, session_id)?;
        let entry = session
            .jobs
            .get(job_id)
            .ok_or_else(|| format!("基准会话中不存在任务：{job_id}"))?;
        (
            session.baseline_descendants.clone(),
            entry.pending_terminal.is_some(),
        )
    };
    if !has_pending {
        return Ok(());
    }
    let sample = match sample_process_tree_memory(std::process::id()) {
        Ok(sample) => sample,
        Err(error) => {
            let mut coordinator = alignment_benchmark_coordinator()
                .lock()
                .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
            let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
            if let Some(entry) = session.jobs.get_mut(job_id) {
                entry
                    .telemetry
                    .record_memory_sample(Instant::now(), Err(error), &baseline);
            }
            return Ok(());
        }
    };
    {
        let mut coordinator = alignment_benchmark_coordinator()
            .lock()
            .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
        let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
        if let Some(entry) = session.jobs.get_mut(job_id) {
            entry
                .telemetry
                .record_memory_sample(Instant::now(), Ok(sample.clone()), &baseline);
        }
    }
    if sample.descendants.difference(&baseline).next().is_some() {
        return Ok(());
    }
    let pending = {
        let mut coordinator = alignment_benchmark_coordinator()
            .lock()
            .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
        let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
        session
            .jobs
            .get_mut(job_id)
            .and_then(|entry| entry.pending_terminal.take())
    };
    if let Some(pending) = pending {
        finalize_alignment_benchmark_job(session_id, job_id, pending);
    }
    Ok(())
}

fn finish_alignment_benchmark_session_inner(
    session_id: &str,
) -> Result<AlignmentBenchmarkSessionSnapshot, String> {
    let pending_jobs = {
        let coordinator = alignment_benchmark_coordinator()
            .lock()
            .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
        let session = require_alignment_benchmark_session(&coordinator, session_id)?;
        session
            .jobs
            .iter()
            .filter(|(_, entry)| entry.pending_terminal.is_some())
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>()
    };
    for job_id in pending_jobs {
        let _ = refresh_alignment_benchmark_cleanup(session_id, &job_id);
    }

    let mut coordinator = alignment_benchmark_coordinator()
        .lock()
        .map_err(|_| "原生对齐基准协调锁已损坏。".to_string())?;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    let has_non_terminal = session.jobs.values().any(|entry| {
        matches!(
            entry.snapshot.status,
            AudioAlignmentJobStatus::Queued | AudioAlignmentJobStatus::Running
        )
    });
    if session.active_job_id.is_some() || has_non_terminal {
        session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
        session.cleanup_reason =
            Some("仍有基准任务或后代进程未进入可信终态；lease 未释放。".to_string());
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }
    if ensure_alignment_benchmark_supervision_clean(session).is_err() {
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }
    if verify_alignment_benchmark_session_toolchain(session).is_err() {
        block_alignment_benchmark_session_for_toolchain(session);
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }
    if session.workload_integrity_failed
        || verify_alignment_benchmark_workload(&session.workload).is_err()
    {
        block_alignment_benchmark_session_for_workload(session);
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }
    let sample = match sample_process_tree_memory(std::process::id()) {
        Ok(sample) => sample,
        Err(_) => {
            session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
            session.cleanup_reason =
                Some("无法确认进程树已清空；lease 按 fail-closed 保持占用。".to_string());
            return Ok(create_alignment_benchmark_session_snapshot(session));
        }
    };
    if sample
        .descendants
        .difference(&session.baseline_descendants)
        .next()
        .is_some()
    {
        session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
        session.cleanup_reason =
            Some("会话开始后出现的后代进程仍未退出；lease 未释放。".to_string());
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }

    let cache_cleanup = (|| -> Result<(), String> {
        let mut audio = audio_feature_cache()
            .lock()
            .map_err(|_| "音频特征缓存锁已损坏。".to_string())?;
        let mut landmarks = v2_landmark_cache()
            .lock()
            .map_err(|_| "landmark 缓存锁已损坏。".to_string())?;
        let mut visual = visual_feature_cache()
            .lock()
            .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
        audio.clear();
        landmarks.clear();
        visual.clear();
        Ok(())
    })();
    if cache_cleanup.is_err() {
        let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
        session.status = AlignmentBenchmarkSessionStatus::CleanupBlocked;
        session.cleanup_reason =
            Some("三类应用特征缓存未能全部清理；lease 按 fail-closed 保持占用。".to_string());
        return Ok(create_alignment_benchmark_session_snapshot(session));
    }
    coordinator.cache_generation = coordinator.cache_generation.saturating_add(1);
    let released_generation = coordinator.cache_generation;
    let session = require_alignment_benchmark_session_mut(&mut coordinator, session_id)?;
    session.cache_generation = released_generation;
    session.jobs.clear();
    session.outstanding_receipt = None;
    session.active_job_id = None;
    session.status = AlignmentBenchmarkSessionStatus::Released;
    session.cleanup_reason = None;
    let snapshot = create_alignment_benchmark_session_snapshot(session);
    coordinator.session = None;
    Ok(snapshot)
}

fn read_alignment_benchmark_cache_counts() -> Result<AlignmentBenchmarkCacheCounts, String> {
    let audio = audio_feature_cache()
        .lock()
        .map_err(|_| "音频特征缓存锁已损坏。".to_string())?;
    let landmarks = v2_landmark_cache()
        .lock()
        .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
    let visual = visual_feature_cache()
        .lock()
        .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
    Ok(AlignmentBenchmarkCacheCounts {
        audio_feature_entries: audio.len(),
        landmark_entries: landmarks.len(),
        visual_feature_entries: visual.len(),
    })
}

fn create_alignment_benchmark_id(prefix: &str, sequence: u64) -> Result<String, String> {
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random).map_err(|error| format!("无法生成基准会话随机标识：{error}"))?;
    Ok(format!(
        "{prefix}-{sequence}-{}",
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

#[cfg(not(windows))]
fn prepare_alignment_benchmark_workload(
    _manifest: &AlignmentBenchmarkBlindRunManifest,
    _run_manifest_digest: &str,
    _workload_digest: &str,
) -> Result<AlignmentBenchmarkRegisteredWorkload, String> {
    Err("unsupported：workload media pin 与卷回执当前只支持 Windows。".to_string())
}

#[cfg(windows)]
fn prepare_alignment_benchmark_workload(
    manifest: &AlignmentBenchmarkBlindRunManifest,
    run_manifest_digest: &str,
    workload_digest: &str,
) -> Result<AlignmentBenchmarkRegisteredWorkload, String> {
    let mut pins = Vec::<AlignmentBenchmarkPinnedMedia>::new();
    let mut pin_indexes = HashMap::<AlignmentBenchmarkWindowsFileIdentity, usize>::new();
    let mut cases = Vec::with_capacity(manifest.cases.len());

    for (case_ordinal, benchmark_case) in manifest.cases.iter().enumerate() {
        let source = register_alignment_benchmark_media_binding(
            &benchmark_case.source,
            case_ordinal * 2,
            &mut pins,
            &mut pin_indexes,
        )?;
        let target = register_alignment_benchmark_media_binding(
            &benchmark_case.target,
            case_ordinal * 2 + 1,
            &mut pins,
            &mut pin_indexes,
        )?;
        cases.push(AlignmentBenchmarkRegisteredCase {
            case_ordinal,
            source,
            target,
        });
    }

    reject_ambiguous_alignment_benchmark_case_registrations(&cases)?;

    // Every distinct media handle is now pinned. Only after that invariant is established may
    // the native collector inspect the actual volumes backing those handles.
    let volume_measurements = pins
        .iter()
        .map(windows_alignment_benchmark_media_volume)
        .collect::<Result<Vec<_>, _>>()?;
    let (bindings, volumes) =
        create_alignment_benchmark_volume_receipts(&cases, &volume_measurements)?;
    let media_set_digest = create_alignment_benchmark_media_set_digest(manifest)?;
    let mut receipt = AlignmentBenchmarkWorkloadStorageReceipt {
        schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
        run_manifest_digest: run_manifest_digest.to_string(),
        workload_digest: workload_digest.to_string(),
        binding_count: bindings.len(),
        unique_media_count: pins.len(),
        volume_count: volumes.len(),
        media_set_digest,
        bindings,
        volumes,
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = create_alignment_benchmark_workload_receipt_digest(&receipt)?;
    Ok(AlignmentBenchmarkRegisteredWorkload {
        pins,
        cases,
        receipt,
    })
}

#[cfg(windows)]
fn register_alignment_benchmark_media_binding(
    media: &AlignmentBenchmarkBlindMediaInput,
    binding_ordinal: usize,
    pins: &mut Vec<AlignmentBenchmarkPinnedMedia>,
    pin_indexes: &mut HashMap<AlignmentBenchmarkWindowsFileIdentity, usize>,
) -> Result<AlignmentBenchmarkRegisteredBinding, String> {
    let (file, identity, canonical_path) = open_alignment_benchmark_media_candidate(media)?;
    let pin_index = if let Some(existing_index) = pin_indexes.get(&identity).copied() {
        let existing = &pins[existing_index];
        if existing.expected_digest != media.content_identity.digest
            || existing.expected_size_bytes != media.content_identity.size_bytes
            || existing.canonical_path != canonical_path
        {
            return Err("同一媒体文件身份对应了互相冲突的 blind manifest 声明。".to_string());
        }
        existing_index
    } else {
        let observed_digest = sha256_alignment_benchmark_pinned_file(&file)?;
        if identity.file_size != media.content_identity.size_bytes
            || observed_digest != media.content_identity.digest
        {
            return Err("blind run manifest 媒体完整身份与固定句柄不一致。".to_string());
        }
        let expected_content_identity =
            alignment_benchmark_pinned_media_content_identity(&file, &observed_digest)?;
        let candidate = AlignmentBenchmarkPinnedMedia {
            canonical_path,
            expected_digest: observed_digest,
            expected_size_bytes: identity.file_size,
            expected_content_identity,
            file,
            identity,
        };
        verify_alignment_benchmark_pinned_media(&candidate)?;
        let index = pins.len();
        pin_indexes.insert(identity, index);
        pins.push(candidate);
        index
    };
    Ok(AlignmentBenchmarkRegisteredBinding {
        binding_ordinal,
        pin_index,
        audio_stream_index: media.audio_stream_index,
        video_stream_index: media.video_stream_index,
    })
}

#[cfg(windows)]
fn open_alignment_benchmark_media_candidate(
    media: &AlignmentBenchmarkBlindMediaInput,
) -> Result<(File, AlignmentBenchmarkWindowsFileIdentity, PathBuf), String> {
    let requested_path = Path::new(media.path.trim());
    if !requested_path.is_absolute() {
        return Err("blind run manifest 媒体路径必须是绝对本地路径。".to_string());
    }
    let file = open_alignment_benchmark_media_read_pin(requested_path)?;
    let identity = windows_alignment_benchmark_file_identity(&file)?;
    let canonical_path = windows_alignment_benchmark_final_path(&file)?;
    Ok((file, identity, canonical_path))
}

#[cfg(windows)]
fn open_alignment_benchmark_media_read_pin(path: &Path) -> Result<File, String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| {
            "blocked:workload-media-pin：无法固定本地媒体；路径与系统详情已隐藏。".to_string()
        })
}

#[cfg(windows)]
fn alignment_benchmark_pinned_media_content_identity(
    file: &File,
    full_digest: &str,
) -> Result<MediaContentIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "固定 workload media 无法读取身份元数据。".to_string())?;
    let modified_unix_ms = metadata
        .modified()
        .map_err(|_| "固定 workload media 无法读取修改时间。".to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "固定 workload media 修改时间无效。".to_string())?
        .as_millis();
    let modified_unix_ms = u64::try_from(modified_unix_ms)
        .map_err(|_| "固定 workload media 修改时间超出支持范围。".to_string())?;
    if metadata.len() == 0
        || metadata.len() != windows_alignment_benchmark_file_identity(file)?.file_size
    {
        return Err("固定 workload media 身份元数据不一致。".to_string());
    }
    if full_digest.len() != 64
        || !full_digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("固定 workload media 全文件摘要格式无效。".to_string());
    }
    Ok(MediaContentIdentity {
        algorithm: "sha256-full-file-v2",
        size_bytes: metadata.len(),
        modified_unix_ms,
        first_sample_digest: full_digest.to_string(),
        middle_sample_digest: full_digest.to_string(),
        last_sample_digest: full_digest.to_string(),
    })
}

#[cfg(windows)]
fn windows_alignment_benchmark_final_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_GUID,
    };

    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: file owns a valid handle and buffer is writable for the capacity supplied.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(
            "固定媒体句柄无法解析本地卷 GUID canonical path；远程或无卷 GUID 输入已拒绝。"
                .to_string(),
        );
    }
    buffer.truncate(length);
    let raw = std::ffi::OsString::from_wide(&buffer)
        .to_string_lossy()
        .into_owned();
    if !is_alignment_benchmark_local_volume_guid_path(&raw) {
        return Err("固定媒体句柄没有解析到规范本地卷 GUID path。".to_string());
    }
    // Keep the verbatim \\?\Volume{GUID}\ prefix. std::fs/OpenOptions passes it to CreateFileW,
    // while current FFmpeg/FFprobe Windows file I/O recognizes an existing extended prefix and
    // leaves it unchanged. Reusing this exact handle-derived path removes the mutable drive-letter
    // and mounted-folder namespace from job validation, reopening and execution.
    Ok(PathBuf::from(raw))
}

#[cfg(windows)]
fn verify_alignment_benchmark_pinned_media(
    pinned: &AlignmentBenchmarkPinnedMedia,
) -> Result<(), String> {
    let handle_identity = windows_alignment_benchmark_file_identity(&pinned.file)?;
    let current_path_file = open_alignment_benchmark_media_read_pin(&pinned.canonical_path)?;
    let current_path_identity = windows_alignment_benchmark_file_identity(&current_path_file)?;
    let current_final_path = windows_alignment_benchmark_final_path(&current_path_file)?;
    if handle_identity != pinned.identity
        || current_path_identity != pinned.identity
        || current_final_path != pinned.canonical_path
        || handle_identity.file_size != pinned.expected_size_bytes
    {
        return Err("固定 workload media 身份或 canonical final path 发生变化。".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_alignment_benchmark_pinned_media(
    _pinned: &AlignmentBenchmarkPinnedMedia,
) -> Result<(), String> {
    Err("unsupported：workload media pin 当前只支持 Windows。".to_string())
}

fn verify_alignment_benchmark_workload(
    workload: &AlignmentBenchmarkRegisteredWorkload,
) -> Result<(), String> {
    for pinned in &workload.pins {
        verify_alignment_benchmark_pinned_media(pinned)?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct AlignmentBenchmarkVolumeMeasurement {
    stable_key: String,
    seek_penalty: bool,
}

#[cfg(windows)]
fn windows_alignment_benchmark_media_volume(
    pinned: &AlignmentBenchmarkPinnedMedia,
) -> Result<AlignmentBenchmarkVolumeMeasurement, String> {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    const WINDOWS_DRIVE_FIXED: u32 = 3;

    let guid_path = pinned
        .canonical_path
        .to_str()
        .ok_or_else(|| "固定媒体句柄返回的实际卷 GUID 无效。".to_string())?;
    let volume_root = alignment_benchmark_volume_guid_root_from_handle_path(guid_path)?;
    let volume_length = volume_root.encode_utf16().count();
    let volume_name = volume_root
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: volume_name is a NUL-terminated root path returned by Windows.
    let drive_type = unsafe { GetDriveTypeW(volume_name.as_ptr()) };
    if drive_type != WINDOWS_DRIVE_FIXED {
        return Err("workload media 位于非固定本地卷，正式基准已拒绝。".to_string());
    }
    let stable_key = String::from_utf16_lossy(&volume_name[..volume_length]).to_ascii_lowercase();
    let seek_penalty = windows_alignment_benchmark_volume_seek_penalty(&volume_name)?;
    Ok(AlignmentBenchmarkVolumeMeasurement {
        stable_key,
        seek_penalty,
    })
}

fn alignment_benchmark_volume_guid_root_from_handle_path(path: &str) -> Result<String, String> {
    const PREFIX: &str = r"\\?\Volume{";
    let prefix = path
        .get(..PREFIX.len())
        .filter(|value| value.eq_ignore_ascii_case(PREFIX))
        .ok_or_else(|| "固定媒体句柄没有返回规范卷 GUID 路径。".to_string())?;
    let remainder = path
        .get(prefix.len()..)
        .ok_or_else(|| "固定媒体句柄返回的卷 GUID 路径不完整。".to_string())?;
    let close = remainder
        .find(r"}\")
        .ok_or_else(|| "固定媒体句柄返回的卷 GUID 根目录不完整。".to_string())?;
    let identifier = &remainder[..close];
    let valid_guid = identifier.len() == 36
        && identifier.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if !valid_guid {
        return Err("固定媒体句柄返回的卷 GUID 格式无效。".to_string());
    }
    let root_end = PREFIX.len() + close + 2;
    path.get(..root_end)
        .map(str::to_string)
        .ok_or_else(|| "固定媒体句柄返回的卷 GUID 根目录无法截取。".to_string())
}

fn is_alignment_benchmark_local_volume_guid_path(path: &str) -> bool {
    alignment_benchmark_volume_guid_root_from_handle_path(path.trim()).is_ok()
}

fn alignment_benchmark_path_uses_unsupported_remote_namespace(path: &str) -> bool {
    let path = path.trim();
    path.starts_with("//")
        || (path.starts_with(r"\\") && !is_alignment_benchmark_local_volume_guid_path(path))
}

#[cfg(any(windows, test))]
fn validate_alignment_benchmark_volume_device_flags(
    removable_media: bool,
    media_removable: bool,
    media_hotplug: bool,
    device_hotplug: bool,
) -> Result<(), String> {
    if removable_media || media_removable || media_hotplug || device_hotplug {
        return Err("workload media 位于可移除或可热插拔设备，正式基准已拒绝。".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn read_alignment_benchmark_device_u32(
    bytes: &[u8],
    offset: usize,
    error: &'static str,
) -> Result<u32, String> {
    bytes
        .get(offset..offset.saturating_add(std::mem::size_of::<u32>()))
        .and_then(|value| <[u8; 4]>::try_from(value).ok())
        .map(u32::from_ne_bytes)
        .ok_or_else(|| error.to_string())
}

#[cfg(windows)]
fn create_alignment_benchmark_hotplug_buffer() -> Vec<u8> {
    use windows_sys::Win32::System::Ioctl::STORAGE_HOTPLUG_INFO;

    let size = std::mem::size_of::<STORAGE_HOTPLUG_INFO>() as u32;
    let mut bytes = vec![0_u8; size as usize];
    bytes[..std::mem::size_of::<u32>()].copy_from_slice(&size.to_ne_bytes());
    bytes
}

#[cfg(windows)]
fn parse_alignment_benchmark_hotplug_buffer(
    bytes: &[u8],
    returned: u32,
) -> Result<(bool, bool, bool), String> {
    use windows_sys::Win32::System::Ioctl::STORAGE_HOTPLUG_INFO;

    let minimum = std::mem::size_of::<STORAGE_HOTPLUG_INFO>();
    let returned = returned as usize;
    if returned < minimum || returned > bytes.len() {
        return Err("实际 workload 卷热插拔属性读取边界无效。".to_string());
    }
    let reported_size = read_alignment_benchmark_device_u32(
        bytes,
        std::mem::offset_of!(STORAGE_HOTPLUG_INFO, Size),
        "实际 workload 卷热插拔属性 Size 无效。",
    )? as usize;
    if reported_size < minimum || reported_size > returned {
        return Err("实际 workload 卷热插拔属性 Size 与返回边界不一致。".to_string());
    }
    let read_flag = |offset: usize| {
        bytes
            .get(offset)
            .copied()
            .map(|value| value != 0)
            .ok_or_else(|| "实际 workload 卷热插拔属性字段不完整。".to_string())
    };
    Ok((
        read_flag(std::mem::offset_of!(STORAGE_HOTPLUG_INFO, MediaRemovable))?,
        read_flag(std::mem::offset_of!(STORAGE_HOTPLUG_INFO, MediaHotplug))?,
        read_flag(std::mem::offset_of!(STORAGE_HOTPLUG_INFO, DeviceHotplug))?,
    ))
}

#[cfg(windows)]
fn parse_alignment_benchmark_storage_device_descriptor(
    bytes: &[u8],
    returned: u32,
    expected_version: u32,
    expected_size: u32,
) -> Result<bool, String> {
    use windows_sys::Win32::System::Ioctl::STORAGE_DEVICE_DESCRIPTOR;

    let minimum = std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia) + 1;
    let returned = returned as usize;
    if returned < minimum || returned > bytes.len() {
        return Err("实际 workload 卷设备描述属性读取边界无效。".to_string());
    }
    let version = read_alignment_benchmark_device_u32(
        bytes,
        std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, Version),
        "实际 workload 卷设备描述 Version 无效。",
    )?;
    let size = read_alignment_benchmark_device_u32(
        bytes,
        std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, Size),
        "实际 workload 卷设备描述 Size 无效。",
    )?;
    if version < minimum as u32
        || version > size
        || size < minimum as u32
        || size as usize > returned
        || version != expected_version
        || size != expected_size
    {
        return Err("实际 workload 卷设备描述 Version/Size 与返回边界不一致。".to_string());
    }
    Ok(bytes[std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia)] != 0)
}

#[cfg(windows)]
fn windows_alignment_benchmark_volume_seek_penalty(
    nul_terminated_volume_name: &[u16],
) -> Result<bool, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::{
            Ioctl::{
                PropertyStandardQuery, StorageDeviceProperty, StorageDeviceSeekPenaltyProperty,
                DEVICE_SEEK_PENALTY_DESCRIPTOR, IOCTL_STORAGE_GET_HOTPLUG_INFO,
                IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DESCRIPTOR_HEADER, STORAGE_DEVICE_DESCRIPTOR,
                STORAGE_PROPERTY_QUERY,
            },
            IO::DeviceIoControl,
        },
    };

    if nul_terminated_volume_name.len() < 2 {
        return Err("实际卷身份无效。".to_string());
    }
    let mut device_path = nul_terminated_volume_name.to_vec();
    if device_path.len() >= 2 && device_path[device_path.len() - 2] == b'\\' as u16 {
        device_path.remove(device_path.len() - 2);
    }
    // SAFETY: device_path is NUL-terminated; the call opens only the already-resolved local volume.
    let handle = unsafe {
        CreateFileW(
            device_path.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("实际 workload 卷无法打开以核验设备属性。".to_string());
    }
    let result = (|| -> Result<bool, String> {
        let device_query = STORAGE_PROPERTY_QUERY {
            PropertyId: StorageDeviceProperty,
            QueryType: PropertyStandardQuery,
            AdditionalParameters: [0],
        };
        let mut header = STORAGE_DESCRIPTOR_HEADER::default();
        let mut returned = 0_u32;
        // SAFETY: handle and both synchronous query buffers are valid for their supplied sizes.
        let header_ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&device_query as *const STORAGE_PROPERTY_QUERY).cast(),
                std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
                (&mut header as *mut STORAGE_DESCRIPTOR_HEADER).cast(),
                std::mem::size_of::<STORAGE_DESCRIPTOR_HEADER>() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        let minimum_device_descriptor_size =
            std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia) + 1;
        let header_capacity = std::mem::size_of::<STORAGE_DESCRIPTOR_HEADER>();
        if header_ok == 0
            || returned as usize != header_capacity
            || header.Version < minimum_device_descriptor_size as u32
            || header.Version > header.Size
            || header.Size < minimum_device_descriptor_size as u32
            || header.Size > 1024 * 1024
        {
            return Err("实际 workload 卷设备描述属性不可用。".to_string());
        }
        let descriptor_word_count = (header.Size as usize).div_ceil(std::mem::size_of::<u64>());
        let mut descriptor_words = vec![0_u64; descriptor_word_count];
        let descriptor_capacity = descriptor_words.len() * std::mem::size_of::<u64>();
        returned = 0;
        // SAFETY: the u64-backed buffer is suitably aligned and has at least header.Size bytes.
        let descriptor_ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&device_query as *const STORAGE_PROPERTY_QUERY).cast(),
                std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
                descriptor_words.as_mut_ptr().cast(),
                header.Size,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if descriptor_ok == 0
            || returned < minimum_device_descriptor_size as u32
            || returned > header.Size
            || returned as usize > descriptor_capacity
        {
            return Err("实际 workload 卷设备描述属性读取不完整。".to_string());
        }
        // SAFETY: descriptor_words owns returned initialized output bytes from DeviceIoControl.
        let descriptor_bytes = unsafe {
            std::slice::from_raw_parts(descriptor_words.as_ptr().cast::<u8>(), returned as usize)
        };
        let removable_media = parse_alignment_benchmark_storage_device_descriptor(
            descriptor_bytes,
            returned,
            header.Version,
            header.Size,
        )?;

        let mut hotplug_bytes = create_alignment_benchmark_hotplug_buffer();
        returned = 0;
        // SAFETY: the output buffer is writable for the exact supplied size and no input is used.
        let hotplug_ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_GET_HOTPLUG_INFO,
                std::ptr::null(),
                0,
                hotplug_bytes.as_mut_ptr().cast(),
                hotplug_bytes.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if hotplug_ok == 0 {
            return Err("实际 workload 卷热插拔属性不可用。".to_string());
        }
        let (media_removable, media_hotplug, device_hotplug) =
            parse_alignment_benchmark_hotplug_buffer(&hotplug_bytes, returned)?;
        validate_alignment_benchmark_volume_device_flags(
            removable_media,
            media_removable,
            media_hotplug,
            device_hotplug,
        )?;

        let seek_query = STORAGE_PROPERTY_QUERY {
            PropertyId: StorageDeviceSeekPenaltyProperty,
            QueryType: PropertyStandardQuery,
            AdditionalParameters: [0],
        };
        let mut descriptor = DEVICE_SEEK_PENALTY_DESCRIPTOR::default();
        returned = 0;
        // SAFETY: handle and both synchronous query buffers are valid for the exact supplied sizes.
        let seek_ok = unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                (&seek_query as *const STORAGE_PROPERTY_QUERY).cast(),
                std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
                (&mut descriptor as *mut DEVICE_SEEK_PENALTY_DESCRIPTOR).cast(),
                std::mem::size_of::<DEVICE_SEEK_PENALTY_DESCRIPTOR>() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        let descriptor_size = std::mem::size_of::<DEVICE_SEEK_PENALTY_DESCRIPTOR>() as u32;
        if seek_ok == 0
            || returned != descriptor_size
            || descriptor.Size < descriptor_size
            || descriptor.Size > returned
            || descriptor.Version < descriptor_size
            || descriptor.Version > descriptor.Size
        {
            return Err("实际 workload 卷 seek-penalty 属性不可用。".to_string());
        }
        Ok(descriptor.IncursSeekPenalty)
    })();
    // SAFETY: handle is owned by this function and closed exactly once.
    unsafe { CloseHandle(handle) };
    result
}

fn create_alignment_benchmark_volume_receipts(
    cases: &[AlignmentBenchmarkRegisteredCase],
    measurements: &[AlignmentBenchmarkVolumeMeasurement],
) -> Result<
    (
        Vec<AlignmentBenchmarkWorkloadBindingReceipt>,
        Vec<AlignmentBenchmarkWorkloadVolumeReceipt>,
    ),
    String,
> {
    let mut volume_ordinals = HashMap::<String, usize>::new();
    let mut volume_seek_penalties = Vec::<bool>::new();
    let mut volume_binding_counts = Vec::<usize>::new();
    let mut bindings = Vec::with_capacity(cases.len() * 2);
    for benchmark_case in cases {
        for (side, binding) in [
            (
                AlignmentBenchmarkBindingSide::Source,
                &benchmark_case.source,
            ),
            (
                AlignmentBenchmarkBindingSide::Target,
                &benchmark_case.target,
            ),
        ] {
            let measurement = measurements
                .get(binding.pin_index)
                .ok_or_else(|| "workload volume measurement 与 pin 注册不一致。".to_string())?;
            let volume_ordinal =
                if let Some(ordinal) = volume_ordinals.get(&measurement.stable_key).copied() {
                    if volume_seek_penalties[ordinal] != measurement.seek_penalty {
                        return Err("同一实际卷返回了冲突的 seek-penalty 属性。".to_string());
                    }
                    ordinal
                } else {
                    let ordinal = volume_ordinals.len();
                    volume_ordinals.insert(measurement.stable_key.clone(), ordinal);
                    volume_seek_penalties.push(measurement.seek_penalty);
                    volume_binding_counts.push(0);
                    ordinal
                };
            volume_binding_counts[volume_ordinal] =
                volume_binding_counts[volume_ordinal].saturating_add(1);
            bindings.push(AlignmentBenchmarkWorkloadBindingReceipt {
                binding_ordinal: binding.binding_ordinal,
                case_ordinal: benchmark_case.case_ordinal,
                side,
                volume_ordinal,
            });
        }
    }
    let volumes = volume_binding_counts
        .into_iter()
        .enumerate()
        .map(
            |(volume_ordinal, binding_count)| AlignmentBenchmarkWorkloadVolumeReceipt {
                volume_ordinal,
                binding_count,
                drive_type: "fixed",
                seek_penalty: if volume_seek_penalties[volume_ordinal] {
                    "incurs"
                } else {
                    "none"
                },
                measurement_status: "complete",
            },
        )
        .collect();
    Ok((bindings, volumes))
}

fn create_alignment_benchmark_media_set_digest(
    manifest: &AlignmentBenchmarkBlindRunManifest,
) -> Result<String, String> {
    let bindings = manifest
        .cases
        .iter()
        .enumerate()
        .flat_map(|(case_ordinal, benchmark_case)| {
            [
                (
                    AlignmentBenchmarkBindingSide::Source,
                    &benchmark_case.source,
                ),
                (
                    AlignmentBenchmarkBindingSide::Target,
                    &benchmark_case.target,
                ),
            ]
            .into_iter()
            .enumerate()
            .map(move |(side_ordinal, (side, media))| {
                serde_json::json!({
                    "bindingOrdinal": case_ordinal * 2 + side_ordinal,
                    "caseOrdinal": case_ordinal,
                    "side": side,
                    "audioStreamIndex": media.audio_stream_index,
                    "videoStreamIndex": media.video_stream_index,
                    "contentIdentity": {
                        "algorithm": media.content_identity.algorithm,
                        "sizeBytes": media.content_identity.size_bytes,
                        "digest": media.content_identity.digest,
                    }
                })
            })
        })
        .collect::<Vec<_>>();
    let projection = serde_json::json!({
        "schemaVersion": ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
        "bindings": bindings,
    });
    let canonical = canonicalize_alignment_benchmark_json(&projection)?;
    Ok(format!(
        "sha256:{}",
        sha256_alignment_benchmark_bytes(canonical.as_bytes())
    ))
}

fn create_alignment_benchmark_workload_receipt_digest(
    receipt: &AlignmentBenchmarkWorkloadStorageReceipt,
) -> Result<String, String> {
    let mut value = serde_json::to_value(receipt)
        .map_err(|_| "workload storage receipt 无法序列化。".to_string())?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "workload storage receipt 不是对象。".to_string())?;
    object.remove("receiptDigest");
    let canonical = canonicalize_alignment_benchmark_json(&value)?;
    Ok(format!(
        "sha256:{}",
        sha256_alignment_benchmark_bytes(canonical.as_bytes())
    ))
}

fn summarize_alignment_benchmark_storage_kind(
    receipt: &AlignmentBenchmarkWorkloadStorageReceipt,
) -> Result<String, String> {
    if receipt.volumes.is_empty()
        || receipt.volume_count != receipt.volumes.len()
        || receipt
            .volumes
            .iter()
            .any(|volume| volume.drive_type != "fixed" || volume.measurement_status != "complete")
    {
        return Err("workload storage receipt 没有形成完整固定卷闭环。".to_string());
    }
    let incurs = receipt
        .volumes
        .iter()
        .filter(|volume| volume.seek_penalty == "incurs")
        .count();
    if receipt
        .volumes
        .iter()
        .any(|volume| volume.seek_penalty != "incurs" && volume.seek_penalty != "none")
    {
        return Err("workload storage receipt seek-penalty 无效。".to_string());
    }
    Ok(match (receipt.volume_count, incurs) {
        (1, 1) => "workload-media-single-volume-rotational-seek-penalty",
        (1, 0) => "workload-media-single-volume-nonrotational-no-seek-penalty",
        (count, value) if count == value => {
            "workload-media-multi-volume-all-rotational-seek-penalty"
        }
        (_, 0) => "workload-media-multi-volume-all-nonrotational-no-seek-penalty",
        _ => "workload-media-multi-volume-mixed-seek-penalty",
    }
    .to_string())
}

fn reject_ambiguous_alignment_benchmark_case_registrations(
    cases: &[AlignmentBenchmarkRegisteredCase],
) -> Result<(), String> {
    let mut registrations = HashSet::with_capacity(cases.len());
    for benchmark_case in cases {
        let key = (
            benchmark_case.source.pin_index,
            benchmark_case.source.audio_stream_index,
            benchmark_case.source.video_stream_index,
            benchmark_case.target.pin_index,
            benchmark_case.target.audio_stream_index,
            benchmark_case.target.video_stream_index,
        );
        if !registrations.insert(key) {
            return Err(
                "blind run manifest 含重复执行 case，无法唯一注册 benchmark job。".to_string(),
            );
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn collect_alignment_benchmark_environment(
    _ffmpeg_path: &str,
    _ffprobe_path: &Path,
    _workload_storage: AlignmentBenchmarkWorkloadStorageReceipt,
) -> Result<
    (
        AlignmentBenchmarkEnvironmentReceipt,
        AlignmentBenchmarkPinnedTool,
        AlignmentBenchmarkPinnedTool,
    ),
    String,
> {
    Err("unsupported：原生进程树 RSS 与物理核拓扑采集当前只支持 Windows。".to_string())
}

#[cfg(windows)]
fn collect_alignment_benchmark_environment(
    ffmpeg_path: &str,
    ffprobe_path: &Path,
    workload_storage: AlignmentBenchmarkWorkloadStorageReceipt,
) -> Result<
    (
        AlignmentBenchmarkEnvironmentReceipt,
        AlignmentBenchmarkPinnedTool,
        AlignmentBenchmarkPinnedTool,
    ),
    String,
> {
    let ffmpeg_path = resolve_windows_benchmark_executable(Path::new(ffmpeg_path))?;
    let ffprobe_path = resolve_windows_benchmark_executable(ffprobe_path)?;
    let ffmpeg_tool = pin_alignment_benchmark_tool(ffmpeg_path)?;
    let ffprobe_tool = pin_alignment_benchmark_tool(ffprobe_path)?;
    let physical_core_count = windows_physical_core_count()?;
    let logical_core_count = windows_logical_core_count()?;
    let total_memory_bytes = windows_total_memory_bytes()?;
    let cpu_model = windows_registry_string(
        r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        "ProcessorNameString",
    )?;
    let operating_system = windows_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "ProductName",
    )?;
    let display_version = windows_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "DisplayVersion",
    )
    .or_else(|_| {
        windows_registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ReleaseId")
    })?;
    let build = windows_registry_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "CurrentBuildNumber",
    )?;
    let operating_system_version = format!("{display_version} build {build}");
    let ffmpeg = collect_alignment_benchmark_tool_fingerprint("ffmpeg", &ffmpeg_tool)?;
    let ffprobe = collect_alignment_benchmark_tool_fingerprint("ffprobe", &ffprobe_tool)?;
    let mut issues = Vec::new();
    let power_profile = match windows_active_power_profile() {
        Ok(profile) => profile,
        Err(_) if process_supervision_cleanup_faulted() => {
            // Keep enough environment state to commit the already-owned lease and tool pins as a
            // cleanup-blocked session. The post-collection sticky check must never publish Active.
            issues.push("process-cleanup-fault".to_string());
            "cleanup-blocked".to_string()
        }
        Err(_) => "unknown".to_string(),
    };
    let storage_kind = summarize_alignment_benchmark_storage_kind(&workload_storage)?;
    if power_profile == "unknown" {
        issues.push("power-profile-unavailable".to_string());
    }
    let measurement_status = if issues.is_empty() {
        "complete"
    } else {
        "incomplete"
    };
    Ok((
        AlignmentBenchmarkEnvironmentReceipt {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            collector_version: BENCHMARK_TELEMETRY_VERSION,
            measurement_status,
            issues,
            operating_system,
            operating_system_version,
            architecture: std::env::consts::ARCH.to_string(),
            cpu_model: cpu_model.trim().to_string(),
            physical_core_count,
            logical_core_count,
            total_memory_bytes,
            storage_scope: "workload-media-volumes",
            storage_kind,
            workload_storage,
            power_profile,
            ffmpeg,
            ffprobe,
        },
        ffmpeg_tool,
        ffprobe_tool,
    ))
}

#[cfg(windows)]
fn collect_alignment_benchmark_tool_fingerprint(
    tool: &'static str,
    pinned: &AlignmentBenchmarkPinnedTool,
) -> Result<AlignmentBenchmarkToolFingerprint, String> {
    verify_alignment_benchmark_pinned_tool(tool, pinned)?;
    let (stdout, stderr) = run_alignment_benchmark_tool_version_probe(tool, &pinned.path)?;
    let version = parse_alignment_benchmark_tool_semantic_version(tool, &stdout, &stderr)?;
    verify_alignment_benchmark_pinned_tool(tool, pinned)?;
    Ok(AlignmentBenchmarkToolFingerprint {
        version,
        binary_digest: format!("sha256:{}", pinned.expected_digest),
    })
}

#[cfg(windows)]
fn pin_alignment_benchmark_tool(path: PathBuf) -> Result<AlignmentBenchmarkPinnedTool, String> {
    let file = open_alignment_benchmark_tool_read_pin(&path)?;
    let identity = windows_alignment_benchmark_file_identity(&file)?;
    let expected_digest = sha256_alignment_benchmark_pinned_file(&file)?;
    let pinned = AlignmentBenchmarkPinnedTool {
        path,
        expected_digest,
        file,
        identity,
    };
    verify_alignment_benchmark_pinned_tool("media-tool", &pinned)?;
    Ok(pinned)
}

#[cfg(windows)]
fn open_alignment_benchmark_tool_read_pin(path: &Path) -> Result<File, String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| "媒体工具无法取得禁止写入、删除和替换的只读 pin。".to_string())
}

#[cfg(windows)]
fn windows_alignment_benchmark_file_identity(
    file: &File,
) -> Result<AlignmentBenchmarkWindowsFileIdentity, String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: file owns a valid Windows handle and information is a writable structure of the
    // exact type required by GetFileInformationByHandle.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if ok == 0 {
        return Err("媒体工具固定句柄身份读取失败。".to_string());
    }
    Ok(AlignmentBenchmarkWindowsFileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        file_size: (u64::from(information.nFileSizeHigh) << 32)
            | u64::from(information.nFileSizeLow),
        last_write_time: (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(information.ftLastWriteTime.dwLowDateTime),
    })
}

#[cfg(windows)]
fn sha256_alignment_benchmark_pinned_file(file: &File) -> Result<String, String> {
    let mut reader = file
        .try_clone()
        .map_err(|_| "媒体工具固定句柄无法复制以计算摘要。".to_string())?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| "媒体工具固定句柄无法定位摘要起点。".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "媒体工具固定句柄摘要读取失败。".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(windows)]
fn verify_alignment_benchmark_pinned_tool(
    tool: &str,
    pinned: &AlignmentBenchmarkPinnedTool,
) -> Result<(), String> {
    let handle_identity = windows_alignment_benchmark_file_identity(&pinned.file)?;
    let current_path_file = open_alignment_benchmark_tool_read_pin(&pinned.path)?;
    let current_path_identity = windows_alignment_benchmark_file_identity(&current_path_file)?;
    let current_digest = sha256_alignment_benchmark_pinned_file(&pinned.file)?;
    if handle_identity != pinned.identity
        || current_path_identity != pinned.identity
        || current_digest != pinned.expected_digest
    {
        return Err(format!("{tool} 固定文件身份或完整摘要发生变化。"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify_alignment_benchmark_pinned_tool(
    _tool: &str,
    _pinned: &AlignmentBenchmarkPinnedTool,
) -> Result<(), String> {
    Err("unsupported：媒体工具固定句柄当前只支持 Windows。".to_string())
}

#[cfg(windows)]
fn run_alignment_benchmark_tool_version_probe(
    tool: &str,
    executable: &Path,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    run_alignment_benchmark_tool_version_probe_with_timeouts(
        tool,
        executable,
        Duration::from_millis(BENCHMARK_TOOL_VERSION_TIMEOUT_MS),
        Duration::from_millis(CHILD_OUTPUT_DRAIN_TIMEOUT_MS),
    )
}

#[cfg(windows)]
fn run_alignment_benchmark_tool_version_probe_with_timeouts(
    tool: &str,
    executable: &Path,
    process_timeout: Duration,
    output_drain_timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut command = SupervisedCommand::new(executable);
    command.arg("-version");
    let output = command
        .output(
            SupervisedOutputLimits {
                execution_timeout: process_timeout,
                output_drain_timeout,
                termination_timeout: Duration::from_millis(
                    CHILD_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
                ),
                poll_interval: Duration::from_millis(10),
                stdout_hard_limit: BENCHMARK_TOOL_VERSION_MAX_BYTES,
                stderr_hard_limit: BENCHMARK_TOOL_VERSION_MAX_BYTES,
            },
            || false,
        )
        .map_err(|error| format!("{tool} 版本探测失败：{error}"))?;
    if !output.status.success() {
        return Err(format!("{tool} 版本探测未成功退出。"));
    }
    Ok((output.stdout, output.stderr))
}

fn parse_alignment_benchmark_tool_semantic_version(
    tool: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, String> {
    for bytes in [stdout, stderr] {
        for line in String::from_utf8_lossy(bytes).lines() {
            let mut fields = line.split_ascii_whitespace();
            let Some(name) = fields.next() else {
                continue;
            };
            let Some(marker) = fields.next() else {
                continue;
            };
            let Some(raw_version) = fields.next() else {
                continue;
            };
            if !name.eq_ignore_ascii_case(tool) || !marker.eq_ignore_ascii_case("version") {
                continue;
            }
            let numeric_prefix = raw_version
                .chars()
                .take_while(|character| character.is_ascii_digit() || *character == '.')
                .collect::<String>();
            let numeric_prefix = numeric_prefix.trim_end_matches('.');
            let components = numeric_prefix.split('.').collect::<Vec<_>>();
            if components.is_empty()
                || components.len() > 3
                || components.iter().any(|component| component.is_empty())
            {
                continue;
            }
            let parsed = components
                .iter()
                .map(|component| component.parse::<u32>())
                .collect::<Result<Vec<_>, _>>();
            let Ok(mut parsed) = parsed else {
                continue;
            };
            while parsed.len() < 3 {
                parsed.push(0);
            }
            return Ok(format!("{}.{}.{}", parsed[0], parsed[1], parsed[2]));
        }
    }
    Err(format!("{tool} 未返回可去敏的数字版本标识。"))
}

fn first_nonempty_output_line(primary: &[u8], secondary: &[u8]) -> Option<String> {
    [primary, secondary].into_iter().find_map(|bytes| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
    })
}

#[cfg(windows)]
fn resolve_windows_benchmark_executable(path: &Path) -> Result<PathBuf, String> {
    resolve_supervised_executable(path).map_err(|error| format!("无法安全解析媒体工具：{error}"))
}

#[cfg(windows)]
fn windows_registry_string(subkey: &str, value_name: &str) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
    };

    let subkey = std::ffi::OsStr::new(subkey)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let value_name = std::ffi::OsStr::new(value_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut bytes = 0_u32;
    // SAFETY: pointers reference NUL-terminated UTF-16 buffers and the size query has no output
    // buffer by contract.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if status != ERROR_SUCCESS || bytes < 2 {
        return Err("Windows 注册表环境字段不可用。".to_string());
    }
    let mut output = vec![0_u16; bytes as usize / 2];
    // SAFETY: the allocated buffer is at least the byte count returned by the size query.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value_name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            output.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return Err("Windows 注册表环境字段读取失败。".to_string());
    }
    let length = output
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(output.len());
    let value = String::from_utf16_lossy(&output[..length])
        .trim()
        .to_string();
    if value.is_empty() {
        return Err("Windows 注册表环境字段为空。".to_string());
    }
    Ok(value)
}

#[cfg(windows)]
fn windows_physical_core_count() -> Result<u32, String> {
    use windows_sys::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, RelationProcessorCore,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };

    let mut bytes = 0_u32;
    // SAFETY: the first call is the documented size query and writes only `bytes`.
    unsafe {
        GetLogicalProcessorInformationEx(RelationProcessorCore, std::ptr::null_mut(), &mut bytes);
    }
    if bytes == 0 {
        return Err("Windows 未返回物理核拓扑缓冲区大小。".to_string());
    }
    let word_count = (bytes as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0_usize; word_count];
    // SAFETY: the usize buffer is suitably aligned and has at least `bytes` writable bytes.
    let ok = unsafe {
        GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            buffer
                .as_mut_ptr()
                .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(),
            &mut bytes,
        )
    };
    if ok == 0 {
        return Err("Windows 物理核拓扑读取失败。".to_string());
    }
    let mut offset = 0_usize;
    let mut cores = 0_u32;
    while offset < bytes as usize {
        // SAFETY: offset is advanced only by validated record sizes within the returned buffer.
        let record = unsafe {
            &*(buffer.as_ptr().cast::<u8>().add(offset)
                as *const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)
        };
        let size = record.Size as usize;
        if size < std::mem::size_of::<i32>() + std::mem::size_of::<u32>()
            || offset.saturating_add(size) > bytes as usize
        {
            return Err("Windows 物理核拓扑记录大小无效。".to_string());
        }
        if record.Relationship == RelationProcessorCore {
            cores = cores.saturating_add(1);
        }
        offset += size;
    }
    if cores == 0 {
        return Err("Windows 物理核拓扑为空。".to_string());
    }
    Ok(cores)
}

#[cfg(windows)]
fn windows_logical_core_count() -> Result<u32, String> {
    use windows_sys::Win32::System::Threading::{GetActiveProcessorCount, ALL_PROCESSOR_GROUPS};
    // SAFETY: ALL_PROCESSOR_GROUPS requests a scalar count and has no pointer arguments.
    let count = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
    if count == 0 {
        return Err("Windows 逻辑处理器拓扑为空。".to_string());
    }
    Ok(count)
}

#[cfg(windows)]
fn windows_total_memory_bytes() -> Result<u64, String> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..MEMORYSTATUSEX::default()
    };
    // SAFETY: `status` is initialized and its length field matches the structure size.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Err("Windows 总内存读取失败。".to_string());
    }
    Ok(status.ullTotalPhys)
}

#[cfg(windows)]
fn windows_active_power_profile() -> Result<String, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut system_directory = vec![0_u16; 32_768];
    // SAFETY: the UTF-16 output buffer is writable and its capacity is passed exactly.
    let length = unsafe {
        GetSystemDirectoryW(system_directory.as_mut_ptr(), system_directory.len() as u32)
    } as usize;
    if length == 0 || length >= system_directory.len() {
        return Err("Windows System32 路径读取失败。".to_string());
    }
    system_directory.truncate(length);
    let powercfg_path =
        PathBuf::from(std::ffi::OsString::from_wide(&system_directory)).join("powercfg.exe");
    let mut command = SupervisedCommand::new(powercfg_path);
    command.arg("/getactivescheme");
    let output = command
        .output(
            SupervisedOutputLimits {
                execution_timeout: Duration::from_secs(10),
                output_drain_timeout: Duration::from_millis(CHILD_OUTPUT_DRAIN_TIMEOUT_MS),
                termination_timeout: Duration::from_millis(
                    CHILD_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
                ),
                poll_interval: Duration::from_millis(10),
                stdout_hard_limit: 64 * 1024,
                stderr_hard_limit: 64 * 1024,
            },
            || false,
        )
        .map_err(|error| format!("电源方案探测启动失败：{error}"))?;
    if !output.status.success() {
        return Err("电源方案探测未成功退出。".to_string());
    }
    let line = first_nonempty_output_line(&output.stdout, &output.stderr)
        .ok_or_else(|| "电源方案探测没有输出。".to_string())?;
    let lower = line.to_ascii_lowercase();
    for (guid, label) in [
        ("381b4222-f694-41f0-9685-ff5bb260df2e", "balanced"),
        ("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", "high-performance"),
        ("a1841308-3541-4fab-bc81-f71556f20b4a", "power-saver"),
        (
            "e9a42b02-d5df-448d-aa00-03f14749eb61",
            "ultimate-performance",
        ),
    ] {
        if lower.contains(guid) {
            return Ok(label.to_string());
        }
    }
    Ok("custom".to_string())
}

#[cfg(not(windows))]
fn sample_process_tree_memory(_root_pid: u32) -> Result<ProcessTreeMemorySample, String> {
    Err("unsupported：进程树 working-set 采样当前只支持 Windows。".to_string())
}

#[cfg(windows)]
fn sample_process_tree_memory(root_pid: u32) -> Result<ProcessTreeMemorySample, String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    // ToolHelp is intentionally used for the first native implementation because it does not
    // require replacing every std::process::Command call. It cannot provide race-free spawn
    // attribution like a Job Object, so *any* snapshot/open/read failure marks coverage
    // incomplete and no RSS value is emitted for that pass. The session keeps a baseline PID set
    // for persistent WebView children; ToolHelp cannot rule out PID reuse against that baseline,
    // which is why the sampler/method identity remains explicit for a later Job Object upgrade.
    let pairs = windows_process_parent_pairs()?;
    let descendants = collect_process_descendants(root_pid, &pairs);
    let mut pids = Vec::with_capacity(descendants.len().saturating_add(1));
    pids.push(root_pid);
    pids.extend(descendants.iter().copied());
    let mut working_set_bytes = 0_u64;
    for pid in pids {
        // SAFETY: pid comes from the current ToolHelp snapshot; no handle is inherited.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err("Windows 进程树中至少一个进程无法打开，覆盖不完整。".to_string());
        }
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..PROCESS_MEMORY_COUNTERS::default()
        };
        // SAFETY: process is open and counters points to a writable structure of the given size.
        let ok = unsafe {
            GetProcessMemoryInfo(
                process,
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        };
        // SAFETY: process is an owned handle returned by OpenProcess.
        unsafe { CloseHandle(process) };
        if ok == 0 {
            return Err("Windows 进程树 working set 读取失败，覆盖不完整。".to_string());
        }
        working_set_bytes = working_set_bytes
            .checked_add(counters.WorkingSetSize as u64)
            .ok_or_else(|| "进程树 working set 求和溢出。".to_string())?;
    }
    Ok(ProcessTreeMemorySample {
        working_set_bytes,
        descendants,
    })
}

#[cfg(windows)]
fn windows_process_parent_pairs() -> Result<Vec<(u32, u32)>, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    // SAFETY: CreateToolhelp32Snapshot has no borrowed pointer arguments.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Windows ToolHelp 进程快照创建失败。".to_string());
    }
    let mut pairs = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..PROCESSENTRY32W::default()
    };
    // SAFETY: snapshot is valid and entry has the documented size.
    if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
        // SAFETY: snapshot is a valid owned handle.
        unsafe { CloseHandle(snapshot) };
        return Err("Windows ToolHelp 进程快照为空或不可读。".to_string());
    }
    loop {
        pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: snapshot and entry remain valid for enumeration.
        if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
            // SAFETY: GetLastError is read immediately after Process32NextW failed.
            let error = unsafe { GetLastError() };
            if error != ERROR_NO_MORE_FILES {
                // SAFETY: snapshot is a valid owned handle.
                unsafe { CloseHandle(snapshot) };
                return Err("Windows ToolHelp 进程枚举中途失败，覆盖不完整。".to_string());
            }
            break;
        }
    }
    // SAFETY: snapshot is a valid owned handle and is closed exactly once.
    unsafe { CloseHandle(snapshot) };
    Ok(pairs)
}

fn collect_process_descendants(root_pid: u32, pairs: &[(u32, u32)]) -> HashSet<u32> {
    let mut descendants = HashSet::new();
    loop {
        let mut changed = false;
        for (pid, parent_pid) in pairs {
            if *pid == root_pid || descendants.contains(pid) {
                continue;
            }
            if *parent_pid == root_pid || descendants.contains(parent_pid) {
                descendants.insert(*pid);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    descendants
}

fn align_audio_files_inner(
    request: AudioAlignmentRequest,
) -> Result<AudioAlignmentProposal, String> {
    let mut update = |_progress: f64, _message: &str| Ok(());
    align_audio_files_with_progress(request, &mut update, None)
}

fn align_audio_files_with_progress<F>(
    request: AudioAlignmentRequest,
    update_progress: &mut F,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AudioAlignmentProposal, String>
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    ensure_alignment_process_supervision_clean()?;
    validate_media_input(&request.complete_path, "目标原片")?;
    validate_media_input(&request.source_path, "B 站参考")?;
    let _media_read_lease =
        acquire_alignment_media_read_lease(&request.source_path, &request.complete_path)?;
    let target_run_identity =
        probe_alignment_run_expected_identity(&request.complete_path, cancel_flag, "目标原片")?;
    let source_run_identity =
        probe_alignment_run_expected_identity(&request.source_path, cancel_flag, "B 站参考")?;
    let target_path = request.complete_path.clone();
    let source_path = request.source_path.clone();
    let result = align_audio_files_with_progress_impl(request, update_progress, cancel_flag);
    // A lower layer may deliberately downgrade ordinary evidence failures, but a process-tree
    // cleanup failure is never evidence. It invalidates the current run even if a fallback later
    // managed to construct a proposal.
    ensure_alignment_process_supervision_clean()?;
    if let Ok(proposal) = &result {
        verify_media_content_identity_after_tool_output(
            &source_path,
            Some(&source_run_identity),
            cancel_flag,
            "对齐结果最终复核",
        )?;
        verify_media_content_identity_after_tool_output(
            &target_path,
            Some(&target_run_identity),
            cancel_flag,
            "对齐结果最终复核",
        )?;
        verify_proposal_time_map_identities_match_run(
            proposal,
            &source_run_identity,
            &target_run_identity,
        )?;
    }
    result
}

fn align_audio_files_with_progress_impl<F>(
    request: AudioAlignmentRequest,
    update_progress: &mut F,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AudioAlignmentProposal, String>
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    check_cancelled(cancel_flag)?;
    benchmark_stage("validating", "校验输入与媒体时间线");
    update_progress(0.05, "正在校验本地媒体路径。")?;
    validate_media_input(&request.complete_path, "完整版")?;
    validate_media_input(&request.source_path, "当前视频")?;
    let options = create_options(&request)?;
    if options.localization_mode {
        return align_audio_files_v2_with_progress(
            &request,
            &options,
            update_progress,
            cancel_flag,
        );
    }
    update_progress(0.08, "正在探测媒体展示时间线和可用音轨。")?;
    let complete_audio_input = probe_alignment_audio_input(
        &request.complete_path,
        "完整版",
        request.complete_audio_stream_index,
        &options,
        cancel_flag,
    )?;
    check_cancelled(cancel_flag)?;
    let source_audio_input = probe_alignment_audio_input(
        &request.source_path,
        "当前视频",
        request.source_audio_stream_index,
        &options,
        cancel_flag,
    )?;
    update_progress(0.10, "已确认媒体展示时间线、音轨和对齐参数。")?;
    check_cancelled(cancel_flag)?;
    benchmark_stage("extracting-complete", "提取目标原片音频特征");
    update_progress(0.12, "正在检查或提取完整版音频特征。")?;
    let complete_features = get_audio_features(
        &request.complete_path,
        "完整版",
        &options,
        &complete_audio_input,
        cancel_flag,
    )?;
    update_progress(
        0.36,
        &format_audio_feature_cache_message("完整版", &complete_features),
    )?;
    check_cancelled(cancel_flag)?;
    benchmark_stage("extracting-source", "提取参考视频音频特征");
    update_progress(0.40, "正在检查或提取当前视频音频特征。")?;
    let source_features = get_audio_features(
        &request.source_path,
        "当前视频",
        &options,
        &source_audio_input,
        cancel_flag,
    )?;
    update_progress(
        0.64,
        &format_audio_feature_cache_message("当前视频", &source_features),
    )?;
    check_cancelled(cancel_flag)?;
    let mut visual_features: Option<(CachedVisualFeatures, CachedVisualFeatures)> = None;
    let mut visual_error: Option<String> = None;
    if options.enable_visual_evidence {
        benchmark_stage("extracting-visual", "提取独立视觉证据");
        update_progress(0.68, "正在提取鲁棒视觉证据。")?;
        match (
            get_visual_features(
                &request.complete_path,
                "完整版",
                &options,
                complete_audio_input.content_identity.as_ref(),
                cancel_flag,
            ),
            get_visual_features(
                &request.source_path,
                "当前视频",
                &options,
                source_audio_input.content_identity.as_ref(),
                cancel_flag,
            ),
        ) {
            (Ok(complete_visual), Ok(source_visual)) => {
                update_progress(0.74, "鲁棒视觉证据提取完成。")?;
                visual_features = Some((complete_visual, source_visual));
            }
            (Err(error), _) | (_, Err(error)) => {
                propagate_alignment_process_cleanup(&error)?;
                if is_media_identity_guard_error(&error) || error == AUDIO_ALIGNMENT_CANCELLED {
                    return Err(error);
                }
                update_progress(0.74, "视觉证据不可用，继续音频时间映射。")?;
                visual_error = Some(error);
            }
        }
    } else {
        update_progress(0.74, "未启用视觉辅助，继续音频时间映射。")?;
    }
    check_cancelled(cancel_flag)?;
    update_progress(0.78, "正在生成稀疏音频指纹。")?;
    check_cancelled(cancel_flag)?;
    update_progress(0.84, "正在建立候选观测。")?;
    check_cancelled(cancel_flag)?;
    update_progress(0.89, "正在拟合时间映射。")?;
    check_cancelled(cancel_flag)?;
    let mut proposal = create_audio_alignment_proposal(
        &complete_features.frames,
        &source_features.frames,
        &options,
    )?;
    update_progress(0.94, "正在精修候选版本差异。")?;
    check_cancelled(cancel_flag)?;
    apply_visual_evidence_to_proposal(&mut proposal, visual_features.as_ref(), visual_error);
    proposal.diagnostics.push(format!(
        "音频特征缓存：完整版{}，当前视频{}。",
        if complete_features.cache_hit {
            "命中"
        } else {
            "新提取"
        },
        if source_features.cache_hit {
            "命中"
        } else {
            "新提取"
        }
    ));
    proposal
        .diagnostics
        .push(format_alignment_audio_input_diagnostic(
            "完整版",
            &complete_audio_input,
        ));
    proposal
        .diagnostics
        .push(format_alignment_audio_input_diagnostic(
            "当前视频",
            &source_audio_input,
        ));
    if let Some((complete_visual, source_visual)) = &visual_features {
        proposal.diagnostics.push(format!(
            "视觉证据缓存：完整版{}，当前视频{}。",
            if complete_visual.cache_hit {
                "命中"
            } else {
                "新提取"
            },
            if source_visual.cache_hit {
                "命中"
            } else {
                "新提取"
            }
        ));
    }
    benchmark_stage("reporting", "生成对齐复核数据");
    update_progress(0.97, "正在生成对齐复核数据。")?;
    Ok(proposal)
}

fn align_audio_files_v2_with_progress<F>(
    request: &AudioAlignmentRequest,
    options: &AudioAlignmentOptions,
    update_progress: &mut F,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AudioAlignmentProposal, String>
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    benchmark_stage("validating", "探测候选音轨与展示时间线");
    update_progress(0.08, "Alignment V2 正在探测展示时间线和候选音轨。")?;
    let target_inputs = match probe_alignment_audio_candidates(
        &request.complete_path,
        "目标原片",
        request.complete_audio_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(inputs) => inputs,
        Err(error) => {
            update_progress(0.10, "目标音频不可比较，正在尝试独立视觉定位。")?;
            return try_v2_visual_fallback(
                request,
                options,
                &format!("目标音频探测未通过：{}", truncate_visual_note(&error)),
                vec![error],
                cancel_flag,
            );
        }
    };
    let source_inputs = match probe_alignment_audio_candidates(
        &request.source_path,
        "B 站参考",
        request.source_audio_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(inputs) => inputs,
        Err(error) => {
            update_progress(0.10, "参考音频不可比较，正在尝试独立视觉定位。")?;
            return try_v2_visual_fallback(
                request,
                options,
                &format!("参考音频探测未通过：{}", truncate_visual_note(&error)),
                vec![error],
                cancel_flag,
            );
        }
    };
    if source_inputs.is_empty() || target_inputs.is_empty() {
        let reason = "没有可自动使用的非 commentary 音轨；如确需评论音轨，请显式选择全局流索引。";
        update_progress(0.70, "音频不可比，正在尝试独立视觉定位。")?;
        return try_v2_visual_fallback(
            request,
            options,
            reason,
            vec!["自动选轨只评估非 commentary 音轨。".to_string()],
            cancel_flag,
        );
    }
    // Reserve the worst-case candidate payload before the first FFmpeg decode. This makes
    // the auto-track path transactional with respect to the active-memory guard: an input
    // with too many long tracks is rejected without leaving a partially warmed artifact set.
    ensure_v2_candidate_set_active_budget(&source_inputs, &target_inputs)?;
    check_cancelled(cancel_flag)?;

    benchmark_stage("extracting-source", "提取参考音轨 landmark");
    update_progress(0.12, "正在为 B 站参考候选音轨提取 16 kHz landmark。")?;
    let mut extraction_notes = Vec::new();
    let mut retained_artifact_bytes = 0_usize;
    let source_landmarks = extract_v2_landmark_candidates(
        &request.source_path,
        "B 站参考",
        options,
        &source_inputs,
        cancel_flag,
        &mut extraction_notes,
        &mut retained_artifact_bytes,
    )?;
    benchmark_stage("extracting-complete", "提取目标原片 landmark");
    update_progress(0.40, "正在为目标原片候选音轨提取 16 kHz landmark。")?;
    let target_landmarks = extract_v2_landmark_candidates(
        &request.complete_path,
        "目标原片",
        options,
        &target_inputs,
        cancel_flag,
        &mut extraction_notes,
        &mut retained_artifact_bytes,
    )?;
    check_cancelled(cancel_flag)?;
    if source_landmarks.is_empty() || target_landmarks.is_empty() {
        let reason = "候选音轨未产生可用 landmark，不能据此断言存在或不存在内容段。";
        update_progress(0.70, "音频 landmark 不足，正在尝试独立视觉定位。")?;
        return try_v2_visual_fallback(request, options, reason, extraction_notes, cancel_flag);
    }

    benchmark_stage("matching", "比较音轨组合与 Top-K 仿射假设");
    update_progress(0.78, "正在比较合理音轨组合的 Top-K 仿射假设。")?;
    let affine_config = AffineMatchConfig {
        residual_tolerance_ms: 140,
        min_inliers: 6,
        top_k: 5,
        ..AffineMatchConfig::default()
    };
    let has_explicit_selection = request.source_audio_stream_index.is_some()
        || request.complete_audio_stream_index.is_some();
    let mut pair_candidates = Vec::new();
    let mut hypothesis_alternatives = Vec::new();
    for source_input in &source_inputs {
        for target_input in &target_inputs {
            check_cancelled(cancel_flag)?;
            if !has_explicit_selection
                && !is_reasonable_audio_stream_pair(source_input, target_input)
            {
                continue;
            }
            let Some(source_artifact) = source_landmarks.get(&source_input.stream.stream_index)
            else {
                continue;
            };
            let Some(target_artifact) = target_landmarks.get(&target_input.stream.stream_index)
            else {
                continue;
            };
            let result = match match_landmarks_affine_with_cancel(
                &source_artifact.landmarks,
                &target_artifact.landmarks,
                &affine_config,
                cancel_flag,
            ) {
                Ok(result) => result,
                Err(error) => {
                    extraction_notes.push(format!(
                        "音轨 #{} → #{} landmark 拟合失败：{error}",
                        source_input.stream.stream_index, target_input.stream.stream_index
                    ));
                    continue;
                }
            };
            let Some(best) = result.hypotheses.first().cloned() else {
                extraction_notes.push(format!(
                    "音轨 #{} → #{} 没有达到最小内点数的仿射假设。",
                    source_input.stream.stream_index, target_input.stream.stream_index
                ));
                continue;
            };
            extraction_notes.push(format!(
                "音轨 #{} → #{} Top-K affine：{}。",
                source_input.stream.stream_index,
                target_input.stream.stream_index,
                result
                    .hypotheses
                    .iter()
                    .map(|item| format!(
                        "scale={:.6},offset={:+},inliers={},range={}-{}",
                        item.scale,
                        item.offset_ms,
                        item.inlier_count,
                        item.source_start_ms,
                        item.source_end_ms
                    ))
                    .collect::<Vec<_>>()
                    .join("；")
            ));
            let temporal_coverage = affine_temporal_coverage(
                &best,
                &target_artifact.landmarks,
                v2_normalized_pcm_origin_ms(target_input),
            );
            for hypothesis in &result.hypotheses {
                let hypothesis_coverage = affine_temporal_coverage(
                    hypothesis,
                    &target_artifact.landmarks,
                    v2_normalized_pcm_origin_ms(target_input),
                );
                hypothesis_alternatives.push(v2_alternative_hypothesis_score(
                    source_input,
                    target_input,
                    hypothesis,
                    score_v2_track_pair(
                        hypothesis,
                        hypothesis_coverage,
                        &affine_config,
                        source_input,
                        target_input,
                    ),
                ));
            }
            let score = score_v2_track_pair(
                &best,
                temporal_coverage,
                &affine_config,
                source_input,
                target_input,
            );
            // Every distinct Top-K location competes, including disjoint repeated-content
            // ranges. Only global assignment or a user choice may resolve that ambiguity.
            let intrinsic_margin = result.top1_top2_margin;
            let repeated_content_only =
                v2_affine_has_competing_repeated_location(&result.hypotheses, intrinsic_margin);
            pair_candidates.push(V2TrackPairCandidate {
                source_input: source_input.clone(),
                target_input: target_input.clone(),
                hypothesis: best,
                score,
                temporal_coverage,
                intrinsic_margin,
                repeated_content_only,
                observation_count: result.observation_count,
                source_landmark_count: result.source_landmark_count,
                target_landmark_count: result.target_landmark_count,
            });
        }
    }
    pair_candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| {
                right
                    .hypothesis
                    .inlier_count
                    .cmp(&left.hypothesis.inlier_count)
            })
            .then_with(|| {
                left.source_input
                    .stream
                    .stream_index
                    .cmp(&right.source_input.stream.stream_index)
            })
            .then_with(|| {
                left.target_input
                    .stream
                    .stream_index
                    .cmp(&right.target_input.stream.stream_index)
            })
    });
    hypothesis_alternatives.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.inlier_count.cmp(&left.inlier_count))
            .then_with(|| left.source_stream_index.cmp(&right.source_stream_index))
            .then_with(|| left.target_stream_index.cmp(&right.target_stream_index))
            .then_with(|| left.offset_ms.cmp(&right.offset_ms))
    });
    hypothesis_alternatives.truncate(10);
    let alternatives = hypothesis_alternatives;
    let Some(best_pair) = pair_candidates.first().cloned() else {
        let reason = "合理的非 commentary 音轨组合之间没有共同音频证据。";
        extraction_notes.push(format!(
            "音频组合保留了 {} 个未形成主定位的候选分数。",
            alternatives.len()
        ));
        update_progress(0.82, "没有共同音频定位，正在尝试独立视觉定位。")?;
        return try_v2_visual_fallback(request, options, reason, extraction_notes, cancel_flag);
    };
    let pair_margin = pair_candidates
        .get(1)
        .map(|second| {
            ((best_pair.score - second.score) / best_pair.score.max(0.001)).clamp(0.0, 1.0)
        })
        .unwrap_or(1.0);
    let top1_top2_margin = pair_margin.min(best_pair.intrinsic_margin);
    let selected_track_reason = format!(
        "landmark 内容评分选择 B 站参考音轨 #{} 与目标原片音轨 #{}；Top1/Top2 margin {:.3}。",
        best_pair.source_input.stream.stream_index,
        best_pair.target_input.stream.stream_index,
        top1_top2_margin
    );
    extraction_notes.push(selected_track_reason.clone());
    extraction_notes.push(format_v2_decode_timeline_diagnostic(
        "B 站参考",
        &best_pair.source_input,
    ));
    extraction_notes.push(format_v2_decode_timeline_diagnostic(
        "目标原片",
        &best_pair.target_input,
    ));
    if top1_top2_margin < ALIGNMENT_V2_MIN_TRACK_MARGIN {
        extraction_notes.push(
            "Top1/Top2 候选过于接近；继续计算显式 spans 供复核，但最终质量将保持 blocked。"
                .to_string(),
        );
    }
    if best_pair.temporal_coverage < ALIGNMENT_V2_MIN_TEMPORAL_COVERAGE
        || best_pair.hypothesis.inlier_count < affine_config.min_inliers
    {
        return Ok(create_blocked_v2_affine_proposal(
            "landmark 支持范围过短，不能把低分局部巧合解释为完整内容映射。",
            &best_pair,
            top1_top2_margin,
            alternatives,
            extraction_notes,
        ));
    }

    benchmark_stage("extracting-source", "解码参考音轨细粒度特征");
    update_progress(0.84, "已选择音轨，正在保留 PCM 并生成 50 ms 细特征。")?;
    let source_audio = match decode_v2_audio(
        &request.source_path,
        "B 站参考",
        options,
        &best_pair.source_input,
        source_landmarks
            .get(&best_pair.source_input.stream.stream_index)
            .ok_or_else(|| {
                "blocked:artifact-missing：所选 B 站参考音轨的粗定位制品已丢失。".to_string()
            })?,
        cancel_flag,
    ) {
        Ok(audio) => audio,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if is_media_identity_guard_error(&error) || error == AUDIO_ALIGNMENT_CANCELLED {
                return Err(error);
            }
            extraction_notes.push(error);
            return Ok(create_blocked_v2_affine_proposal(
                "所选 B 站参考音轨无法进入细粒度对齐。",
                &best_pair,
                top1_top2_margin,
                alternatives,
                extraction_notes,
            ));
        }
    };
    benchmark_stage("extracting-complete", "解码目标原片细粒度特征");
    let target_audio = match decode_v2_audio(
        &request.complete_path,
        "目标原片",
        options,
        &best_pair.target_input,
        target_landmarks
            .get(&best_pair.target_input.stream.stream_index)
            .ok_or_else(|| {
                "blocked:artifact-missing：所选目标原片音轨的粗定位制品已丢失。".to_string()
            })?,
        cancel_flag,
    ) {
        Ok(audio) => audio,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if is_media_identity_guard_error(&error) || error == AUDIO_ALIGNMENT_CANCELLED {
                return Err(error);
            }
            extraction_notes.push(error);
            return Ok(create_blocked_v2_affine_proposal(
                "所选目标原片音轨无法进入细粒度对齐。",
                &best_pair,
                top1_top2_margin,
                alternatives,
                extraction_notes,
            ));
        }
    };

    benchmark_stage("fitting", "执行分块 edit-aware DP");
    update_progress(0.89, "正在沿最佳 affine 走廊执行分块 edit-aware DP。")?;
    let mut chunk_alignment = match align_v2_feature_chunks(
        &source_audio.fine_features,
        &target_audio.fine_features,
        &best_pair.hypothesis,
        options,
        cancel_flag,
    ) {
        Ok(result) => result,
        Err(error) => {
            extraction_notes.push(error);
            return Ok(create_blocked_v2_affine_proposal(
                "细粒度 DP 未能形成完整、单调的双轴路径；已安全阻断旧引擎回退。",
                &best_pair,
                top1_top2_margin,
                alternatives,
                extraction_notes,
            ));
        }
    };

    benchmark_stage("refining", "精修可识别版本差异边界");
    update_progress(0.94, "正在用局部相关峰精修可识别边界。")?;
    let boundary_summary = refine_v2_span_boundaries(
        &mut chunk_alignment.spans,
        &source_audio.pcm,
        &target_audio.pcm,
        &best_pair.source_input,
        &best_pair.target_input,
        cancel_flag,
    );
    check_cancelled(cancel_flag)?;
    benchmark_stage("reporting", "生成 Alignment V2 时间图与证据");
    update_progress(0.97, "正在生成 Alignment V2 时间图和复核证据。")?;
    extraction_notes.push(format!(
        "细对齐按 {} ms 块、±{} ms affine 走廊执行；边界相关尝试 {} 次，可靠精修 {} 次，歧义 {} 次。",
        ALIGNMENT_V2_DP_CHUNK_MS,
        ALIGNMENT_V2_DP_BAND_RADIUS_MS,
        boundary_summary.attempted_count,
        boundary_summary.refined_count,
        boundary_summary.ambiguous_count
    ));
    extraction_notes.extend(boundary_summary.evidence_notes.iter().cloned());
    let mut proposal = create_v2_alignment_proposal(
        chunk_alignment,
        boundary_summary,
        best_pair,
        top1_top2_margin,
        selected_track_reason,
        alternatives,
        extraction_notes,
    );
    if options.enable_visual_evidence {
        benchmark_stage("extracting-visual", "独立视觉校验时间图");
        update_progress(0.98, "正在用独立视觉采样校验音频时间图。")?;
        apply_v2_visual_validation(request, options, &mut proposal, cancel_flag)?;
        benchmark_stage("reporting", "汇总音频与视觉复核证据");
    }
    Ok(proposal)
}

fn probe_alignment_audio_candidates(
    media_path: &str,
    label: &str,
    requested_stream_index: Option<u32>,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<AlignmentAudioInput>, String> {
    let snapshot = probe_media_timeline_with_ffprobe_cancellable(
        media_path,
        &options.ffprobe_path,
        cancel_flag,
    )
    .map_err(|error| format_alignment_probe_error(&format!("{label}媒体时间线探测失败"), error))?;
    if snapshot
        .duration_ms
        .is_some_and(|duration| duration > ALIGNMENT_V2_MAX_DURATION_MS)
    {
        return Err(format!(
            "blocked:resource-limit：{label}时长超过 Alignment V2 当前 {} 分钟的单次 PCM 上限。",
            ALIGNMENT_V2_MAX_DURATION_MS / 60_000
        ));
    }
    let decode_timelines = probe_audio_decode_timelines_with_ffprobe_cancellable(
        media_path,
        &options.ffprobe_path,
        snapshot.content_identity.as_ref().ok_or_else(|| {
            format!(
                "blocked:media-identity-missing：{label}媒体时间线缺少全文件身份，Alignment V2 已阻断。"
            )
        })?,
        cancel_flag,
    )
    .map_err(|error| {
        format_alignment_probe_error(&format!("{label}逐帧 PTS/skip-sample 探测失败"), error)
    })?;
    if let Some(stream_index) = requested_stream_index {
        let stream = select_audio_stream(&snapshot, Some(stream_index), label)?;
        let decode_timeline = decode_timelines
            .get(&stream.stream_index)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "{label}音轨 #{} 没有可复核的逐帧 PTS 证据，Alignment V2 已阻断。",
                    stream.stream_index
                )
            })?;
        return Ok(vec![alignment_audio_input_from_snapshot(
            &snapshot,
            stream,
            true,
            Some(decode_timeline),
        )]);
    }
    let mut streams = snapshot
        .audio_streams
        .iter()
        .filter(|stream| !stream.is_commentary && stream.timeline_offset_ms >= 0)
        .cloned()
        .collect::<Vec<_>>();
    streams.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| right.channels.unwrap_or(0).cmp(&left.channels.unwrap_or(0)))
            .then_with(|| left.stream_index.cmp(&right.stream_index))
    });
    if streams.len() > ALIGNMENT_V2_MAX_UNSELECTED_STREAMS {
        return Err(format!(
            "blocked:resource-limit：{label}有 {} 条非 commentary 候选音轨，超过自动内容评分硬上限 {}；请显式选择音轨后重试，系统不会按 default/声道数提前截断。",
            streams.len(), ALIGNMENT_V2_MAX_UNSELECTED_STREAMS
        ));
    }
    streams
        .into_iter()
        .map(|stream| {
            let decode_timeline = decode_timelines
                .get(&stream.stream_index)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "{label}音轨 #{} 没有可复核的逐帧 PTS 证据，Alignment V2 已阻断。",
                        stream.stream_index
                    )
                })?;
            Ok(alignment_audio_input_from_snapshot(
                &snapshot,
                stream,
                false,
                Some(decode_timeline),
            ))
        })
        .collect()
}

fn alignment_audio_input_from_snapshot(
    snapshot: &MediaProbeSnapshot,
    stream: AudioStreamProbe,
    explicit_stream_selection: bool,
    decode_timeline: Option<AudioDecodeTimelineProbe>,
) -> AlignmentAudioInput {
    AlignmentAudioInput {
        presentation_origin_ms: snapshot.presentation_origin_ms,
        media_duration_ms: snapshot.duration_ms.or(stream.duration_ms),
        content_identity: snapshot.content_identity.clone(),
        decode_timeline,
        audio_stream_count: snapshot.audio_streams.len(),
        explicit_stream_selection,
        stream,
    }
}

fn is_reasonable_audio_stream_pair(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> bool {
    !source.stream.is_commentary && !target.stream.is_commentary
}

fn normalized_stream_language(language: Option<&str>) -> Option<String> {
    let normalized = language?
        .trim()
        .to_ascii_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_string();
    if normalized.is_empty() || matches!(normalized.as_str(), "und" | "unknown" | "mul") {
        None
    } else {
        Some(
            match normalized.as_str() {
                "ja" | "jpn" => "ja",
                "zh" | "zho" | "chi" => "zh",
                "en" | "eng" => "en",
                "de" | "deu" | "ger" => "de",
                "fr" | "fra" | "fre" => "fr",
                "es" | "spa" => "es",
                "it" | "ita" => "it",
                "ko" | "kor" => "ko",
                "ru" | "rus" => "ru",
                "pt" | "por" => "pt",
                "ar" | "ara" => "ar",
                other => other,
            }
            .to_string(),
        )
    }
}

fn v2_normalized_pcm_origin_ms(input: &AlignmentAudioInput) -> i64 {
    input
        .decode_timeline
        .as_ref()
        .map(|item| item.normalized_pcm_origin_ms)
        .unwrap_or(0)
}

fn format_v2_decode_timeline_diagnostic(label: &str, input: &AlignmentAudioInput) -> String {
    let Some(timeline) = input.decode_timeline.as_ref() else {
        return format!("{label}缺少逐帧 PTS/skip-sample 证据。");
    };
    format!(
        "{label}音轨 #{}：first decoded PTS {:?} ms，PTS discontinuity {} 次，max gap {:?} ms，skip/discard samples={}/{}, normalized PCM origin {} ms。",
        input.stream.stream_index,
        timeline.first_decoded_pts_ms,
        timeline.pts_discontinuity_count,
        timeline.max_pts_gap_ms,
        timeline.skip_samples,
        timeline.discard_padding,
        timeline.normalized_pcm_origin_ms
    )
}

fn v2_language_pair_prior(source: &AlignmentAudioInput, target: &AlignmentAudioInput) -> f64 {
    match (
        normalized_stream_language(source.stream.language.as_deref()),
        normalized_stream_language(target.stream.language.as_deref()),
    ) {
        (Some(source), Some(target)) if source == target => 0.02,
        (Some(_), Some(_)) => -0.02,
        _ => 0.0,
    }
}

fn extract_v2_landmark_candidates(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    inputs: &[AlignmentAudioInput],
    cancel_flag: Option<&AtomicBool>,
    notes: &mut Vec<String>,
    retained_artifact_bytes: &mut usize,
) -> Result<HashMap<u32, CachedV2Landmarks>, String> {
    let mut output = HashMap::new();
    for input in inputs {
        if let Err(error) = check_v2_duration_limit(input, label) {
            notes.push(error);
            continue;
        }
        let estimated_pcm_bytes = input
            .media_duration_ms
            .and_then(v2_pcm_bytes_for_duration_ms)
            .unwrap_or(0);
        ensure_v2_active_artifact_budget(*retained_artifact_bytes, estimated_pcm_bytes)?;
        match get_v2_landmarks(media_path, label, options, input, cancel_flag) {
            Ok(artifact) if !artifact.landmarks.is_empty() => {
                let artifact_bytes = cached_v2_landmark_retained_bytes(&artifact);
                let next_retained_bytes =
                    ensure_v2_active_artifact_budget(*retained_artifact_bytes, artifact_bytes)?;
                *retained_artifact_bytes = next_retained_bytes;
                notes.push(format!(
                    "{label}音轨 #{} landmark {}：{} 个。",
                    input.stream.stream_index,
                    if artifact.cache_hit {
                        "缓存命中"
                    } else {
                        "新提取"
                    },
                    artifact.landmarks.len()
                ));
                output.insert(input.stream.stream_index, artifact);
            }
            Ok(_) => notes.push(format!(
                "{label}音轨 #{} 只有静音或重复性过高，未得到可用 landmark。",
                input.stream.stream_index
            )),
            Err(error) => {
                propagate_alignment_process_cleanup(&error)?;
                if is_media_identity_guard_error(&error)
                    || error == AUDIO_ALIGNMENT_CANCELLED
                    || error.starts_with("blocked:resource-limit")
                {
                    return Err(error);
                }
                notes.push(format!(
                    "{label}音轨 #{} landmark 提取失败：{error}",
                    input.stream.stream_index
                ));
            }
        }
    }
    Ok(output)
}

fn check_v2_duration_limit(input: &AlignmentAudioInput, label: &str) -> Result<(), String> {
    if input
        .media_duration_ms
        .is_some_and(|duration| duration > ALIGNMENT_V2_MAX_DURATION_MS)
    {
        return Err(format!(
            "blocked:resource-limit：{label}时长超过 Alignment V2 当前 {} 分钟的单次 PCM 上限。",
            ALIGNMENT_V2_MAX_DURATION_MS / 60_000
        ));
    }
    Ok(())
}

fn v2_pcm_bytes_for_duration_ms(duration_ms: u64) -> Option<usize> {
    let samples = (duration_ms as u128)
        .checked_mul(ALIGNMENT_V2_SAMPLE_RATE as u128)?
        .checked_add(999)?
        / 1_000;
    let bytes = samples.checked_mul(std::mem::size_of::<i16>() as u128)?;
    usize::try_from(bytes).ok()
}

fn v2_candidate_artifact_upper_bound(input: &AlignmentAudioInput) -> Result<usize, String> {
    let duration_ms = input
        .media_duration_ms
        .unwrap_or(ALIGNMENT_V2_MAX_DURATION_MS);
    let pcm_bytes = v2_pcm_bytes_for_duration_ms(duration_ms)
        .ok_or_else(|| "blocked:resource-limit：候选音轨 PCM 上界无法表示。".to_string())?;
    let frame_count = usize::try_from(
        (duration_ms as u128)
            .checked_add(ALIGNMENT_V2_LANDMARK_HOP_MS as u128 - 1)
            .ok_or_else(|| "blocked:resource-limit：候选帧数溢出。".to_string())?
            / ALIGNMENT_V2_LANDMARK_HOP_MS as u128,
    )
    .map_err(|_| "blocked:resource-limit：候选帧数无法表示。".to_string())?;
    // LandmarkConfig below emits at most 4 anchors * 5 fanout landmarks per frame.
    let landmark_bytes = frame_count
        .checked_mul(20)
        .and_then(|count| count.checked_mul(std::mem::size_of::<SpectralLandmark>()))
        .ok_or_else(|| "blocked:resource-limit：landmark 驻留上界溢出。".to_string())?;
    // FineFeatureConfig currently stores time + Vec metadata + 14 f32 values per frame.
    let fine_bytes_per_frame =
        std::mem::size_of::<FineFeatureFrame>().saturating_add(14 * std::mem::size_of::<f32>());
    let fine_bytes = frame_count
        .checked_mul(fine_bytes_per_frame)
        .ok_or_else(|| "blocked:resource-limit：细特征驻留上界溢出。".to_string())?;
    pcm_bytes
        .checked_add(landmark_bytes)
        .and_then(|value| value.checked_add(fine_bytes))
        .ok_or_else(|| "blocked:resource-limit：候选音轨制品驻留上界溢出。".to_string())
}

fn ensure_v2_candidate_set_active_budget(
    source_inputs: &[AlignmentAudioInput],
    target_inputs: &[AlignmentAudioInput],
) -> Result<(), String> {
    let mut retained = 0_usize;
    for input in source_inputs.iter().chain(target_inputs) {
        retained =
            ensure_v2_active_artifact_budget(retained, v2_candidate_artifact_upper_bound(input)?)?;
    }
    Ok(())
}

fn ensure_v2_active_artifact_budget(
    retained_bytes: usize,
    additional_bytes: usize,
) -> Result<usize, String> {
    let next = retained_bytes
        .checked_add(additional_bytes)
        .ok_or_else(|| "blocked:resource-limit：候选音轨制品驻留字节溢出。".to_string())?;
    if next > MAX_V2_ACTIVE_ARTIFACT_BYTES {
        return Err(format!(
            "blocked:resource-limit：候选音轨制品的单次驻留预算超过 {} MiB；请显式选择需要比较的音轨。",
            MAX_V2_ACTIVE_ARTIFACT_BYTES / (1024 * 1024)
        ));
    }
    Ok(next)
}

fn cached_v2_landmark_retained_bytes(artifact: &CachedV2Landmarks) -> usize {
    v2_media_artifact_payload_bytes(&V2MediaArtifact {
        pcm: artifact.pcm.clone(),
        landmarks: artifact.landmarks.clone(),
        fine_features: artifact.fine_features.clone(),
    })
}

fn v2_media_artifact_payload_bytes(artifact: &V2MediaArtifact) -> usize {
    let pcm_bytes = artifact
        .pcm
        .capacity()
        .saturating_mul(std::mem::size_of::<i16>());
    let landmark_bytes = artifact
        .landmarks
        .capacity()
        .saturating_mul(std::mem::size_of::<SpectralLandmark>());
    let fine_bytes = artifact
        .fine_features
        .as_ref()
        .map(|frames| {
            frames
                .capacity()
                .saturating_mul(std::mem::size_of::<FineFeatureFrame>())
                .saturating_add(frames.iter().fold(0_usize, |total, frame| {
                    total.saturating_add(
                        frame
                            .values
                            .capacity()
                            .saturating_mul(std::mem::size_of::<f32>()),
                    )
                }))
        })
        .unwrap_or(0);
    pcm_bytes
        .saturating_add(landmark_bytes)
        .saturating_add(fine_bytes)
}

fn v2_media_artifact_resident_bytes(cache_key: &str, artifact: &V2MediaArtifact) -> usize {
    v2_media_artifact_payload_bytes(artifact)
        .saturating_add(cache_key.len())
        .saturating_add(std::mem::size_of::<V2MediaArtifactCacheEntry>())
}

fn v2_landmark_cache() -> &'static Mutex<V2MediaArtifactCache> {
    V2_LANDMARK_CACHE
        .get_or_init(|| Mutex::new(V2MediaArtifactCache::new(MAX_V2_MEDIA_ARTIFACT_CACHE_BYTES)))
}

fn get_v2_landmarks(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedV2Landmarks, String> {
    check_cancelled(cancel_flag)?;
    let cache_key = create_v2_audio_cache_key(media_path, options, input, "landmark")?;
    if let Some(artifact) = v2_landmark_cache()
        .lock()
        .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?
        .get(&cache_key)
    {
        benchmark_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Hit);
        return Ok(CachedV2Landmarks {
            landmarks: artifact.landmarks,
            pcm: artifact.pcm,
            fine_features: artifact.fine_features,
            cache_key,
            cache_hit: true,
        });
    }
    benchmark_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Miss);
    let pcm = Arc::new(decode_v2_pcm(
        media_path,
        label,
        options,
        input,
        cancel_flag,
    )?);
    let presentation_offset_ms = input
        .decode_timeline
        .as_ref()
        .map(|item| item.normalized_pcm_origin_ms)
        .unwrap_or(0);
    let extracted = extract_landmarks_and_fine_features_with_cancel(
        &pcm,
        &LandmarkConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            presentation_offset_ms,
            window_ms: 50,
            hop_ms: ALIGNMENT_V2_LANDMARK_HOP_MS,
            max_hash_occurrences: 64,
            ..LandmarkConfig::default()
        },
        &FineFeatureConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            presentation_offset_ms,
            window_ms: 50,
            hop_ms: ALIGNMENT_V2_FINE_HOP_MS,
        },
        cancel_flag,
    )?;
    let landmarks = Arc::new(extracted.landmarks);
    let fine_features = Arc::new(extracted.fine_features);
    // Cancellation after extraction must never publish a partially trusted warm artifact.
    check_cancelled(cancel_flag)?;
    let artifact = V2MediaArtifact {
        pcm: pcm.clone(),
        landmarks: landmarks.clone(),
        fine_features: Some(fine_features.clone()),
    };
    let mut cache = v2_landmark_cache()
        .lock()
        .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?;
    let insertion = cache.insert(cache_key.clone(), artifact, cancel_flag)?;
    for _ in 0..insertion.eviction_count {
        benchmark_cache_event(
            BenchmarkCacheKind::V2Landmarks,
            BenchmarkCacheEvent::Eviction,
        );
    }
    if insertion.stored && insertion.new_entry {
        benchmark_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Write);
    }
    Ok(CachedV2Landmarks {
        landmarks,
        pcm,
        fine_features: Some(fine_features),
        cache_key,
        cache_hit: false,
    })
}

fn create_v2_audio_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    artifact: &str,
) -> Result<String, String> {
    let legacy_identity = create_audio_feature_cache_key(media_path, options, input)?;
    let timeline = input.decode_timeline.as_ref();
    Ok(format!(
        "engine={ALIGNMENT_V2_ENGINE_VERSION}|feature={ALIGNMENT_V2_FEATURE_VERSION}|artifact={artifact}|ptsOrigin={}|streamPtsOffset={}|firstDecodedPts={:?}|ptsDiscontinuities={}|maxPtsGap={:?}|skipSamples={}|discardPadding={}|normalizedPcmOrigin={}|{legacy_identity}",
        input.presentation_origin_ms,
        input.stream.timeline_offset_ms,
        timeline.and_then(|item| item.first_decoded_pts_ms),
        timeline.map(|item| item.pts_discontinuity_count).unwrap_or(0),
        timeline.and_then(|item| item.max_pts_gap_ms),
        timeline.map(|item| item.skip_samples).unwrap_or(0),
        timeline.map(|item| item.discard_padding).unwrap_or(0),
        timeline
            .map(|item| item.normalized_pcm_origin_ms)
            .unwrap_or(0),
    ))
}

fn decode_v2_audio(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    landmark_artifact: &CachedV2Landmarks,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedV2Audio, String> {
    check_v2_duration_limit(input, label)?;
    check_cancelled(cancel_flag)?;
    let expected_cache_key = create_v2_audio_cache_key(media_path, options, input, "landmark")?;
    if landmark_artifact.cache_key != expected_cache_key {
        return Err(format!(
            "blocked:media-identity-changed：{label}粗定位制品与当前内容身份、音轨、PTS 或算法参数不一致。"
        ));
    }
    // Cache hits never replace the run-level final identity gate. Recheck before the
    // retained PCM is consumed so stale bytes cannot drive expensive DP work.
    verify_media_content_identity_after_tool_output(
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 PCM/细特征复用",
    )?;
    if let Some(fine_features) = landmark_artifact.fine_features.clone() {
        if fine_features.is_empty() {
            return Err(format!("{label}没有可用的 50 ms 细粒度音频特征。"));
        }
        return Ok(DecodedV2Audio {
            pcm: landmark_artifact.pcm.clone(),
            fine_features,
        });
    }

    let fine_features = Arc::new(extract_fine_features_with_cancel(
        &landmark_artifact.pcm,
        &FineFeatureConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            presentation_offset_ms: input
                .decode_timeline
                .as_ref()
                .map(|item| item.normalized_pcm_origin_ms)
                .unwrap_or(0),
            window_ms: 50,
            hop_ms: ALIGNMENT_V2_FINE_HOP_MS,
        },
        cancel_flag,
    )?);
    if fine_features.is_empty() {
        return Err(format!("{label}没有可用的 50 ms 细粒度音频特征。"));
    }
    // As with landmark extraction, do not let cancellation race a cache publication.
    check_cancelled(cancel_flag)?;
    let artifact = V2MediaArtifact {
        pcm: landmark_artifact.pcm.clone(),
        landmarks: landmark_artifact.landmarks.clone(),
        fine_features: Some(fine_features.clone()),
    };
    let insertion = v2_landmark_cache()
        .lock()
        .map_err(|_| "Alignment V2 landmark 缓存锁已损坏。".to_string())?
        .insert(expected_cache_key, artifact, cancel_flag)?;
    for _ in 0..insertion.eviction_count {
        benchmark_cache_event(
            BenchmarkCacheKind::V2Landmarks,
            BenchmarkCacheEvent::Eviction,
        );
    }
    // Enriching an existing landmark/PCM entry with fine features is an in-place cache
    // upgrade, not another benchmark write. If the entry was evicted meanwhile, its
    // reintroduction is correctly observable as a new write.
    if insertion.stored && insertion.new_entry {
        benchmark_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Write);
    }
    Ok(DecodedV2Audio {
        pcm: landmark_artifact.pcm.clone(),
        fine_features,
    })
}

fn decode_v2_pcm(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<i16>, String> {
    check_cancelled(cancel_flag)?;
    #[cfg(test)]
    TEST_V2_PCM_DECODE_INVOCATIONS.with(|count| count.set(count.get().saturating_add(1)));
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        create_v2_audio_decode_args(media_path, input),
        "FFmpeg V2 音频解码",
        ALIGNMENT_V2_MAX_PCM_BYTES,
        cancel_flag,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            &format!("FFmpeg 提取 {label} V2 PCM"),
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output(
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 音频解码",
    )?;
    parse_v2_pcm_output(&output.stdout, label, cancel_flag)
}

#[cfg(test)]
fn reset_test_v2_pcm_decode_invocations() {
    TEST_V2_PCM_DECODE_INVOCATIONS.with(|count| count.set(0));
}

#[cfg(test)]
fn test_v2_pcm_decode_invocations() -> u64 {
    TEST_V2_PCM_DECODE_INVOCATIONS.with(std::cell::Cell::get)
}

fn parse_v2_pcm_output(
    stdout: &[u8],
    label: &str,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<i16>, String> {
    check_cancelled(cancel_flag)?;
    if !stdout.len().is_multiple_of(2) {
        return Err(format!("{label} V2 PCM 字节数不是 i16 对齐。"));
    }
    let sample_count = stdout.len() / 2;
    debug_assert!(sample_count <= ALIGNMENT_V2_MAX_PCM_BYTES / 2);
    let mut pcm = Vec::with_capacity(sample_count);
    for bytes in stdout.chunks(V2_PCM_PARSE_CANCEL_CHECK_SAMPLES * 2) {
        pcm.extend(
            bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]])),
        );
        check_cancelled(cancel_flag)?;
    }
    check_cancelled(cancel_flag)?;
    if pcm.is_empty() {
        return Err(format!("{label}没有可用 PCM。"));
    }
    Ok(pcm)
}

fn create_v2_audio_decode_args(media_path: &str, input: &AlignmentAudioInput) -> Vec<String> {
    vec![
        "-nostdin".to_string(),
        "-v".to_string(),
        "error".to_string(),
        "-copyts".to_string(),
        "-start_at_zero".to_string(),
        "-i".to_string(),
        media_path.to_string(),
        "-map".to_string(),
        format!("0:{}", input.stream.stream_index),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-af".to_string(),
        format!("aresample={ALIGNMENT_V2_SAMPLE_RATE}:async=1:first_pts=0"),
        "-t".to_string(),
        format!("{:.3}", ALIGNMENT_V2_MAX_DURATION_MS as f64 / 1_000.0),
        "-f".to_string(),
        "s16le".to_string(),
        "pipe:1".to_string(),
    ]
}

fn affine_temporal_coverage(
    hypothesis: &AffineHypothesis,
    target_landmarks: &[SpectralLandmark],
    target_offset_ms: i64,
) -> f64 {
    let target_start = target_landmarks
        .first()
        .map(|item| item.time_ms)
        .unwrap_or(target_offset_ms);
    let target_end = target_landmarks
        .last()
        .map(|item| item.time_ms)
        .unwrap_or(target_start);
    let projected_start =
        hypothesis.scale * hypothesis.source_start_ms as f64 + hypothesis.offset_ms as f64;
    let projected_end =
        hypothesis.scale * hypothesis.source_end_ms as f64 + hypothesis.offset_ms as f64;
    let overlap_start = projected_start.min(projected_end).max(target_start as f64);
    let overlap_end = projected_start.max(projected_end).min(target_end as f64);
    ((overlap_end - overlap_start).max(0.0) / (target_end - target_start).max(1) as f64)
        .clamp(0.0, 1.0)
}

fn score_v2_track_pair(
    hypothesis: &AffineHypothesis,
    temporal_coverage: f64,
    config: &AffineMatchConfig,
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> f64 {
    let support = (hypothesis.inlier_count as f64 / 24.0).clamp(0.0, 1.0);
    let residual = (1.0 - hypothesis.p95_residual_ms as f64 / config.residual_tolerance_ms as f64)
        .clamp(0.0, 1.0);
    (temporal_coverage * 0.55
        + support * 0.25
        + hypothesis.unique_target_coverage.clamp(0.0, 1.0) * 0.10
        + residual * 0.10
        + v2_language_pair_prior(source, target))
    .clamp(0.0, 1.0)
}

fn v2_affine_has_competing_repeated_location(hypotheses: &[AffineHypothesis], margin: f64) -> bool {
    let (Some(best), Some(alternative)) = (hypotheses.first(), hypotheses.get(1)) else {
        return false;
    };
    if margin >= ALIGNMENT_V2_MIN_TRACK_MARGIN
        || alternative.inlier_count * 4 < best.inlier_count * 3
    {
        return false;
    }
    let midpoint = (best.source_start_ms.saturating_add(best.source_end_ms)) as f64 / 2.0;
    let best_location = best.scale * midpoint + best.offset_ms as f64;
    let alternative_location = alternative.scale * midpoint + alternative.offset_ms as f64;
    (best_location - alternative_location).abs() >= 10_000.0
}

#[cfg(test)]
fn v2_alternative_track_score(candidate: &V2TrackPairCandidate) -> AudioAlternativeTrackScoreDto {
    AudioAlternativeTrackScoreDto {
        source_stream_index: candidate.source_input.stream.stream_index,
        target_stream_index: candidate.target_input.stream.stream_index,
        score: candidate.score,
        scale: candidate.hypothesis.scale,
        offset_ms: candidate.hypothesis.offset_ms,
        inlier_count: candidate.hypothesis.inlier_count,
    }
}

fn v2_alternative_hypothesis_score(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
    hypothesis: &AffineHypothesis,
    score: f64,
) -> AudioAlternativeTrackScoreDto {
    AudioAlternativeTrackScoreDto {
        source_stream_index: source.stream.stream_index,
        target_stream_index: target.stream.stream_index,
        score,
        scale: hypothesis.scale,
        offset_ms: hypothesis.offset_ms,
        inlier_count: hypothesis.inlier_count,
    }
}

fn align_v2_feature_chunks(
    source_frames: &[FineFeatureFrame],
    target_frames: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<V2ChunkAlignment, String> {
    if source_frames.is_empty() || target_frames.is_empty() || coarse.scale <= 0.0 {
        return Err("Alignment V2 分块输入为空或 affine scale 无效。".to_string());
    }
    let allowed_cells = options.max_cells.min(ALIGNMENT_V2_MAX_DP_CELLS);
    let target_hop_ms = estimate_v2_hop_ms(target_frames);
    let chunk_frame_count = (ALIGNMENT_V2_DP_CHUNK_MS / target_hop_ms).max(1) as usize;
    let inverse = inverse_affine_hypothesis(coarse)?;
    let mut spans = Vec::<AudioTimeMapSpanDto>::new();
    let mut matched_step_count = 0usize;
    let mut ambiguous_step_count = 0usize;
    let mut target_start_index = 0usize;
    let mut previous_source_end_ms: Option<i64> = None;
    while target_start_index < target_frames.len() {
        check_cancelled(cancel_flag)?;
        let target_end_index = (target_start_index + chunk_frame_count).min(target_frames.len());
        let target_chunk = &target_frames[target_start_index..target_end_index];
        let target_start_ms = target_chunk
            .first()
            .ok_or_else(|| "V2 目标分块为空。".to_string())?
            .time_ms;
        let target_end_ms = target_chunk
            .last()
            .ok_or_else(|| "V2 目标分块为空。".to_string())?
            .time_ms
            .saturating_add(target_hop_ms);
        let (source_lower_ms, source_upper_ms, chunk_inverse) =
            if let Some(previous_source_end_ms) = previous_source_end_ms {
                // Re-anchor each chunk at the last confirmed source position. A target-only edit
                // therefore advances the target axis without accumulating the global affine
                // error; the following chunk starts from the same source cursor and can recover
                // after edits substantially wider than the local ±30 s DP band.
                let expected_source_advance_ms = ((target_end_ms - target_start_ms) as f64
                    * inverse.scale)
                    .ceil()
                    .max(1.0) as i64;
                let mut recursive = inverse.clone();
                recursive.offset_ms = (previous_source_end_ms as f64
                    - recursive.scale * target_start_ms as f64)
                    .round() as i64;
                (
                    previous_source_end_ms,
                    previous_source_end_ms
                        .saturating_add(expected_source_advance_ms)
                        .saturating_add(ALIGNMENT_V2_RECURSIVE_LOOKAHEAD_MS),
                    recursive,
                )
            } else {
                let predicted_source_start = inverse.scale * target_start_ms as f64
                    + inverse.offset_ms as f64
                    - ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                let predicted_source_end = inverse.scale * target_end_ms as f64
                    + inverse.offset_ms as f64
                    + ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                (
                    predicted_source_start.floor() as i64,
                    predicted_source_end.ceil() as i64,
                    inverse.clone(),
                )
            };
        let source_start_index =
            source_frames.partition_point(|frame| frame.time_ms < source_lower_ms);
        let source_end_index =
            source_frames.partition_point(|frame| frame.time_ms <= source_upper_ms);
        if source_end_index <= source_start_index {
            return Err(format!(
                "粗 affine 在目标 {}–{} ms 的 ±{} ms 走廊内没有参考特征。",
                target_start_ms, target_end_ms, ALIGNMENT_V2_DP_BAND_RADIUS_MS
            ));
        }
        let source_window = &source_frames[source_start_index..source_end_index];
        if previous_source_end_ms.is_some()
            && v2_chunk_content_support(target_chunk, source_window, &chunk_inverse) < 0.10
        {
            let source_cursor = previous_source_end_ms.unwrap_or(source_lower_ms).max(0) as u64;
            let target_span_start = spans
                .last()
                .map(|span| span.target_end_ms)
                .unwrap_or_else(|| target_start_ms.max(0) as u64);
            append_or_merge_v2_span(
                &mut spans,
                AudioTimeMapSpanDto {
                    kind: AudioTimeMapSpanKind::TargetOnly,
                    source_start_ms: source_cursor,
                    source_end_ms: source_cursor,
                    target_start_ms: target_span_start,
                    target_end_ms: target_end_ms.max(0) as u64,
                },
            );
            target_start_index = target_end_index;
            continue;
        }
        let required_cells = (target_chunk.len() + 1)
            .checked_mul(source_window.len() + 1)
            .ok_or_else(|| "V2 分块 DP 单元数溢出。".to_string())?;
        if required_cells > allowed_cells {
            return Err(format!(
                "blocked:resource-limit：V2 分块需要 {required_cells} 个 DP 单元，硬上限为 {allowed_cells}。"
            ));
        }
        // 反向调用：完整消费目标原片块，并在较宽的参考窗内 semi-global 定位。
        // 返回后交换两条轴，恢复 B 站参考 -> 目标原片的正式 TimeMap 方向。
        let result = align_features_edit_aware_with_cancel(
            target_chunk,
            source_window,
            &chunk_inverse,
            &EditAlignmentConfig {
                mode: EditAlignmentMode::SemiGlobal,
                band_radius_ms: ALIGNMENT_V2_DP_BAND_RADIUS_MS,
                max_dp_cells: allowed_cells,
                gap_open_cost: 320,
                gap_extend_cost: 55,
                ambiguous_match_cost: 720,
            },
            cancel_flag,
        )?;
        let chunk_spans = result
            .spans
            .iter()
            .map(swap_v2_edit_span_axes)
            .collect::<Result<Vec<_>, _>>()?;
        append_v2_chunk_spans(&mut spans, chunk_spans)?;
        previous_source_end_ms = spans.last().map(|span| span.source_end_ms as i64);
        matched_step_count += result.matched_step_count;
        ambiguous_step_count += result.ambiguous_step_count;
        target_start_index = target_end_index;
    }
    if spans.is_empty() {
        return Err("V2 分块 DP 没有输出 span。".to_string());
    }
    validate_v2_time_map_spans(&spans)?;
    Ok(V2ChunkAlignment {
        spans,
        matched_step_count,
        ambiguous_step_count,
    })
}

fn v2_chunk_content_support(
    target_chunk: &[FineFeatureFrame],
    source_window: &[FineFeatureFrame],
    target_to_source: &AffineHypothesis,
) -> f64 {
    if target_chunk.is_empty() || source_window.is_empty() {
        return 0.0;
    }
    let step = target_chunk.len().div_ceil(32).max(1);
    let mut observations = 0usize;
    let mut supported = 0usize;
    for target in target_chunk.iter().step_by(step) {
        let predicted =
            target_to_source.scale * target.time_ms as f64 + target_to_source.offset_ms as f64;
        let index = source_window.partition_point(|frame| frame.time_ms < predicted.round() as i64);
        let candidate = [index.checked_sub(1), Some(index)]
            .into_iter()
            .flatten()
            .filter_map(|index| source_window.get(index))
            .min_by_key(|frame| frame.time_ms.abs_diff(predicted.round() as i64));
        if let Some(source) = candidate {
            observations += 1;
            if v2_fine_feature_distance(&target.values, &source.values) < 0.5 {
                supported += 1;
            }
        }
    }
    supported as f64 / observations.max(1) as f64
}

fn v2_fine_feature_distance(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 2.0;
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum::<f64>();
    let left_norm = left
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    let right_norm = right
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        2.0
    } else {
        (1.0 - dot / (left_norm * right_norm)).clamp(0.0, 2.0)
    }
}

fn estimate_v2_hop_ms(frames: &[FineFeatureFrame]) -> i64 {
    let mut differences = frames
        .windows(2)
        .map(|window| window[1].time_ms - window[0].time_ms)
        .filter(|difference| *difference > 0)
        .collect::<Vec<_>>();
    differences.sort_unstable();
    differences
        .get(differences.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(ALIGNMENT_V2_FINE_HOP_MS as i64)
}

fn inverse_affine_hypothesis(coarse: &AffineHypothesis) -> Result<AffineHypothesis, String> {
    if !coarse.scale.is_finite() || coarse.scale <= 0.0 {
        return Err("无法反转无效 affine scale。".to_string());
    }
    Ok(AffineHypothesis {
        scale: 1.0 / coarse.scale,
        offset_ms: (-coarse.offset_ms as f64 / coarse.scale).round() as i64,
        inlier_count: coarse.inlier_count,
        unique_source_count: coarse.unique_target_count,
        unique_source_coverage: coarse.unique_target_coverage,
        unique_target_count: coarse.unique_source_count,
        unique_target_coverage: coarse.unique_source_coverage,
        source_start_ms: (coarse.scale * coarse.source_start_ms as f64 + coarse.offset_ms as f64)
            .round() as i64,
        source_end_ms: (coarse.scale * coarse.source_end_ms as f64 + coarse.offset_ms as f64)
            .round() as i64,
        p50_residual_ms: coarse.p50_residual_ms,
        p95_residual_ms: coarse.p95_residual_ms,
        max_residual_ms: coarse.max_residual_ms,
    })
}

fn swap_v2_edit_span_axes(span: &EditTimeSpan) -> Result<AudioTimeMapSpanDto, String> {
    let kind = match span.kind {
        EditPathKind::Matched => AudioTimeMapSpanKind::Matched,
        EditPathKind::SourceOnly => AudioTimeMapSpanKind::TargetOnly,
        EditPathKind::TargetOnly => AudioTimeMapSpanKind::SourceOnly,
        EditPathKind::Ambiguous => AudioTimeMapSpanKind::Ambiguous,
    };
    Ok(AudioTimeMapSpanDto {
        kind,
        source_start_ms: checked_v2_milliseconds(span.target_start_ms)?,
        source_end_ms: checked_v2_milliseconds(span.target_end_ms)?,
        target_start_ms: checked_v2_milliseconds(span.source_start_ms)?,
        target_end_ms: checked_v2_milliseconds(span.source_end_ms)?,
    })
}

fn checked_v2_milliseconds(value: i64) -> Result<u64, String> {
    u64::try_from(value)
        .map_err(|_| format!("V2 生成了负的 presentation timeline 坐标 {value} ms，已安全阻断。"))
}

fn append_v2_chunk_spans(
    output: &mut Vec<AudioTimeMapSpanDto>,
    mut chunk: Vec<AudioTimeMapSpanDto>,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Err("V2 细对齐块没有 span。".to_string());
    }
    if let Some(previous) = output.last() {
        let next = &chunk[0];
        if next.target_start_ms != previous.target_end_ms {
            return Err(format!(
                "V2 分块目标轴不连续：{} -> {}。",
                previous.target_end_ms, next.target_start_ms
            ));
        }
        if next.source_start_ms < previous.source_end_ms {
            return Err(format!(
                "V2 分块参考轴回退：{} -> {}，可能存在重复内容歧义。",
                previous.source_end_ms, next.source_start_ms
            ));
        }
        if next.source_start_ms > previous.source_end_ms {
            output.push(AudioTimeMapSpanDto {
                kind: AudioTimeMapSpanKind::SourceOnly,
                source_start_ms: previous.source_end_ms,
                source_end_ms: next.source_start_ms,
                target_start_ms: previous.target_end_ms,
                target_end_ms: previous.target_end_ms,
            });
        }
    }
    for span in chunk.drain(..) {
        append_or_merge_v2_span(output, span);
    }
    Ok(())
}

fn append_or_merge_v2_span(output: &mut Vec<AudioTimeMapSpanDto>, span: AudioTimeMapSpanDto) {
    if let Some(previous) = output.last_mut() {
        if previous.kind == span.kind
            && previous.source_end_ms == span.source_start_ms
            && previous.target_end_ms == span.target_start_ms
        {
            previous.source_end_ms = span.source_end_ms;
            previous.target_end_ms = span.target_end_ms;
            return;
        }
    }
    output.push(span);
}

fn validate_v2_time_map_spans(spans: &[AudioTimeMapSpanDto]) -> Result<(), String> {
    for (index, span) in spans.iter().enumerate() {
        let source_duration = span.source_end_ms.checked_sub(span.source_start_ms);
        let target_duration = span.target_end_ms.checked_sub(span.target_start_ms);
        let valid_shape = match (span.kind, source_duration, target_duration) {
            (AudioTimeMapSpanKind::Matched, Some(source), Some(target)) => source > 0 && target > 0,
            (AudioTimeMapSpanKind::SourceOnly, Some(source), Some(target)) => {
                source > 0 && target == 0
            }
            (AudioTimeMapSpanKind::TargetOnly, Some(source), Some(target)) => {
                source == 0 && target > 0
            }
            (AudioTimeMapSpanKind::Ambiguous, Some(source), Some(target)) => {
                source > 0 || target > 0
            }
            _ => false,
        };
        if !valid_shape {
            return Err(format!("V2 TimeMap 第 {} 段形状无效。", index + 1));
        }
        if let Some(previous) = index.checked_sub(1).and_then(|item| spans.get(item)) {
            if previous.source_end_ms != span.source_start_ms
                || previous.target_end_ms != span.target_start_ms
            {
                return Err(format!("V2 TimeMap 第 {} 段与前一段不连续。", index + 1));
            }
        }
    }
    Ok(())
}

fn refine_v2_span_boundaries(
    spans: &mut [AudioTimeMapSpanDto],
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_input: &AlignmentAudioInput,
    target_input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
) -> V2BoundarySummary {
    let mut summary = V2BoundarySummary::default();
    let mut edit_side_refined = vec![[false; 2]; spans.len()];
    let mut non_edit_ambiguity_count = 0usize;
    for boundary_index in 1..spans.len() {
        if check_cancelled(cancel_flag).is_err() {
            return summary;
        }
        let left = &spans[boundary_index - 1];
        let right = &spans[boundary_index];
        if left.kind == AudioTimeMapSpanKind::Ambiguous
            || right.kind == AudioTimeMapSpanKind::Ambiguous
        {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        }
        let left_is_edit = is_v2_edit_span(left.kind);
        let right_is_edit = is_v2_edit_span(right.kind);
        if left_is_edit && right_is_edit {
            summary.evidence_notes.push(format!(
                "删减边界 #{} 两侧都是单轴内容，缺少共同音频上下文，不能精修。",
                boundary_index
            ));
            continue;
        }
        let Ok(source_boundary_ms) = i64::try_from(left.source_end_ms) else {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        };
        let Ok(target_boundary_ms) = i64::try_from(left.target_end_ms) else {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        };
        summary.attempted_count += 1;
        let edit_context = if right_is_edit {
            Some((
                boundary_index,
                0usize,
                right.kind,
                BoundaryContextSide::Before,
            ))
        } else if left_is_edit {
            Some((
                boundary_index - 1,
                1usize,
                left.kind,
                BoundaryContextSide::After,
            ))
        } else {
            None
        };
        let result = match edit_context {
            Some((_, _, AudioTimeMapSpanKind::SourceOnly, context_side)) => {
                // Swap the axes: target content is the fixed reference and the source boundary
                // is searched. This is the symmetric operation that the old implementation
                // lacked for sourceOnly edits.
                refine_boundary_by_one_sided_correlation_with_cancel(
                    target_pcm,
                    source_pcm,
                    target_boundary_ms,
                    source_boundary_ms,
                    context_side,
                    &v2_boundary_refinement_config(target_input, source_input),
                    cancel_flag,
                )
            }
            Some((_, _, AudioTimeMapSpanKind::TargetOnly, context_side)) => {
                refine_boundary_by_one_sided_correlation_with_cancel(
                    source_pcm,
                    target_pcm,
                    source_boundary_ms,
                    target_boundary_ms,
                    context_side,
                    &v2_boundary_refinement_config(source_input, target_input),
                    cancel_flag,
                )
            }
            Some(_) => unreachable!("edit_context only contains single-axis spans"),
            None => refine_boundary_by_correlation_with_cancel(
                source_pcm,
                target_pcm,
                source_boundary_ms,
                target_boundary_ms,
                &v2_boundary_refinement_config(source_input, target_input),
                cancel_flag,
            ),
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if let Some((edit_index, _, edit_kind, context_side)) = edit_context {
                    summary.evidence_notes.push(format!(
                        "{} span #{} 的{}边界精修失败：{}",
                        format_v2_span_kind(edit_kind),
                        edit_index + 1,
                        format_v2_context_side(context_side),
                        redact_sensitive_media_text(&error)
                    ));
                } else {
                    non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
                }
                continue;
            }
        };
        summary.max_uncertainty_ms = Some(
            summary
                .max_uncertainty_ms
                .unwrap_or(0)
                .max(result.uncertainty_ms.max(0) as u64),
        );
        if result.ambiguous {
            if let Some((edit_index, _, edit_kind, context_side)) = edit_context {
                summary.evidence_notes.push(format!(
                    "{} span #{} 的{}边界存在多个相关峰：corr {:.3}，margin {:.3}，候选范围 [{}，{}] ms。",
                    format_v2_span_kind(edit_kind),
                    edit_index + 1,
                    format_v2_context_side(context_side),
                    result.best_correlation,
                    result.alternative_margin,
                    result.uncertainty_start_ms,
                    result.uncertainty_end_ms
                ));
            } else {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
            continue;
        }
        let Ok(refined_axis_ms) = u64::try_from(result.refined_target_boundary_ms) else {
            if edit_context.is_none() {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
            continue;
        };
        let refine_source_axis =
            edit_context.is_some_and(|(_, _, kind, _)| kind == AudioTimeMapSpanKind::SourceOnly);
        let (old_left_end, old_right_start) = if refine_source_axis {
            let old = (
                spans[boundary_index - 1].source_end_ms,
                spans[boundary_index].source_start_ms,
            );
            spans[boundary_index - 1].source_end_ms = refined_axis_ms;
            spans[boundary_index].source_start_ms = refined_axis_ms;
            old
        } else {
            let old = (
                spans[boundary_index - 1].target_end_ms,
                spans[boundary_index].target_start_ms,
            );
            spans[boundary_index - 1].target_end_ms = refined_axis_ms;
            spans[boundary_index].target_start_ms = refined_axis_ms;
            old
        };
        if validate_v2_time_map_spans(spans).is_ok() {
            summary.refined_count += 1;
            if let Some((edit_index, edit_side, edit_kind, context_side)) = edit_context {
                edit_side_refined[edit_index][edit_side] = true;
                summary.evidence_notes.push(format!(
                    "{} span #{} 的{}边界已用{}单侧共同音频精修：{} -> {} ms，不确定范围 [{}，{}] ms（corr {:.3}，margin {:.3}）。",
                    format_v2_span_kind(edit_kind),
                    edit_index + 1,
                    if edit_side == 0 { "起始" } else { "结束" },
                    format_v2_context_side(context_side),
                    result.coarse_target_boundary_ms,
                    result.refined_target_boundary_ms,
                    result.uncertainty_start_ms,
                    result.uncertainty_end_ms,
                    result.best_correlation,
                    result.alternative_margin
                ));
            }
        } else {
            if refine_source_axis {
                spans[boundary_index - 1].source_end_ms = old_left_end;
                spans[boundary_index].source_start_ms = old_right_start;
            } else {
                spans[boundary_index - 1].target_end_ms = old_left_end;
                spans[boundary_index].target_start_ms = old_right_start;
            }
            if edit_context.is_none() {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
        }
    }
    for (span_index, span) in spans.iter().enumerate() {
        if !is_v2_edit_span(span.kind) {
            continue;
        }
        for (side_index, refined) in edit_side_refined[span_index].iter().enumerate() {
            if !refined {
                summary.ambiguous_count = summary.ambiguous_count.saturating_add(1);
                summary.evidence_notes.push(format!(
                    "{} span #{} 缺少可靠的{}侧共同音频边界证据；不会把粗 DP 边界冒充精确时间。",
                    format_v2_span_kind(span.kind),
                    span_index + 1,
                    if side_index == 0 {
                        "删减前"
                    } else {
                        "删减后"
                    }
                ));
            }
        }
    }
    summary.ambiguous_count = summary
        .ambiguous_count
        .saturating_add(non_edit_ambiguity_count);
    if summary.max_uncertainty_ms.is_none() && !spans.iter().any(|span| is_v2_edit_span(span.kind))
    {
        summary.max_uncertainty_ms = Some(0);
    }
    summary
}

fn is_v2_edit_span(kind: AudioTimeMapSpanKind) -> bool {
    matches!(
        kind,
        AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
    )
}

fn v2_boundary_refinement_config(
    fixed_input: &AlignmentAudioInput,
    searched_input: &AlignmentAudioInput,
) -> BoundaryRefinementConfig {
    BoundaryRefinementConfig {
        sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
        source_presentation_offset_ms: v2_normalized_pcm_origin_ms(fixed_input),
        target_presentation_offset_ms: v2_normalized_pcm_origin_ms(searched_input),
        search_radius_ms: 500,
        window_ms: 300,
        score_tolerance: 0.01,
        min_correlation: 0.50,
        min_alternative_margin: 0.005,
        max_uncertainty_ms: 150,
    }
}

fn format_v2_span_kind(kind: AudioTimeMapSpanKind) -> &'static str {
    match kind {
        AudioTimeMapSpanKind::Matched => "matched",
        AudioTimeMapSpanKind::SourceOnly => "sourceOnly",
        AudioTimeMapSpanKind::TargetOnly => "targetOnly",
        AudioTimeMapSpanKind::Ambiguous => "ambiguous",
    }
}

fn format_v2_context_side(side: BoundaryContextSide) -> &'static str {
    match side {
        BoundaryContextSide::Before => "删减前",
        BoundaryContextSide::After => "删减后",
    }
}

#[allow(clippy::too_many_arguments)]
fn create_v2_alignment_proposal(
    alignment: V2ChunkAlignment,
    boundary: V2BoundarySummary,
    pair: V2TrackPairCandidate,
    top1_top2_margin: f64,
    selected_track_reason: String,
    alternatives: Vec<AudioAlternativeTrackScoreDto>,
    mut diagnostics: Vec<String>,
) -> AudioAlignmentProposal {
    let source_start_ms = alignment
        .spans
        .first()
        .map(|span| span.source_start_ms)
        .unwrap_or(0);
    let source_end_ms = alignment
        .spans
        .last()
        .map(|span| span.source_end_ms)
        .unwrap_or(source_start_ms);
    let target_start_ms = alignment
        .spans
        .first()
        .map(|span| span.target_start_ms)
        .unwrap_or(0);
    let target_end_ms = alignment
        .spans
        .last()
        .map(|span| span.target_end_ms)
        .unwrap_or(target_start_ms);
    let target_duration_ms = target_end_ms.saturating_sub(target_start_ms).max(1);
    let matched_target_ms = alignment
        .spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
        .map(|span| span.target_end_ms.saturating_sub(span.target_start_ms))
        .sum::<u64>();
    let coverage = (matched_target_ms as f64 / target_duration_ms as f64).clamp(0.0, 1.0);
    let ambiguous_span_count = alignment
        .spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Ambiguous)
        .count();
    let catastrophic = coverage < 0.50
        || pair.hypothesis.p95_residual_ms > 400
        || pair.hypothesis.max_residual_ms > 1_000;
    let blocked = catastrophic
        || ambiguous_span_count > 0
        || alignment.matched_step_count == 0
        || top1_top2_margin < ALIGNMENT_V2_MIN_TRACK_MARGIN
        || boundary.ambiguous_count > 0;
    let quality_level = if blocked { "blocked" } else { "review" };
    let mut quality_reasons = Vec::new();
    if catastrophic {
        quality_reasons.push(format!(
            "灾难性门控：coverage {:.3}、P95 {} ms、max {} ms。",
            coverage, pair.hypothesis.p95_residual_ms, pair.hypothesis.max_residual_ms
        ));
    }
    if ambiguous_span_count > 0 {
        quality_reasons.push(format!(
            "细对齐包含 {ambiguous_span_count} 个 ambiguous span，不能自动投影。"
        ));
    }
    if alignment.matched_step_count == 0 {
        quality_reasons.push("细对齐没有 matched step。".to_string());
    }
    if top1_top2_margin < ALIGNMENT_V2_MIN_TRACK_MARGIN {
        quality_reasons.push(format!(
            "Top1/Top2 margin {:.3} 低于 {:.3}，音轨或重复内容假设仍有歧义。",
            top1_top2_margin, ALIGNMENT_V2_MIN_TRACK_MARGIN
        ));
    }
    if boundary.ambiguous_count > 0 {
        quality_reasons.push(format!(
            "{} 个局部边界没有唯一、稳定的相关峰，边界精度仍有歧义。",
            boundary.ambiguous_count
        ));
    }
    if !blocked {
        quality_reasons
            .push("真实媒体冻结集和概率校准尚未完成；该结果最高只能进入人工复核。".to_string());
    }
    diagnostics.push(format!(
        "Alignment V2 输出 {} 个 span（matched steps {}，ambiguous steps {}），目标覆盖率 {:.1}%。",
        alignment.spans.len(),
        alignment.matched_step_count,
        alignment.ambiguous_step_count,
        coverage * 100.0
    ));
    diagnostics.push(format!(
        "Affine：scale {:.8}，offset {:+} ms，内点 {}，P50/P95/max={}/{}/{} ms。",
        pair.hypothesis.scale,
        pair.hypothesis.offset_ms,
        pair.hypothesis.inlier_count,
        pair.hypothesis.p50_residual_ms,
        pair.hypothesis.p95_residual_ms,
        pair.hypothesis.max_residual_ms
    ));
    diagnostics.extend(quality_reasons.clone());
    let anchors =
        create_v2_compatibility_anchors(&alignment.spans, pair.hypothesis.p95_residual_ms, blocked);
    let cut_candidates = create_v2_compatibility_cut_candidates(&alignment.spans, blocked);
    let parameters_hash = create_v2_parameters_hash(&pair.source_input, &pair.target_input);
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans: alignment.spans.clone(),
        quality: AudioTimeMapQualityDto {
            level: quality_level,
            metric_source: "measured",
            probability: None,
            coverage: Some(coverage),
            p50_residual_ms: Some(pair.hypothesis.p50_residual_ms.max(0) as u64),
            p95_residual_ms: Some(pair.hypothesis.p95_residual_ms.max(0) as u64),
            max_residual_ms: Some(pair.hypothesis.max_residual_ms.max(0) as u64),
            boundary_uncertainty_ms: boundary.max_uncertainty_ms,
            alternative_margin: Some(top1_top2_margin),
            anchor_count: pair.hypothesis.inlier_count,
            held_out_anchor_count: 0,
            reasons: quality_reasons,
        },
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["audio"],
            audio_anchor_count: pair.hypothesis.inlier_count,
            visual_anchor_count: 0,
            held_out_anchor_count: 0,
            top1_top2_margin: Some(top1_top2_margin),
            unique_content_coverage: Some(pair.hypothesis.unique_source_coverage.clamp(0.0, 1.0)),
            repeated_content_only: pair.repeated_content_only,
            selected_track_reason,
            alternative_track_scores: alternatives,
            notes: diagnostics.clone(),
        },
        source_stream: Some(v2_stream_identity(&pair.source_input.stream)),
        target_stream: Some(v2_stream_identity(&pair.target_input.stream)),
        source_visual_stream: None,
        target_visual_stream: None,
        source_identity: pair.source_input.content_identity.clone(),
        target_identity: pair.target_input.content_identity.clone(),
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version: ALIGNMENT_V2_FEATURE_VERSION,
        parameters_hash,
    };
    let strong_anchor_count = anchors
        .iter()
        .filter(|anchor| anchor.confidence >= 0.7)
        .count();
    AudioAlignmentProposal {
        anchors,
        cut_candidates,
        confidence: if blocked { 0.0 } else { coverage },
        diagnostics,
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-edit-map".to_string(),
            complete_fingerprint_count: pair.target_landmark_count,
            source_fingerprint_count: pair.source_landmark_count,
            fingerprint_match_count: pair.observation_count,
            monotonic_match_count: pair.hypothesis.inlier_count,
            strong_anchor_count,
            weak_anchor_count: pair
                .hypothesis
                .inlier_count
                .saturating_sub(strong_anchor_count),
            offset_cluster_count: 1,
            refined_candidate_count: boundary.refined_count,
            low_confidence_region_count: ambiguous_span_count
                + boundary.ambiguous_count
                + usize::from(catastrophic),
            quality: if blocked { "blocked" } else { "medium" }.to_string(),
            time_mapping_segment_count: Some(alignment.spans.len()),
            confirmed_change_count: Some(
                alignment
                    .spans
                    .iter()
                    .filter(|span| {
                        matches!(
                            span.kind,
                            AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
                        )
                    })
                    .count(),
            ),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "used",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: pair.hypothesis.inlier_count,
                weight: 1.0,
                note: "单一音频证据，必须人工复核。".to_string(),
            }]),
        }),
        match_range: Some(AlignmentMatchRange {
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
            coverage,
        }),
        time_map: Some(time_map),
    }
}

fn create_v2_compatibility_anchors(
    spans: &[AudioTimeMapSpanDto],
    p95_residual_ms: i64,
    blocked: bool,
) -> Vec<SyncAnchorDto> {
    if blocked {
        return Vec::new();
    }
    let confidence = (1.0 - p95_residual_ms.max(0) as f64 / 500.0).clamp(0.25, 0.85);
    let mut points = Vec::new();
    for span in spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
    {
        points.push((span.source_start_ms, span.target_start_ms));
        points.push((span.source_end_ms, span.target_end_ms));
    }
    points.sort_unstable();
    points.dedup();
    points
        .into_iter()
        .take(200)
        .enumerate()
        .map(|(index, (source_ms, target_ms))| SyncAnchorDto {
            id: format!("alignment-v2-anchor-{}", index + 1),
            source_ms,
            target_ms,
            confidence,
            origin: "automatic",
        })
        .collect()
}

fn create_v2_compatibility_cut_candidates(
    spans: &[AudioTimeMapSpanDto],
    blocked: bool,
) -> Vec<CutCandidateDto> {
    if blocked {
        return Vec::new();
    }
    spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::TargetOnly)
        .enumerate()
        .map(|(index, span)| CutCandidateDto {
            id: format!("alignment-v2-gap-{}", index + 1),
            name: format!("V2 目标独有段 {}", index + 1),
            source_at_ms: span.source_start_ms,
            source_range_start_ms: span.source_start_ms,
            source_range_end_ms: span.source_end_ms,
            target_gap_ms: span.target_end_ms.saturating_sub(span.target_start_ms),
            confidence: 0.65,
            note: "由 V2 targetOnly span 兼容派生；正式结论以 timeMap 为准。".to_string(),
        })
        .collect()
}

fn create_blocked_v2_proposal(
    reason: &str,
    source_input: Option<&AlignmentAudioInput>,
    target_input: Option<&AlignmentAudioInput>,
    margin: Option<f64>,
    alternatives: Vec<AudioAlternativeTrackScoreDto>,
    mut notes: Vec<String>,
) -> AudioAlignmentProposal {
    benchmark_stage("reporting", "生成阻断型 Alignment V2 复核证据");
    notes.push(reason.to_string());
    let selected_track_reason = match (source_input, target_input) {
        (Some(source), Some(target)) => format!(
            "候选 B 站参考音轨 #{}、目标原片音轨 #{} 未通过质量门控。",
            source.stream.stream_index, target.stream.stream_index
        ),
        _ => "没有可形成主结论的音轨组合。".to_string(),
    };
    notes.push(selected_track_reason);
    if let Some(margin) = margin {
        notes.push(format!("阻断时 Top1/Top2 margin 为 {margin:.3}。"));
    }
    if !alternatives.is_empty() {
        notes.push(format!(
            "已保留 {} 个候选音轨组合分数；因没有合法定位范围，不生成 timeMap。",
            alternatives.len()
        ));
    }
    AudioAlignmentProposal {
        anchors: Vec::new(),
        cut_candidates: Vec::new(),
        confidence: 0.0,
        diagnostics: notes.clone(),
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-edit-map".to_string(),
            complete_fingerprint_count: 0,
            source_fingerprint_count: 0,
            fingerprint_match_count: 0,
            monotonic_match_count: 0,
            strong_anchor_count: 0,
            weak_anchor_count: 0,
            offset_cluster_count: 0,
            refined_candidate_count: 0,
            low_confidence_region_count: 1,
            quality: "blocked".to_string(),
            time_mapping_segment_count: Some(0),
            confirmed_change_count: Some(0),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "blocked",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: 0,
                weight: 0.0,
                note: reason.to_string(),
            }]),
        }),
        match_range: None,
        time_map: None,
    }
}

fn create_blocked_v2_affine_proposal(
    reason: &str,
    pair: &V2TrackPairCandidate,
    margin: f64,
    alternatives: Vec<AudioAlternativeTrackScoreDto>,
    notes: Vec<String>,
) -> AudioAlignmentProposal {
    benchmark_stage("reporting", "生成仿射阻断型复核证据");
    let mut proposal = create_blocked_v2_proposal(
        reason,
        Some(&pair.source_input),
        Some(&pair.target_input),
        Some(margin),
        alternatives.clone(),
        notes,
    );
    let (source_start_ms, source_end_ms, target_start_ms, target_end_ms) =
        create_blocked_affine_bounds(pair);
    let selected_track_reason = format!(
        "已定位 B 站参考音轨 #{} 与目标原片音轨 #{}，但结果被质量门控阻断。",
        pair.source_input.stream.stream_index, pair.target_input.stream.stream_index
    );
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans: vec![AudioTimeMapSpanDto {
            kind: AudioTimeMapSpanKind::Ambiguous,
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
        }],
        quality: AudioTimeMapQualityDto {
            level: "blocked",
            metric_source: "measured",
            probability: None,
            coverage: Some(pair.temporal_coverage.clamp(0.0, 1.0)),
            p50_residual_ms: Some(pair.hypothesis.p50_residual_ms.max(0) as u64),
            p95_residual_ms: Some(pair.hypothesis.p95_residual_ms.max(0) as u64),
            max_residual_ms: Some(pair.hypothesis.max_residual_ms.max(0) as u64),
            boundary_uncertainty_ms: None,
            alternative_margin: Some(margin),
            anchor_count: pair.hypothesis.inlier_count,
            held_out_anchor_count: 0,
            reasons: vec![reason.to_string()],
        },
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["audio"],
            audio_anchor_count: pair.hypothesis.inlier_count,
            visual_anchor_count: 0,
            held_out_anchor_count: 0,
            top1_top2_margin: Some(margin),
            unique_content_coverage: Some(pair.hypothesis.unique_source_coverage.clamp(0.0, 1.0)),
            repeated_content_only: pair.repeated_content_only,
            selected_track_reason,
            alternative_track_scores: alternatives,
            notes: proposal.diagnostics.clone(),
        },
        source_stream: Some(v2_stream_identity(&pair.source_input.stream)),
        target_stream: Some(v2_stream_identity(&pair.target_input.stream)),
        source_visual_stream: None,
        target_visual_stream: None,
        source_identity: pair.source_input.content_identity.clone(),
        target_identity: pair.target_input.content_identity.clone(),
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version: ALIGNMENT_V2_FEATURE_VERSION,
        parameters_hash: create_v2_parameters_hash(&pair.source_input, &pair.target_input),
    };
    proposal.match_range = Some(AlignmentMatchRange {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        coverage: pair.temporal_coverage.clamp(0.0, 1.0),
    });
    proposal.time_map = Some(time_map);
    proposal
}

fn create_blocked_affine_bounds(pair: &V2TrackPairCandidate) -> (u64, u64, u64, u64) {
    let mut target_start = pair.target_input.stream.timeline_offset_ms.max(0);
    let mut target_end = pair
        .target_input
        .media_duration_ms
        .and_then(|duration| i64::try_from(duration).ok())
        .map(|duration| target_start.saturating_add(duration))
        .unwrap_or_else(|| {
            (pair.hypothesis.scale * pair.hypothesis.source_end_ms as f64
                + pair.hypothesis.offset_ms as f64)
                .round() as i64
        });
    if target_end <= target_start {
        target_start = (pair.hypothesis.scale * pair.hypothesis.source_start_ms as f64
            + pair.hypothesis.offset_ms as f64)
            .round()
            .max(0.0) as i64;
        target_end = (pair.hypothesis.scale * pair.hypothesis.source_end_ms as f64
            + pair.hypothesis.offset_ms as f64)
            .round()
            .max((target_start + ALIGNMENT_V2_FINE_HOP_MS as i64) as f64)
            as i64;
    }
    let source_start = ((target_start - pair.hypothesis.offset_ms) as f64 / pair.hypothesis.scale)
        .floor()
        .max(0.0) as u64;
    let source_end = ((target_end - pair.hypothesis.offset_ms) as f64 / pair.hypothesis.scale)
        .ceil()
        .max(source_start as f64 + ALIGNMENT_V2_FINE_HOP_MS as f64) as u64;
    (
        source_start,
        source_end,
        target_start.max(0) as u64,
        target_end.max(target_start + 1) as u64,
    )
}

fn v2_stream_identity(stream: &AudioStreamProbe) -> AudioTimeMapStreamIdentityDto {
    AudioTimeMapStreamIdentityDto {
        stream_type: "audio",
        index: stream.stream_index,
        codec: stream.codec_name.clone(),
        start_ms: Some(stream.start_time_ms),
        timeline_offset_ms: Some(stream.timeline_offset_ms),
        time_base: stream.time_base.clone(),
        sample_rate: stream.sample_rate,
        channels: stream.channels,
        frame_rate: None,
        language: stream.language.clone(),
        title: stream.title.clone(),
    }
}

fn v2_video_stream_identity(stream: &VideoStreamProbe) -> AudioTimeMapStreamIdentityDto {
    AudioTimeMapStreamIdentityDto {
        stream_type: "video",
        index: stream.stream_index,
        codec: stream.codec_name.clone(),
        start_ms: Some(stream.start_time_ms),
        timeline_offset_ms: Some(stream.timeline_offset_ms),
        time_base: stream.time_base.clone(),
        sample_rate: None,
        channels: None,
        frame_rate: stream.frame_rate,
        language: stream.language.clone(),
        title: stream.title.clone(),
    }
}

fn try_v2_visual_fallback(
    request: &AudioAlignmentRequest,
    options: &AudioAlignmentOptions,
    audio_reason: &str,
    mut notes: Vec<String>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AudioAlignmentProposal, String> {
    benchmark_stage("extracting-visual", "执行独立视觉定位回退");
    check_cancelled(cancel_flag)?;
    ensure_alignment_process_supervision_clean()?;
    notes.push(format!("音频主路径已阻断：{audio_reason}"));
    let source_input = match probe_alignment_visual_input(
        &request.source_path,
        "B 站参考",
        request.source_video_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(input) => input,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if error == AUDIO_ALIGNMENT_CANCELLED || is_media_identity_guard_error(&error) {
                return Err(error);
            }
            return Ok(create_blocked_visual_fallback_without_map(
                audio_reason,
                &format!("B 站参考视觉不可用：{}", truncate_visual_note(&error)),
                notes,
            ));
        }
    };
    let target_input = match probe_alignment_visual_input(
        &request.complete_path,
        "目标原片",
        request.complete_video_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(input) => input,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if error == AUDIO_ALIGNMENT_CANCELLED || is_media_identity_guard_error(&error) {
                return Err(error);
            }
            return Ok(create_blocked_visual_fallback_without_map(
                audio_reason,
                &format!("目标原片视觉不可用：{}", truncate_visual_note(&error)),
                notes,
            ));
        }
    };
    let source_features = match get_v2_visual_features(
        &request.source_path,
        "B 站参考",
        options,
        &source_input,
        cancel_flag,
    ) {
        Ok(features) => features,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if error == AUDIO_ALIGNMENT_CANCELLED || is_media_identity_guard_error(&error) {
                return Err(error);
            }
            return Ok(create_blocked_visual_fallback_without_map(
                audio_reason,
                &format!("B 站参考视觉特征不可用：{}", truncate_visual_note(&error)),
                notes,
            ));
        }
    };
    let target_features = match get_v2_visual_features(
        &request.complete_path,
        "目标原片",
        options,
        &target_input,
        cancel_flag,
    ) {
        Ok(features) => features,
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            if error == AUDIO_ALIGNMENT_CANCELLED || is_media_identity_guard_error(&error) {
                return Err(error);
            }
            return Ok(create_blocked_visual_fallback_without_map(
                audio_reason,
                &format!("目标原片视觉特征不可用：{}", truncate_visual_note(&error)),
                notes,
            ));
        }
    };
    let result = match_visual_features_affine(
        &source_features.frames,
        &target_features.frames,
        cancel_flag,
    )?;
    notes.push(format!(
        "独立视觉回退：参考/目标有效帧 {}/{}，外观候选 {}，缓存参考{}、目标{}。",
        result.informative_source_count,
        result.informative_target_count,
        result.candidate_count,
        if source_features.cache_hit {
            "命中"
        } else {
            "新提取"
        },
        if target_features.cache_hit {
            "命中"
        } else {
            "新提取"
        },
    ));
    Ok(create_visual_affine_fallback_proposal(
        audio_reason,
        &source_input,
        &target_input,
        &source_features.frames,
        &target_features.frames,
        result,
        notes,
        options,
    ))
}

fn create_blocked_visual_fallback_without_map(
    audio_reason: &str,
    visual_reason: &str,
    mut notes: Vec<String>,
) -> AudioAlignmentProposal {
    benchmark_stage("reporting", "生成视觉回退阻断证据");
    notes.push(visual_reason.to_string());
    let mut proposal =
        create_blocked_v2_proposal(audio_reason, None, None, None, Vec::new(), notes);
    if let Some(evidence) = &mut proposal.evidence {
        evidence.algorithm = "alignment-v2-visual-fallback".to_string();
    }
    replace_visual_evidence_signal(
        &mut proposal,
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "blocked",
            label: "V2 独立视觉仿射回退",
            observations: 0,
            weight: 0.0,
            note: visual_reason.to_string(),
        },
    );
    proposal
}

#[allow(clippy::too_many_arguments)]
fn create_visual_affine_fallback_proposal(
    audio_reason: &str,
    source_input: &AlignmentVisualInput,
    target_input: &AlignmentVisualInput,
    source_frames: &[VisualFeatureFrame],
    target_frames: &[VisualFeatureFrame],
    result: VisualAffineMatchResult,
    mut diagnostics: Vec<String>,
    options: &AudioAlignmentOptions,
) -> AudioAlignmentProposal {
    benchmark_stage("reporting", "生成独立视觉定位复核证据");
    let Some(best) = result.hypotheses.first() else {
        let reason = if result.informative_source_count < ALIGNMENT_V2_VISUAL_MIN_INLIERS
            || result.informative_target_count < ALIGNMENT_V2_VISUAL_MIN_INLIERS
        {
            "画面信息量过低，未达到独立视觉定位的最小有效帧数。"
        } else {
            "视觉外观候选未形成满足 scale 0.94–1.06 的单调仿射假设。"
        };
        return create_blocked_visual_fallback_without_map(audio_reason, reason, diagnostics);
    };
    diagnostics.push(format!(
        "视觉 Top-K：{}。",
        result
            .hypotheses
            .iter()
            .map(|item| format!(
                "scale={:.6},offset={:+},inliers={},coverage={:.3},span={:.3},distance={:.3},score={:.3}",
                item.scale,
                item.offset_ms,
                item.matches.len(),
                item.coverage,
                item.temporal_span_coverage,
                item.mean_distance,
                item.score,
            ))
            .collect::<Vec<_>>()
            .join("；")
    ));
    let interval_ms = estimate_visual_frame_step_ms(source_frames)
        .max(estimate_visual_frame_step_ms(target_frames));
    let full_source_bounds = visual_stream_domain(source_input, source_frames, interval_ms);
    let full_target_bounds = visual_stream_domain(target_input, target_frames, interval_ms);
    let mapped_full_target_start =
        visual_affine_map_time(best, full_source_bounds.0).unwrap_or(u64::MAX);
    let mapped_full_target_end =
        visual_affine_map_time(best, full_source_bounds.1).unwrap_or(u64::MAX);
    let mapping_inside_target = mapped_full_target_start.saturating_add(interval_ms)
        >= full_target_bounds.0
        && mapped_full_target_end <= full_target_bounds.1.saturating_add(interval_ms)
        && mapped_full_target_end > mapped_full_target_start;
    let passes_evidence_gate = best.matches.len() >= ALIGNMENT_V2_VISUAL_MIN_INLIERS
        && best.coverage >= ALIGNMENT_V2_VISUAL_MIN_COVERAGE
        && best.temporal_span_coverage >= ALIGNMENT_V2_VISUAL_MIN_COVERAGE
        && result.top1_top2_margin >= ALIGNMENT_V2_VISUAL_MIN_MARGIN
        && mapping_inside_target;
    let repeated_content_only = result.top1_top2_margin < ALIGNMENT_V2_VISUAL_MIN_MARGIN
        && result.hypotheses.get(1).is_some_and(|alternative| {
            alternative.matches.len() * 4 >= best.matches.len() * 3
                && alternative.offset_ms.abs_diff(best.offset_ms) > interval_ms.saturating_mul(2)
        });
    let (source_start_ms, source_end_ms, target_start_ms, target_end_ms) = if passes_evidence_gate {
        (
            full_source_bounds.0,
            full_source_bounds.1,
            mapped_full_target_start,
            mapped_full_target_end,
        )
    } else {
        visual_observed_bounds(best, interval_ms)
    };
    let quality_level = if passes_evidence_gate {
        "review"
    } else {
        "blocked"
    };
    let span_kind = if passes_evidence_gate {
        AudioTimeMapSpanKind::Matched
    } else {
        AudioTimeMapSpanKind::Ambiguous
    };
    let mut quality_reasons = vec![
        "视觉回退是稀疏仿射定位，只能确认粗粒度时间关系，不能宣称精确删减边界。".to_string(),
        "真实媒体冻结集和概率校准尚未完成；视觉结果最高只能进入人工复核。".to_string(),
    ];
    if best.coverage < ALIGNMENT_V2_VISUAL_MIN_COVERAGE
        || best.temporal_span_coverage < ALIGNMENT_V2_VISUAL_MIN_COVERAGE
    {
        quality_reasons.push(format!(
            "视觉覆盖不足：有效帧覆盖 {:.3}，时间跨度覆盖 {:.3}。",
            best.coverage, best.temporal_span_coverage
        ));
    }
    if result.top1_top2_margin < ALIGNMENT_V2_VISUAL_MIN_MARGIN {
        quality_reasons.push(format!(
            "重复片头或重复画面仍有竞争位置：Top1/Top2 margin {:.3} 低于 {:.3}。",
            result.top1_top2_margin, ALIGNMENT_V2_VISUAL_MIN_MARGIN
        ));
    }
    if !mapping_inside_target {
        quality_reasons.push("视觉仿射外推超出目标视频展示时间域。".to_string());
    }
    diagnostics.extend(quality_reasons.clone());
    let anchors = if passes_evidence_gate {
        let stride = best.matches.len().div_ceil(120).max(1);
        best.matches
            .iter()
            .step_by(stride)
            .enumerate()
            .map(|(index, item)| SyncAnchorDto {
                id: format!("alignment-v2-visual-anchor-{}", index + 1),
                source_ms: item.source_time_ms,
                target_ms: item.target_time_ms,
                confidence: (0.45 + best.coverage * 0.25).min(0.70),
                origin: "automatic",
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let parameters_hash =
        create_v2_visual_parameters_hash(source_input, target_input, options, interval_ms);
    let selected_reason = format!(
        "音频不可用后，独立视觉选择参考视频流 #{} → 目标视频流 #{}；Top1/Top2 margin {:.3}。",
        source_input.stream.stream_index, target_input.stream.stream_index, result.top1_top2_margin
    );
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans: vec![AudioTimeMapSpanDto {
            kind: span_kind,
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
        }],
        quality: AudioTimeMapQualityDto {
            level: quality_level,
            metric_source: "measured",
            probability: None,
            coverage: Some(best.coverage.min(best.temporal_span_coverage)),
            p50_residual_ms: Some(best.p50_residual_ms),
            p95_residual_ms: Some(best.p95_residual_ms),
            max_residual_ms: Some(best.max_residual_ms),
            boundary_uncertainty_ms: Some(interval_ms.saturating_mul(2)),
            alternative_margin: Some(result.top1_top2_margin),
            anchor_count: best.matches.len(),
            held_out_anchor_count: 0,
            reasons: quality_reasons,
        },
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["visual"],
            audio_anchor_count: 0,
            visual_anchor_count: best.matches.len(),
            held_out_anchor_count: 0,
            top1_top2_margin: Some(result.top1_top2_margin),
            unique_content_coverage: Some(
                best.coverage
                    .min(best.temporal_span_coverage)
                    .clamp(0.0, 1.0),
            ),
            repeated_content_only,
            selected_track_reason: selected_reason.clone(),
            alternative_track_scores: Vec::new(),
            notes: diagnostics.clone(),
        },
        source_stream: Some(v2_video_stream_identity(&source_input.stream)),
        target_stream: Some(v2_video_stream_identity(&target_input.stream)),
        source_visual_stream: Some(v2_video_stream_identity(&source_input.stream)),
        target_visual_stream: Some(v2_video_stream_identity(&target_input.stream)),
        source_identity: source_input.content_identity.clone(),
        target_identity: target_input.content_identity.clone(),
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version: ALIGNMENT_V2_VISUAL_FEATURE_VERSION,
        parameters_hash,
    };
    let visual_signal = AlignmentEvidenceSignalSummary {
        kind: "visual",
        status: if passes_evidence_gate {
            "used"
        } else {
            "blocked"
        },
        label: "V2 独立视觉仿射回退",
        observations: best.matches.len(),
        weight: if passes_evidence_gate { 1.0 } else { 0.0 },
        note: if passes_evidence_gate {
            "视觉仅提供粗粒度仿射定位；稀疏采样不用于断言精确删减边界。".to_string()
        } else {
            "视觉候选因覆盖、重复位置 margin 或时间域门控不足而阻断。".to_string()
        },
    };
    AudioAlignmentProposal {
        anchors,
        cut_candidates: Vec::new(),
        confidence: if passes_evidence_gate {
            (best.coverage * 0.7).min(0.7)
        } else {
            0.0
        },
        diagnostics: diagnostics.clone(),
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-visual-affine-fallback".to_string(),
            complete_fingerprint_count: result.informative_target_count,
            source_fingerprint_count: result.informative_source_count,
            fingerprint_match_count: result.candidate_count,
            monotonic_match_count: best.matches.len(),
            strong_anchor_count: if passes_evidence_gate {
                best.matches.len()
            } else {
                0
            },
            weak_anchor_count: if passes_evidence_gate {
                0
            } else {
                best.matches.len()
            },
            offset_cluster_count: result.hypotheses.len(),
            refined_candidate_count: 0,
            low_confidence_region_count: usize::from(!passes_evidence_gate),
            quality: if passes_evidence_gate {
                "medium"
            } else {
                "blocked"
            }
            .to_string(),
            time_mapping_segment_count: Some(1),
            confirmed_change_count: Some(0),
            signals: Some(vec![
                AlignmentEvidenceSignalSummary {
                    kind: "audio",
                    status: "blocked",
                    label: "Alignment V2 landmark + edit-aware DP",
                    observations: 0,
                    weight: 0.0,
                    note: audio_reason.to_string(),
                },
                visual_signal,
            ]),
        }),
        match_range: Some(AlignmentMatchRange {
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
            coverage: best.coverage.min(best.temporal_span_coverage),
        }),
        time_map: Some(time_map),
    }
}

fn visual_stream_domain(
    input: &AlignmentVisualInput,
    frames: &[VisualFeatureFrame],
    interval_ms: u64,
) -> (u64, u64) {
    let start = input.stream.timeline_offset_ms.max(0) as u64;
    let end = input
        .stream
        .duration_ms
        .map(|duration| start.saturating_add(duration))
        .or(input.media_duration_ms)
        .or_else(|| {
            frames
                .last()
                .map(|frame| frame.time_ms.saturating_add(interval_ms))
        })
        .unwrap_or_else(|| start.saturating_add(interval_ms))
        .max(start.saturating_add(1));
    (start, end)
}

fn visual_affine_map_time(hypothesis: &VisualAffineHypothesis, source_ms: u64) -> Option<u64> {
    let target = hypothesis.scale * source_ms as f64 + hypothesis.offset_ms as f64;
    (target.is_finite() && target >= 0.0 && target <= u64::MAX as f64)
        .then_some(target.round() as u64)
}

fn visual_observed_bounds(
    hypothesis: &VisualAffineHypothesis,
    interval_ms: u64,
) -> (u64, u64, u64, u64) {
    let source_start = hypothesis
        .matches
        .first()
        .map(|item| item.source_time_ms)
        .unwrap_or(0);
    let source_end = hypothesis
        .matches
        .last()
        .map(|item| item.source_time_ms.saturating_add(interval_ms))
        .unwrap_or_else(|| source_start.saturating_add(interval_ms))
        .max(source_start.saturating_add(1));
    let target_start = visual_affine_map_time(hypothesis, source_start).unwrap_or(0);
    let target_end = visual_affine_map_time(hypothesis, source_end)
        .unwrap_or_else(|| target_start.saturating_add(1))
        .max(target_start.saturating_add(1));
    (source_start, source_end, target_start, target_end)
}

fn create_v2_visual_parameters_hash(
    source: &AlignmentVisualInput,
    target: &AlignmentVisualInput,
    options: &AudioAlignmentOptions,
    interval_ms: u64,
) -> String {
    let parameters = format!(
        "engine={ALIGNMENT_V2_ENGINE_VERSION}|feature={ALIGNMENT_V2_VISUAL_FEATURE_VERSION}|interval={interval_ms}|threshold={ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD}|scale=0.94:1.06|ffmpeg={}|source={:?}|target={:?}",
        options.ffmpeg_path,
        (
            source.stream.stream_index,
            source.presentation_origin_ms,
            source.stream.start_time_ms,
            source.stream.timeline_offset_ms,
            source.stream.time_base.as_deref(),
            source.content_identity.as_ref(),
        ),
        (
            target.stream.stream_index,
            target.presentation_origin_ms,
            target.stream.start_time_ms,
            target.stream.timeline_offset_ms,
            target.stream.time_base.as_deref(),
            target.content_identity.as_ref(),
        ),
    );
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in parameters.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn apply_v2_visual_validation(
    request: &AudioAlignmentRequest,
    options: &AudioAlignmentOptions,
    proposal: &mut AudioAlignmentProposal,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(), String> {
    check_cancelled(cancel_flag)?;
    let (expected_source_identity, expected_target_identity) =
        v2_time_map_media_identities_for_visual_validation(proposal)?;
    let source_input = match probe_alignment_visual_input(
        &request.source_path,
        "B 站参考",
        request.source_video_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(input) => input,
        Err(error) if is_media_identity_guard_error(&error) => return Err(error),
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            append_v2_visual_validation_unavailable(
                proposal,
                format!("参考视频视觉校验不可用：{}", truncate_visual_note(&error)),
            );
            return Ok(());
        }
    };
    let target_input = match probe_alignment_visual_input(
        &request.complete_path,
        "目标原片",
        request.complete_video_stream_index,
        options,
        cancel_flag,
    ) {
        Ok(input) => input,
        Err(error) if is_media_identity_guard_error(&error) => return Err(error),
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            append_v2_visual_validation_unavailable(
                proposal,
                format!("目标视频视觉校验不可用：{}", truncate_visual_note(&error)),
            );
            return Ok(());
        }
    };
    ensure_visual_input_matches_time_map_identity(
        &expected_source_identity,
        source_input.content_identity.as_ref(),
        "参考视频",
    )?;
    ensure_visual_input_matches_time_map_identity(
        &expected_target_identity,
        target_input.content_identity.as_ref(),
        "目标视频",
    )?;
    let source_features = match get_v2_visual_features(
        &request.source_path,
        "B 站参考",
        options,
        &source_input,
        cancel_flag,
    ) {
        Ok(features) => features,
        Err(error) if error == AUDIO_ALIGNMENT_CANCELLED => return Err(error),
        Err(error) if is_media_identity_guard_error(&error) => return Err(error),
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            append_v2_visual_validation_unavailable(
                proposal,
                format!("参考视频视觉校验提取失败：{}", truncate_visual_note(&error)),
            );
            return Ok(());
        }
    };
    let target_features = match get_v2_visual_features(
        &request.complete_path,
        "目标原片",
        options,
        &target_input,
        cancel_flag,
    ) {
        Ok(features) => features,
        Err(error) if error == AUDIO_ALIGNMENT_CANCELLED => return Err(error),
        Err(error) if is_media_identity_guard_error(&error) => return Err(error),
        Err(error) => {
            propagate_alignment_process_cleanup(&error)?;
            append_v2_visual_validation_unavailable(
                proposal,
                format!("目标视频视觉校验提取失败：{}", truncate_visual_note(&error)),
            );
            return Ok(());
        }
    };
    // Cache hits do not run FFmpeg and therefore need their own full-file recheck. Compare to the
    // audio timeMap identities, not merely the newly probed visual inputs, before attaching any
    // visual stream or evidence.
    verify_media_content_identity_after_tool_output(
        &request.source_path,
        Some(&expected_source_identity),
        cancel_flag,
        "视觉证据绑定复核",
    )?;
    verify_media_content_identity_after_tool_output(
        &request.complete_path,
        Some(&expected_target_identity),
        cancel_flag,
        "视觉证据绑定复核",
    )?;
    if let Some(time_map) = &mut proposal.time_map {
        time_map.source_visual_stream = Some(v2_video_stream_identity(&source_input.stream));
        time_map.target_visual_stream = Some(v2_video_stream_identity(&target_input.stream));
    }
    let Some(time_map) = proposal.time_map.as_ref() else {
        append_v2_visual_validation_unavailable(
            proposal,
            "音频路径没有可供视觉校验的 timeMap。".to_string(),
        );
        return Ok(());
    };
    let summary = summarize_v2_visual_time_map_validation(
        &source_features.frames,
        &target_features.frames,
        time_map,
        cancel_flag,
    )?;
    let Some(summary) = summary else {
        append_v2_visual_validation_unavailable(
            proposal,
            "视觉有效帧与音频 matched spans 的交集不足，未改变音频质量等级。".to_string(),
        );
        return Ok(());
    };
    let support_ratio = summary.supported_observations as f64 / summary.observations.max(1) as f64;
    let conflict = v2_visual_summary_is_conflict(&summary);
    let note = format!(
        "独立视觉校验：{} / {} 帧支持音频 timeMap，支持率 {:.1}%，平均距离 {:.3}。",
        summary.supported_observations,
        summary.observations,
        support_ratio * 100.0,
        summary.mean_distance
    );
    proposal.diagnostics.push(note.clone());
    if let Some(time_map) = &mut proposal.time_map {
        if !time_map.evidence.types.contains(&"visual") {
            time_map.evidence.types.push("visual");
        }
        time_map.evidence.visual_anchor_count = summary.supported_observations;
        time_map.evidence.notes.push(note.clone());
    }
    let signal = AlignmentEvidenceSignalSummary {
        kind: "visual",
        status: if conflict { "conflict" } else { "used" },
        label: "V2 独立视觉校验",
        observations: summary.observations,
        weight: if conflict { 0.0 } else { 0.25 },
        note: if conflict {
            format!("{note} 与音频映射明显冲突，已触发 blocked 否决。")
        } else {
            format!("{note} 视觉证据只校验，不提高质量等级。")
        },
    };
    replace_visual_evidence_signal(proposal, signal);
    if conflict {
        block_proposal_for_v2_visual_conflict(proposal);
    }
    Ok(())
}

fn v2_time_map_media_identities_for_visual_validation(
    proposal: &AudioAlignmentProposal,
) -> Result<(MediaContentIdentity, MediaContentIdentity), String> {
    let time_map = proposal.time_map.as_ref().ok_or_else(|| {
        "blocked:media-identity-missing：音频路径没有可绑定视觉证据的 timeMap。".to_string()
    })?;
    let source = require_full_file_media_content_identity(time_map.source_identity.as_ref())?;
    let target = require_full_file_media_content_identity(time_map.target_identity.as_ref())?;
    Ok((source.clone(), target.clone()))
}

fn ensure_visual_input_matches_time_map_identity(
    expected: &MediaContentIdentity,
    observed: Option<&MediaContentIdentity>,
    role: &str,
) -> Result<(), String> {
    let observed = require_full_file_media_content_identity(observed)?;
    if observed != expected {
        return Err(format!(
            "blocked:media-identity-changed：{role}视觉证据与音频 timeMap 的全文件身份不一致；拒绝混合证据。"
        ));
    }
    Ok(())
}

fn is_media_identity_guard_error(error: &str) -> bool {
    error.starts_with("blocked:media-identity-")
}

fn block_proposal_for_v2_visual_conflict(proposal: &mut AudioAlignmentProposal) {
    if let Some(time_map) = &mut proposal.time_map {
        time_map.quality.level = "blocked";
        time_map
            .quality
            .reasons
            .push("独立视觉采样与音频 timeMap 明显冲突；该映射已降级为 blocked。".to_string());
        time_map
            .evidence
            .notes
            .push("视觉只执行冲突否决，不会把音频结果升级为 verified。".to_string());
    }
    proposal.confidence = 0.0;
    proposal.anchors.clear();
    proposal.cut_candidates.clear();
    if let Some(evidence) = &mut proposal.evidence {
        evidence.quality = "blocked".to_string();
        evidence.low_confidence_region_count =
            evidence.low_confidence_region_count.saturating_add(1);
    }
    proposal
        .diagnostics
        .push("安全门控：音画冲突已清空兼容锚点与删减候选。".to_string());
}

fn v2_visual_summary_is_conflict(summary: &VisualTimeMappingEvidence) -> bool {
    let support_ratio = summary.supported_observations as f64 / summary.observations.max(1) as f64;
    summary.observations >= ALIGNMENT_V2_VISUAL_MIN_INLIERS
        && support_ratio < 0.25
        && summary.mean_distance > ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD
}

fn append_v2_visual_validation_unavailable(proposal: &mut AudioAlignmentProposal, note: String) {
    proposal.diagnostics.push(note.clone());
    replace_visual_evidence_signal(
        proposal,
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "blocked",
            label: "V2 独立视觉校验",
            observations: 0,
            weight: 0.0,
            note,
        },
    );
}

fn summarize_v2_visual_time_map_validation(
    source_frames: &[VisualFeatureFrame],
    target_frames: &[VisualFeatureFrame],
    time_map: &AudioAlignmentTimeMapDto,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Option<VisualTimeMappingEvidence>, String> {
    let source_indices = uniformly_sample_informative_visual_indices(source_frames);
    if source_indices.is_empty() || target_frames.is_empty() {
        return Ok(None);
    }
    let max_distance_ms = estimate_visual_frame_step_ms(source_frames)
        .max(estimate_visual_frame_step_ms(target_frames))
        .saturating_mul(2);
    let mut observations = 0usize;
    let mut supported_observations = 0usize;
    let mut total_distance = 0.0;
    for (position, source_index) in source_indices.into_iter().enumerate() {
        if position % 32 == 0 {
            check_cancelled(cancel_flag)?;
        }
        let source = &source_frames[source_index];
        let Some(mapped_target_ms) = map_source_time_through_v2_time_map(time_map, source.time_ms)
        else {
            continue;
        };
        let Some(target) = find_nearest_visual_frame_binary(target_frames, mapped_target_ms) else {
            continue;
        };
        if target.time_ms.abs_diff(mapped_target_ms) > max_distance_ms
            || visual_information_score(target) < ALIGNMENT_V2_VISUAL_MIN_INFORMATION
        {
            continue;
        }
        let distance = get_visual_feature_distance(source, target);
        observations += 1;
        total_distance += distance;
        if distance <= ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD {
            supported_observations += 1;
        }
    }
    if observations == 0 {
        return Ok(None);
    }
    Ok(Some(VisualTimeMappingEvidence {
        observations,
        supported_observations,
        mean_distance: total_distance / observations as f64,
    }))
}

fn map_source_time_through_v2_time_map(
    time_map: &AudioAlignmentTimeMapDto,
    source_ms: u64,
) -> Option<u64> {
    let span = time_map
        .spans
        .iter()
        .enumerate()
        .find_map(|(index, span)| {
            let contains = source_ms >= span.source_start_ms
                && (source_ms < span.source_end_ms
                    || (index + 1 == time_map.spans.len() && source_ms == span.source_end_ms));
            (contains && span.kind == AudioTimeMapSpanKind::Matched).then_some(span)
        })?;
    let source_duration = span.source_end_ms.checked_sub(span.source_start_ms)?;
    let target_duration = span.target_end_ms.checked_sub(span.target_start_ms)?;
    if source_duration == 0 {
        return None;
    }
    let relative = source_ms.saturating_sub(span.source_start_ms) as f64 / source_duration as f64;
    Some((span.target_start_ms as f64 + relative * target_duration as f64).round() as u64)
}

fn find_nearest_visual_frame_binary(
    frames: &[VisualFeatureFrame],
    time_ms: u64,
) -> Option<&VisualFeatureFrame> {
    if frames.is_empty() {
        return None;
    }
    let insertion = frames.partition_point(|frame| frame.time_ms < time_ms);
    match (insertion.checked_sub(1), frames.get(insertion)) {
        (Some(before), Some(after)) => {
            let before = &frames[before];
            if before.time_ms.abs_diff(time_ms) <= after.time_ms.abs_diff(time_ms) {
                Some(before)
            } else {
                Some(after)
            }
        }
        (Some(before), None) => frames.get(before),
        (None, Some(after)) => Some(after),
        (None, None) => None,
    }
}

fn create_v2_parameters_hash(source: &AlignmentAudioInput, target: &AlignmentAudioInput) -> String {
    create_v2_optional_parameters_hash(Some(source), Some(target))
}

fn create_v2_optional_parameters_hash(
    source: Option<&AlignmentAudioInput>,
    target: Option<&AlignmentAudioInput>,
) -> String {
    let parameters = format!(
        "engine={ALIGNMENT_V2_ENGINE_VERSION}|feature={ALIGNMENT_V2_FEATURE_VERSION}|sampleRate={ALIGNMENT_V2_SAMPLE_RATE}|landmarkHop={ALIGNMENT_V2_LANDMARK_HOP_MS}|fineHop={ALIGNMENT_V2_FINE_HOP_MS}|chunk={ALIGNMENT_V2_DP_CHUNK_MS}|band={ALIGNMENT_V2_DP_BAND_RADIUS_MS}|source={:?}|target={:?}",
        source.map(|input| (
            input.stream.stream_index,
            input.presentation_origin_ms,
            input.stream.timeline_offset_ms,
            input.stream.time_base.as_deref(),
            input.decode_timeline.as_ref().map(|timeline| (
                timeline.first_decoded_pts_ms,
                timeline.pts_discontinuity_count,
                timeline.max_pts_gap_ms,
                timeline.skip_samples,
                timeline.discard_padding,
                timeline.normalized_pcm_origin_ms,
            )),
        )),
        target.map(|input| (
            input.stream.stream_index,
            input.presentation_origin_ms,
            input.stream.timeline_offset_ms,
            input.stream.time_base.as_deref(),
            input.decode_timeline.as_ref().map(|timeline| (
                timeline.first_decoded_pts_ms,
                timeline.pts_discontinuity_count,
                timeline.max_pts_gap_ms,
                timeline.skip_samples,
                timeline.discard_padding,
                timeline.normalized_pcm_origin_ms,
            )),
        )),
    );
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in parameters.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn run_audio_alignment_job(
    job_id: String,
    cancel_flag: Arc<AtomicBool>,
    request: AudioAlignmentRequest,
) {
    let mut update = |progress: f64, message: &str| {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(AUDIO_ALIGNMENT_CANCELLED.to_string());
        }
        update_audio_alignment_job(
            &job_id,
            AudioAlignmentJobStatus::Running,
            progress,
            message,
            None,
            None,
        )
    };
    let result = align_audio_files_with_progress(request, &mut update, Some(cancel_flag.as_ref()));
    if cancel_flag.load(Ordering::Relaxed) {
        let _ = update_audio_alignment_job(
            &job_id,
            AudioAlignmentJobStatus::Cancelled,
            1.0,
            AUDIO_ALIGNMENT_CANCELLED,
            None,
            None,
        );
        return;
    }
    match result {
        Ok(proposal) => {
            let _ = update_audio_alignment_job(
                &job_id,
                AudioAlignmentJobStatus::Completed,
                1.0,
                "本地音频对齐完成。",
                Some(proposal),
                None,
            );
        }
        Err(error) => {
            let status = if error == AUDIO_ALIGNMENT_CANCELLED {
                AudioAlignmentJobStatus::Cancelled
            } else {
                AudioAlignmentJobStatus::Failed
            };
            let _ =
                update_audio_alignment_job(&job_id, status, 1.0, &error, None, Some(error.clone()));
        }
    }
}

fn create_options(request: &AudioAlignmentRequest) -> Result<AudioAlignmentOptions, String> {
    let sample_rate = request.sample_rate.unwrap_or(DEFAULT_SAMPLE_RATE);
    let window_ms = request.window_ms.unwrap_or(DEFAULT_WINDOW_MS);
    let match_threshold = request.match_threshold.unwrap_or(DEFAULT_MATCH_THRESHOLD);
    let min_gap_ms = request.min_gap_ms.unwrap_or(DEFAULT_MIN_GAP_MS);
    let max_cells = request.max_cells.unwrap_or(DEFAULT_MAX_CELLS);
    let visual_sample_interval_ms = request
        .visual_sample_interval_ms
        .unwrap_or(DEFAULT_VISUAL_SAMPLE_INTERVAL_MS);
    if sample_rate == 0 {
        return Err("音频采样率必须大于 0。".to_string());
    }
    if window_ms == 0 {
        return Err("音频特征窗口必须大于 0。".to_string());
    }
    if !match_threshold.is_finite() || match_threshold <= 0.0 {
        return Err("音频匹配阈值必须是大于 0 的数字。".to_string());
    }
    if visual_sample_interval_ms == 0 {
        return Err("视觉采样间隔必须大于 0。".to_string());
    }
    let ffmpeg_path = request
        .ffmpeg_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("ffmpeg")
        .to_string();
    let ffprobe_path = request
        .ffprobe_path
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_ffprobe_path(&ffmpeg_path));
    Ok(AudioAlignmentOptions {
        sample_rate,
        window_ms,
        match_threshold,
        min_gap_ms,
        max_cells,
        ffmpeg_path,
        ffprobe_path,
        enable_visual_evidence: request.enable_visual_evidence.unwrap_or(false),
        visual_sample_interval_ms,
        localization_mode: request.localization_mode.unwrap_or(false),
    })
}

fn audio_alignment_jobs() -> &'static Mutex<HashMap<String, AudioAlignmentJobEntry>> {
    AUDIO_ALIGNMENT_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_audio_alignment_job_id() -> String {
    let next = AUDIO_ALIGNMENT_JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("audio-align-{next}")
}

fn insert_audio_alignment_job(job_id: String, cancel_flag: Arc<AtomicBool>) -> Result<(), String> {
    let snapshot = AudioAlignmentJobSnapshot {
        job_id: job_id.clone(),
        status: AudioAlignmentJobStatus::Queued,
        progress: 0.0,
        message: "音频对齐任务已加入队列。".to_string(),
        stage_key: "queued".to_string(),
        stage_label: "排队".to_string(),
        stage_index: 0,
        stage_count: AUDIO_ALIGNMENT_STAGE_COUNT,
        stage_progress: 0.0,
        logs: vec!["音频对齐任务已加入队列。".to_string()],
        proposal: None,
        error: None,
        updated_at_ms: current_time_ms(),
    };
    let mut jobs = audio_alignment_jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    jobs.insert(
        job_id,
        AudioAlignmentJobEntry {
            snapshot,
            cancel_flag,
        },
    );
    Ok(())
}

fn update_audio_alignment_job(
    job_id: &str,
    status: AudioAlignmentJobStatus,
    progress: f64,
    message: &str,
    proposal: Option<AudioAlignmentProposal>,
    error: Option<String>,
) -> Result<(), String> {
    let mut jobs = audio_alignment_jobs()
        .lock()
        .map_err(|_| "音频对齐任务状态锁已损坏。".to_string())?;
    let entry = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("未找到音频对齐任务：{job_id}"))?;
    if entry.snapshot.status == AudioAlignmentJobStatus::Cancelled
        && status != AudioAlignmentJobStatus::Cancelled
    {
        return Ok(());
    }
    entry.snapshot.status = status;
    entry.snapshot.progress = progress.clamp(0.0, 1.0);
    entry.snapshot.message = message.to_string();
    let stage =
        create_audio_alignment_stage_snapshot(&entry.snapshot.status, entry.snapshot.progress);
    apply_audio_alignment_stage_snapshot(&mut entry.snapshot, stage);
    append_audio_alignment_log(&mut entry.snapshot.logs, message);
    if let Some(error_message) = &error {
        append_audio_alignment_log(&mut entry.snapshot.logs, error_message);
    }
    entry.snapshot.proposal = proposal;
    entry.snapshot.error = error;
    entry.snapshot.updated_at_ms = current_time_ms();
    Ok(())
}

fn create_audio_alignment_stage_snapshot(
    status: &AudioAlignmentJobStatus,
    progress: f64,
) -> AudioAlignmentStageSnapshot {
    if *status == AudioAlignmentJobStatus::Cancelled {
        return AudioAlignmentStageSnapshot {
            key: "cancelled",
            label: "已取消",
            index: AUDIO_ALIGNMENT_STAGE_COUNT,
            count: AUDIO_ALIGNMENT_STAGE_COUNT,
            progress: 1.0,
        };
    }
    if *status == AudioAlignmentJobStatus::Failed {
        return AudioAlignmentStageSnapshot {
            key: "failed",
            label: "失败",
            index: AUDIO_ALIGNMENT_STAGE_COUNT,
            count: AUDIO_ALIGNMENT_STAGE_COUNT,
            progress: 1.0,
        };
    }
    if *status == AudioAlignmentJobStatus::Completed {
        return AudioAlignmentStageSnapshot {
            key: "completed",
            label: "已完成",
            index: AUDIO_ALIGNMENT_STAGE_COUNT,
            count: AUDIO_ALIGNMENT_STAGE_COUNT,
            progress: 1.0,
        };
    }
    let clamped = progress.clamp(0.0, 1.0);
    if clamped < 0.10 {
        create_stage_range("validating", "校验输入", 1, clamped, 0.0, 0.10)
    } else if clamped < 0.38 {
        create_stage_range(
            "extracting-complete",
            "提取完整版特征",
            2,
            clamped,
            0.10,
            0.38,
        )
    } else if clamped < 0.66 {
        create_stage_range(
            "extracting-source",
            "提取删减版特征",
            3,
            clamped,
            0.38,
            0.66,
        )
    } else if clamped < 0.76 {
        create_stage_range("extracting-visual", "提取视觉证据", 4, clamped, 0.66, 0.76)
    } else if clamped < 0.81 {
        create_stage_range("fingerprinting", "生成稀疏指纹", 5, clamped, 0.76, 0.81)
    } else if clamped < 0.87 {
        create_stage_range("matching", "建立候选观测", 6, clamped, 0.81, 0.87)
    } else if clamped < 0.92 {
        create_stage_range("fitting", "拟合时间映射", 7, clamped, 0.87, 0.92)
    } else if clamped < 0.97 {
        create_stage_range("refining", "确认持续变点", 8, clamped, 0.92, 0.97)
    } else {
        create_stage_range("reporting", "生成复核数据", 9, clamped, 0.97, 1.0)
    }
}

fn create_stage_range(
    key: &'static str,
    label: &'static str,
    index: u8,
    progress: f64,
    start: f64,
    end: f64,
) -> AudioAlignmentStageSnapshot {
    let stage_progress = if end <= start {
        1.0
    } else {
        ((progress - start) / (end - start)).clamp(0.0, 1.0)
    };
    AudioAlignmentStageSnapshot {
        key,
        label,
        index,
        count: AUDIO_ALIGNMENT_STAGE_COUNT,
        progress: stage_progress,
    }
}

fn apply_audio_alignment_stage_snapshot(
    snapshot: &mut AudioAlignmentJobSnapshot,
    stage: AudioAlignmentStageSnapshot,
) {
    snapshot.stage_key = stage.key.to_string();
    snapshot.stage_label = stage.label.to_string();
    snapshot.stage_index = stage.index;
    snapshot.stage_count = stage.count;
    snapshot.stage_progress = stage.progress;
}

fn append_audio_alignment_log(logs: &mut Vec<String>, message: &str) {
    let trimmed = message.trim();
    if trimmed.is_empty() || logs.last().is_some_and(|last| last == trimmed) {
        return;
    }
    logs.push(trimmed.to_string());
    if logs.len() > MAX_JOB_LOGS {
        let overflow = logs.len() - MAX_JOB_LOGS;
        logs.drain(0..overflow);
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn validate_media_input(path: &str, label: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label}路径不能为空。"));
    }
    if is_remote_media_input(trimmed) {
        return Err("音频对齐仅支持已导入的本地媒体文件；远程地址不会被读取。".to_string());
    }
    if !Path::new(trimmed).is_file() {
        return Err(format!(
            "{label}不是可读取的本地媒体文件；请重新选择或连接素材。"
        ));
    }
    Ok(())
}

fn acquire_alignment_media_read_lease(
    source_path: &str,
    target_path: &str,
) -> Result<AlignmentMediaReadLease, String> {
    Ok(AlignmentMediaReadLease {
        _source: open_alignment_media_read_lease(Path::new(source_path))?,
        _target: open_alignment_media_read_lease(Path::new(target_path))?,
    })
}

#[cfg(windows)]
fn open_alignment_media_read_lease(path: &Path) -> Result<File, String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| {
            "blocked:media-lease：无法取得禁止写入、删除和替换的媒体只读 lease；路径已隐藏。"
                .to_string()
        })
}

#[cfg(not(windows))]
fn open_alignment_media_read_lease(path: &Path) -> Result<File, String> {
    File::open(path)
        .map_err(|_| "blocked:media-lease：无法取得媒体只读 lease；路径已隐藏。".to_string())
}

fn probe_alignment_audio_input(
    media_path: &str,
    label: &str,
    requested_stream_index: Option<u32>,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AlignmentAudioInput, String> {
    let snapshot = probe_media_timeline_with_ffprobe_cancellable(
        media_path,
        &options.ffprobe_path,
        cancel_flag,
    )
    .map_err(|error| format_alignment_probe_error(&format!("{label}媒体时间线探测失败"), error))?;
    let stream = select_audio_stream(&snapshot, requested_stream_index, label)?;
    if stream.timeline_offset_ms < 0 {
        return Err(format!(
            "{label}音轨 #{} 的展示时间偏移为负，无法建立非负媒体展示时间线。",
            stream.stream_index
        ));
    }
    Ok(AlignmentAudioInput {
        presentation_origin_ms: snapshot.presentation_origin_ms,
        media_duration_ms: snapshot.duration_ms.or(stream.duration_ms),
        content_identity: snapshot.content_identity.clone(),
        decode_timeline: None,
        audio_stream_count: snapshot.audio_streams.len(),
        explicit_stream_selection: requested_stream_index.is_some(),
        stream,
    })
}

fn format_alignment_audio_input_diagnostic(label: &str, input: &AlignmentAudioInput) -> String {
    format!(
        "媒体时间基准：{label} presentation origin {:+} ms，选择音轨 #{}（共 {} 条，流起点 {:+} ms，相对展示时间 +{} ms{}{}）。",
        input.presentation_origin_ms,
        input.stream.stream_index,
        input.audio_stream_count,
        input.stream.start_time_ms,
        input.stream.timeline_offset_ms,
        if input.stream.is_default { "，default" } else { "" },
        if input.stream.is_commentary {
            if input.explicit_stream_selection {
                "，commentary（显式选择）"
            } else {
                "，commentary（没有非评论音轨）"
            }
        } else {
            ""
        }
    )
}

fn is_remote_media_input(path: &str) -> bool {
    let lower = path.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn get_audio_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    audio_input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedAudioFeatures, String> {
    check_cancelled(cancel_flag)?;
    let cache_key = create_audio_feature_cache_key(media_path, options, audio_input)?;
    if let Some(frames) = read_audio_feature_cache(&cache_key)? {
        return Ok(CachedAudioFeatures {
            frames,
            cache_hit: true,
        });
    }

    let frames = extract_audio_features(media_path, label, options, audio_input, cancel_flag)?;
    write_audio_feature_cache(cache_key, &frames)?;
    Ok(CachedAudioFeatures {
        frames,
        cache_hit: false,
    })
}

fn audio_feature_cache() -> &'static Mutex<HashMap<String, Vec<AudioFeatureFrame>>> {
    AUDIO_FEATURE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_audio_feature_cache(cache_key: &str) -> Result<Option<Vec<AudioFeatureFrame>>, String> {
    let cache = audio_feature_cache()
        .lock()
        .map_err(|_| "音频特征缓存锁已损坏。".to_string())?;
    let result = cache.get(cache_key).cloned();
    drop(cache);
    benchmark_cache_event(
        BenchmarkCacheKind::AudioFeatures,
        if result.is_some() {
            BenchmarkCacheEvent::Hit
        } else {
            BenchmarkCacheEvent::Miss
        },
    );
    Ok(result)
}

fn write_audio_feature_cache(
    cache_key: String,
    frames: &[AudioFeatureFrame],
) -> Result<(), String> {
    let mut cache = audio_feature_cache()
        .lock()
        .map_err(|_| "音频特征缓存锁已损坏。".to_string())?;
    if !cache.contains_key(&cache_key) && cache.len() >= MAX_AUDIO_FEATURE_CACHE_ENTRIES {
        cache.clear();
        benchmark_cache_event(
            BenchmarkCacheKind::AudioFeatures,
            BenchmarkCacheEvent::Eviction,
        );
    }
    cache.insert(cache_key, frames.to_vec());
    benchmark_cache_event(
        BenchmarkCacheKind::AudioFeatures,
        BenchmarkCacheEvent::Write,
    );
    Ok(())
}

fn create_audio_feature_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
    audio_input: &AlignmentAudioInput,
) -> Result<String, String> {
    let content_identity = alignment_audio_content_identity_cache_fragment(audio_input)?;
    let stream_identity = format!(
        "{}|channelLayout={}",
        serde_json::to_string(&audio_input.stream)
            .map_err(|error| format!("无法序列化音轨缓存身份：{error}"))?,
        audio_input.stream.channel_layout.as_deref().unwrap_or("")
    );
    let metadata = fs::metadata(media_path)
        .map_err(|error| format!("无法读取音频特征缓存文件信息：{error}"))?;
    let canonical_path = fs::canonicalize(media_path).unwrap_or_else(|_| PathBuf::from(media_path));
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Ok(format!(
        "{}|len={}|modified={modified_ms}|{content_identity}|presentationOriginMs={}|audioStream={}|sampleRate={}|windowMs={}|ffmpeg={}",
        canonical_path.to_string_lossy(),
        metadata.len(),
        audio_input.presentation_origin_ms,
        stream_identity,
        options.sample_rate,
        options.window_ms,
        options.ffmpeg_path
    ))
}

fn alignment_audio_content_identity_cache_fragment(
    audio_input: &AlignmentAudioInput,
) -> Result<String, String> {
    let identity = require_full_file_media_content_identity(audio_input.content_identity.as_ref())?;
    Ok(format!(
        "contentIdentity={}:{}:{}:{}:{}:{}",
        identity.algorithm,
        identity.size_bytes,
        identity.modified_unix_ms,
        identity.first_sample_digest,
        identity.middle_sample_digest,
        identity.last_sample_digest,
    ))
}

fn format_audio_feature_cache_message(label: &str, features: &CachedAudioFeatures) -> String {
    let action = if features.cache_hit {
        "缓存命中"
    } else {
        "提取完成并写入缓存"
    };
    format!("{label}音频特征{action}：{} 帧。", features.frames.len())
}

fn get_visual_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    expected_identity: Option<&MediaContentIdentity>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedVisualFeatures, String> {
    check_cancelled(cancel_flag)?;
    let cache_key = create_visual_feature_cache_key(media_path, options, expected_identity)?;
    if let Some(frames) = read_visual_feature_cache(&cache_key)? {
        return Ok(CachedVisualFeatures {
            frames,
            cache_hit: true,
        });
    }

    let frames =
        extract_visual_features(media_path, label, options, expected_identity, cancel_flag)?;
    write_visual_feature_cache(cache_key, &frames)?;
    Ok(CachedVisualFeatures {
        frames,
        cache_hit: false,
    })
}

fn probe_alignment_visual_input(
    media_path: &str,
    label: &str,
    requested_stream_index: Option<u32>,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AlignmentVisualInput, String> {
    let snapshot = probe_media_timeline_with_ffprobe_cancellable(
        media_path,
        &options.ffprobe_path,
        cancel_flag,
    )
    .map_err(|error| {
        format_alignment_probe_error(&format!("{label}视频展示时间线探测失败"), error)
    })?;
    if snapshot
        .duration_ms
        .is_some_and(|duration| duration > ALIGNMENT_V2_VISUAL_MAX_DURATION_MS)
    {
        return Err(format!(
            "blocked:resource-limit：{label}时长超过视觉回退当前 {} 小时上限。",
            ALIGNMENT_V2_VISUAL_MAX_DURATION_MS / (60 * 60 * 1_000)
        ));
    }
    let stream = select_alignment_video_stream(&snapshot, requested_stream_index, label)?;
    if stream.timeline_offset_ms < 0 {
        return Err(format!(
            "{label}视频流 #{} 的展示时间偏移为负，无法安全归一化视觉 PTS。",
            stream.stream_index
        ));
    }
    Ok(AlignmentVisualInput {
        presentation_origin_ms: snapshot.presentation_origin_ms,
        media_duration_ms: snapshot.duration_ms,
        content_identity: snapshot.content_identity,
        stream,
    })
}

fn select_alignment_video_stream(
    snapshot: &MediaProbeSnapshot,
    requested_stream_index: Option<u32>,
    label: &str,
) -> Result<VideoStreamProbe, String> {
    if let Some(stream_index) = requested_stream_index {
        return snapshot
            .video_streams
            .iter()
            .find(|stream| stream.stream_index == stream_index)
            .cloned()
            .ok_or_else(|| format!("{label}未找到显式指定的视频流 #{stream_index}。"));
    }
    snapshot
        .video_streams
        .iter()
        .filter(|stream| !stream.is_commentary)
        .max_by_key(|stream| (stream.is_default, std::cmp::Reverse(stream.stream_index)))
        .cloned()
        .ok_or_else(|| format!("{label}没有可用于视觉回退的非 commentary 视频流。"))
}

fn get_v2_visual_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentVisualInput,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedVisualFeatures, String> {
    check_cancelled(cancel_flag)?;
    let interval_ms = v2_visual_sample_interval_ms(input, options);
    let cache_key = create_v2_visual_feature_cache_key(media_path, options, input, interval_ms)?;
    if let Some(frames) = read_visual_feature_cache(&cache_key)? {
        return Ok(CachedVisualFeatures {
            frames,
            cache_hit: true,
        });
    }
    let frames =
        extract_v2_visual_features(media_path, label, options, input, interval_ms, cancel_flag)?;
    write_visual_feature_cache(cache_key, &frames)?;
    Ok(CachedVisualFeatures {
        frames,
        cache_hit: false,
    })
}

fn v2_visual_sample_interval_ms(
    input: &AlignmentVisualInput,
    options: &AudioAlignmentOptions,
) -> u64 {
    let configured = options.visual_sample_interval_ms.clamp(
        ALIGNMENT_V2_VISUAL_MIN_SAMPLE_INTERVAL_MS,
        ALIGNMENT_V2_VISUAL_MAX_SAMPLE_INTERVAL_MS,
    );
    let duration_ms = input
        .stream
        .duration_ms
        .or(input.media_duration_ms)
        .unwrap_or(0);
    let capacity_interval = duration_ms.saturating_add(ALIGNMENT_V2_VISUAL_MAX_FRAMES as u64 - 1)
        / ALIGNMENT_V2_VISUAL_MAX_FRAMES as u64;
    configured.max(capacity_interval.max(1))
}

fn create_v2_visual_feature_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentVisualInput,
    interval_ms: u64,
) -> Result<String, String> {
    let canonical_path = fs::canonicalize(media_path).unwrap_or_else(|_| PathBuf::from(media_path));
    let identity = require_full_file_media_content_identity(input.content_identity.as_ref())?;
    Ok(format!(
        "feature={ALIGNMENT_V2_VISUAL_FEATURE_VERSION}|path={}|identity={}:{}:{}:{}:{}:{}|presentationOrigin={}|stream={}:{}:{}:{:?}|interval={interval_ms}|ffmpeg={}",
        canonical_path.to_string_lossy(),
        identity.algorithm,
        identity.size_bytes,
        identity.modified_unix_ms,
        identity.first_sample_digest,
        identity.middle_sample_digest,
        identity.last_sample_digest,
        input.presentation_origin_ms,
        input.stream.stream_index,
        input.stream.start_time_ms,
        input.stream.timeline_offset_ms,
        input.stream.time_base,
        options.ffmpeg_path,
    ))
}

fn extract_v2_visual_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentVisualInput,
    interval_ms: u64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<VisualFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let fps = 1000.0 / interval_ms.max(1) as f64;
    let presentation_start_seconds = input.stream.timeline_offset_ms.max(0) as f64 / 1000.0;
    let filter = format!(
        "fps=fps={fps:.9}:start_time={presentation_start_seconds:.6},scale={VISUAL_SAMPLE_WIDTH}:{VISUAL_SAMPLE_HEIGHT}:flags=area,format=gray"
    );
    let stream_map = format!("0:{}", input.stream.stream_index);
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        [
            "-nostdin",
            "-v",
            "error",
            "-copyts",
            "-start_at_zero",
            "-i",
            media_path,
            "-map",
            stream_map.as_str(),
            "-vf",
            filter.as_str(),
            "-an",
            "-sn",
            "-dn",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ],
        "FFmpeg V2 视觉采样",
        ALIGNMENT_V2_VISUAL_MAX_RAW_BYTES,
        cancel_flag,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            &format!("FFmpeg 提取 {label} V2 视觉特征"),
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output(
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 视觉采样",
    )?;
    let start_ms = input.stream.timeline_offset_ms.max(0) as u64;
    let frames = raw_visual_frames_to_features_with_origin(
        &output.stdout,
        interval_ms,
        start_ms,
        cancel_flag,
    )?;
    if frames.is_empty() {
        return Err(format!("{label}未能提取到可用 V2 视觉特征。"));
    }
    Ok(frames)
}

fn visual_feature_cache() -> &'static Mutex<HashMap<String, Vec<VisualFeatureFrame>>> {
    VISUAL_FEATURE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_visual_feature_cache(cache_key: &str) -> Result<Option<Vec<VisualFeatureFrame>>, String> {
    let cache = visual_feature_cache()
        .lock()
        .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
    let result = cache.get(cache_key).cloned();
    drop(cache);
    benchmark_cache_event(
        BenchmarkCacheKind::VisualFeatures,
        if result.is_some() {
            BenchmarkCacheEvent::Hit
        } else {
            BenchmarkCacheEvent::Miss
        },
    );
    Ok(result)
}

fn write_visual_feature_cache(
    cache_key: String,
    frames: &[VisualFeatureFrame],
) -> Result<(), String> {
    let mut cache = visual_feature_cache()
        .lock()
        .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
    if !cache.contains_key(&cache_key) && cache.len() >= MAX_VISUAL_FEATURE_CACHE_ENTRIES {
        cache.clear();
        benchmark_cache_event(
            BenchmarkCacheKind::VisualFeatures,
            BenchmarkCacheEvent::Eviction,
        );
    }
    cache.insert(cache_key, frames.to_vec());
    benchmark_cache_event(
        BenchmarkCacheKind::VisualFeatures,
        BenchmarkCacheEvent::Write,
    );
    Ok(())
}

fn create_visual_feature_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
    expected_identity: Option<&MediaContentIdentity>,
) -> Result<String, String> {
    let identity = require_full_file_media_content_identity(expected_identity)?;
    let content_identity = format!(
        "contentIdentity={}:{}:{}:{}:{}:{}",
        identity.algorithm,
        identity.size_bytes,
        identity.modified_unix_ms,
        identity.first_sample_digest,
        identity.middle_sample_digest,
        identity.last_sample_digest,
    );
    let metadata = fs::metadata(media_path)
        .map_err(|error| format!("无法读取视觉特征缓存文件信息：{error}"))?;
    let canonical_path = fs::canonicalize(media_path).unwrap_or_else(|_| PathBuf::from(media_path));
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Ok(format!(
        "{}|len={}|modified={modified_ms}|{content_identity}|visualInterval={}|ffmpeg={}",
        canonical_path.to_string_lossy(),
        metadata.len(),
        options.visual_sample_interval_ms,
        options.ffmpeg_path
    ))
}

fn extract_visual_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    expected_identity: Option<&MediaContentIdentity>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<VisualFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let fps = 1000.0 / options.visual_sample_interval_ms.max(1) as f64;
    let filter = format!(
        "fps={fps:.6},scale={VISUAL_SAMPLE_WIDTH}:{VISUAL_SAMPLE_HEIGHT}:flags=bilinear,format=gray"
    );
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        [
            "-nostdin",
            "-v",
            "error",
            "-i",
            media_path,
            "-vf",
            filter.as_str(),
            "-an",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        "FFmpeg 视觉采样",
        ALIGNMENT_V2_VISUAL_MAX_RAW_BYTES,
        cancel_flag,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            "FFmpeg 提取视觉证据",
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output(
        media_path,
        expected_identity,
        cancel_flag,
        "视觉特征采样",
    )?;
    let frames = raw_visual_frames_to_features(
        &output.stdout,
        options.visual_sample_interval_ms,
        cancel_flag,
    )?;
    if frames.is_empty() {
        return Err(format!("{label}未能提取到可用视觉证据。"));
    }
    Ok(frames)
}

fn raw_visual_frames_to_features(
    raw: &[u8],
    sample_interval_ms: u64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<VisualFeatureFrame>, String> {
    raw_visual_frames_to_features_with_origin(raw, sample_interval_ms, 0, cancel_flag)
}

fn raw_visual_frames_to_features_with_origin(
    raw: &[u8],
    sample_interval_ms: u64,
    presentation_start_ms: u64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<VisualFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let frame_size = VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT;
    if raw.len() < frame_size {
        check_cancelled(cancel_flag)?;
        return Ok(Vec::new());
    }
    if raw.len() / frame_size > ALIGNMENT_V2_VISUAL_MAX_FRAMES {
        return Err("blocked:resource-limit：视觉帧数超过硬上限。".to_string());
    }
    let mut frames = Vec::new();
    for (index, chunk) in raw.chunks_exact(frame_size).enumerate() {
        frames.push(VisualFeatureFrame {
            time_ms: presentation_start_ms.saturating_add(index as u64 * sample_interval_ms),
            values: create_robust_visual_values(chunk),
        });
        check_cancelled(cancel_flag)?;
    }
    check_cancelled(cancel_flag)?;
    Ok(frames)
}

fn create_robust_visual_values(pixels: &[u8]) -> Vec<f64> {
    let mut totals = vec![0.0; VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS];
    let mut counts = vec![0usize; VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS];
    let mut core_values = Vec::with_capacity(VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT);
    for y in 0..VISUAL_SAMPLE_HEIGHT {
        for x in 0..VISUAL_SAMPLE_WIDTH {
            if !is_core_visual_pixel(x, y) {
                continue;
            }
            let column =
                (x * VISUAL_GRID_COLUMNS / VISUAL_SAMPLE_WIDTH).min(VISUAL_GRID_COLUMNS - 1);
            let row = ((y.saturating_sub(1)) * VISUAL_GRID_ROWS / 13).min(VISUAL_GRID_ROWS - 1);
            let index = row * VISUAL_GRID_COLUMNS + column;
            let value = pixels[y * VISUAL_SAMPLE_WIDTH + x] as f64 / 255.0;
            totals[index] += value;
            counts[index] += 1;
            core_values.push(value);
        }
    }
    let global_count = core_values.len().max(1);
    let global_mean = core_values.iter().sum::<f64>() / global_count as f64;
    let variance = core_values
        .iter()
        .map(|value| (value - global_mean).powi(2))
        .sum::<f64>()
        / global_count as f64;
    let global_std = variance.sqrt();
    let cells = totals
        .into_iter()
        .zip(counts)
        .map(|(total, count)| {
            if count == 0 {
                global_mean
            } else {
                total / count as f64
            }
        })
        .collect::<Vec<_>>();
    let normalization = global_std.max(0.02);
    let normalized = cells
        .iter()
        .map(|value| ((value - global_mean) / normalization).clamp(-3.0, 3.0))
        .collect::<Vec<_>>();

    // The first two values deliberately retain weak luminance/contrast cues. The remaining
    // values describe masked structure and are resilient to global brightness changes.
    let mut features = Vec::with_capacity(2 + normalized.len() * 3);
    features.push(global_mean);
    features.push(global_std);
    features.extend(normalized.iter().copied());

    // Multi-block gradients distinguish cuts that have similar average brightness. The ignored
    // right-top watermark and bottom subtitle band never enter the cells above.
    for row in 0..VISUAL_GRID_ROWS {
        for column in 0..VISUAL_GRID_COLUMNS - 1 {
            let index = row * VISUAL_GRID_COLUMNS + column;
            features.push((normalized[index + 1] - normalized[index]).clamp(-4.0, 4.0));
        }
    }
    for row in 0..VISUAL_GRID_ROWS - 1 {
        for column in 0..VISUAL_GRID_COLUMNS {
            let index = row * VISUAL_GRID_COLUMNS + column;
            features.push(
                (normalized[index + VISUAL_GRID_COLUMNS] - normalized[index]).clamp(-4.0, 4.0),
            );
        }
    }

    // A compact low-frequency 2-D DCT/pHash-like tail adds scene-layout discrimination without
    // storing source frames. DC is omitted because mean luminance is already recorded above.
    for vertical_frequency in 0..4 {
        for horizontal_frequency in 0..4 {
            if horizontal_frequency == 0 && vertical_frequency == 0 {
                continue;
            }
            let mut coefficient = 0.0;
            for row in 0..VISUAL_GRID_ROWS {
                for column in 0..VISUAL_GRID_COLUMNS {
                    let x_basis = (std::f64::consts::PI
                        * (2 * column + 1) as f64
                        * horizontal_frequency as f64
                        / (2 * VISUAL_GRID_COLUMNS) as f64)
                        .cos();
                    let y_basis =
                        (std::f64::consts::PI * (2 * row + 1) as f64 * vertical_frequency as f64
                            / (2 * VISUAL_GRID_ROWS) as f64)
                            .cos();
                    coefficient +=
                        normalized[row * VISUAL_GRID_COLUMNS + column] * x_basis * y_basis;
                }
            }
            features.push(coefficient / (VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS) as f64);
        }
    }
    features
}

fn is_core_visual_pixel(x: usize, y: usize) -> bool {
    if !(2..VISUAL_SAMPLE_WIDTH - 2).contains(&x) || y == 0 || y >= 14 {
        return false;
    }
    !(x >= 24 && y <= 5)
}

fn extract_audio_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    audio_input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<AudioFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        create_audio_decode_args(media_path, options, audio_input),
        "FFmpeg 音频解码",
        LEGACY_MAX_PCM_BYTES,
        cancel_flag,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            "FFmpeg 提取音频",
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output(
        media_path,
        audio_input.content_identity.as_ref(),
        cancel_flag,
        "音频特征解码",
    )?;
    let frames = pcm_to_feature_frames(
        &output.stdout,
        options,
        audio_input.stream.timeline_offset_ms,
        cancel_flag,
    )?;
    if frames.is_empty() {
        return Err(format!("{label}未能提取到可用音频特征。"));
    }
    Ok(frames)
}

fn create_audio_decode_args(
    media_path: &str,
    options: &AudioAlignmentOptions,
    audio_input: &AlignmentAudioInput,
) -> Vec<String> {
    vec![
        "-v".to_string(),
        "error".to_string(),
        "-i".to_string(),
        media_path.to_string(),
        "-map".to_string(),
        format!("0:{}", audio_input.stream.stream_index),
        "-vn".to_string(),
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        options.sample_rate.to_string(),
        "-f".to_string(),
        "f32le".to_string(),
        "pipe:1".to_string(),
    ]
}

fn format_media_tool_nonzero_exit(
    action: &str,
    status_code: Option<i32>,
    _untrusted_tool_output: &[u8],
) -> String {
    format!(
        "{action}失败（退出码 {}）；为保护本地路径，未回显工具输出。",
        status_code.unwrap_or(-1)
    )
}

fn redact_sensitive_media_text(text: &str) -> String {
    let mut redacted = text.to_string();
    for key in [
        "api_key=",
        "apiKey=",
        "AccessToken=",
        "X-Emby-Token=",
        "token=",
    ] {
        redacted = redact_query_value(&redacted, key);
    }
    redacted
}

fn redact_query_value(text: &str, key: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(relative_start) = text[cursor..].find(key) {
        let key_start = cursor + relative_start;
        let value_start = key_start + key.len();
        output.push_str(&text[cursor..value_start]);
        output.push_str("<已隐藏>");
        let value_end = text[value_start..]
            .find(['&', ' ', '\n', '\r', '"', '\''])
            .map(|relative_end| value_start + relative_end)
            .unwrap_or(text.len());
        cursor = value_end;
    }
    output.push_str(&text[cursor..]);
    output
}

fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(AUDIO_ALIGNMENT_CANCELLED.to_string());
    }
    Ok(())
}

fn ensure_alignment_process_supervision_clean() -> Result<(), String> {
    if process_supervision_cleanup_faulted() {
        return Err(
            "blocked:process-cleanup：受监督媒体进程未能可信收尾；当前对齐结果已作废。".to_string(),
        );
    }
    Ok(())
}

fn propagate_alignment_process_cleanup(error: &str) -> Result<(), String> {
    if process_supervision_cleanup_faulted() || error.starts_with("blocked:process-cleanup") {
        return Err(
            "blocked:process-cleanup：受监督媒体进程未能可信收尾；禁止降级或回退。".to_string(),
        );
    }
    Ok(())
}

fn format_alignment_probe_error(context: &str, error: String) -> String {
    if process_supervision_cleanup_faulted()
        || error.starts_with("blocked:process-cleanup")
        || error.starts_with("blocked:cleanup-failed")
    {
        return "blocked:process-cleanup：受监督媒体探测未能可信收尾。".to_string();
    }
    if error.starts_with("cancelled：") {
        return AUDIO_ALIGNMENT_CANCELLED.to_string();
    }
    if is_media_identity_guard_error(&error) {
        return error;
    }
    format!("{context}：{}", redact_sensitive_media_text(&error))
}

fn require_full_file_media_content_identity(
    identity: Option<&MediaContentIdentity>,
) -> Result<&MediaContentIdentity, String> {
    let identity = identity.ok_or_else(|| {
        "blocked:media-identity-missing：媒体输入缺少全文件身份，拒绝使用缓存或分析结果。"
            .to_string()
    })?;
    let digest_is_valid =
        |digest: &str| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    if identity.algorithm != "sha256-full-file-v2"
        || !digest_is_valid(&identity.first_sample_digest)
        || identity.first_sample_digest != identity.middle_sample_digest
        || identity.middle_sample_digest != identity.last_sample_digest
    {
        return Err(
            "blocked:media-identity-invalid：媒体输入没有有效的 sha256-full-file-v2 全文件摘要，拒绝使用缓存或分析结果。"
                .to_string(),
        );
    }
    Ok(identity)
}

fn probe_alignment_run_expected_identity(
    media_path: &str,
    cancel_flag: Option<&AtomicBool>,
    role: &str,
) -> Result<MediaContentIdentity, String> {
    check_cancelled(cancel_flag)?;
    let identity = probe_media_content_identity_cancellable(Path::new(media_path), cancel_flag)
        .map_err(|error| {
            if error.starts_with("cancelled：") {
                AUDIO_ALIGNMENT_CANCELLED.to_string()
            } else {
                format!(
                    "blocked:media-identity-recheck：无法建立{role}的全文件媒体身份；路径与探测错误已隐藏。"
                )
            }
        })?;
    require_full_file_media_content_identity(Some(&identity)).map_err(|_| {
        format!("blocked:media-identity-invalid：{role}没有有效的 sha256-full-file-v2 全文件摘要。")
    })?;
    Ok(identity)
}

fn verify_media_content_identity_after_tool_output(
    media_path: &str,
    expected_identity: Option<&MediaContentIdentity>,
    cancel_flag: Option<&AtomicBool>,
    operation: &str,
) -> Result<(), String> {
    check_cancelled(cancel_flag)?;
    ensure_alignment_process_supervision_clean()?;
    let expected_identity = require_full_file_media_content_identity(expected_identity)?;
    let current_identity = probe_media_content_identity_cancellable(Path::new(media_path), cancel_flag)
        .map_err(|error| {
            if error.starts_with("cancelled：") {
                AUDIO_ALIGNMENT_CANCELLED.to_string()
            } else {
                format!(
                    "blocked:media-identity-recheck：{operation}后无法重新核验媒体身份；已丢弃工具输出。"
                )
            }
        })?;
    check_cancelled(cancel_flag)?;
    require_full_file_media_content_identity(Some(&current_identity)).map_err(|_| {
        format!("blocked:media-identity-recheck：{operation}后的媒体身份格式无效；已丢弃工具输出。")
    })?;
    if &current_identity != expected_identity {
        return Err(format!(
            "blocked:media-identity-changed：媒体文件在{operation}期间发生变化；已丢弃工具输出、缓存与结论。"
        ));
    }
    Ok(())
}

fn verify_proposal_time_map_identities_match_run(
    proposal: &AudioAlignmentProposal,
    source_run_identity: &MediaContentIdentity,
    target_run_identity: &MediaContentIdentity,
) -> Result<(), String> {
    let Some(time_map) = proposal.time_map.as_ref() else {
        return Ok(());
    };
    let source_identity =
        require_full_file_media_content_identity(time_map.source_identity.as_ref())?;
    let target_identity =
        require_full_file_media_content_identity(time_map.target_identity.as_ref())?;
    if source_identity != source_run_identity || target_identity != target_run_identity {
        return Err(
            "blocked:media-identity-changed：TimeMap 媒体身份与本次只读运行 lease 不一致；已丢弃 proposal。"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlignmentBenchmarkProposalIdentityBinding {
    Bound,
    MissingTimeMap,
}

fn verify_alignment_benchmark_proposal_media_identities(
    proposal: &AudioAlignmentProposal,
    expected_source_identity: &MediaContentIdentity,
    expected_target_identity: &MediaContentIdentity,
) -> Result<AlignmentBenchmarkProposalIdentityBinding, String> {
    if proposal.time_map.is_none() {
        return Ok(AlignmentBenchmarkProposalIdentityBinding::MissingTimeMap);
    }
    verify_proposal_time_map_identities_match_run(
        proposal,
        expected_source_identity,
        expected_target_identity,
    )
    .map_err(|_| {
        "blocked:workload-media-integrity：benchmark proposal 的媒体身份与注册 workload 不一致。"
            .to_string()
    })?;
    Ok(AlignmentBenchmarkProposalIdentityBinding::Bound)
}

fn bind_alignment_benchmark_proposal_to_workload(
    proposal: AudioAlignmentProposal,
    expected_source_identity: &MediaContentIdentity,
    expected_target_identity: &MediaContentIdentity,
) -> (Result<AudioAlignmentProposal, String>, bool) {
    match verify_alignment_benchmark_proposal_media_identities(
        &proposal,
        expected_source_identity,
        expected_target_identity,
    ) {
        Ok(AlignmentBenchmarkProposalIdentityBinding::Bound) => (Ok(proposal), false),
        Ok(AlignmentBenchmarkProposalIdentityBinding::MissingTimeMap) => (
            Err("benchmark proposal 未产出可用于正式 case 的 timeMap。".to_string()),
            false,
        ),
        Err(error) => (Err(error), true),
    }
}

fn run_supervised_ffmpeg_output<I, S>(
    executable: &str,
    args: I,
    context: &str,
    stdout_hard_limit: usize,
    cancel_flag: Option<&AtomicBool>,
) -> Result<SupervisedOutput, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = SupervisedCommand::new(executable);
    command.args(args);
    if let Ok(current_dir) = std::env::current_dir() {
        command.current_dir(current_dir);
    }
    command
        .output(
            SupervisedOutputLimits {
                execution_timeout: Duration::from_millis(MEDIA_TOOL_EXECUTION_TIMEOUT_MS),
                output_drain_timeout: Duration::from_millis(CHILD_OUTPUT_DRAIN_TIMEOUT_MS),
                termination_timeout: Duration::from_millis(
                    CHILD_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
                ),
                poll_interval: Duration::from_millis(20),
                stdout_hard_limit,
                stderr_hard_limit: ALIGNMENT_V2_MAX_STDERR_BYTES,
            },
            || cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)),
        )
        .map_err(|error| match error.kind() {
            SupervisedProcessErrorKind::Cancelled => AUDIO_ALIGNMENT_CANCELLED.to_string(),
            SupervisedProcessErrorKind::StdoutOverflow => format!(
                "blocked:resource-limit：{context} stdout 超过 {} MiB 硬上限。",
                stdout_hard_limit.div_ceil(1024 * 1024)
            ),
            SupervisedProcessErrorKind::StderrOverflow => {
                format!("blocked:resource-limit：{context} stderr 超过硬上限。")
            }
            SupervisedProcessErrorKind::Timeout => {
                format!("blocked:tool-timeout：{context} 超过执行时限。")
            }
            SupervisedProcessErrorKind::Cleanup => error.to_string(),
            _ => format!("{context} 失败：{error}"),
        })
}

fn pcm_to_feature_frames(
    bytes: &[u8],
    options: &AudioAlignmentOptions,
    timeline_offset_ms: i64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<AudioFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let frame_samples = ((options.sample_rate as u64 * options.window_ms) / 1000).max(1) as usize;
    let sample_count = bytes.len() / 4;
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset + frame_samples <= sample_count {
        check_cancelled(cancel_flag)?;
        let mut frame_samples_values = Vec::with_capacity(frame_samples);
        let mut square_sum = 0.0;
        let mut crossing_count = 0usize;
        let mut previous = 0.0f32;
        for index in 0..frame_samples {
            let byte_offset = (offset + index) * 4;
            let sample = f32::from_le_bytes([
                bytes[byte_offset],
                bytes[byte_offset + 1],
                bytes[byte_offset + 2],
                bytes[byte_offset + 3],
            ]);
            square_sum += f64::from(sample) * f64::from(sample);
            if index > 0 && (sample >= 0.0) != (previous >= 0.0) {
                crossing_count += 1;
            }
            previous = sample;
            frame_samples_values.push(f64::from(sample));
            if should_check_parse_cancellation(index + 1, LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES) {
                check_cancelled(cancel_flag)?;
            }
        }
        let rms = (square_sum / frame_samples as f64).sqrt();
        let zero_crossing_rate = crossing_count as f64 / frame_samples as f64;
        let mut values = vec![(rms * 8.0).min(1.0), (zero_crossing_rate * 12.0).min(1.0)];
        values.extend(calculate_spectral_features(
            &frame_samples_values,
            options.sample_rate,
            cancel_flag,
        )?);
        frames.push(AudioFeatureFrame {
            time_ms: presentation_time_from_sample_offset(
                offset,
                options.sample_rate,
                timeline_offset_ms,
            ),
            values,
        });
        offset += frame_samples;
    }
    check_cancelled(cancel_flag)?;
    if frames.is_empty() {
        return Err("未能提取到可用音频特征。".to_string());
    }
    Ok(frames)
}

fn presentation_time_from_sample_offset(
    sample_offset: usize,
    sample_rate: u32,
    timeline_offset_ms: i64,
) -> u64 {
    let decoded_offset_ms = (sample_offset as u128 * 1000) / u128::from(sample_rate.max(1));
    (i128::from(timeline_offset_ms) + decoded_offset_ms.min(i64::MAX as u128) as i128)
        .clamp(0, u64::MAX as i128) as u64
}

fn calculate_spectral_features(
    samples: &[f64],
    sample_rate: u32,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<f64>, String> {
    check_cancelled(cancel_flag)?;
    let mut powers = Vec::with_capacity(SPECTRAL_FREQUENCIES_HZ.len());
    for frequency in SPECTRAL_FREQUENCIES_HZ {
        powers.push(calculate_goertzel_power(
            samples,
            f64::from(sample_rate),
            frequency,
            cancel_flag,
        )?);
    }
    let total_power = powers.iter().sum::<f64>().max(0.000_001);
    let normalized = powers
        .into_iter()
        .map(|power| (power / total_power).sqrt().min(1.0))
        .collect();
    check_cancelled(cancel_flag)?;
    Ok(normalized)
}

fn calculate_goertzel_power(
    samples: &[f64],
    sample_rate: f64,
    frequency: f64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<f64, String> {
    check_cancelled(cancel_flag)?;
    if samples.is_empty() || sample_rate <= 0.0 {
        return Ok(0.0);
    }
    let normalized_frequency = frequency / sample_rate;
    let coefficient = 2.0 * (2.0 * std::f64::consts::PI * normalized_frequency).cos();
    let mut previous = 0.0;
    let mut previous2 = 0.0;
    for (index, sample) in samples.iter().enumerate() {
        let current = sample + coefficient * previous - previous2;
        previous2 = previous;
        previous = current;
        if should_check_parse_cancellation(index + 1, LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES) {
            check_cancelled(cancel_flag)?;
        }
    }
    check_cancelled(cancel_flag)?;
    Ok(previous2 * previous2 + previous * previous - coefficient * previous * previous2)
}

fn should_check_parse_cancellation(processed_items: usize, interval: usize) -> bool {
    interval != 0 && processed_items != 0 && processed_items.is_multiple_of(interval)
}

fn create_audio_alignment_proposal(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Result<AudioAlignmentProposal, String> {
    if complete_frames.is_empty() || source_frames.is_empty() {
        return Ok(AudioAlignmentProposal {
            anchors: Vec::new(),
            cut_candidates: Vec::new(),
            confidence: 0.0,
            diagnostics: vec!["音频特征为空，无法对齐。".to_string()],
            evidence: Some(AlignmentEvidenceSummary {
                algorithm: "sparse-fingerprint".to_string(),
                complete_fingerprint_count: 0,
                source_fingerprint_count: 0,
                fingerprint_match_count: 0,
                monotonic_match_count: 0,
                strong_anchor_count: 0,
                weak_anchor_count: 0,
                offset_cluster_count: 0,
                refined_candidate_count: 0,
                low_confidence_region_count: 1,
                quality: "blocked".to_string(),
                time_mapping_segment_count: None,
                confirmed_change_count: None,
                signals: None,
            }),
            match_range: None,
            time_map: None,
        });
    }
    let alignment = if options.localization_mode {
        create_localization_audio_alignment(complete_frames, source_frames, options)
    } else {
        create_multistage_audio_alignment(complete_frames, source_frames, options)?
    };
    benchmark_stage("refining", "推断并精修候选版本差异");
    let cut_candidates = if let Some(change_points) = &alignment.change_points {
        refine_cut_candidates(create_cut_candidates_from_time_mapping_changes(
            change_points,
        ))
    } else {
        refine_cut_candidates(infer_cut_candidates(&alignment.matches, options))
    };
    let cut_candidate_count = cut_candidates.len();
    let signals = create_evidence_signals(&alignment, cut_candidate_count, alignment.matches.len());
    let confirmed_change_count = alignment
        .change_points
        .as_ref()
        .map(|_| cut_candidate_count);
    let match_range = if options.localization_mode {
        create_localization_match_range(&alignment.matches, complete_frames, source_frames, options)
    } else {
        None
    };
    let matches = alignment.matches;
    let anchors = create_anchors(&matches, options.match_threshold);
    let coverage_frame_count = if options.localization_mode {
        complete_frames.len()
    } else {
        source_frames.len()
    };
    let coverage = matches.len() as f64 / coverage_frame_count.max(1) as f64;
    let strong_anchor_count = matches
        .iter()
        .filter(|item| item.distance <= options.match_threshold * 0.5)
        .count();
    let weak_anchor_count = matches.len().saturating_sub(strong_anchor_count);
    let mut diagnostics = alignment.diagnostics;
    diagnostics.push(format!(
        "音频特征匹配 {} / {} 帧，覆盖率 {}%。",
        matches.len(),
        coverage_frame_count,
        (coverage * 100.0).round()
    ));
    if let Some(range) = &match_range {
        diagnostics.push(format!(
            "长参考定位范围：参考 {}-{}，目标 {}-{}，目标覆盖率 {}%。",
            format_duration(range.source_start_ms),
            format_duration(range.source_end_ms),
            format_duration(range.target_start_ms),
            format_duration(range.target_end_ms),
            (range.coverage * 100.0).round()
        ));
    }
    diagnostics.push(if cut_candidate_count == 0 {
        "未发现超过阈值的候选缺失段。".to_string()
    } else {
        format!("已推断 {cut_candidate_count} 个候选缺失段。")
    });
    Ok(AudioAlignmentProposal {
        anchors,
        cut_candidates,
        confidence: coverage.clamp(0.0, 1.0),
        diagnostics,
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: alignment.algorithm,
            complete_fingerprint_count: alignment.complete_fingerprint_count,
            source_fingerprint_count: alignment.source_fingerprint_count,
            fingerprint_match_count: alignment.fingerprint_match_count,
            monotonic_match_count: matches.len(),
            strong_anchor_count,
            weak_anchor_count,
            offset_cluster_count: alignment.offset_cluster_count,
            refined_candidate_count: cut_candidate_count,
            low_confidence_region_count: alignment.low_confidence_region_count,
            time_mapping_segment_count: alignment.time_mapping_segment_count,
            confirmed_change_count,
            signals: Some(signals),
            quality: create_evidence_quality(
                coverage,
                strong_anchor_count,
                weak_anchor_count,
                alignment.low_confidence_region_count,
            ),
        }),
        match_range,
        time_map: None,
    })
}

fn create_multistage_audio_alignment(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Result<MultistageAudioAlignmentResult, String> {
    if source_frames.len() >= OFFSET_PATH_MIN_SOURCE_FRAMES {
        benchmark_stage("fitting", "拟合分块偏移路径");
        let offset_path =
            create_offset_path_audio_alignment(complete_frames, source_frames, options);
        let offset_path_coverage =
            offset_path.matches.len() as f64 / source_frames.len().max(1) as f64;
        if offset_path.fingerprint_match_count >= OFFSET_PATH_MIN_OBSERVATIONS
            && offset_path_coverage >= 0.6
        {
            return Ok(MultistageAudioAlignmentResult {
                algorithm: "time-map-audio".to_string(),
                matches: offset_path.matches,
                complete_fingerprint_count: offset_path.complete_fingerprint_count,
                source_fingerprint_count: offset_path.source_fingerprint_count,
                fingerprint_match_count: offset_path.fingerprint_match_count,
                offset_cluster_count: offset_path.offset_cluster_count,
                low_confidence_region_count: offset_path.low_confidence_region_count,
                diagnostics: offset_path.diagnostics,
                time_mapping_segment_count: offset_path.time_mapping_segment_count,
                change_points: offset_path.change_points,
            });
        }
    }

    let sparse = create_sparse_audio_alignment(complete_frames, source_frames, options);
    let sparse_coverage = sparse.matches.len() as f64 / source_frames.len().max(1) as f64;
    let required_matches = MIN_SPARSE_MATCHES.min(source_frames.len());
    if sparse.matches.len() >= required_matches && sparse_coverage >= MIN_SPARSE_COVERAGE {
        return Ok(MultistageAudioAlignmentResult {
            algorithm: "sparse-fingerprint".to_string(),
            matches: sparse.matches,
            complete_fingerprint_count: sparse.complete_fingerprint_count,
            source_fingerprint_count: sparse.source_fingerprint_count,
            fingerprint_match_count: sparse.fingerprint_match_count,
            offset_cluster_count: sparse.offset_cluster_count,
            low_confidence_region_count: sparse.low_confidence_region_count,
            diagnostics: sparse.diagnostics,
            time_mapping_segment_count: None,
            change_points: None,
        });
    }

    let cell_count = (complete_frames.len() + 1) * (source_frames.len() + 1);
    if cell_count > options.max_cells {
        let mut diagnostics = sparse.diagnostics;
        diagnostics.push(format!(
            "稀疏锚点不足，已跳过 {cell_count} 个 DP 单元的密集回退以避免平方级爆炸。"
        ));
        return Ok(MultistageAudioAlignmentResult {
            algorithm: "sparse-fingerprint".to_string(),
            matches: sparse.matches,
            complete_fingerprint_count: sparse.complete_fingerprint_count,
            source_fingerprint_count: sparse.source_fingerprint_count,
            fingerprint_match_count: sparse.fingerprint_match_count,
            offset_cluster_count: sparse.offset_cluster_count,
            low_confidence_region_count: sparse.low_confidence_region_count,
            diagnostics,
            time_mapping_segment_count: None,
            change_points: None,
        });
    }

    benchmark_stage("fitting", "执行密集时间序列回退");
    let dense_matches = align_audio_feature_sequences(complete_frames, source_frames, options)?;
    let low_confidence_region_count =
        sparse
            .low_confidence_region_count
            .max(estimate_low_confidence_region_count(
                dense_matches.len(),
                source_frames.len(),
            ));
    let mut diagnostics = sparse.diagnostics;
    diagnostics.push(format!(
        "稀疏锚点不足，已回退到密集 DP：{} 个匹配点。",
        dense_matches.len()
    ));
    Ok(MultistageAudioAlignmentResult {
        algorithm: "sparse-fingerprint-fallback".to_string(),
        matches: dense_matches,
        complete_fingerprint_count: sparse.complete_fingerprint_count,
        source_fingerprint_count: sparse.source_fingerprint_count,
        fingerprint_match_count: sparse.fingerprint_match_count,
        offset_cluster_count: sparse.offset_cluster_count,
        low_confidence_region_count,
        diagnostics,
        time_mapping_segment_count: None,
        change_points: None,
    })
}

fn create_localization_audio_alignment(
    target_frames: &[AudioFeatureFrame],
    reference_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> MultistageAudioAlignmentResult {
    benchmark_stage("fingerprinting", "生成定位音频指纹");
    let reference_fingerprints = create_audio_fingerprints(reference_frames);
    let target_fingerprints = create_audio_fingerprints(target_frames);
    benchmark_stage("matching", "建立定位候选观测");
    let candidates = create_sparse_audio_candidates(
        reference_frames,
        target_frames,
        &reference_fingerprints,
        &target_fingerprints,
        options.match_threshold,
    );
    let offset_clusters = create_offset_clusters(&candidates);
    let matches = select_monotonic_localization_matches(
        &candidates,
        &offset_clusters,
        options.match_threshold,
    );
    let match_count = matches.len();
    MultistageAudioAlignmentResult {
        algorithm: "sparse-fingerprint".to_string(),
        matches,
        complete_fingerprint_count: target_fingerprints.len(),
        source_fingerprint_count: reference_fingerprints.len(),
        fingerprint_match_count: candidates.len(),
        offset_cluster_count: offset_clusters.len(),
        low_confidence_region_count: estimate_low_confidence_region_count(
            match_count,
            target_frames.len(),
        ),
        diagnostics: vec![
            format!(
                "长参考定位：在 {} 个参考特征中检索 {} 个目标原片特征。",
                reference_frames.len(),
                target_frames.len()
            ),
            format!(
                "长参考定位：生成 {} 对稀疏候选，单调路径保留 {} 个目标锚点，offset 簇 {} 个。",
                candidates.len(),
                match_count,
                offset_clusters.len()
            ),
        ],
        time_mapping_segment_count: None,
        change_points: None,
    }
}

fn select_monotonic_localization_matches(
    candidates: &[SparseAudioCandidate],
    offset_clusters: &HashSet<i64>,
    match_threshold: f64,
) -> Vec<AudioFeatureMatch> {
    let mut by_target_index: HashMap<usize, Vec<&SparseAudioCandidate>> = HashMap::new();
    for candidate in candidates {
        if !offset_clusters.contains(&candidate.offset_bucket) {
            continue;
        }
        by_target_index
            .entry(candidate.source_index)
            .or_default()
            .push(candidate);
    }

    let mut target_indexes: Vec<usize> = by_target_index.keys().copied().collect();
    target_indexes.sort_unstable();
    let mut matches = Vec::new();
    let mut previous_reference_index: Option<usize> = None;
    let mut previous_offset_ms: Option<i64> = None;
    for target_index in target_indexes {
        let Some(group) = by_target_index.get(&target_index) else {
            continue;
        };
        let candidate = group
            .iter()
            .copied()
            .filter(|item| {
                previous_reference_index
                    .map(|previous| item.complete_index > previous)
                    .unwrap_or(true)
            })
            .filter(|item| {
                previous_offset_ms
                    .map(|previous| item.offset_ms <= previous + FINGERPRINT_BUCKET_MS)
                    .unwrap_or(true)
            })
            .max_by(|left, right| {
                score_sparse_candidate(left, previous_offset_ms, offset_clusters, match_threshold)
                    .total_cmp(&score_sparse_candidate(
                        right,
                        previous_offset_ms,
                        offset_clusters,
                        match_threshold,
                    ))
                    .then_with(|| right.complete_index.cmp(&left.complete_index))
            });
        let Some(candidate) = candidate else {
            continue;
        };
        matches.push(AudioFeatureMatch {
            complete_time_ms: candidate.source_time_ms,
            source_time_ms: candidate.complete_time_ms,
            distance: candidate.distance,
        });
        previous_reference_index = Some(candidate.complete_index);
        previous_offset_ms = Some(
            previous_offset_ms
                .map(|previous| previous.min(candidate.offset_ms))
                .unwrap_or(candidate.offset_ms),
        );
    }
    matches
}

fn create_localization_match_range(
    matches: &[AudioFeatureMatch],
    target_frames: &[AudioFeatureFrame],
    reference_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Option<AlignmentMatchRange> {
    if matches.is_empty() || target_frames.is_empty() || reference_frames.is_empty() {
        return None;
    }
    let mut ordered_matches = matches.to_vec();
    ordered_matches.sort_by_key(|item| (item.complete_time_ms, item.source_time_ms));
    let sample_count = (ordered_matches.len() / 5).clamp(1, 12);
    let early_offset_ms = median_offset(
        ordered_matches
            .iter()
            .take(sample_count)
            .map(|item| signed_time_offset(item.source_time_ms, item.complete_time_ms))
            .collect(),
    );
    let late_offset_ms = median_offset(
        ordered_matches
            .iter()
            .rev()
            .take(sample_count)
            .map(|item| signed_time_offset(item.source_time_ms, item.complete_time_ms))
            .collect(),
    );
    let target_step_ms = estimate_frame_step_ms(target_frames, options);
    let reference_step_ms = estimate_frame_step_ms(reference_frames, options);
    let target_start_ms = target_frames.first()?.time_ms;
    let target_end_ms = target_frames.last()?.time_ms.saturating_add(target_step_ms);
    let reference_end_ms = reference_frames
        .last()?
        .time_ms
        .saturating_add(reference_step_ms);
    let observed_source_start_ms = ordered_matches
        .iter()
        .map(|item| item.source_time_ms)
        .min()?;
    let observed_source_end_ms = ordered_matches
        .iter()
        .map(|item| item.source_time_ms)
        .max()?
        .saturating_add(reference_step_ms)
        .min(reference_end_ms);
    let extrapolated_source_start_ms =
        add_signed_milliseconds(target_start_ms, early_offset_ms, reference_end_ms);
    let extrapolated_source_end_ms =
        add_signed_milliseconds(target_end_ms, late_offset_ms, reference_end_ms);
    let source_start_ms = extrapolated_source_start_ms.min(observed_source_start_ms);
    let source_end_ms = extrapolated_source_end_ms.max(observed_source_end_ms);
    if source_end_ms <= source_start_ms || target_end_ms <= target_start_ms {
        return None;
    }
    Some(AlignmentMatchRange {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        coverage: (matches.len() as f64 / target_frames.len().max(1) as f64).clamp(0.0, 1.0),
    })
}

fn median_offset(mut offsets: Vec<i64>) -> i64 {
    offsets.sort_unstable();
    offsets
        .get(offsets.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(0)
}

fn signed_time_offset(source_time_ms: u64, target_time_ms: u64) -> i64 {
    let offset = source_time_ms as i128 - target_time_ms as i128;
    offset.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

fn add_signed_milliseconds(base_ms: u64, offset_ms: i64, upper_bound_ms: u64) -> u64 {
    (base_ms as i128 + offset_ms as i128).clamp(0, upper_bound_ms as i128) as u64
}

fn create_offset_path_audio_alignment(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> SparseAudioAlignmentResult {
    let frame_step_ms = estimate_frame_step_ms(source_frames, options);
    let block_size = create_offset_path_block_size(source_frames.len());
    let step_size = (block_size / OFFSET_PATH_STEP_DIVISOR).max(1);
    let raw_observations = create_offset_path_observations(
        complete_frames,
        source_frames,
        block_size,
        step_size,
        frame_step_ms,
    );
    let time_mapping =
        create_time_mapping_from_offset_observations(&raw_observations, options, frame_step_ms);
    let matches =
        expand_offset_path_matches(complete_frames, source_frames, &time_mapping.observations);
    let match_count = matches.len();
    let offset_cluster_count = time_mapping.segments.len();
    let low_confidence_region_count = raw_observations
        .iter()
        .filter(|observation| observation.distance > options.match_threshold)
        .count();
    let mut diagnostics = vec![format!(
        "音频时间映射：用 {block_size} 帧局部窗口生成 {} 个 offset 观测。",
        raw_observations.len()
    )];
    diagnostics.extend(time_mapping.diagnostics.clone());
    diagnostics.push(format!("音频时间映射：展开为 {match_count} 个单调匹配点。"));
    SparseAudioAlignmentResult {
        matches,
        complete_fingerprint_count: complete_frames.len(),
        source_fingerprint_count: source_frames.len(),
        fingerprint_match_count: raw_observations.len(),
        offset_cluster_count,
        low_confidence_region_count,
        diagnostics,
        time_mapping_segment_count: Some(time_mapping.segments.len()),
        change_points: Some(time_mapping.change_points),
    }
}

fn create_time_mapping_from_offset_observations(
    observations: &[OffsetPathObservation],
    options: &AudioAlignmentOptions,
    frame_step_ms: u64,
) -> TimeMappingResult {
    let stable_observations = stabilize_offset_observations(
        smooth_offset_observations(observations),
        options.min_gap_ms,
        frame_step_ms,
    );
    let segments = create_time_mapping_segments(&stable_observations, frame_step_ms);
    let change_points =
        create_time_mapping_change_points(&segments, options.min_gap_ms, frame_step_ms);
    TimeMappingResult {
        observations: stable_observations,
        diagnostics: vec![
            format!("时间映射：稳定后得到 {} 个持续 offset 段。", segments.len()),
            if change_points.is_empty() {
                "时间映射：未确认持续阶跃变点。".to_string()
            } else {
                format!("时间映射：确认 {} 个持续阶跃变点。", change_points.len())
            },
        ],
        segments,
        change_points,
    }
}

fn create_time_mapping_segments(
    observations: &[OffsetPathObservation],
    frame_step_ms: u64,
) -> Vec<TimeMappingSegment> {
    let mut segments: Vec<TimeMappingSegment> = Vec::new();
    for observation in observations {
        let offset_ms = round_to_step(observation.offset_ms, frame_step_ms);
        if let Some(previous) = segments.last_mut() {
            if previous.offset_ms == offset_ms {
                previous.source_end_ms = observation.source_time_ms;
                previous.observation_count += 1;
                previous.mean_distance = (previous.mean_distance
                    * (previous.observation_count - 1) as f64
                    + observation.distance)
                    / previous.observation_count as f64;
                continue;
            }
        }
        segments.push(TimeMappingSegment {
            source_start_ms: observation.source_time_ms,
            source_end_ms: observation.source_time_ms,
            offset_ms,
            observation_count: 1,
            mean_distance: observation.distance,
        });
    }
    segments
}

fn create_time_mapping_change_points(
    segments: &[TimeMappingSegment],
    min_gap_ms: u64,
    frame_step_ms: u64,
) -> Vec<TimeMappingChangePoint> {
    let mut change_points = Vec::new();
    let min_stable_span_ms =
        TIME_MAPPING_MIN_STABLE_SPAN_MS.max(frame_step_ms * OFFSET_PATH_STABLE_OBSERVATIONS as u64);
    for index in 1..segments.len() {
        let previous = &segments[index - 1];
        let current = &segments[index];
        let target_gap_ms = current.offset_ms - previous.offset_ms;
        let current_span_ms = current
            .source_end_ms
            .saturating_sub(current.source_start_ms)
            + frame_step_ms;
        if target_gap_ms < min_gap_ms as i64 || current_span_ms < min_stable_span_ms {
            continue;
        }
        let support_score = (current.observation_count as f64
            / OFFSET_PATH_STABLE_OBSERVATIONS as f64)
            .clamp(0.0, 1.0);
        let distance_score =
            (1.0 - current.mean_distance / DEFAULT_MATCH_THRESHOLD).clamp(0.0, 1.0);
        change_points.push(TimeMappingChangePoint {
            source_at_ms: (previous.source_end_ms + current.source_start_ms) / 2,
            source_range_start_ms: previous.source_end_ms,
            source_range_end_ms: current.source_start_ms,
            target_gap_ms: target_gap_ms as u64,
            support_count: current.observation_count,
            confidence: (0.45 + support_score * 0.35 + distance_score * 0.15).clamp(0.1, 0.98),
        });
    }
    change_points
}

fn create_offset_path_observations(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    block_size: usize,
    step_size: usize,
    frame_step_ms: u64,
) -> Vec<OffsetPathObservation> {
    let half_block = block_size / 2;
    let offset_steps = create_offset_search_steps(complete_frames, source_frames, frame_step_ms);
    let mut observations = Vec::new();
    let mut source_index = half_block;
    while source_index < source_frames.len().saturating_sub(half_block) {
        if let Some(observation) = find_best_offset_observation(
            complete_frames,
            source_frames,
            source_index,
            block_size,
            &offset_steps,
        ) {
            observations.push(observation);
        }
        source_index += step_size;
    }
    if observations.is_empty() && !source_frames.is_empty() {
        if let Some(observation) = find_best_offset_observation(
            complete_frames,
            source_frames,
            source_frames.len() / 2,
            block_size.min(source_frames.len()),
            &offset_steps,
        ) {
            observations.push(observation);
        }
    }
    observations
}

fn find_best_offset_observation(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    source_index: usize,
    block_size: usize,
    offset_steps: &[i64],
) -> Option<OffsetPathObservation> {
    let half_block = block_size / 2;
    let mut best: Option<OffsetPathObservation> = None;
    for offset_step in offset_steps {
        let complete_center_index = source_index as i64 + offset_step;
        if complete_center_index < 0 {
            continue;
        }
        let source_start = source_index as i64 - half_block as i64;
        let complete_start = complete_center_index - half_block as i64;
        if source_start < 0
            || complete_start < 0
            || source_start as usize + block_size > source_frames.len()
            || complete_start as usize + block_size > complete_frames.len()
        {
            continue;
        }
        let mut total_distance = 0.0;
        for block_offset in 0..block_size {
            total_distance += get_feature_distance(
                &complete_frames[complete_start as usize + block_offset],
                &source_frames[source_start as usize + block_offset],
            );
        }
        let distance = total_distance / block_size as f64;
        if best
            .as_ref()
            .map(|current| distance < current.distance)
            .unwrap_or(true)
        {
            let complete_index = complete_center_index as usize;
            best = Some(OffsetPathObservation {
                source_time_ms: source_frames[source_index].time_ms,
                offset_ms: complete_frames[complete_index].time_ms as i64
                    - source_frames[source_index].time_ms as i64,
                distance,
            });
        }
    }
    best
}

fn create_offset_search_steps(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    frame_step_ms: u64,
) -> Vec<i64> {
    let complete_end_ms = complete_frames
        .last()
        .map(|frame| frame.time_ms)
        .unwrap_or(0) as i64;
    let source_end_ms = source_frames.last().map(|frame| frame.time_ms).unwrap_or(0) as i64;
    let duration_delta_ms = complete_end_ms - source_end_ms;
    let min_offset_ms =
        (-OFFSET_PATH_MAX_SEARCH_MS).max(duration_delta_ms.min(0) - OFFSET_PATH_SEARCH_MARGIN_MS);
    let max_offset_ms =
        OFFSET_PATH_MAX_SEARCH_MS.min(duration_delta_ms.max(0) + OFFSET_PATH_SEARCH_MARGIN_MS);
    let frame_step = frame_step_ms.max(1) as f64;
    let min_step = (min_offset_ms as f64 / frame_step).floor() as i64;
    let max_step = (max_offset_ms as f64 / frame_step).ceil() as i64;
    (min_step..=max_step).collect()
}

fn smooth_offset_observations(
    observations: &[OffsetPathObservation],
) -> Vec<OffsetPathObservation> {
    observations
        .iter()
        .enumerate()
        .map(|(index, observation)| {
            let start = index.saturating_sub(2);
            let end = (index + 3).min(observations.len());
            let mut nearby_offsets: Vec<i64> = observations[start..end]
                .iter()
                .map(|item| item.offset_ms)
                .collect();
            nearby_offsets.sort_unstable();
            OffsetPathObservation {
                offset_ms: nearby_offsets
                    .get(nearby_offsets.len() / 2)
                    .copied()
                    .unwrap_or(observation.offset_ms),
                ..observation.clone()
            }
        })
        .collect()
}

fn stabilize_offset_observations(
    observations: Vec<OffsetPathObservation>,
    min_gap_ms: u64,
    frame_step_ms: u64,
) -> Vec<OffsetPathObservation> {
    if observations.is_empty() {
        return Vec::new();
    }
    let mut stable = Vec::new();
    let mut active_offset_ms = round_to_step(observations[0].offset_ms, frame_step_ms);
    for index in 0..observations.len() {
        let candidate_offset_ms = round_to_step(observations[index].offset_ms, frame_step_ms);
        if candidate_offset_ms - active_offset_ms >= min_gap_ms as i64 {
            let support_count =
                count_offset_support(&observations, index, candidate_offset_ms, frame_step_ms);
            let support_window_size = (observations.len() - index)
                .min(OFFSET_PATH_STABLE_OBSERVATIONS * OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER);
            let required_support = OFFSET_PATH_STABLE_OBSERVATIONS
                .min(support_window_size)
                .max(
                    (support_window_size as f64 * OFFSET_PATH_STABLE_SUPPORT_RATIO).ceil() as usize,
                );
            if support_count >= required_support {
                active_offset_ms = candidate_offset_ms;
            }
        }
        stable.push(OffsetPathObservation {
            offset_ms: active_offset_ms,
            ..observations[index].clone()
        });
    }
    stable
}

fn count_offset_support(
    observations: &[OffsetPathObservation],
    start_index: usize,
    offset_ms: i64,
    frame_step_ms: u64,
) -> usize {
    let mut count = 0;
    let end_index = (start_index
        + OFFSET_PATH_STABLE_OBSERVATIONS * OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER)
        .min(observations.len());
    for observation in observations.iter().take(end_index).skip(start_index) {
        if round_to_step(observation.offset_ms, frame_step_ms).abs_diff(offset_ms) <= frame_step_ms
        {
            count += 1;
        }
    }
    count
}

fn expand_offset_path_matches(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    observations: &[OffsetPathObservation],
) -> Vec<AudioFeatureMatch> {
    if observations.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    let mut observation_index = 0usize;
    for (source_index, source_frame) in source_frames.iter().enumerate() {
        while observation_index + 1 < observations.len()
            && observations[observation_index + 1]
                .source_time_ms
                .abs_diff(source_frame.time_ms)
                <= observations[observation_index]
                    .source_time_ms
                    .abs_diff(source_frame.time_ms)
        {
            observation_index += 1;
        }
        let complete_time_ms =
            source_frame.time_ms as i64 + observations[observation_index].offset_ms;
        if complete_time_ms < 0 {
            continue;
        }
        let Some(complete_index) =
            find_nearest_frame_index(complete_frames, complete_time_ms as u64)
        else {
            continue;
        };
        matches.push(AudioFeatureMatch {
            complete_time_ms: complete_frames[complete_index].time_ms,
            source_time_ms: source_frame.time_ms,
            distance: get_feature_distance(&complete_frames[complete_index], source_frame),
        });
        let _ = source_index;
    }
    matches
}

fn find_nearest_frame_index(frames: &[AudioFeatureFrame], time_ms: u64) -> Option<usize> {
    if frames.is_empty() || time_ms < frames[0].time_ms || time_ms > frames.last()?.time_ms {
        return None;
    }
    let mut best_index = 0usize;
    let mut best_distance = frames[0].time_ms.abs_diff(time_ms);
    for (index, frame) in frames.iter().enumerate().skip(1) {
        let distance = frame.time_ms.abs_diff(time_ms);
        if distance > best_distance {
            break;
        }
        best_index = index;
        best_distance = distance;
    }
    Some(best_index)
}

fn create_offset_path_block_size(source_frame_count: usize) -> usize {
    if source_frame_count <= OFFSET_PATH_MIN_BLOCK_FRAMES {
        return source_frame_count.max(1);
    }
    OFFSET_PATH_TARGET_BLOCK_FRAMES.min(OFFSET_PATH_MIN_BLOCK_FRAMES.max(source_frame_count / 4))
}

fn estimate_frame_step_ms(frames: &[AudioFeatureFrame], options: &AudioAlignmentOptions) -> u64 {
    if frames.len() >= 2 {
        return frames[1].time_ms.saturating_sub(frames[0].time_ms).max(1);
    }
    options.window_ms.max(1)
}

fn round_to_step(value: i64, step: u64) -> i64 {
    ((value as f64 / step.max(1) as f64).round() * step.max(1) as f64) as i64
}

fn create_sparse_audio_alignment(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> SparseAudioAlignmentResult {
    benchmark_stage("fingerprinting", "生成稀疏音频指纹");
    let complete_fingerprints = create_audio_fingerprints(complete_frames);
    let source_fingerprints = create_audio_fingerprints(source_frames);
    benchmark_stage("matching", "建立稀疏候选观测");
    let candidates = create_sparse_audio_candidates(
        complete_frames,
        source_frames,
        &complete_fingerprints,
        &source_fingerprints,
        options.match_threshold,
    );
    let offset_clusters = create_offset_clusters(&candidates);
    let matches =
        select_monotonic_sparse_matches(&candidates, &offset_clusters, options.match_threshold);
    let match_count = matches.len();
    let low_confidence_region_count =
        estimate_low_confidence_region_count(match_count, source_frames.len());
    SparseAudioAlignmentResult {
        matches,
        complete_fingerprint_count: complete_fingerprints.len(),
        source_fingerprint_count: source_fingerprints.len(),
        fingerprint_match_count: candidates.len(),
        offset_cluster_count: offset_clusters.len(),
        low_confidence_region_count,
        diagnostics: vec![
            format!(
                "多阶段对齐：生成完整版 {} 个、B 站删减版 {} 个稀疏音频指纹。",
                complete_fingerprints.len(),
                source_fingerprints.len()
            ),
            format!(
                "稀疏锚点匹配 {} 对，单调路径保留 {} 个锚点，offset 簇 {} 个。",
                candidates.len(),
                match_count,
                offset_clusters.len()
            ),
        ],
        time_mapping_segment_count: None,
        change_points: None,
    }
}

fn create_audio_fingerprints(frames: &[AudioFeatureFrame]) -> Vec<AudioFingerprint> {
    frames
        .iter()
        .enumerate()
        .map(|(frame_index, frame)| AudioFingerprint {
            key: create_audio_fingerprint_key(frame),
            frame_index,
            time_ms: frame.time_ms,
        })
        .collect()
}

fn create_audio_fingerprint_key(frame: &AudioFeatureFrame) -> u64 {
    let width = frame.values.len().clamp(1, 4);
    let mut key = width as u64;
    for index in 0..width {
        key = key * 37 + quantize_feature(frame.values.get(index).copied().unwrap_or(0.0));
    }
    key
}

fn quantize_feature(value: f64) -> u64 {
    if !value.is_finite() {
        return 0;
    }
    (value.clamp(0.0, 1.0) * 32.0).round() as u64
}

fn create_sparse_audio_candidates(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    complete_fingerprints: &[AudioFingerprint],
    source_fingerprints: &[AudioFingerprint],
    match_threshold: f64,
) -> Vec<SparseAudioCandidate> {
    let mut complete_by_key: HashMap<u64, Vec<AudioFingerprint>> = HashMap::new();
    for fingerprint in complete_fingerprints {
        complete_by_key
            .entry(fingerprint.key)
            .or_default()
            .push(fingerprint.clone());
    }

    let mut candidates = Vec::new();
    for source_fingerprint in source_fingerprints {
        let Some(complete_matches) = complete_by_key.get(&source_fingerprint.key) else {
            continue;
        };
        for complete_fingerprint in select_complete_fingerprints_for_key(complete_matches) {
            let complete_frame = &complete_frames[complete_fingerprint.frame_index];
            let source_frame = &source_frames[source_fingerprint.frame_index];
            let distance = get_feature_distance(complete_frame, source_frame);
            if distance > match_threshold.max(0.05) {
                continue;
            }
            let offset_ms = complete_fingerprint.time_ms as i64 - source_fingerprint.time_ms as i64;
            candidates.push(SparseAudioCandidate {
                complete_index: complete_fingerprint.frame_index,
                source_index: source_fingerprint.frame_index,
                complete_time_ms: complete_fingerprint.time_ms,
                source_time_ms: source_fingerprint.time_ms,
                distance,
                offset_ms,
                offset_bucket: (offset_ms as f64 / FINGERPRINT_BUCKET_MS as f64).round() as i64,
            });
            if candidates.len() >= MAX_SPARSE_MATCH_CANDIDATES {
                return candidates;
            }
        }
    }
    candidates
}

fn select_complete_fingerprints_for_key(items: &[AudioFingerprint]) -> Vec<&AudioFingerprint> {
    if items.len() <= MAX_COMPLETE_FINGERPRINTS_PER_KEY {
        return items.iter().collect();
    }
    let mut selected = Vec::new();
    let step = (items.len() - 1) as f64 / (MAX_COMPLETE_FINGERPRINTS_PER_KEY - 1) as f64;
    for index in 0..MAX_COMPLETE_FINGERPRINTS_PER_KEY {
        selected.push(&items[(index as f64 * step).round() as usize]);
    }
    selected
}

fn create_offset_clusters(candidates: &[SparseAudioCandidate]) -> HashSet<i64> {
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for candidate in candidates {
        *counts.entry(candidate.offset_bucket).or_default() += 1;
    }
    let mut sorted: Vec<(i64, usize)> = counts.into_iter().collect();
    sorted.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let mut accepted = HashSet::new();
    for (bucket, count) in sorted.into_iter().take(24) {
        if count >= 2 || accepted.len() < 8 {
            accepted.insert(bucket);
        }
    }
    accepted
}

fn select_monotonic_sparse_matches(
    candidates: &[SparseAudioCandidate],
    offset_clusters: &HashSet<i64>,
    match_threshold: f64,
) -> Vec<AudioFeatureMatch> {
    let mut by_source_index: HashMap<usize, Vec<&SparseAudioCandidate>> = HashMap::new();
    for candidate in candidates {
        if !offset_clusters.contains(&candidate.offset_bucket) {
            continue;
        }
        by_source_index
            .entry(candidate.source_index)
            .or_default()
            .push(candidate);
    }

    let mut source_indexes: Vec<usize> = by_source_index.keys().copied().collect();
    source_indexes.sort_unstable();
    let mut matches = Vec::new();
    let mut previous_complete_index: Option<usize> = None;
    let mut previous_offset_ms: Option<i64> = None;
    for source_index in source_indexes {
        let Some(group) = by_source_index.get(&source_index) else {
            continue;
        };
        let candidate = group
            .iter()
            .copied()
            .filter(|item| {
                previous_complete_index
                    .map(|previous| item.complete_index > previous)
                    .unwrap_or(true)
            })
            .filter(|item| {
                previous_offset_ms
                    .map(|previous| item.offset_ms + FINGERPRINT_BUCKET_MS >= previous)
                    .unwrap_or(true)
            })
            .max_by(|left, right| {
                score_sparse_candidate(left, previous_offset_ms, offset_clusters, match_threshold)
                    .total_cmp(&score_sparse_candidate(
                        right,
                        previous_offset_ms,
                        offset_clusters,
                        match_threshold,
                    ))
                    .then_with(|| right.complete_index.cmp(&left.complete_index))
            });
        let Some(candidate) = candidate else {
            continue;
        };
        matches.push(AudioFeatureMatch {
            complete_time_ms: candidate.complete_time_ms,
            source_time_ms: candidate.source_time_ms,
            distance: candidate.distance,
        });
        previous_complete_index = Some(candidate.complete_index);
        previous_offset_ms = Some(
            previous_offset_ms
                .map(|previous| previous.max(candidate.offset_ms))
                .unwrap_or(candidate.offset_ms),
        );
    }
    matches
}

fn score_sparse_candidate(
    candidate: &SparseAudioCandidate,
    previous_offset_ms: Option<i64>,
    offset_clusters: &HashSet<i64>,
    match_threshold: f64,
) -> f64 {
    let cluster_score = if offset_clusters.contains(&candidate.offset_bucket) {
        3.0
    } else {
        0.0
    };
    let match_score = 1.0 - candidate.distance / match_threshold.max(0.000_001);
    let offset_penalty = previous_offset_ms
        .map(|previous| {
            candidate.offset_ms.abs_diff(previous) as f64 / FINGERPRINT_BUCKET_MS as f64
        })
        .unwrap_or(0.0);
    cluster_score + match_score - offset_penalty
}

fn align_audio_feature_sequences(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Result<Vec<AudioFeatureMatch>, String> {
    let width = source_frames.len() + 1;
    let cell_count = (complete_frames.len() + 1) * width;
    if cell_count > options.max_cells {
        return Err(format!(
            "音频特征数量过多：{cell_count} 个 DP 单元，请增大采样窗口或提高 maxCells。"
        ));
    }
    let mut previous = vec![0.0; width];
    let mut directions = vec![0u8; cell_count];
    for complete_index in 1..=complete_frames.len() {
        let mut current = vec![0.0; width];
        for source_index in 1..=source_frames.len() {
            let distance = get_feature_distance(
                &complete_frames[complete_index - 1],
                &source_frames[source_index - 1],
            );
            let match_score = if distance <= options.match_threshold {
                1.0 - distance / options.match_threshold
            } else {
                f64::NEG_INFINITY
            };
            let skip_complete_score = previous[source_index];
            let skip_source_score = current[source_index - 1];
            let matched_score = previous[source_index - 1] + match_score;
            let cell_offset = complete_index * width + source_index;
            if matched_score >= skip_complete_score && matched_score >= skip_source_score {
                current[source_index] = matched_score;
                directions[cell_offset] = DIRECTION_MATCH;
            } else if skip_complete_score >= skip_source_score {
                current[source_index] = skip_complete_score;
                directions[cell_offset] = DIRECTION_SKIP_COMPLETE;
            } else {
                current[source_index] = skip_source_score;
                directions[cell_offset] = DIRECTION_SKIP_SOURCE;
            }
        }
        previous = current;
    }
    Ok(backtrack_matches(
        complete_frames,
        source_frames,
        &directions,
    ))
}

fn backtrack_matches(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    directions: &[u8],
) -> Vec<AudioFeatureMatch> {
    let width = source_frames.len() + 1;
    let mut matches = Vec::new();
    let mut complete_index = complete_frames.len();
    let mut source_index = source_frames.len();
    while complete_index > 0 && source_index > 0 {
        let direction = directions[complete_index * width + source_index];
        if direction == DIRECTION_MATCH {
            let complete_frame = &complete_frames[complete_index - 1];
            let source_frame = &source_frames[source_index - 1];
            matches.push(AudioFeatureMatch {
                complete_time_ms: complete_frame.time_ms,
                source_time_ms: source_frame.time_ms,
                distance: get_feature_distance(complete_frame, source_frame),
            });
            complete_index -= 1;
            source_index -= 1;
        } else if direction == DIRECTION_SKIP_COMPLETE {
            complete_index -= 1;
        } else {
            source_index -= 1;
        }
    }
    matches.reverse();
    matches
}

fn infer_cut_candidates(
    matches: &[AudioFeatureMatch],
    options: &AudioAlignmentOptions,
) -> Vec<CutCandidateDto> {
    let mut candidates = Vec::new();
    for window in matches.windows(2) {
        let previous = &window[0];
        let current = &window[1];
        let complete_delta_ms = current
            .complete_time_ms
            .saturating_sub(previous.complete_time_ms);
        let source_delta_ms = current
            .source_time_ms
            .saturating_sub(previous.source_time_ms);
        let missing_duration_ms = complete_delta_ms.saturating_sub(source_delta_ms);
        if missing_duration_ms < options.min_gap_ms {
            continue;
        }
        let source_at_ms = estimate_cut_boundary_ms(previous, current);
        let confidence = (1.0
            - (previous.distance + current.distance) / (2.0 * options.match_threshold))
            .clamp(0.1, 0.95);
        candidates.push(CutCandidateDto {
            id: format!("audio-gap-{}", candidates.len() + 1),
            name: format!("音频推断差异 {}", candidates.len() + 1),
            source_at_ms,
            source_range_start_ms: previous.source_time_ms,
            source_range_end_ms: current.source_time_ms,
            target_gap_ms: missing_duration_ms,
            confidence,
            note: format!(
                "音频对齐显示完整版比当前视频多出约 {}，候选边界约在当前视频 {}。",
                format_duration(missing_duration_ms),
                format_duration(source_at_ms)
            ),
        });
    }
    merge_nearby_candidates(candidates)
}

fn create_cut_candidates_from_time_mapping_changes(
    change_points: &[TimeMappingChangePoint],
) -> Vec<CutCandidateDto> {
    change_points
        .iter()
        .enumerate()
        .map(|(index, change_point)| CutCandidateDto {
            id: format!("audio-gap-{}", index + 1),
            name: format!("音频时间映射差异 {}", index + 1),
            source_at_ms: change_point.source_at_ms,
            source_range_start_ms: change_point.source_range_start_ms,
            source_range_end_ms: change_point.source_range_end_ms,
            target_gap_ms: change_point.target_gap_ms,
            confidence: change_point.confidence,
            note: format!(
                "音频时间映射显示 offset 在当前视频 {} 附近持续增加 {}，后续 {} 个观测窗口保持稳定，建议在该区间试听复核。",
                format_duration(change_point.source_at_ms),
                format_duration(change_point.target_gap_ms),
                change_point.support_count
            ),
        })
        .collect()
}

fn refine_cut_candidates(candidates: Vec<CutCandidateDto>) -> Vec<CutCandidateDto> {
    candidates
        .into_iter()
        .map(|mut candidate| {
            if candidate.source_range_end_ms <= candidate.source_range_start_ms {
                return candidate;
            }
            candidate.source_at_ms = candidate.source_range_start_ms
                + (candidate.source_range_end_ms - candidate.source_range_start_ms) / 2;
            candidate.confidence = (candidate.confidence + 0.03).clamp(0.1, 0.98);
            candidate.note = format!(
                "{} 已用相邻单调锚点给出复核区间 {}-{}。",
                candidate.note,
                format_duration(candidate.source_range_start_ms),
                format_duration(candidate.source_range_end_ms)
            );
            candidate
        })
        .collect()
}

fn estimate_low_confidence_region_count(match_count: usize, source_frame_count: usize) -> usize {
    let unmatched_count = source_frame_count.saturating_sub(match_count);
    if unmatched_count == 0 {
        return 0;
    }
    (unmatched_count as f64 / 5.0).ceil().max(1.0) as usize
}

fn create_evidence_quality(
    coverage: f64,
    strong_anchor_count: usize,
    weak_anchor_count: usize,
    low_confidence_region_count: usize,
) -> String {
    if coverage == 0.0 || low_confidence_region_count >= 6 {
        return "blocked".to_string();
    }
    if coverage >= 0.75
        && strong_anchor_count >= weak_anchor_count
        && low_confidence_region_count <= 1
    {
        return "high".to_string();
    }
    if coverage >= 0.45 && low_confidence_region_count <= 3 {
        return "medium".to_string();
    }
    "low".to_string()
}

fn create_evidence_signals(
    alignment: &MultistageAudioAlignmentResult,
    confirmed_change_count: usize,
    match_count: usize,
) -> Vec<AlignmentEvidenceSignalSummary> {
    vec![
        AlignmentEvidenceSignalSummary {
            kind: "audio",
            status: if match_count > 0 { "used" } else { "blocked" },
            label: "音频时间映射",
            observations: alignment.fingerprint_match_count,
            weight: 1.0,
            note: if alignment.algorithm == "time-map-audio" {
                format!(
                    "已用音频指纹建立 {} 个稳定时间段，确认 {confirmed_change_count} 个持续变点。",
                    alignment
                        .time_mapping_segment_count
                        .unwrap_or(alignment.offset_cluster_count)
                )
            } else {
                "已用音频指纹生成单调锚点；未进入持续时间映射路径。".to_string()
            },
        },
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "notConfigured",
            label: "鲁棒视觉指纹",
            observations: 0,
            weight: 0.0,
            note: "当前版本未采样视觉证据；未来只作为水印/字幕降权后的辅助确认，不单独宣判删减。"
                .to_string(),
        },
        AlignmentEvidenceSignalSummary {
            kind: "danmaku",
            status: "notConfigured",
            label: "弹幕文本线索",
            observations: 0,
            weight: 0.0,
            note: "当前本地音频对齐未融合弹幕语义；弹幕线索仍保留为人工复核参考。".to_string(),
        },
    ]
}

fn apply_visual_evidence_to_proposal(
    proposal: &mut AudioAlignmentProposal,
    visual_features: Option<&(CachedVisualFeatures, CachedVisualFeatures)>,
    visual_error: Option<String>,
) {
    let signal = if let Some((complete_visual, source_visual)) = visual_features {
        match summarize_visual_time_mapping_evidence(
            &complete_visual.frames,
            &source_visual.frames,
            &proposal.anchors,
        ) {
            Some(summary) => {
                let support_ratio =
                    summary.supported_observations as f64 / summary.observations.max(1) as f64;
                if support_ratio >= 0.55 && !proposal.cut_candidates.is_empty() {
                    for candidate in &mut proposal.cut_candidates {
                        candidate.confidence = (candidate.confidence + 0.02).clamp(0.1, 0.98);
                        candidate
                            .note
                            .push_str(" 鲁棒视觉辅助与音频时间映射总体一致。");
                    }
                }
                proposal.diagnostics.push(format!(
                    "鲁棒视觉证据：{} / {} 个时间映射锚点得到画面结构支持，平均距离 {:.3}。",
                    summary.supported_observations, summary.observations, summary.mean_distance
                ));
                AlignmentEvidenceSignalSummary {
                    kind: "visual",
                    status: "used",
                    label: "鲁棒视觉指纹",
                    observations: summary.observations,
                    weight: 0.25,
                    note: format!(
                        "已用低频画面指纹复核时间映射；右上水印、底部字幕带和边缘区域已降权，支持率 {}%。",
                        (support_ratio * 100.0).round()
                    ),
                }
            }
            None => AlignmentEvidenceSignalSummary {
                kind: "visual",
                status: "blocked",
                label: "鲁棒视觉指纹",
                observations: 0,
                weight: 0.0,
                note: "视觉指纹不足，未参与本次结论。".to_string(),
            },
        }
    } else if let Some(error) = visual_error {
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "blocked",
            label: "鲁棒视觉指纹",
            observations: 0,
            weight: 0.0,
            note: format!("视觉证据不可用：{}", truncate_visual_note(&error)),
        }
    } else {
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "notConfigured",
            label: "鲁棒视觉指纹",
            observations: 0,
            weight: 0.0,
            note: "当前运行未启用视觉辅助；视觉不会参与本次结论。".to_string(),
        }
    };
    replace_visual_evidence_signal(proposal, signal);
}

fn summarize_visual_time_mapping_evidence(
    complete_frames: &[VisualFeatureFrame],
    source_frames: &[VisualFeatureFrame],
    anchors: &[SyncAnchorDto],
) -> Option<VisualTimeMappingEvidence> {
    if complete_frames.is_empty() || source_frames.is_empty() || anchors.is_empty() {
        return None;
    }
    let complete_step_ms = estimate_visual_frame_step_ms(complete_frames);
    let source_step_ms = estimate_visual_frame_step_ms(source_frames);
    let max_distance_ms = complete_step_ms.max(source_step_ms) * 2;
    let stride = (anchors.len() / 160).max(1);
    let mut observations = 0usize;
    let mut supported_observations = 0usize;
    let mut total_distance = 0.0;
    for anchor in anchors.iter().step_by(stride) {
        let Some(complete_frame) = find_nearest_visual_frame(complete_frames, anchor.target_ms)
        else {
            continue;
        };
        let Some(source_frame) = find_nearest_visual_frame(source_frames, anchor.source_ms) else {
            continue;
        };
        if complete_frame.time_ms.abs_diff(anchor.target_ms) > max_distance_ms
            || source_frame.time_ms.abs_diff(anchor.source_ms) > max_distance_ms
        {
            continue;
        }
        let distance = get_visual_feature_distance(complete_frame, source_frame);
        observations += 1;
        total_distance += distance;
        if distance <= VISUAL_MATCH_THRESHOLD {
            supported_observations += 1;
        }
    }
    if observations == 0 {
        return None;
    }
    Some(VisualTimeMappingEvidence {
        observations,
        supported_observations,
        mean_distance: total_distance / observations as f64,
    })
}

fn estimate_visual_frame_step_ms(frames: &[VisualFeatureFrame]) -> u64 {
    if frames.len() >= 2 {
        frames[1].time_ms.saturating_sub(frames[0].time_ms).max(1)
    } else {
        DEFAULT_VISUAL_SAMPLE_INTERVAL_MS
    }
}

fn find_nearest_visual_frame(
    frames: &[VisualFeatureFrame],
    time_ms: u64,
) -> Option<&VisualFeatureFrame> {
    frames
        .iter()
        .min_by_key(|frame| frame.time_ms.abs_diff(time_ms))
}

fn get_visual_feature_distance(left: &VisualFeatureFrame, right: &VisualFeatureFrame) -> f64 {
    let structural_width = left.values.len().max(right.values.len()).saturating_sub(2);
    if structural_width == 0 {
        return 1.0;
    }
    let total = (0..structural_width)
        .map(|index| {
            let delta = left.values.get(index + 2).copied().unwrap_or(0.0)
                - right.values.get(index + 2).copied().unwrap_or(0.0);
            delta * delta
        })
        .sum::<f64>();
    let structural = (total / structural_width as f64).sqrt();
    let mean_delta =
        left.values.first().copied().unwrap_or(0.0) - right.values.first().copied().unwrap_or(0.0);
    let contrast_delta =
        left.values.get(1).copied().unwrap_or(0.0) - right.values.get(1).copied().unwrap_or(0.0);
    structural + mean_delta.abs() * 0.15 + contrast_delta.abs() * 0.25
}

fn visual_information_score(frame: &VisualFeatureFrame) -> f64 {
    frame.values.get(1).copied().unwrap_or(0.0)
}

fn match_visual_features_affine(
    source_frames: &[VisualFeatureFrame],
    target_frames: &[VisualFeatureFrame],
    cancel_flag: Option<&AtomicBool>,
) -> Result<VisualAffineMatchResult, String> {
    check_cancelled(cancel_flag)?;
    let source_indices = uniformly_sample_informative_visual_indices(source_frames);
    let target_indices = uniformly_sample_informative_visual_indices(target_frames);
    if source_indices.len() < ALIGNMENT_V2_VISUAL_MIN_INLIERS
        || target_indices.len() < ALIGNMENT_V2_VISUAL_MIN_INLIERS
    {
        return Ok(VisualAffineMatchResult {
            hypotheses: Vec::new(),
            informative_source_count: source_indices.len(),
            informative_target_count: target_indices.len(),
            candidate_count: 0,
            top1_top2_margin: 0.0,
        });
    }

    let mut candidates_by_source = Vec::with_capacity(source_indices.len());
    for (position, source_index) in source_indices.iter().copied().enumerate() {
        if position % 16 == 0 {
            check_cancelled(cancel_flag)?;
        }
        let source = &source_frames[source_index];
        let mut candidates = target_indices
            .iter()
            .copied()
            .filter_map(|target_index| {
                let target = &target_frames[target_index];
                let distance = get_visual_feature_distance(source, target);
                (distance <= ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD).then_some(
                    VisualAffineObservation {
                        target_index,
                        source_time_ms: source.time_ms,
                        target_time_ms: target.time_ms,
                        distance,
                    },
                )
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            left.distance
                .total_cmp(&right.distance)
                .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
        });
        candidates.truncate(ALIGNMENT_V2_VISUAL_MAX_CANDIDATES_PER_SOURCE);
        candidates_by_source.push(candidates);
    }
    let candidate_count = candidates_by_source.iter().map(Vec::len).sum::<usize>();
    if candidate_count < ALIGNMENT_V2_VISUAL_MIN_INLIERS {
        return Ok(VisualAffineMatchResult {
            hypotheses: Vec::new(),
            informative_source_count: source_indices.len(),
            informative_target_count: target_indices.len(),
            candidate_count,
            top1_top2_margin: 0.0,
        });
    }

    let source_step_ms = estimate_visual_frame_step_ms(source_frames);
    let target_step_ms = estimate_visual_frame_step_ms(target_frames);
    let offset_bucket_ms = source_step_ms.max(target_step_ms).max(1) as f64 / 2.0;
    let mut votes: HashMap<(usize, i64), f64> = HashMap::new();
    const SCALE_STEP: f64 = 0.0025;
    const SCALE_COUNT: usize = 49;
    for scale_index in 0..SCALE_COUNT {
        if scale_index % 4 == 0 {
            check_cancelled(cancel_flag)?;
        }
        let scale = 0.94 + scale_index as f64 * SCALE_STEP;
        for observation in candidates_by_source.iter().flatten() {
            let offset =
                observation.target_time_ms as f64 - scale * observation.source_time_ms as f64;
            let bucket = (offset / offset_bucket_ms).round() as i64;
            let weight = 1.0 - observation.distance / ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD;
            *votes.entry((scale_index, bucket)).or_insert(0.0) += weight.max(0.01);
        }
    }
    let mut seeds = votes.into_iter().collect::<Vec<_>>();
    seeds.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    seeds.truncate(ALIGNMENT_V2_VISUAL_MAX_SEEDS);

    let tolerance_ms = source_step_ms.max(target_step_ms).saturating_mul(3) / 4 + 250;
    let mut hypotheses = Vec::new();
    for (seed_index, ((scale_index, offset_bucket), _)) in seeds.into_iter().enumerate() {
        if seed_index % 8 == 0 {
            check_cancelled(cancel_flag)?;
        }
        let seed_scale = 0.94 + scale_index as f64 * SCALE_STEP;
        let seed_offset = (offset_bucket as f64 * offset_bucket_ms).round() as i64;
        let initial_matches = collect_visual_affine_inliers(
            &candidates_by_source,
            seed_scale,
            seed_offset,
            tolerance_ms,
        );
        if initial_matches.len() < ALIGNMENT_V2_VISUAL_MIN_INLIERS {
            continue;
        }
        let (refined_scale, refined_offset) = fit_visual_affine(&initial_matches)
            .filter(|(scale, _)| (0.94..=1.06).contains(scale))
            .unwrap_or((seed_scale, seed_offset));
        let matches = collect_visual_affine_inliers(
            &candidates_by_source,
            refined_scale,
            refined_offset,
            tolerance_ms,
        );
        if matches.len() < ALIGNMENT_V2_VISUAL_MIN_INLIERS {
            continue;
        }
        let hypothesis = summarize_visual_affine_hypothesis(
            refined_scale,
            refined_offset,
            matches,
            source_frames,
            &source_indices,
            tolerance_ms,
        );
        if hypothesis.score.is_finite() && hypothesis.score > 0.0 {
            hypotheses.push(hypothesis);
        }
    }
    hypotheses.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.matches.len().cmp(&left.matches.len()))
            .then_with(|| left.offset_ms.cmp(&right.offset_ms))
    });
    let mut distinct = Vec::new();
    for hypothesis in hypotheses {
        if distinct.iter().any(|existing| {
            visual_hypotheses_share_location(
                existing,
                &hypothesis,
                source_frames,
                source_step_ms.max(target_step_ms),
            )
        }) {
            continue;
        }
        distinct.push(hypothesis);
        if distinct.len() >= 5 {
            break;
        }
    }
    let top1_top2_margin = match (distinct.first(), distinct.get(1)) {
        (Some(first), Some(second)) => {
            ((first.score - second.score) / first.score.max(0.001)).clamp(0.0, 1.0)
        }
        (Some(_), None) => 1.0,
        _ => 0.0,
    };
    Ok(VisualAffineMatchResult {
        hypotheses: distinct,
        informative_source_count: source_indices.len(),
        informative_target_count: target_indices.len(),
        candidate_count,
        top1_top2_margin,
    })
}

fn uniformly_sample_informative_visual_indices(frames: &[VisualFeatureFrame]) -> Vec<usize> {
    let informative = frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            (visual_information_score(frame) >= ALIGNMENT_V2_VISUAL_MIN_INFORMATION)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if informative.len() <= ALIGNMENT_V2_VISUAL_MAX_MATCH_FRAMES {
        return informative;
    }
    let stride = informative
        .len()
        .div_ceil(ALIGNMENT_V2_VISUAL_MAX_MATCH_FRAMES);
    informative.into_iter().step_by(stride).collect()
}

fn collect_visual_affine_inliers(
    candidates_by_source: &[Vec<VisualAffineObservation>],
    scale: f64,
    offset_ms: i64,
    tolerance_ms: u64,
) -> Vec<VisualAffineObservation> {
    let mut selected = candidates_by_source
        .iter()
        .filter_map(|candidates| {
            candidates
                .iter()
                .filter_map(|candidate| {
                    let predicted = scale * candidate.source_time_ms as f64 + offset_ms as f64;
                    let residual = (candidate.target_time_ms as f64 - predicted).abs();
                    (residual <= tolerance_ms as f64).then_some((candidate, residual))
                })
                .min_by(|left, right| {
                    (left.1 / tolerance_ms.max(1) as f64 + left.0.distance)
                        .total_cmp(&(right.1 / tolerance_ms.max(1) as f64 + right.0.distance))
                })
                .map(|(candidate, _)| candidate.clone())
        })
        .collect::<Vec<_>>();
    selected.sort_by_key(|item| (item.source_time_ms, item.target_time_ms));
    let mut monotonic = Vec::with_capacity(selected.len());
    let mut used_targets = HashSet::new();
    for candidate in selected {
        if monotonic
            .last()
            .is_some_and(|previous: &VisualAffineObservation| {
                candidate.source_time_ms <= previous.source_time_ms
                    || candidate.target_time_ms <= previous.target_time_ms
            })
            || !used_targets.insert(candidate.target_index)
        {
            continue;
        }
        monotonic.push(candidate);
    }
    monotonic
}

fn fit_visual_affine(matches: &[VisualAffineObservation]) -> Option<(f64, i64)> {
    if matches.len() < 2 {
        return None;
    }
    let count = matches.len() as f64;
    let source_mean = matches
        .iter()
        .map(|item| item.source_time_ms as f64)
        .sum::<f64>()
        / count;
    let target_mean = matches
        .iter()
        .map(|item| item.target_time_ms as f64)
        .sum::<f64>()
        / count;
    let denominator = matches
        .iter()
        .map(|item| (item.source_time_ms as f64 - source_mean).powi(2))
        .sum::<f64>();
    if denominator <= f64::EPSILON {
        return None;
    }
    let scale = matches
        .iter()
        .map(|item| {
            (item.source_time_ms as f64 - source_mean) * (item.target_time_ms as f64 - target_mean)
        })
        .sum::<f64>()
        / denominator;
    let offset = (target_mean - scale * source_mean).round();
    (scale.is_finite() && offset.is_finite()).then_some((scale, offset as i64))
}

fn summarize_visual_affine_hypothesis(
    scale: f64,
    offset_ms: i64,
    matches: Vec<VisualAffineObservation>,
    source_frames: &[VisualFeatureFrame],
    informative_source_indices: &[usize],
    tolerance_ms: u64,
) -> VisualAffineHypothesis {
    let mut residuals = matches
        .iter()
        .map(|item| {
            let predicted = scale * item.source_time_ms as f64 + offset_ms as f64;
            (item.target_time_ms as f64 - predicted).abs().round() as u64
        })
        .collect::<Vec<_>>();
    residuals.sort_unstable();
    let percentile = |ratio: f64| -> u64 {
        let index = ((residuals.len().saturating_sub(1)) as f64 * ratio).round() as usize;
        residuals.get(index).copied().unwrap_or(0)
    };
    let coverage = matches.len() as f64 / informative_source_indices.len().max(1) as f64;
    // Span coverage is deliberately measured against the full sampled source axis. Long black
    // or otherwise low-information prefixes/suffixes must not disappear from the denominator and
    // turn a short visual coincidence into an apparently complete mapping.
    let source_domain_start = source_frames
        .first()
        .map(|frame| frame.time_ms)
        .unwrap_or(0);
    let source_domain_end = source_frames
        .last()
        .map(|frame| frame.time_ms)
        .unwrap_or(source_domain_start);
    let matched_start = matches
        .first()
        .map(|item| item.source_time_ms)
        .unwrap_or(source_domain_start);
    let matched_end = matches
        .last()
        .map(|item| item.source_time_ms)
        .unwrap_or(matched_start);
    let temporal_span_coverage = if source_domain_end > source_domain_start {
        matched_end.saturating_sub(matched_start) as f64
            / source_domain_end.saturating_sub(source_domain_start) as f64
    } else {
        0.0
    };
    let mean_distance =
        matches.iter().map(|item| item.distance).sum::<f64>() / matches.len().max(1) as f64;
    let appearance_score =
        (1.0 - mean_distance / ALIGNMENT_V2_VISUAL_MATCH_THRESHOLD).clamp(0.0, 1.0);
    let residual_score =
        (1.0 - percentile(0.95) as f64 / tolerance_ms.max(1) as f64).clamp(0.0, 1.0);
    let score = coverage.clamp(0.0, 1.0)
        * (0.4 + 0.6 * temporal_span_coverage.clamp(0.0, 1.0))
        * (0.55 + 0.45 * appearance_score)
        * (0.7 + 0.3 * residual_score);
    VisualAffineHypothesis {
        scale,
        offset_ms,
        score,
        coverage: coverage.clamp(0.0, 1.0),
        temporal_span_coverage: temporal_span_coverage.clamp(0.0, 1.0),
        mean_distance,
        p50_residual_ms: percentile(0.50),
        p95_residual_ms: percentile(0.95),
        max_residual_ms: residuals.last().copied().unwrap_or(0),
        matches,
    }
}

fn visual_hypotheses_share_location(
    left: &VisualAffineHypothesis,
    right: &VisualAffineHypothesis,
    source_frames: &[VisualFeatureFrame],
    sample_step_ms: u64,
) -> bool {
    let start = source_frames
        .first()
        .map(|frame| frame.time_ms)
        .unwrap_or(0) as f64;
    let end = source_frames.last().map(|frame| frame.time_ms).unwrap_or(0) as f64;
    let left_start = left.scale * start + left.offset_ms as f64;
    let right_start = right.scale * start + right.offset_ms as f64;
    let left_end = left.scale * end + left.offset_ms as f64;
    let right_end = right.scale * end + right.offset_ms as f64;
    let tolerance = sample_step_ms.max(1) as f64 * 2.0;
    (left_start - right_start).abs() <= tolerance && (left_end - right_end).abs() <= tolerance
}

fn replace_visual_evidence_signal(
    proposal: &mut AudioAlignmentProposal,
    signal: AlignmentEvidenceSignalSummary,
) {
    if let Some(evidence) = &mut proposal.evidence {
        let mut signals = evidence.signals.take().unwrap_or_default();
        signals.retain(|item| item.kind != "visual");
        let insert_index = signals
            .iter()
            .position(|item| item.kind == "danmaku")
            .unwrap_or(signals.len());
        signals.insert(insert_index, signal);
        evidence.signals = Some(signals);
    }
}

fn truncate_visual_note(text: &str) -> String {
    const MAX_CHARS: usize = 120;
    let mut truncated: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        truncated.push_str("...");
    }
    truncated
}

fn estimate_cut_boundary_ms(previous: &AudioFeatureMatch, current: &AudioFeatureMatch) -> u64 {
    let source_delta_ms = current
        .source_time_ms
        .saturating_sub(previous.source_time_ms);
    previous.source_time_ms + source_delta_ms / 2
}

fn merge_nearby_candidates(candidates: Vec<CutCandidateDto>) -> Vec<CutCandidateDto> {
    let mut merged: Vec<CutCandidateDto> = Vec::new();
    for candidate in candidates {
        if let Some(previous) = merged.last_mut() {
            let distance = previous.source_at_ms.abs_diff(candidate.source_at_ms);
            if distance <= MERGE_NEARBY_CANDIDATE_MS {
                previous.target_gap_ms += candidate.target_gap_ms;
                previous.confidence = previous.confidence.min(candidate.confidence);
                previous.source_range_start_ms = previous
                    .source_range_start_ms
                    .min(candidate.source_range_start_ms);
                previous.source_range_end_ms = previous
                    .source_range_end_ms
                    .max(candidate.source_range_end_ms);
                previous.note = format!("{} {}", previous.note, candidate.note);
                continue;
            }
        }
        merged.push(candidate);
    }
    merged
        .into_iter()
        .enumerate()
        .map(|(index, mut candidate)| {
            candidate.id = format!("audio-gap-{}", index + 1);
            candidate.name = format!("音频推断差异 {}", index + 1);
            candidate
        })
        .collect()
}

fn create_anchors(matches: &[AudioFeatureMatch], match_threshold: f64) -> Vec<SyncAnchorDto> {
    matches
        .iter()
        .enumerate()
        .filter(|(index, _)| index % 8 == 0 || *index + 1 == matches.len())
        .map(|(_, item)| SyncAnchorDto {
            id: String::new(),
            source_ms: item.source_time_ms,
            target_ms: item.complete_time_ms,
            confidence: (1.0 - item.distance / match_threshold).clamp(0.0, 1.0),
            origin: "automatic",
        })
        .enumerate()
        .map(|(index, mut anchor)| {
            anchor.id = format!("audio-anchor-{}", index + 1);
            anchor
        })
        .collect()
}

fn get_feature_distance(left: &AudioFeatureFrame, right: &AudioFeatureFrame) -> f64 {
    let width = left.values.len().max(right.values.len());
    if width == 0 {
        return 1.0;
    }
    let total = (0..width)
        .map(|index| {
            let delta = left.values.get(index).copied().unwrap_or(0.0)
                - right.values.get(index).copied().unwrap_or(0.0);
            delta * delta
        })
        .sum::<f64>();
    (total / width as f64).sqrt()
}

fn format_duration(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_probe::{
        probe_audio_decode_timelines_with_ffprobe, probe_media_timeline_with_ffprobe,
    };
    use std::process::{Command, Stdio};

    #[test]
    #[ignore = "process-supervision sticky cleanup helper"]
    fn sticky_cleanup_abort_helper() {
        crate::process_supervision::mark_process_supervision_cleanup_fault_for_test();
        let request = AudioAlignmentRequest {
            complete_path: "must-not-be-opened-complete.mkv".to_string(),
            source_path: "must-not-be-opened-source.mkv".to_string(),
            ffmpeg_path: Some("must-not-be-spawned.exe".to_string()),
            ffprobe_path: Some("must-not-be-spawned.exe".to_string()),
            complete_audio_stream_index: None,
            source_audio_stream_index: None,
            complete_video_stream_index: None,
            source_video_stream_index: None,
            sample_rate: None,
            window_ms: None,
            match_threshold: None,
            min_gap_ms: None,
            max_cells: None,
            enable_visual_evidence: None,
            visual_sample_interval_ms: None,
            localization_mode: None,
        };
        let error = align_audio_files_inner(request).expect_err("sticky cleanup must abort");
        assert!(error.starts_with("blocked:process-cleanup"));
    }

    #[test]
    fn sticky_cleanup_aborts_before_media_validation_or_spawn() {
        let status = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--ignored",
                "--exact",
                "audio_alignment::tests::sticky_cleanup_abort_helper",
                "--nocapture",
            ])
            .status()
            .expect("run isolated sticky-cleanup test");
        assert!(status.success());
    }

    fn test_options() -> AudioAlignmentOptions {
        AudioAlignmentOptions {
            sample_rate: 10,
            window_ms: 1000,
            match_threshold: 0.01,
            min_gap_ms: 1000,
            max_cells: 1_000_000,
            ffmpeg_path: "ffmpeg".to_string(),
            ffprobe_path: PathBuf::from("ffprobe"),
            enable_visual_evidence: false,
            visual_sample_interval_ms: DEFAULT_VISUAL_SAMPLE_INTERVAL_MS,
            localization_mode: false,
        }
    }

    fn test_media_content_identity(
        digest_character: char,
        size_bytes: u64,
        modified_unix_ms: u64,
    ) -> MediaContentIdentity {
        let digest = digest_character.to_string().repeat(64);
        MediaContentIdentity {
            algorithm: "sha256-full-file-v2",
            size_bytes,
            modified_unix_ms,
            first_sample_digest: digest.clone(),
            middle_sample_digest: digest.clone(),
            last_sample_digest: digest,
        }
    }

    fn test_audio_input(stream_index: u32, timeline_offset_ms: i64) -> AlignmentAudioInput {
        AlignmentAudioInput {
            presentation_origin_ms: -80,
            media_duration_ms: Some(120_000),
            content_identity: Some(test_media_content_identity('a', 1_024, 1)),
            decode_timeline: Some(AudioDecodeTimelineProbe {
                first_decoded_pts_ms: Some(-80 + timeline_offset_ms),
                decoded_frame_count: 1,
                ..AudioDecodeTimelineProbe::default()
            }),
            audio_stream_count: 2,
            explicit_stream_selection: false,
            stream: AudioStreamProbe {
                stream_index,
                codec_name: Some("aac".to_string()),
                start_time_ms: -80 + timeline_offset_ms,
                timeline_offset_ms,
                duration_ms: Some(120_000),
                time_base: Some("1/48000".to_string()),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: Some(format!("Track {stream_index}")),
                is_default: stream_index == 1,
                is_commentary: false,
            },
        }
    }

    fn test_video_stream(stream_index: u32, is_default: bool) -> VideoStreamProbe {
        VideoStreamProbe {
            stream_index,
            codec_name: Some("h264".to_string()),
            start_time_ms: 0,
            timeline_offset_ms: 0,
            duration_ms: Some(120_000),
            time_base: Some("1/90000".to_string()),
            frame_rate: Some(24.0),
            language: None,
            title: Some(format!("Video {stream_index}")),
            is_default,
            is_commentary: false,
        }
    }

    fn test_visual_input(stream_index: u32) -> AlignmentVisualInput {
        AlignmentVisualInput {
            presentation_origin_ms: 0,
            media_duration_ms: Some(120_000),
            content_identity: Some(test_media_content_identity('a', 1_024, 1)),
            stream: test_video_stream(stream_index, stream_index == 1),
        }
    }

    fn frames(values: &[f64]) -> Vec<AudioFeatureFrame> {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| AudioFeatureFrame {
                time_ms: index as u64 * 10_000,
                values: vec![*value],
            })
            .collect()
    }

    fn pattern_frames(count: usize) -> Vec<AudioFeatureFrame> {
        (0..count)
            .map(|index| AudioFeatureFrame {
                time_ms: index as u64 * 1_000,
                values: vec![
                    0.5 + (index as f64 * 0.37).sin() * 0.25,
                    0.5 + (index as f64 * 0.19).cos() * 0.2,
                    0.5 + (index as f64 * 0.11 + 0.4).sin() * 0.18,
                ],
            })
            .collect()
    }

    fn v2_labeled_features(labels: &[usize], start_ms: i64, hop_ms: i64) -> Vec<FineFeatureFrame> {
        labels
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let mut values = vec![0.0f32; 32];
                values[*label] = 1.0;
                FineFeatureFrame {
                    time_ms: start_ms + index as i64 * hop_ms,
                    values,
                }
            })
            .collect()
    }

    fn v2_distinct_features(ids: &[usize], start_ms: i64, hop_ms: i64) -> Vec<FineFeatureFrame> {
        ids.iter()
            .enumerate()
            .map(|(index, id)| {
                let mut state = (*id as u64).wrapping_add(1).wrapping_mul(0x9e37_79b9);
                let mut values = (0..32)
                    .map(|_| {
                        state = state
                            .wrapping_mul(6_364_136_223_846_793_005)
                            .wrapping_add(1_442_695_040_888_963_407);
                        (((state >> 32) as u32) as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
                    })
                    .collect::<Vec<_>>();
                let norm = values
                    .iter()
                    .map(|value| f64::from(*value).powi(2))
                    .sum::<f64>()
                    .sqrt();
                for value in &mut values {
                    *value = (f64::from(*value) / norm) as f32;
                }
                FineFeatureFrame {
                    time_ms: start_ms + index as i64 * hop_ms,
                    values,
                }
            })
            .collect()
    }

    fn v2_test_hypothesis(scale: f64, offset_ms: i64) -> AffineHypothesis {
        AffineHypothesis {
            scale,
            offset_ms,
            inlier_count: 24,
            unique_source_count: 24,
            unique_source_coverage: 0.8,
            unique_target_count: 24,
            unique_target_coverage: 0.8,
            source_start_ms: 0,
            source_end_ms: 2_400,
            p50_residual_ms: 15,
            p95_residual_ms: 40,
            max_residual_ms: 60,
        }
    }

    fn v2_test_pair_candidate() -> V2TrackPairCandidate {
        let source_input = test_audio_input(1, 80);
        let mut target_input = test_audio_input(2, 120);
        target_input.presentation_origin_ms = -120;
        V2TrackPairCandidate {
            source_input,
            target_input,
            hypothesis: v2_test_hypothesis(1.02, 500),
            score: 0.8,
            temporal_coverage: 0.75,
            intrinsic_margin: 0.5,
            repeated_content_only: false,
            observation_count: 64,
            source_landmark_count: 80,
            target_landmark_count: 72,
        }
    }

    fn ffmpeg_test_tools_available() -> bool {
        Command::new("ffmpeg")
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
            && Command::new("ffprobe")
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
    }

    fn generate_v2_ffmpeg_fixture(
        output_path: &Path,
        primary_filter: &str,
        output_offset: &str,
        commentary_frequency: &str,
    ) {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=exprs=0.45*sin(2*PI*(180+23*t)*t)+0.3*sin(2*PI*(620+11*t)*t)+0.2*sin(2*PI*(1200+7*t)*t):s=16000:d=16",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={commentary_frequency}:sample_rate=16000:duration=16"),
                "-filter_complex",
                primary_filter,
                "-map",
                "[main]",
                "-map",
                "1:a",
                "-c:a",
                "pcm_s16le",
                "-metadata:s:a:0",
                "language=jpn",
                "-metadata:s:a:0",
                "title=Main",
                "-disposition:a:0",
                "default",
                "-metadata:s:a:1",
                "title=Director Commentary",
                "-disposition:a:1",
                "comment",
                "-avoid_negative_ts",
                "disabled",
                "-output_ts_offset",
                output_offset,
            ])
            .arg(output_path)
            .status()
            .unwrap();
        assert!(status.success(), "FFmpeg V2 fixture 生成失败");
    }

    fn generate_v2_vfr_ffmpeg_fixture(
        output_path: &Path,
        primary_audio_filter: &str,
        video_select_filter: &str,
        output_offset: &str,
    ) {
        let filter_complex =
            format!("{primary_audio_filter};[1:v]{video_select_filter},format=yuv420p[v]");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=exprs=0.45*sin(2*PI*(180+23*t)*t)+0.3*sin(2*PI*(620+11*t)*t)+0.2*sin(2*PI*(1200+7*t)*t):s=16000:d=16",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=30:duration=16",
                "-filter_complex",
                &filter_complex,
                "-map",
                "[main]",
                "-map",
                "[v]",
                "-c:a",
                "pcm_s16le",
                "-c:v",
                "ffv1",
                "-fps_mode:v:0",
                "vfr",
                "-avoid_negative_ts",
                "disabled",
                "-output_ts_offset",
                output_offset,
            ])
            .arg(output_path)
            .status()
            .unwrap();
        assert!(status.success(), "FFmpeg VFR fixture 生成失败");
    }

    fn probe_video_frame_pts_ms(path: &Path) -> Vec<i64> {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_frames",
                "-show_entries",
                "frame=best_effort_timestamp_time",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "FFprobe VFR PTS 失败：{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<f64>().ok())
            .map(|seconds| (seconds * 1_000.0).round() as i64)
            .collect()
    }

    fn assert_genuine_vfr_pts(path: &Path, expected_start_ms: i64) {
        let pts = probe_video_frame_pts_ms(path);
        assert!(pts.len() > 80, "VFR 帧数过少：{}", pts.len());
        assert!(pts.windows(2).all(|pair| pair[1] > pair[0]));
        assert!(
            pts[0].abs_diff(expected_start_ms) <= 150,
            "首个保留视频帧 PTS={} ms，容器展示起点={} ms",
            pts[0],
            expected_start_ms
        );
        let deltas = pts
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect::<HashSet<_>>();
        assert!(deltas.len() >= 3, "视频帧 PTS 仍近似固定间隔：{deltas:?}");
        let min_delta = *deltas.iter().min().unwrap();
        let max_delta = *deltas.iter().max().unwrap();
        assert!(max_delta - min_delta >= 30, "VFR PTS 差异不足：{deltas:?}");
    }

    fn assert_v2_bilateral_edit_gold(time_map: &AudioAlignmentTimeMapDto) {
        let source_only_spans = time_map
            .spans
            .iter()
            .filter(|span| span.kind == AudioTimeMapSpanKind::SourceOnly)
            .collect::<Vec<_>>();
        let target_only_spans = time_map
            .spans
            .iter()
            .filter(|span| span.kind == AudioTimeMapSpanKind::TargetOnly)
            .collect::<Vec<_>>();
        assert_eq!(source_only_spans.len(), 1, "spans={:?}", time_map.spans);
        assert_eq!(target_only_spans.len(), 1, "spans={:?}", time_map.spans);
        let source_only = source_only_spans[0];
        let target_only = target_only_spans[0];
        assert!(source_only.source_start_ms.abs_diff(10_000) <= 200);
        assert!(source_only.source_end_ms.abs_diff(11_000) <= 200);
        assert!(source_only.target_start_ms.abs_diff(11_220) <= 250);
        assert_eq!(source_only.target_start_ms, source_only.target_end_ms);
        assert!(target_only.source_start_ms.abs_diff(5_000) <= 200);
        assert_eq!(target_only.source_start_ms, target_only.source_end_ms);
        assert!(target_only.target_start_ms.abs_diff(5_100) <= 250);
        assert!(target_only.target_end_ms.abs_diff(6_120) <= 250);
        let source_only_ms = source_only_spans
            .iter()
            .map(|span| span.source_end_ms - span.source_start_ms)
            .sum::<u64>();
        let target_only_ms = target_only_spans
            .iter()
            .map(|span| span.target_end_ms - span.target_start_ms)
            .sum::<u64>();
        assert!(
            (700..=1_300).contains(&source_only_ms),
            "sourceOnly={source_only_ms}, spans={:?}",
            time_map.spans
        );
        assert!(
            (700..=1_400).contains(&target_only_ms),
            "targetOnly={target_only_ms}, spans={:?}",
            time_map.spans
        );
        for (kind, expected_side_count) in [
            ("sourceOnly", source_only_spans.len() * 2),
            ("targetOnly", target_only_spans.len() * 2),
        ] {
            let refined_side_count = time_map
                .evidence
                .notes
                .iter()
                .filter(|note| note.contains(&format!("{kind} span #")) && note.contains("已用"))
                .count();
            assert_eq!(
                refined_side_count, expected_side_count,
                "{kind} 缺少双侧证据：{:?}",
                time_map.evidence.notes
            );
        }
        assert!(time_map
            .quality
            .boundary_uncertainty_ms
            .is_some_and(|value| value <= 150));
        validate_v2_time_map_spans(&time_map.spans).unwrap();
    }

    fn localization_target_frames(count: usize) -> Vec<AudioFeatureFrame> {
        (0..count)
            .map(|index| AudioFeatureFrame {
                time_ms: index as u64 * 1_000,
                values: vec![
                    ((index % 20) + 1) as f64 / 32.0,
                    (((index / 20) % 20) + 1) as f64 / 32.0,
                    (((index / 400) % 20) + 1) as f64 / 32.0,
                    0.125,
                ],
            })
            .collect()
    }

    fn scene_pixels(level: u8) -> Vec<u8> {
        let mut pixels = vec![0u8; VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT];
        for y in 0..VISUAL_SAMPLE_HEIGHT {
            for x in 0..VISUAL_SAMPLE_WIDTH {
                pixels[y * VISUAL_SAMPLE_WIDTH + x] =
                    level.saturating_add(x as u8).saturating_add(y as u8);
            }
        }
        pixels
    }

    fn paint_visual_rect(
        pixels: &mut [u8],
        start_x: usize,
        start_y: usize,
        width: usize,
        height: usize,
        value: u8,
    ) {
        for y in start_y..start_y + height {
            for x in start_x..start_x + width {
                pixels[y * VISUAL_SAMPLE_WIDTH + x] = value;
            }
        }
    }

    fn visual_frame(time_ms: u64, level: u8) -> VisualFeatureFrame {
        VisualFeatureFrame {
            time_ms,
            values: create_robust_visual_values(&scene_pixels(level)),
        }
    }

    fn visual_signature_frame(time_ms: u64, content_id: u64) -> VisualFeatureFrame {
        let mut state = content_id
            .wrapping_add(1)
            .wrapping_mul(0x9e37_79b9_7f4a_7c15);
        let mut values = vec![0.5, 0.2];
        for _ in 0..96 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            values.push(if state >> 63 == 0 { -0.8 } else { 0.8 });
        }
        VisualFeatureFrame { time_ms, values }
    }

    fn visual_test_time_map(span: AudioTimeMapSpanDto) -> AudioAlignmentTimeMapDto {
        AudioAlignmentTimeMapDto {
            source_start_ms: span.source_start_ms,
            source_end_ms: span.source_end_ms,
            target_start_ms: span.target_start_ms,
            target_end_ms: span.target_end_ms,
            spans: vec![span],
            quality: AudioTimeMapQualityDto {
                level: "review",
                metric_source: "measured",
                probability: None,
                coverage: Some(1.0),
                p50_residual_ms: Some(0),
                p95_residual_ms: Some(0),
                max_residual_ms: Some(0),
                boundary_uncertainty_ms: None,
                alternative_margin: Some(1.0),
                anchor_count: 10,
                held_out_anchor_count: 0,
                reasons: Vec::new(),
            },
            evidence: AudioTimeMapEvidenceDto {
                types: vec!["audio"],
                audio_anchor_count: 10,
                visual_anchor_count: 0,
                held_out_anchor_count: 0,
                top1_top2_margin: Some(1.0),
                unique_content_coverage: Some(1.0),
                repeated_content_only: false,
                selected_track_reason: "test".to_string(),
                alternative_track_scores: Vec::new(),
                notes: Vec::new(),
            },
            source_stream: None,
            target_stream: None,
            source_visual_stream: None,
            target_visual_stream: None,
            source_identity: None,
            target_identity: None,
            engine_version: ALIGNMENT_V2_ENGINE_VERSION,
            feature_version: ALIGNMENT_V2_FEATURE_VERSION,
            parameters_hash: "test".to_string(),
        }
    }

    fn cut_candidate(id: &str, source_at_ms: u64, target_gap_ms: u64) -> CutCandidateDto {
        CutCandidateDto {
            id: id.to_string(),
            name: id.to_string(),
            source_at_ms,
            source_range_start_ms: source_at_ms.saturating_sub(500),
            source_range_end_ms: source_at_ms + 500,
            target_gap_ms,
            confidence: 0.8,
            note: format!("候选 {id}"),
        }
    }

    fn clear_audio_feature_cache_for_tests() {
        audio_feature_cache().lock().unwrap().clear();
    }

    fn lock_audio_feature_cache_test_fixture() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("audio feature cache test fixture lock")
    }

    fn temp_audio_cache_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}-{}.media",
            std::process::id(),
            current_time_ms()
        ))
    }

    #[test]
    fn audio_alignment_infers_missing_segment() {
        let options = test_options();
        let proposal = create_audio_alignment_proposal(
            &frames(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
            &frames(&[0.1, 0.2, 0.5, 0.6]),
            &options,
        )
        .unwrap();
        assert_eq!(proposal.cut_candidates.len(), 1);
        assert_eq!(proposal.cut_candidates[0].source_at_ms, 15_000);
        assert_eq!(proposal.cut_candidates[0].source_range_start_ms, 10_000);
        assert_eq!(proposal.cut_candidates[0].source_range_end_ms, 20_000);
        assert_eq!(proposal.cut_candidates[0].target_gap_ms, 20_000);
        assert!(proposal.cut_candidates[0]
            .note
            .contains("候选边界约在当前视频 0:15"));
        let evidence = proposal.evidence.as_ref().unwrap();
        assert_eq!(evidence.algorithm, "sparse-fingerprint");
        assert_eq!(evidence.fingerprint_match_count, 4);
        assert_eq!(evidence.monotonic_match_count, 4);
        assert_eq!(evidence.refined_candidate_count, 1);
        assert!(proposal.diagnostics.join("\n").contains("稀疏音频指纹"));
        assert!(proposal.match_range.is_none());
    }

    #[test]
    fn sparse_alignment_avoids_dense_dp_cell_limit() {
        let mut options = test_options();
        options.max_cells = 1;
        let proposal = create_audio_alignment_proposal(
            &frames(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
            &frames(&[0.1, 0.2, 0.5, 0.6]),
            &options,
        )
        .unwrap();

        assert_eq!(proposal.cut_candidates.len(), 1);
        assert_eq!(
            proposal.evidence.as_ref().unwrap().algorithm,
            "sparse-fingerprint"
        );
    }

    #[test]
    fn localization_finds_target_in_late_half_of_long_reference() {
        let target = localization_target_frames(120);
        let mut reference: Vec<AudioFeatureFrame> = (0..720)
            .map(|index| AudioFeatureFrame {
                time_ms: index as u64 * 1_000,
                values: vec![0.97, 0.97, 0.97, 0.97],
            })
            .collect();
        for (index, frame) in target.iter().enumerate() {
            reference[500 + index].values = frame.values.clone();
        }
        let mut options = test_options();
        options.localization_mode = true;
        options.max_cells = 1;

        let proposal = create_audio_alignment_proposal(&target, &reference, &options).unwrap();
        let range = proposal.match_range.as_ref().expect("应返回长参考定位范围");

        assert_eq!(range.source_start_ms, 500_000);
        assert_eq!(range.source_end_ms, 620_000);
        assert_eq!(range.target_start_ms, 0);
        assert_eq!(range.target_end_ms, 120_000);
        assert_eq!(range.coverage, 1.0);
        assert_eq!(proposal.confidence, 1.0);
        assert_eq!(
            proposal.evidence.as_ref().unwrap().monotonic_match_count,
            target.len()
        );
        assert_eq!(
            proposal.evidence.as_ref().unwrap().algorithm,
            "sparse-fingerprint"
        );
        assert!(proposal.anchors.iter().all(|anchor| {
            anchor.source_ms >= range.source_start_ms
                && anchor.source_ms < range.source_end_ms
                && anchor.target_ms < range.target_end_ms
        }));
        assert!(proposal.diagnostics.join("\n").contains("目标覆盖率 100%"));
    }

    #[test]
    fn localization_keeps_absolute_range_across_reference_cut() {
        let target = localization_target_frames(120);
        let mut reference: Vec<AudioFeatureFrame> = (0..720)
            .map(|index| AudioFeatureFrame {
                time_ms: index as u64 * 1_000,
                values: vec![0.97, 0.97, 0.97, 0.97],
            })
            .collect();
        let mut reference_index = 500;
        for (target_index, frame) in target.iter().enumerate() {
            if (40..60).contains(&target_index) {
                continue;
            }
            reference[reference_index].values = frame.values.clone();
            reference_index += 1;
        }
        let mut options = test_options();
        options.localization_mode = true;

        let proposal = create_audio_alignment_proposal(&target, &reference, &options).unwrap();
        let range = proposal.match_range.as_ref().expect("应返回删减版绝对范围");

        assert_eq!(range.source_start_ms, 500_000);
        assert_eq!(range.source_end_ms, 600_000);
        assert_eq!(range.target_start_ms, 0);
        assert_eq!(range.target_end_ms, 120_000);
        assert!((range.coverage - 100.0 / 120.0).abs() < f64::EPSILON);
        assert_eq!(proposal.cut_candidates.len(), 1);
        assert_eq!(proposal.cut_candidates[0].target_gap_ms, 20_000);
        assert!(proposal.cut_candidates[0].source_at_ms >= range.source_start_ms);
        assert!(proposal.cut_candidates[0].source_at_ms < range.source_end_ms);
    }

    #[test]
    fn offset_path_detects_single_sustained_gap() {
        let mut options = test_options();
        options.match_threshold = 0.35;
        options.min_gap_ms = 3_000;
        let complete = pattern_frames(120);
        let mut source = Vec::new();
        source.extend_from_slice(&complete[0..30]);
        source.extend_from_slice(&complete[50..]);
        for (index, frame) in source.iter_mut().enumerate() {
            frame.time_ms = index as u64 * 1_000;
        }

        let proposal = create_audio_alignment_proposal(&complete, &source, &options).unwrap();

        assert_eq!(
            proposal.evidence.as_ref().unwrap().algorithm,
            "time-map-audio"
        );
        assert_eq!(
            proposal
                .evidence
                .as_ref()
                .unwrap()
                .time_mapping_segment_count,
            Some(2)
        );
        assert_eq!(
            proposal.evidence.as_ref().unwrap().confirmed_change_count,
            Some(1)
        );
        assert_eq!(proposal.cut_candidates.len(), 1);
        assert_eq!(proposal.cut_candidates[0].target_gap_ms, 20_000);
        assert!(proposal.cut_candidates[0].source_at_ms >= 24_000);
        assert!(proposal.cut_candidates[0].source_at_ms <= 36_000);
        assert!(proposal
            .diagnostics
            .join("\n")
            .contains("时间映射：确认 1 个持续阶跃变点"));
    }

    #[test]
    fn offset_path_rejects_short_forward_mismatch() {
        let mut options = test_options();
        options.match_threshold = 0.35;
        options.min_gap_ms = 3_000;
        let complete = pattern_frames(180);
        let source: Vec<AudioFeatureFrame> = complete
            .iter()
            .enumerate()
            .map(|(index, frame)| AudioFeatureFrame {
                time_ms: index as u64 * 1_000,
                values: if (60..70).contains(&index) {
                    complete[index + 20].values.clone()
                } else {
                    frame.values.clone()
                },
            })
            .collect();

        let proposal = create_audio_alignment_proposal(&complete, &source, &options).unwrap();

        assert_eq!(
            proposal.evidence.as_ref().unwrap().algorithm,
            "time-map-audio"
        );
        assert_eq!(proposal.cut_candidates.len(), 0);
        assert_eq!(
            proposal.evidence.as_ref().unwrap().confirmed_change_count,
            Some(0)
        );
    }

    #[test]
    fn nearby_cut_candidates_are_merged_before_export() {
        let merged = merge_nearby_candidates(vec![
            cut_candidate("first", 10_000, 1_200),
            cut_candidate("second", 11_000, 1_800),
            cut_candidate("third", 30_000, 4_000),
        ]);

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "audio-gap-1");
        assert_eq!(merged[0].name, "音频推断差异 1");
        assert_eq!(merged[0].source_at_ms, 10_000);
        assert_eq!(merged[0].source_range_start_ms, 9_500);
        assert_eq!(merged[0].source_range_end_ms, 11_500);
        assert_eq!(merged[0].target_gap_ms, 3_000);
        assert!(merged[0].note.contains("候选 first 候选 second"));
        assert_eq!(merged[1].id, "audio-gap-2");
        assert_eq!(merged[1].target_gap_ms, 4_000);
    }

    #[test]
    fn pcm_feature_extraction_uses_rms_and_crossing_rate() {
        let options = test_options();
        let mut bytes = Vec::new();
        for sample in [0.5f32, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let extracted = pcm_to_feature_frames(&bytes, &options, 80, None).unwrap();
        assert_eq!(extracted.len(), 1);
        assert_eq!(extracted[0].time_ms, 80);
        assert!(extracted[0].values[0] > 0.9);
        assert!(extracted[0].values[1] > 0.9);
    }

    #[test]
    fn bounded_cpu_parsers_fail_closed_when_cancelled_before_work() {
        let cancelled = AtomicBool::new(true);
        let v2_error = parse_v2_pcm_output(&[0, 0], "测试", Some(&cancelled)).unwrap_err();
        assert_eq!(v2_error, AUDIO_ALIGNMENT_CANCELLED);

        let options = test_options();
        let legacy_bytes = vec![0_u8; options.sample_rate as usize * 4];
        let legacy_error =
            pcm_to_feature_frames(&legacy_bytes, &options, 0, Some(&cancelled)).unwrap_err();
        assert_eq!(legacy_error, AUDIO_ALIGNMENT_CANCELLED);

        let visual_bytes = vec![0_u8; VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT];
        let visual_error =
            raw_visual_frames_to_features(&visual_bytes, 1_000, Some(&cancelled)).unwrap_err();
        assert_eq!(visual_error, AUDIO_ALIGNMENT_CANCELLED);
    }

    #[test]
    fn legacy_cpu_parse_cancel_schedule_has_a_fixed_work_bound() {
        let processed = (1..=LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES * 3 + 17)
            .filter(|processed| {
                should_check_parse_cancellation(*processed, LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES)
            })
            .collect::<Vec<_>>();

        assert_eq!(
            processed,
            vec![
                LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES,
                LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES * 2,
                LEGACY_PCM_PARSE_CANCEL_CHECK_SAMPLES * 3,
            ]
        );
        assert!(!should_check_parse_cancellation(1, 0));
    }

    #[test]
    fn audio_decode_args_map_the_selected_global_stream_index() {
        let args =
            create_audio_decode_args("episode.mkv", &test_options(), &test_audio_input(3, 120));
        let map_position = args.iter().position(|value| value == "-map").unwrap();

        assert_eq!(args.get(map_position + 1).map(String::as_str), Some("0:3"));
        assert_eq!(
            args.iter().filter(|value| value.as_str() == "-map").count(),
            1
        );
    }

    #[test]
    fn presentation_time_uses_stream_offset_and_never_becomes_negative() {
        assert_eq!(presentation_time_from_sample_offset(0, 8_000, 125), 125);
        assert_eq!(
            presentation_time_from_sample_offset(8_000, 8_000, 125),
            1_125
        );
        assert_eq!(presentation_time_from_sample_offset(0, 8_000, -80), 0);
    }

    #[test]
    fn v2_decode_args_use_selected_stream_and_s16le_16k_mono() {
        let args = create_v2_audio_decode_args("episode.mkv", &test_audio_input(4, 125));
        let map_position = args.iter().position(|value| value == "-map").unwrap();
        let filter_position = args.iter().position(|value| value == "-af").unwrap();
        let channels_position = args.iter().position(|value| value == "-ac").unwrap();

        assert_eq!(args[map_position + 1], "0:4");
        assert_eq!(
            args[filter_position + 1],
            "aresample=16000:async=1:first_pts=0"
        );
        assert_eq!(args[channels_position + 1], "1");
        assert!(args.iter().any(|value| value == "-copyts"));
        assert!(args.iter().any(|value| value == "-start_at_zero"));
        assert!(args.iter().any(|value| value == "-t"));
        assert!(args.iter().any(|value| value == "s16le"));
    }

    #[test]
    fn v2_cache_key_includes_engine_feature_stream_and_pts_identity() {
        let path = temp_audio_cache_path("v2-cache-key");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let first = create_v2_audio_cache_key(
            &path_text,
            &test_options(),
            &test_audio_input(1, 80),
            "landmark",
        )
        .unwrap();
        let other_stream = create_v2_audio_cache_key(
            &path_text,
            &test_options(),
            &test_audio_input(2, 80),
            "landmark",
        )
        .unwrap();
        let other_pts = create_v2_audio_cache_key(
            &path_text,
            &test_options(),
            &test_audio_input(1, 160),
            "landmark",
        )
        .unwrap();

        assert!(first.contains(ALIGNMENT_V2_ENGINE_VERSION));
        assert!(first.contains(ALIGNMENT_V2_FEATURE_VERSION));
        assert!(first.contains("ptsOrigin=-80"));
        assert!(first.contains("streamPtsOffset=80"));
        assert_ne!(first, other_stream);
        assert_ne!(first, other_pts);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn v2_explicit_video_stream_overrides_default_and_changes_cache_key() {
        let snapshot = MediaProbeSnapshot {
            path: "hidden-test-path.mkv".to_string(),
            presentation_origin_ms: 0,
            duration_ms: Some(120_000),
            content_identity: None,
            video_streams: vec![test_video_stream(1, true), test_video_stream(4, false)],
            audio_streams: Vec::new(),
            preferred_audio_stream_index: None,
        };
        assert_eq!(
            select_alignment_video_stream(&snapshot, None, "测试")
                .unwrap()
                .stream_index,
            1
        );
        assert_eq!(
            select_alignment_video_stream(&snapshot, Some(4), "测试")
                .unwrap()
                .stream_index,
            4
        );
        assert!(select_alignment_video_stream(&snapshot, Some(9), "测试")
            .unwrap_err()
            .contains("#9"));

        let first = create_v2_visual_feature_cache_key(
            "hidden-test-path.mkv",
            &test_options(),
            &test_visual_input(1),
            1_000,
        )
        .unwrap();
        let explicit = create_v2_visual_feature_cache_key(
            "hidden-test-path.mkv",
            &test_options(),
            &test_visual_input(4),
            1_000,
        )
        .unwrap();
        assert_ne!(first, explicit);
        assert!(explicit.contains("stream=4:"));
    }

    #[test]
    fn v2_stream_pair_uses_language_alias_as_soft_prior_and_rejects_commentary() {
        let source = test_audio_input(1, 0);
        let mut commentary = test_audio_input(2, 0);
        commentary.stream.is_commentary = true;
        assert!(!is_reasonable_audio_stream_pair(&source, &commentary));

        let mut english = test_audio_input(3, 0);
        english.stream.language = Some("eng".to_string());
        assert!(is_reasonable_audio_stream_pair(&source, &english));
        assert!(v2_language_pair_prior(&source, &english) < 0.0);

        let mut japanese_alias = english;
        japanese_alias.stream.language = Some("ja-JP".to_string());
        assert!(v2_language_pair_prior(&source, &japanese_alias) > 0.0);
        assert_eq!(
            normalized_stream_language(Some("zh-Hans")).as_deref(),
            Some("zh")
        );
        assert_eq!(
            normalized_stream_language(Some("chi")).as_deref(),
            Some("zh")
        );
    }

    #[test]
    fn v2_disjoint_repeated_content_hypotheses_compete_and_are_preserved() {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..24i64 {
            let hash = ((10_000 + index as u64) << 8) | 4;
            source.push(SpectralLandmark {
                hash,
                time_ms: index * 1_000,
                strength_milli: 1_000,
            });
            source.push(SpectralLandmark {
                hash,
                time_ms: 60_000 + index * 1_000,
                strength_milli: 1_000,
            });
            target.push(SpectralLandmark {
                hash,
                time_ms: 5_000 + index * 1_000,
                strength_milli: 1_000,
            });
        }
        source.sort_by_key(|item| item.time_ms);
        let config = AffineMatchConfig {
            min_inliers: 6,
            top_k: 5,
            ..AffineMatchConfig::default()
        };
        let result = match_landmarks_affine_with_cancel(&source, &target, &config, None).unwrap();
        let first = result.hypotheses.first().unwrap();
        let second = result.hypotheses.get(1).unwrap();
        let source_input = test_audio_input(1, 0);
        let target_input = test_audio_input(2, 0);
        let alternatives = result
            .hypotheses
            .iter()
            .map(|hypothesis| {
                v2_alternative_hypothesis_score(
                    &source_input,
                    &target_input,
                    hypothesis,
                    score_v2_track_pair(hypothesis, 1.0, &config, &source_input, &target_input),
                )
            })
            .collect::<Vec<_>>();

        assert!(
            first.source_end_ms < second.source_start_ms
                || second.source_end_ms < first.source_start_ms
        );
        assert!(result.top1_top2_margin < ALIGNMENT_V2_MIN_TRACK_MARGIN);
        assert!(v2_affine_has_competing_repeated_location(
            &result.hypotheses,
            result.top1_top2_margin
        ));
        assert!(alternatives.len() >= 2);
        assert!(alternatives
            .iter()
            .any(|item| item.offset_ms.abs_diff(5_000) <= 2));
        assert!(alternatives
            .iter()
            .any(|item| item.offset_ms.abs_diff(-55_000) <= 2));
    }

    #[test]
    fn v2_chunked_edit_dp_outputs_both_symmetric_gap_kinds_at_speed_1_02() {
        let base = (0..24usize).collect::<Vec<_>>();
        let source_labels = base
            .iter()
            .copied()
            .filter(|label| !(5..7).contains(label))
            .collect::<Vec<_>>();
        let target_labels = base
            .iter()
            .copied()
            .filter(|label| !(15..17).contains(label))
            .collect::<Vec<_>>();
        let source = v2_labeled_features(&source_labels, 0, 100);
        let target = v2_labeled_features(&target_labels, 500, 102);
        let coarse = v2_test_hypothesis(1.02, 500);
        let result =
            align_v2_feature_chunks(&source, &target, &coarse, &test_options(), None).unwrap();
        let kinds = result
            .spans
            .iter()
            .map(|span| span.kind)
            .collect::<Vec<_>>();

        assert!(kinds.contains(&AudioTimeMapSpanKind::SourceOnly));
        assert!(kinds.contains(&AudioTimeMapSpanKind::TargetOnly));
        assert!(kinds.contains(&AudioTimeMapSpanKind::Matched));
        validate_v2_time_map_spans(&result.spans).unwrap();
    }

    #[test]
    fn v2_recursive_corridor_recovers_after_120_second_target_only_edit() {
        let source_ids = (0..180usize).collect::<Vec<_>>();
        let mut target_ids = source_ids[..60].to_vec();
        target_ids.extend(10_000..10_120);
        target_ids.extend_from_slice(&source_ids[60..]);
        let source = v2_distinct_features(&source_ids, 0, 1_000);
        let target = v2_distinct_features(&target_ids, 0, 1_000);
        let coarse = v2_test_hypothesis(1.0, 0);
        let result =
            align_v2_feature_chunks(&source, &target, &coarse, &test_options(), None).unwrap();
        let target_only_ms = result
            .spans
            .iter()
            .filter(|span| span.kind == AudioTimeMapSpanKind::TargetOnly)
            .map(|span| span.target_end_ms.saturating_sub(span.target_start_ms))
            .sum::<u64>();
        let recovered_tail_ms = result
            .spans
            .iter()
            .filter(|span| {
                span.kind == AudioTimeMapSpanKind::Matched && span.target_end_ms > 240_000
            })
            .map(|span| span.target_end_ms.saturating_sub(span.target_start_ms))
            .sum::<u64>();

        assert!(target_only_ms >= 100_000, "targetOnly={target_only_ms}");
        assert!(recovered_tail_ms >= 30_000, "tail={recovered_tail_ms}");
        validate_v2_time_map_spans(&result.spans).unwrap();
    }

    #[test]
    fn v2_silent_source_only_boundaries_are_attempted_but_remain_blocking() {
        let mut spans = vec![
            AudioTimeMapSpanDto {
                kind: AudioTimeMapSpanKind::Matched,
                source_start_ms: 0,
                source_end_ms: 10_000,
                target_start_ms: 0,
                target_end_ms: 10_000,
            },
            AudioTimeMapSpanDto {
                kind: AudioTimeMapSpanKind::SourceOnly,
                source_start_ms: 10_000,
                source_end_ms: 20_000,
                target_start_ms: 10_000,
                target_end_ms: 10_000,
            },
            AudioTimeMapSpanDto {
                kind: AudioTimeMapSpanKind::Matched,
                source_start_ms: 20_000,
                source_end_ms: 30_000,
                target_start_ms: 10_000,
                target_end_ms: 20_000,
            },
        ];
        let pcm = vec![0i16; ALIGNMENT_V2_SAMPLE_RATE as usize * 31];
        let summary = refine_v2_span_boundaries(
            &mut spans,
            &pcm,
            &pcm,
            &test_audio_input(1, 0),
            &test_audio_input(2, 0),
            None,
        );

        assert_eq!(summary.attempted_count, 2);
        assert_eq!(summary.refined_count, 0);
        assert_eq!(summary.ambiguous_count, 2);
        assert!(summary.max_uncertainty_ms.is_some_and(|value| value >= 150));
        assert!(summary
            .evidence_notes
            .iter()
            .any(|note| note.contains("不会把粗 DP 边界冒充精确时间")));
    }

    #[test]
    fn v2_no_range_block_omits_time_map_but_affine_block_is_valid_ambiguous_map() {
        let without_range =
            create_blocked_v2_proposal("没有共同音轨。", None, None, None, Vec::new(), Vec::new());
        assert!(without_range.time_map.is_none());
        assert!(without_range.match_range.is_none());

        let pair = v2_test_pair_candidate();
        let with_affine = create_blocked_v2_affine_proposal(
            "Top1/Top2 歧义。",
            &pair,
            0.02,
            vec![v2_alternative_track_score(&pair)],
            Vec::new(),
        );
        let time_map = with_affine.time_map.unwrap();
        assert_eq!(time_map.quality.level, "blocked");
        assert!(time_map.quality.probability.is_none());
        assert_eq!(time_map.spans.len(), 1);
        assert_eq!(time_map.spans[0].kind, AudioTimeMapSpanKind::Ambiguous);
        assert!(time_map.source_end_ms > time_map.source_start_ms);
        assert!(time_map.target_end_ms > time_map.target_start_ms);
        validate_v2_time_map_spans(&time_map.spans).unwrap();
    }

    #[test]
    fn ffmpeg_v2_integration_keeps_pts_avoids_commentary_and_models_bilateral_edits() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过 Alignment V2 FFmpeg 集成测试：ffmpeg/ffprobe 不可用。");
            return;
        }
        let directory = std::env::temp_dir().join(format!(
            "alignment-v2-ffmpeg-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source_path = directory.join("source-negative-pts.mka");
        let target_path = directory.join("target-positive-pts.mka");
        generate_v2_ffmpeg_fixture(
            &source_path,
            "[0:a]asplit=2[x0][x1];[x0]atrim=start=0:end=5,asetpts=PTS-STARTPTS[a0];[x1]atrim=start=6:end=16,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[main]",
            "-0.25",
            "440",
        );
        generate_v2_ffmpeg_fixture(
            &target_path,
            "[0:a]asplit=2[x0][x1];[x0]atrim=start=0:end=11,asetpts=PTS-STARTPTS[a0];[x1]atrim=start=12:end=16,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1,atempo=0.980392[main]",
            "0.5",
            "660",
        );
        reset_test_v2_pcm_decode_invocations();
        let proposal = align_audio_files_inner(AudioAlignmentRequest {
            complete_path: target_path.to_string_lossy().to_string(),
            source_path: source_path.to_string_lossy().to_string(),
            ffmpeg_path: Some("ffmpeg".to_string()),
            ffprobe_path: Some("ffprobe".to_string()),
            complete_audio_stream_index: None,
            source_audio_stream_index: None,
            complete_video_stream_index: None,
            source_video_stream_index: None,
            sample_rate: None,
            window_ms: None,
            match_threshold: None,
            min_gap_ms: None,
            max_cells: Some(ALIGNMENT_V2_MAX_DP_CELLS),
            enable_visual_evidence: Some(false),
            visual_sample_interval_ms: None,
            localization_mode: Some(true),
        })
        .unwrap();
        assert_eq!(
            test_v2_pcm_decode_invocations(),
            2,
            "两个所选主音轨应各只解码一次；粗定位后不得为细对齐再次调用 FFmpeg"
        );
        let time_map = proposal.time_map.as_ref().unwrap_or_else(|| {
            panic!(
                "V2 应输出合法时间图；diagnostics={:?}",
                proposal.diagnostics
            )
        });

        assert_eq!(time_map.engine_version, ALIGNMENT_V2_ENGINE_VERSION);
        assert_eq!(time_map.feature_version, ALIGNMENT_V2_FEATURE_VERSION);
        assert_ne!(time_map.quality.level, "verified");
        assert!(time_map.quality.probability.is_none());
        assert_eq!(time_map.source_stream.as_ref().unwrap().index, 0);
        assert_eq!(time_map.target_stream.as_ref().unwrap().index, 0);
        assert_eq!(
            time_map.source_stream.as_ref().unwrap().start_ms,
            Some(-250)
        );
        assert_eq!(time_map.target_stream.as_ref().unwrap().start_ms, Some(500));
        assert_eq!(
            time_map.source_stream.as_ref().unwrap().timeline_offset_ms,
            Some(0)
        );
        assert_v2_bilateral_edit_gold(time_map);
        assert!(time_map.evidence.selected_track_reason.contains("音轨 #0"));
        assert!((time_map.evidence.alternative_track_scores[0].scale - 1.02).abs() < 0.01);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn ffmpeg_v2_vfr_container_keeps_audio_pts_and_bilateral_edit_boundaries() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过 Alignment V2 VFR 金标准：ffmpeg/ffprobe 不可用。");
            return;
        }
        let directory = std::env::temp_dir().join(format!(
            "alignment-v2-vfr-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source_path = directory.join("source-vfr-negative-pts.mkv");
        let target_path = directory.join("target-vfr-positive-pts.mkv");
        generate_v2_vfr_ffmpeg_fixture(
            &source_path,
            "[0:a]asplit=2[x0][x1];[x0]atrim=start=0:end=5,asetpts=PTS-STARTPTS[a0];[x1]atrim=start=6:end=16,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[main]",
            "select=not(mod(n\\,2))+not(mod(n\\,5))",
            "-0.25",
        );
        generate_v2_vfr_ffmpeg_fixture(
            &target_path,
            "[0:a]asplit=2[x0][x1];[x0]atrim=start=0:end=11,asetpts=PTS-STARTPTS[a0];[x1]atrim=start=12:end=16,asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1,atempo=0.980392[main]",
            "select=not(mod(n\\,3))+not(mod(n\\,7))",
            "0.5",
        );

        assert_genuine_vfr_pts(&source_path, -250);
        assert_genuine_vfr_pts(&target_path, 500);
        let source_snapshot =
            probe_media_timeline_with_ffprobe(&source_path.to_string_lossy(), Path::new("ffprobe"))
                .unwrap();
        let target_snapshot =
            probe_media_timeline_with_ffprobe(&target_path.to_string_lossy(), Path::new("ffprobe"))
                .unwrap();
        let source_audio = source_snapshot.audio_streams.first().unwrap();
        let target_audio = target_snapshot.audio_streams.first().unwrap();
        assert_eq!(source_audio.start_time_ms, -250);
        assert_eq!(target_audio.start_time_ms, 500);
        assert_eq!(source_audio.timeline_offset_ms, 0);
        assert_eq!(target_audio.timeline_offset_ms, 0);
        let source_decode_timeline = probe_audio_decode_timelines_with_ffprobe(
            &source_path.to_string_lossy(),
            Path::new("ffprobe"),
        )
        .unwrap();
        let target_decode_timeline = probe_audio_decode_timelines_with_ffprobe(
            &target_path.to_string_lossy(),
            Path::new("ffprobe"),
        )
        .unwrap();
        assert_eq!(
            source_decode_timeline
                .get(&source_audio.stream_index)
                .and_then(|timeline| timeline.first_decoded_pts_ms),
            Some(-250)
        );
        assert_eq!(
            target_decode_timeline
                .get(&target_audio.stream_index)
                .and_then(|timeline| timeline.first_decoded_pts_ms),
            Some(500)
        );

        let proposal = align_audio_files_inner(AudioAlignmentRequest {
            complete_path: target_path.to_string_lossy().to_string(),
            source_path: source_path.to_string_lossy().to_string(),
            ffmpeg_path: Some("ffmpeg".to_string()),
            ffprobe_path: Some("ffprobe".to_string()),
            complete_audio_stream_index: None,
            source_audio_stream_index: None,
            complete_video_stream_index: None,
            source_video_stream_index: None,
            sample_rate: None,
            window_ms: None,
            match_threshold: None,
            min_gap_ms: None,
            max_cells: Some(ALIGNMENT_V2_MAX_DP_CELLS),
            enable_visual_evidence: Some(false),
            visual_sample_interval_ms: None,
            localization_mode: Some(true),
        })
        .unwrap();
        let time_map = proposal
            .time_map
            .as_ref()
            .expect("VFR 容器应输出音频时间图");

        assert_eq!(
            time_map.source_stream.as_ref().unwrap().stream_type,
            "audio"
        );
        assert_eq!(
            time_map.target_stream.as_ref().unwrap().stream_type,
            "audio"
        );
        assert_eq!(
            time_map.source_stream.as_ref().unwrap().start_ms,
            Some(-250)
        );
        assert_eq!(time_map.target_stream.as_ref().unwrap().start_ms, Some(500));
        assert_eq!(
            time_map.source_stream.as_ref().unwrap().timeline_offset_ms,
            Some(0)
        );
        assert_eq!(
            time_map.target_stream.as_ref().unwrap().timeline_offset_ms,
            Some(0)
        );
        assert_eq!(time_map.evidence.types, vec!["audio"]);
        assert_v2_bilateral_edit_gold(time_map);
        assert!((time_map.evidence.alternative_track_scores[0].scale - 1.02).abs() < 0.01);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn ffmpeg_v2_visual_fallback_localizes_video_without_audio() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过 Alignment V2 视觉回退集成测试：ffmpeg/ffprobe 不可用。");
            return;
        }
        let directory = std::env::temp_dir().join(format!(
            "alignment-v2-visual-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let source_path = directory.join("source-video-only.mkv");
        let target_path = directory.join("target-video-only.mkv");
        let source_status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=10:duration=12",
                "-an",
                "-c:v",
                "ffv1",
            ])
            .arg(&source_path)
            .status()
            .unwrap();
        assert!(source_status.success());
        let target_status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=black:size=160x90:rate=10:duration=8",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=10:duration=12",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map",
                "[v]",
                "-an",
                "-c:v",
                "ffv1",
            ])
            .arg(&target_path)
            .status()
            .unwrap();
        assert!(target_status.success());

        let proposal = align_audio_files_inner(AudioAlignmentRequest {
            complete_path: target_path.to_string_lossy().to_string(),
            source_path: source_path.to_string_lossy().to_string(),
            ffmpeg_path: Some("ffmpeg".to_string()),
            ffprobe_path: Some("ffprobe".to_string()),
            complete_audio_stream_index: None,
            source_audio_stream_index: None,
            complete_video_stream_index: None,
            source_video_stream_index: None,
            sample_rate: None,
            window_ms: None,
            match_threshold: None,
            min_gap_ms: None,
            max_cells: Some(ALIGNMENT_V2_MAX_DP_CELLS),
            enable_visual_evidence: Some(false),
            visual_sample_interval_ms: Some(1_000),
            localization_mode: Some(true),
        })
        .unwrap();
        let time_map = proposal.time_map.as_ref().unwrap_or_else(|| {
            panic!(
                "视觉回退应输出 timeMap；diagnostics={:?}",
                proposal.diagnostics
            )
        });
        assert_eq!(time_map.quality.level, "review");
        assert_eq!(
            time_map.feature_version,
            ALIGNMENT_V2_VISUAL_FEATURE_VERSION
        );
        assert_eq!(time_map.spans[0].kind, AudioTimeMapSpanKind::Matched);
        assert_eq!(
            time_map.source_stream.as_ref().unwrap().stream_type,
            "video"
        );
        assert_eq!(
            time_map.target_stream.as_ref().unwrap().stream_type,
            "video"
        );
        assert_eq!(
            time_map.source_visual_stream.as_ref().unwrap().index,
            time_map.source_stream.as_ref().unwrap().index
        );
        assert_eq!(
            time_map.target_visual_stream.as_ref().unwrap().index,
            time_map.target_stream.as_ref().unwrap().index
        );
        assert!(time_map.target_start_ms.abs_diff(8_000) <= 1_000);
        assert!(time_map.evidence.types.contains(&"visual"));
        assert!(!time_map.evidence.types.contains(&"audio"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn ffmpeg_v2_pts_gap_is_preserved_as_silence_instead_of_being_flattened() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过 Alignment V2 PTS gap 测试：ffmpeg/ffprobe 不可用。");
            return;
        }
        let directory = std::env::temp_dir().join(format!(
            "alignment-v2-pts-gap-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let media_path = directory.join("five-second-middle-gap.mka");
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=if(lt(t\\,4)\\,0.6*sin(2*PI*440*t)\\,0.6*sin(2*PI*880*t)):s=16000:d=8",
                "-af",
                "asetpts=PTS+5/TB*gte(T\\,4)",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&media_path)
            .status()
            .unwrap();
        assert!(status.success(), "PTS gap fixture 生成失败");

        let snapshot =
            probe_media_timeline_with_ffprobe(&media_path.to_string_lossy(), Path::new("ffprobe"))
                .unwrap();
        let timelines = probe_audio_decode_timelines_with_ffprobe(
            &media_path.to_string_lossy(),
            Path::new("ffprobe"),
        )
        .unwrap();
        let stream = snapshot.audio_streams[0].clone();
        let evidence = timelines.get(&stream.stream_index).cloned().unwrap();
        assert_eq!(evidence.pts_discontinuity_count, 1);
        assert!(evidence.max_pts_gap_ms.is_some_and(|gap| gap >= 4_900));
        let input = alignment_audio_input_from_snapshot(&snapshot, stream, true, Some(evidence));
        let pcm = decode_v2_pcm(
            &media_path.to_string_lossy(),
            "PTS gap fixture",
            &test_options(),
            &input,
            None,
        )
        .unwrap();
        let sample_rate = ALIGNMENT_V2_SAMPLE_RATE as usize;
        let middle_gap = &pcm[5 * sample_rate..8 * sample_rate];
        let post_gap = &pcm[10 * sample_rate..11 * sample_rate];
        let mean_abs = |samples: &[i16]| {
            samples
                .iter()
                .map(|sample| i64::from(*sample).abs() as f64)
                .sum::<f64>()
                / samples.len() as f64
        };

        assert!(pcm.len() >= 12 * sample_rate, "samples={}", pcm.len());
        assert!(
            mean_abs(middle_gap) < 10.0,
            "gap energy={}",
            mean_abs(middle_gap)
        );
        assert!(
            mean_abs(post_gap) > 1_000.0,
            "post energy={}",
            mean_abs(post_gap)
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn visual_features_ignore_watermark_and_subtitle_regions() {
        let base = scene_pixels(90);
        let mut noisy = base.clone();
        paint_visual_rect(&mut noisy, 24, 1, 8, 5, 255);
        paint_visual_rect(&mut noisy, 0, 14, 32, 4, 0);
        let base_frame = VisualFeatureFrame {
            time_ms: 0,
            values: create_robust_visual_values(&base),
        };
        let noisy_frame = VisualFeatureFrame {
            time_ms: 0,
            values: create_robust_visual_values(&noisy),
        };

        assert!(get_visual_feature_distance(&base_frame, &noisy_frame) < 0.01);
    }

    #[test]
    fn v2_visual_affine_finds_scale_1_02_in_late_half_of_long_target() {
        let source = (0..40)
            .map(|index| visual_signature_frame(index * 5_000, index))
            .collect::<Vec<_>>();
        let mut target = (0..60)
            .map(|index| visual_signature_frame(index * 5_000, 10_000 + index))
            .collect::<Vec<_>>();
        target.extend((0..40).map(|index| {
            visual_signature_frame(
                300_000 + (index as f64 * 5_000.0 * 1.02).round() as u64,
                index,
            )
        }));
        target.sort_by_key(|frame| frame.time_ms);

        let result = match_visual_features_affine(&source, &target, None).unwrap();
        let best = result.hypotheses.first().expect("visual affine");
        assert!((best.scale - 1.02).abs() < 0.002, "scale={}", best.scale);
        assert!(best.offset_ms.abs_diff(300_000) < 1_000);
        assert!(best.coverage > 0.95);
        assert!(best.temporal_span_coverage > 0.95);
        assert!(result.top1_top2_margin >= ALIGNMENT_V2_VISUAL_MIN_MARGIN);
    }

    #[test]
    fn v2_visual_repeated_opening_keeps_competing_locations_and_low_margin() {
        let source = (0..24)
            .map(|index| visual_signature_frame(index * 5_000, index))
            .collect::<Vec<_>>();
        let mut target = Vec::new();
        for offset in [20_000, 240_000] {
            target
                .extend((0..24).map(|index| visual_signature_frame(offset + index * 5_000, index)));
        }
        target.sort_by_key(|frame| frame.time_ms);

        let result = match_visual_features_affine(&source, &target, None).unwrap();
        assert!(result.hypotheses.len() >= 2);
        assert!(
            result.hypotheses[0]
                .offset_ms
                .abs_diff(result.hypotheses[1].offset_ms)
                > 100_000
        );
        assert!(result.top1_top2_margin < ALIGNMENT_V2_VISUAL_MIN_MARGIN);
    }

    #[test]
    fn v2_visual_low_information_and_missing_video_are_safely_blocked() {
        let low_information = (0..20)
            .map(|index| VisualFeatureFrame {
                time_ms: index * 5_000,
                values: vec![0.5, 0.001, 0.0, 0.0],
            })
            .collect::<Vec<_>>();
        let result =
            match_visual_features_affine(&low_information, &low_information, None).unwrap();
        assert!(result.hypotheses.is_empty());

        let proposal =
            create_blocked_visual_fallback_without_map("无共同音频", "没有视频流", Vec::new());
        assert!(proposal.time_map.is_none());
        assert_eq!(proposal.confidence, 0.0);
        let visual = proposal
            .evidence
            .unwrap()
            .signals
            .unwrap()
            .into_iter()
            .find(|signal| signal.kind == "visual")
            .unwrap();
        assert_eq!(visual.status, "blocked");
    }

    #[test]
    fn v2_visual_validation_detects_audio_video_conflict() {
        let source = (0..16)
            .map(|index| visual_signature_frame(index * 5_000, index))
            .collect::<Vec<_>>();
        let target = (0..16)
            .map(|index| visual_signature_frame(index * 5_000, 1_000 + index))
            .collect::<Vec<_>>();
        let time_map = visual_test_time_map(AudioTimeMapSpanDto {
            kind: AudioTimeMapSpanKind::Matched,
            source_start_ms: 0,
            source_end_ms: 80_000,
            target_start_ms: 0,
            target_end_ms: 80_000,
        });

        let summary = summarize_v2_visual_time_map_validation(&source, &target, &time_map, None)
            .unwrap()
            .unwrap();
        assert_eq!(summary.observations, 16);
        assert_eq!(summary.supported_observations, 0);
        assert!(v2_visual_summary_is_conflict(&summary));

        let mut proposal = create_v2_alignment_proposal(
            V2ChunkAlignment {
                spans: vec![AudioTimeMapSpanDto {
                    kind: AudioTimeMapSpanKind::Matched,
                    source_start_ms: 0,
                    source_end_ms: 120_000,
                    target_start_ms: 0,
                    target_end_ms: 120_000,
                }],
                matched_step_count: 20,
                ambiguous_step_count: 0,
            },
            V2BoundarySummary::default(),
            v2_test_pair_candidate(),
            0.5,
            "test audio".to_string(),
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(proposal.time_map.as_ref().unwrap().quality.level, "review");
        assert!(!proposal.anchors.is_empty());
        block_proposal_for_v2_visual_conflict(&mut proposal);
        assert_eq!(proposal.time_map.as_ref().unwrap().quality.level, "blocked");
        assert_eq!(proposal.confidence, 0.0);
        assert!(proposal.anchors.is_empty());
        assert!(proposal
            .diagnostics
            .iter()
            .any(|line| line.contains("音画冲突")));
    }

    #[test]
    fn proposal_time_map_identities_must_match_run_lease_identities() {
        let mut proposal = create_v2_alignment_proposal(
            V2ChunkAlignment {
                spans: vec![AudioTimeMapSpanDto {
                    kind: AudioTimeMapSpanKind::Matched,
                    source_start_ms: 0,
                    source_end_ms: 120_000,
                    target_start_ms: 0,
                    target_end_ms: 120_000,
                }],
                matched_step_count: 20,
                ambiguous_step_count: 0,
            },
            V2BoundarySummary::default(),
            v2_test_pair_candidate(),
            0.5,
            "test audio".to_string(),
            Vec::new(),
            Vec::new(),
        );
        let source_run = test_media_content_identity('a', 1_024, 1);
        let target_run = test_media_content_identity('a', 1_024, 1);
        assert!(
            verify_proposal_time_map_identities_match_run(&proposal, &source_run, &target_run,)
                .is_ok()
        );

        proposal.time_map.as_mut().unwrap().target_identity =
            Some(test_media_content_identity('b', 1_024, 1));
        let error =
            verify_proposal_time_map_identities_match_run(&proposal, &source_run, &target_run)
                .unwrap_err();
        assert!(error.starts_with("blocked:media-identity-changed"));
        assert!(!error.contains(&source_run.first_sample_digest));
    }

    #[test]
    fn benchmark_proposal_binding_separates_missing_map_from_identity_mismatch() {
        let mut proposal = create_v2_alignment_proposal(
            V2ChunkAlignment {
                spans: vec![AudioTimeMapSpanDto {
                    kind: AudioTimeMapSpanKind::Matched,
                    source_start_ms: 0,
                    source_end_ms: 120_000,
                    target_start_ms: 0,
                    target_end_ms: 120_000,
                }],
                matched_step_count: 20,
                ambiguous_step_count: 0,
            },
            V2BoundarySummary::default(),
            v2_test_pair_candidate(),
            0.5,
            "benchmark identity".to_string(),
            Vec::new(),
            Vec::new(),
        );
        let source = proposal
            .time_map
            .as_ref()
            .unwrap()
            .source_identity
            .clone()
            .unwrap();
        let target = proposal
            .time_map
            .as_ref()
            .unwrap()
            .target_identity
            .clone()
            .unwrap();
        assert_eq!(
            verify_alignment_benchmark_proposal_media_identities(&proposal, &source, &target),
            Ok(AlignmentBenchmarkProposalIdentityBinding::Bound)
        );

        proposal.time_map.as_mut().unwrap().source_identity =
            Some(test_media_content_identity('d', source.size_bytes, 1));
        let (mismatch_result, mismatch_is_integrity_failure) =
            bind_alignment_benchmark_proposal_to_workload(proposal.clone(), &source, &target);
        let mismatch = mismatch_result.unwrap_err();
        assert!(mismatch_is_integrity_failure);
        assert!(mismatch.starts_with("blocked:workload-media-integrity"));
        assert!(!mismatch.contains(&source.first_sample_digest));

        proposal.time_map = None;
        let (missing_result, missing_is_integrity_failure) =
            bind_alignment_benchmark_proposal_to_workload(proposal, &source, &target);
        let missing = missing_result.unwrap_err();
        assert!(!missing_is_integrity_failure);
        assert!(missing.contains("未产出"));
        assert!(!missing.starts_with("blocked:workload-media-integrity"));
    }

    #[test]
    fn visual_evidence_updates_proposal_as_auxiliary_signal() {
        let mut proposal = AudioAlignmentProposal {
            anchors: vec![
                SyncAnchorDto {
                    id: "anchor-1".to_string(),
                    source_ms: 0,
                    target_ms: 0,
                    confidence: 0.9,
                    origin: "automatic",
                },
                SyncAnchorDto {
                    id: "anchor-2".to_string(),
                    source_ms: 5_000,
                    target_ms: 5_000,
                    confidence: 0.9,
                    origin: "automatic",
                },
            ],
            cut_candidates: vec![cut_candidate("gap", 5_000, 20_000)],
            confidence: 0.8,
            diagnostics: Vec::new(),
            evidence: Some(AlignmentEvidenceSummary {
                algorithm: "time-map-audio".to_string(),
                complete_fingerprint_count: 2,
                source_fingerprint_count: 2,
                fingerprint_match_count: 2,
                monotonic_match_count: 2,
                strong_anchor_count: 2,
                weak_anchor_count: 0,
                offset_cluster_count: 1,
                refined_candidate_count: 1,
                low_confidence_region_count: 0,
                quality: "high".to_string(),
                time_mapping_segment_count: Some(1),
                confirmed_change_count: Some(1),
                signals: Some(vec![AlignmentEvidenceSignalSummary {
                    kind: "visual",
                    status: "notConfigured",
                    label: "鲁棒视觉指纹",
                    observations: 0,
                    weight: 0.0,
                    note: "未启用".to_string(),
                }]),
            }),
            match_range: None,
            time_map: None,
        };
        let complete = CachedVisualFeatures {
            frames: vec![visual_frame(0, 80), visual_frame(5_000, 100)],
            cache_hit: false,
        };
        let source = CachedVisualFeatures {
            frames: vec![visual_frame(0, 80), visual_frame(5_000, 100)],
            cache_hit: false,
        };
        let visual_pair = (complete, source);

        apply_visual_evidence_to_proposal(&mut proposal, Some(&visual_pair), None);

        let visual_signal = proposal
            .evidence
            .as_ref()
            .unwrap()
            .signals
            .as_ref()
            .unwrap()
            .iter()
            .find(|signal| signal.kind == "visual")
            .unwrap();
        assert_eq!(visual_signal.status, "used");
        assert_eq!(visual_signal.observations, 2);
        assert!(proposal.cut_candidates[0].confidence > 0.8);
        assert!(proposal.cut_candidates[0].note.contains("鲁棒视觉辅助"));
    }

    #[test]
    fn audio_feature_cache_reuses_frames_for_same_file_and_options() {
        let _fixture_guard = lock_audio_feature_cache_test_fixture();
        clear_audio_feature_cache_for_tests();
        let path = temp_audio_cache_path("audio-cache-hit");
        std::fs::write(&path, b"not-a-real-media-file").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let audio_input = test_audio_input(1, 80);
        let cached_frames = frames(&[0.1, 0.2]);
        let cache_key = create_audio_feature_cache_key(&path_text, &options, &audio_input).unwrap();
        write_audio_feature_cache(cache_key, &cached_frames).unwrap();

        let cached =
            get_audio_features(&path_text, "完整版", &options, &audio_input, None).unwrap();

        assert!(cached.cache_hit);
        assert_eq!(cached.frames.len(), cached_frames.len());
        assert_eq!(cached.frames[1].time_ms, cached_frames[1].time_ms);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audio_feature_cache_key_changes_with_feature_window() {
        let _fixture_guard = lock_audio_feature_cache_test_fixture();
        clear_audio_feature_cache_for_tests();
        let path = temp_audio_cache_path("audio-cache-key");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let mut changed_options = test_options();
        changed_options.window_ms = 2_000;
        let audio_input = test_audio_input(1, 80);

        let original_key =
            create_audio_feature_cache_key(&path_text, &options, &audio_input).unwrap();
        let changed_key =
            create_audio_feature_cache_key(&path_text, &changed_options, &audio_input).unwrap();

        assert_ne!(original_key, changed_key);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audio_feature_cache_key_separates_stream_identity_and_presentation_timeline() {
        let path = temp_audio_cache_path("audio-cache-stream");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();

        let first =
            create_audio_feature_cache_key(&path_text, &options, &test_audio_input(1, 80)).unwrap();
        let other_stream =
            create_audio_feature_cache_key(&path_text, &options, &test_audio_input(2, 80)).unwrap();
        let other_timeline =
            create_audio_feature_cache_key(&path_text, &options, &test_audio_input(1, 160))
                .unwrap();

        assert_ne!(first, other_stream);
        assert_ne!(first, other_timeline);
        assert!(first.contains("presentationOriginMs=-80"));
        assert!(first.contains("timelineOffsetMs\":80"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audio_cache_keys_bind_full_digest_even_when_size_and_mtime_match() {
        let path = temp_audio_cache_path("audio-cache-full-digest");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let mut first = test_audio_input(1, 80);
        first.content_identity = Some(test_media_content_identity('a', 5, 42));
        let mut different_bytes = first.clone();
        different_bytes.content_identity = Some(test_media_content_identity('b', 5, 42));

        let first_legacy_key =
            create_audio_feature_cache_key(&path_text, &options, &first).unwrap();
        let changed_legacy_key =
            create_audio_feature_cache_key(&path_text, &options, &different_bytes).unwrap();
        let first_v2_key =
            create_v2_audio_cache_key(&path_text, &options, &first, "landmark").unwrap();
        let changed_v2_key =
            create_v2_audio_cache_key(&path_text, &options, &different_bytes, "landmark").unwrap();
        let first_visual_key =
            create_visual_feature_cache_key(&path_text, &options, first.content_identity.as_ref())
                .unwrap();
        let changed_visual_key = create_visual_feature_cache_key(
            &path_text,
            &options,
            different_bytes.content_identity.as_ref(),
        )
        .unwrap();

        assert_ne!(first_legacy_key, changed_legacy_key);
        assert_ne!(first_v2_key, changed_v2_key);
        assert_ne!(first_visual_key, changed_visual_key);
        assert!(first_legacy_key.contains(&"a".repeat(64)));
        assert!(changed_legacy_key.contains(&"b".repeat(64)));
        std::fs::remove_file(path).unwrap();
    }

    fn test_v2_media_artifact(pcm_samples: usize, marker: u64) -> V2MediaArtifact {
        V2MediaArtifact {
            pcm: Arc::new(vec![marker as i16; pcm_samples]),
            landmarks: Arc::new(vec![SpectralLandmark {
                hash: marker,
                time_ms: marker as i64,
                strength_milli: 1_000,
            }]),
            fine_features: None,
        }
    }

    #[test]
    fn v2_media_artifact_cache_evicts_one_lru_entry_by_resident_bytes() {
        let first = test_v2_media_artifact(256, 1);
        let second = test_v2_media_artifact(256, 2);
        let third = test_v2_media_artifact(256, 3);
        let entry_bytes = v2_media_artifact_resident_bytes("a", &first);
        let mut cache = V2MediaArtifactCache::new(entry_bytes * 2);

        assert_eq!(
            cache.insert("a".to_string(), first, None).unwrap(),
            V2MediaArtifactCacheInsert {
                stored: true,
                new_entry: true,
                eviction_count: 0,
            }
        );
        assert_eq!(
            cache.insert("b".to_string(), second, None).unwrap(),
            V2MediaArtifactCacheInsert {
                stored: true,
                new_entry: true,
                eviction_count: 0,
            }
        );
        assert!(cache.get("a").is_some(), "a must become most recently used");
        assert_eq!(
            cache.insert("c".to_string(), third, None).unwrap(),
            V2MediaArtifactCacheInsert {
                stored: true,
                new_entry: true,
                eviction_count: 1,
            }
        );

        assert_eq!(cache.len(), 2);
        assert!(cache.entries.contains_key("a"));
        assert!(!cache.entries.contains_key("b"));
        assert!(cache.entries.contains_key("c"));
        assert!(cache.resident_bytes <= cache.max_resident_bytes);
    }

    #[test]
    fn v2_media_artifact_cache_clear_removes_pcm_landmarks_and_fine_features() {
        let mut artifact = test_v2_media_artifact(512, 7);
        artifact.fine_features = Some(Arc::new(vec![FineFeatureFrame {
            time_ms: 0,
            values: vec![0.1, 0.2, 0.3],
        }]));
        let mut cache = V2MediaArtifactCache::new(1024 * 1024);
        assert_eq!(
            cache
                .insert("complete-artifact".to_string(), artifact, None)
                .unwrap(),
            V2MediaArtifactCacheInsert {
                stored: true,
                new_entry: true,
                eviction_count: 0,
            }
        );
        assert!(cache.resident_bytes > 0);

        let mut upgraded = test_v2_media_artifact(512, 7);
        upgraded.fine_features = Some(Arc::new(vec![FineFeatureFrame {
            time_ms: 0,
            values: vec![0.4, 0.5, 0.6],
        }]));
        let upgrade = cache
            .insert("complete-artifact".to_string(), upgraded, None)
            .unwrap();
        assert!(upgrade.stored);
        assert!(
            !upgrade.new_entry,
            "same-key fine enrichment is not a new write"
        );
        assert_eq!(upgrade.eviction_count, 0);
        assert_eq!(cache.len(), 1);

        cache.clear();

        assert_eq!(cache.len(), 0);
        assert_eq!(cache.resident_bytes, 0);
        assert_eq!(cache.access_clock, 0);
    }

    #[test]
    fn v2_media_artifact_cache_cancellation_never_publishes_an_entry() {
        let cancelled = AtomicBool::new(true);
        let mut cache = V2MediaArtifactCache::new(1024 * 1024);
        let error = cache
            .insert(
                "cancelled".to_string(),
                test_v2_media_artifact(256, 9),
                Some(&cancelled),
            )
            .unwrap_err();

        assert_eq!(error, AUDIO_ALIGNMENT_CANCELLED);
        assert_eq!(cache.len(), 0);
        assert_eq!(cache.resident_bytes, 0);
    }

    #[test]
    fn v2_auto_track_budget_blocks_before_any_pcm_decode() {
        let mut source_inputs = (0..12)
            .map(|stream_index| {
                let mut input = test_audio_input(stream_index, 0);
                input.media_duration_ms = Some(ALIGNMENT_V2_MAX_DURATION_MS);
                input
            })
            .collect::<Vec<_>>();
        let target_inputs = source_inputs.split_off(6);
        reset_test_v2_pcm_decode_invocations();

        let error = ensure_v2_candidate_set_active_budget(&source_inputs, &target_inputs)
            .expect_err("twelve one-hour tracks must exceed the active artifact budget");

        assert!(error.starts_with("blocked:resource-limit"));
        assert_eq!(test_v2_pcm_decode_invocations(), 0);
    }

    #[test]
    fn audio_cache_keys_reject_missing_or_non_full_file_identity() {
        let path = temp_audio_cache_path("audio-cache-identity-missing");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let mut missing = test_audio_input(1, 80);
        missing.content_identity = None;

        let legacy_error =
            create_audio_feature_cache_key(&path_text, &options, &missing).unwrap_err();
        let v2_error =
            create_v2_audio_cache_key(&path_text, &options, &missing, "landmark").unwrap_err();
        let visual_error = create_visual_feature_cache_key(&path_text, &options, None).unwrap_err();
        assert!(legacy_error.starts_with("blocked:media-identity-missing"));
        assert!(v2_error.starts_with("blocked:media-identity-missing"));
        assert!(visual_error.starts_with("blocked:media-identity-missing"));

        let mut legacy = test_audio_input(1, 80);
        legacy.content_identity = Some(MediaContentIdentity {
            algorithm: "fnv1a64-first-middle-last-64k-v1",
            size_bytes: 5,
            modified_unix_ms: 42,
            first_sample_digest: "1".repeat(16),
            middle_sample_digest: "2".repeat(16),
            last_sample_digest: "3".repeat(16),
        });
        let invalid = create_audio_feature_cache_key(&path_text, &options, &legacy).unwrap_err();
        assert!(invalid.starts_with("blocked:media-identity-invalid"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn post_decode_identity_recheck_rejects_missing_and_changed_identity() {
        let missing = verify_media_content_identity_after_tool_output(
            r"C:\private\must-not-be-opened.mkv",
            None,
            None,
            "测试音频解码",
        )
        .unwrap_err();
        assert!(missing.starts_with("blocked:media-identity-missing"));
        assert!(!missing.contains("private"));

        let path = temp_audio_cache_path("post-decode-identity-change");
        std::fs::write(&path, b"decoded-media-source").unwrap();
        let actual = probe_media_content_identity_cancellable(&path, None).unwrap();
        let path_text = path.to_string_lossy().to_string();
        verify_media_content_identity_after_tool_output(
            &path_text,
            Some(&actual),
            None,
            "测试音频解码",
        )
        .unwrap();
        let mut stale = actual.clone();
        stale.first_sample_digest = "b".repeat(64);
        stale.middle_sample_digest = stale.first_sample_digest.clone();
        stale.last_sample_digest = stale.first_sample_digest.clone();
        let changed = verify_media_content_identity_after_tool_output(
            &path_text,
            Some(&stale),
            None,
            "测试音频解码",
        )
        .unwrap_err();
        assert!(changed.starts_with("blocked:media-identity-changed"));
        assert!(!changed.contains(&path_text));
        assert!(!changed.contains(&actual.first_sample_digest));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn final_identity_gate_rejects_a_cached_artifact_after_file_replacement() {
        let _fixture_guard = lock_audio_feature_cache_test_fixture();
        clear_audio_feature_cache_for_tests();
        let path = temp_audio_cache_path("cache-hit-final-identity-gate");
        std::fs::write(&path, b"version-a-media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let expected = probe_media_content_identity_cancellable(&path, None).unwrap();
        let mut input = test_audio_input(1, 80);
        input.content_identity = Some(expected.clone());
        let cache_key =
            create_audio_feature_cache_key(&path_text, &test_options(), &input).unwrap();
        write_audio_feature_cache(cache_key.clone(), &frames(&[0.1, 0.2])).unwrap();
        assert!(read_audio_feature_cache(&cache_key).unwrap().is_some());

        std::fs::write(&path, b"version-b-media").unwrap();
        let error = verify_media_content_identity_after_tool_output(
            &path_text,
            Some(&expected),
            None,
            "对齐结果最终复核",
        )
        .unwrap_err();
        assert!(error.starts_with("blocked:media-identity-changed"));
        assert!(!error.contains(&path_text));
        std::fs::remove_file(path).unwrap();
        clear_audio_feature_cache_for_tests();
    }

    #[test]
    fn visual_validation_rejects_cross_media_identity_binding() {
        let expected = test_media_content_identity('a', 42, 7);
        let other_media = test_media_content_identity('b', 42, 7);

        assert!(ensure_visual_input_matches_time_map_identity(
            &expected,
            Some(&expected),
            "参考视频"
        )
        .is_ok());
        let mismatch = ensure_visual_input_matches_time_map_identity(
            &expected,
            Some(&other_media),
            "参考视频",
        )
        .unwrap_err();
        assert!(mismatch.starts_with("blocked:media-identity-changed"));
        assert!(!mismatch.contains(&expected.first_sample_digest));
        assert!(!mismatch.contains(&other_media.first_sample_digest));
    }

    #[test]
    fn post_decode_identity_recheck_preserves_cancel_and_redacts_probe_errors() {
        let expected = test_media_content_identity('a', 1, 1);
        let cancelled = AtomicBool::new(true);
        let cancel_error = verify_media_content_identity_after_tool_output(
            "must-not-be-opened.mkv",
            Some(&expected),
            Some(&cancelled),
            "测试音频解码",
        )
        .unwrap_err();
        assert_eq!(cancel_error, AUDIO_ALIGNMENT_CANCELLED);

        let missing_path = r"C:\Users\alice\private\missing.mkv";
        let probe_error = verify_media_content_identity_after_tool_output(
            missing_path,
            Some(&expected),
            None,
            "测试音频解码",
        )
        .unwrap_err();
        assert!(probe_error.starts_with("blocked:media-identity-recheck"));
        assert!(!probe_error.contains("alice"));
        assert!(!probe_error.contains("missing.mkv"));
    }

    #[test]
    fn remote_media_input_is_rejected_before_alignment_without_echoing_secrets() {
        let remote = "https://emby.example.test/Videos/private-item/stream?api_key=secret-token";
        let error = validate_media_input(remote, "完整版").unwrap_err();

        assert_eq!(
            error,
            "音频对齐仅支持已导入的本地媒体文件；远程地址不会被读取。"
        );
        assert!(!error.contains("emby.example.test"));
        assert!(!error.contains("private-item"));
        assert!(!error.contains("secret-token"));
        assert!(!error.contains(remote));
        assert!(
            validate_media_input("HTTP://example.test/other?token=hidden", "完整版")
                .unwrap_err()
                .starts_with("音频对齐仅支持已导入的本地媒体文件")
        );
        assert!(validate_media_input("ftp://example.test/item.mkv", "完整版").is_err());
    }

    #[test]
    fn invalid_local_media_path_is_never_echoed_to_errors_or_job_logs() {
        let private_path = r"C:\Users\alice\private\episode.mkv?token=secret-value";
        let error = validate_media_input(private_path, "目标原片").unwrap_err();

        assert!(error.contains("目标原片不是可读取的本地媒体文件"));
        assert!(!error.contains("alice"));
        assert!(!error.contains("episode.mkv"));
        assert!(!error.contains("secret-value"));
        assert!(!error.contains(private_path));
    }

    #[test]
    fn ffmpeg_error_text_redacts_emby_tokens() {
        let redacted = redact_sensitive_media_text(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&token=other failed",
        );

        assert_eq!(
            redacted,
            "https://emby.example.test/Videos/item/stream?api_key=<已隐藏>&token=<已隐藏> failed"
        );
    }

    #[test]
    fn supervised_media_tool_nonzero_error_never_echoes_untrusted_paths() {
        let raw = br#"C:\Users\alice\private\episode.mkv: api_key=secret-token"#;
        let error = format_media_tool_nonzero_exit("FFmpeg 提取音频", Some(7), raw);

        assert!(error.contains("退出码 7"));
        assert!(!error.contains("alice"));
        assert!(!error.contains("episode.mkv"));
        assert!(!error.contains("secret-token"));
    }

    #[test]
    fn cancellable_probe_error_is_normalized_to_alignment_cancellation() {
        let error = format_alignment_probe_error(
            "目标原片媒体时间线探测失败",
            "cancelled：FFprobe 媒体时间线探测已取消。".to_string(),
        );
        assert_eq!(error, AUDIO_ALIGNMENT_CANCELLED);
    }

    #[test]
    fn cleanup_marker_cannot_be_downgraded_to_optional_evidence() {
        let error =
            propagate_alignment_process_cleanup("blocked:process-cleanup：reader cleanup failed")
                .expect_err("cleanup failure must propagate");
        assert!(error.starts_with("blocked:process-cleanup"));
    }

    #[test]
    fn request_validation_rejects_empty_window() {
        let request = AudioAlignmentRequest {
            complete_path: "a.mp4".to_string(),
            source_path: "b.mp4".to_string(),
            ffmpeg_path: None,
            ffprobe_path: None,
            complete_audio_stream_index: None,
            source_audio_stream_index: None,
            complete_video_stream_index: None,
            source_video_stream_index: None,
            sample_rate: Some(8000),
            window_ms: Some(0),
            match_threshold: None,
            min_gap_ms: None,
            max_cells: None,
            enable_visual_evidence: None,
            visual_sample_interval_ms: None,
            localization_mode: None,
        };
        assert!(create_options(&request).is_err());
    }

    #[test]
    fn request_accepts_explicit_global_audio_stream_indexes_and_derives_ffprobe_path() {
        let request: AudioAlignmentRequest = serde_json::from_str(
            r#"{
              "completePath":"complete.mkv",
              "sourcePath":"source.mkv",
              "ffmpegPath":"C:\\tools\\ffmpeg.exe",
              "completeAudioStreamIndex":2,
              "sourceAudioStreamIndex":4
            }"#,
        )
        .unwrap();
        let options = create_options(&request).unwrap();

        assert_eq!(request.complete_audio_stream_index, Some(2));
        assert_eq!(request.source_audio_stream_index, Some(4));
        assert_eq!(options.ffprobe_path, PathBuf::from(r"C:\tools\ffprobe.exe"));
    }

    #[test]
    fn audio_alignment_job_updates_snapshot() {
        let job_id = "test-audio-job-update".to_string();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        insert_audio_alignment_job(job_id.clone(), cancel_flag).unwrap();
        update_audio_alignment_job(
            &job_id,
            AudioAlignmentJobStatus::Running,
            0.35,
            "正在测试任务状态。",
            None,
            None,
        )
        .unwrap();

        let snapshot = get_audio_alignment_job(job_id).unwrap();
        assert_eq!(snapshot.status, AudioAlignmentJobStatus::Running);
        assert_eq!(snapshot.progress, 0.35);
        assert_eq!(snapshot.message, "正在测试任务状态。");
        assert_eq!(snapshot.stage_key, "extracting-complete");
        assert_eq!(snapshot.stage_label, "提取完整版特征");
        assert_eq!(snapshot.stage_index, 2);
        assert_eq!(snapshot.stage_count, AUDIO_ALIGNMENT_STAGE_COUNT);
        assert!(snapshot.stage_progress > 0.0);
        assert!(snapshot.logs.contains(&"正在测试任务状态。".to_string()));
    }

    #[test]
    fn audio_alignment_job_cancel_is_non_terminal_until_worker_exits() {
        let job_id = "test-audio-job-cancel".to_string();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        insert_audio_alignment_job(job_id.clone(), cancel_flag.clone()).unwrap();
        let cancelled = cancel_audio_alignment_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.status, AudioAlignmentJobStatus::Queued);
        assert!(cancelled.message.contains("正在取消"));
        assert!(cancel_flag.load(Ordering::Relaxed));

        update_audio_alignment_job(
            &job_id,
            AudioAlignmentJobStatus::Cancelled,
            1.0,
            AUDIO_ALIGNMENT_CANCELLED,
            None,
            None,
        )
        .unwrap();

        let snapshot = get_audio_alignment_job(job_id).unwrap();
        assert_eq!(snapshot.status, AudioAlignmentJobStatus::Cancelled);
        assert_eq!(snapshot.message, AUDIO_ALIGNMENT_CANCELLED);
        assert!(snapshot.logs.iter().any(|line| line.contains("仍在退出中")));
    }

    #[test]
    fn cancellation_is_checked_before_ffmpeg_spawn() {
        let cancel_flag = AtomicBool::new(true);
        let error = extract_audio_features(
            "missing.mp4",
            "完整版",
            &test_options(),
            &test_audio_input(1, 80),
            Some(&cancel_flag),
        )
        .unwrap_err();

        assert_eq!(error, AUDIO_ALIGNMENT_CANCELLED);
    }

    #[test]
    fn benchmark_lease_rejects_existing_session_and_ordinary_work() {
        assert!(validate_alignment_benchmark_lease_availability(false, false, 0, false).is_ok());
        assert!(validate_alignment_benchmark_lease_availability(true, false, 0, false).is_err());
        assert!(validate_alignment_benchmark_lease_availability(false, true, 0, false).is_err());
        assert!(validate_alignment_benchmark_lease_availability(false, false, 1, false).is_err());
        assert!(validate_alignment_benchmark_lease_availability(false, false, 0, true).is_err());
    }

    #[test]
    fn ordinary_alignment_allows_only_one_native_heavy_run() {
        assert!(validate_ordinary_alignment_run_availability(false, false, 0).is_ok());
        let concurrent =
            validate_ordinary_alignment_run_availability(false, false, MAX_ORDINARY_ALIGNMENT_RUNS)
                .unwrap_err();
        assert!(concurrent.contains("已有一个媒体对齐任务"));
        assert!(validate_ordinary_alignment_run_availability(true, false, 0).is_err());
        assert!(validate_ordinary_alignment_run_availability(false, true, 0).is_err());
    }

    fn benchmark_test_blind_manifest() -> AlignmentBenchmarkBlindRunManifest {
        let identity = AlignmentBenchmarkBlindContentIdentity {
            algorithm: "sha256-full-file-v2".to_string(),
            size_bytes: 128,
            digest: "c".repeat(64),
        };
        AlignmentBenchmarkBlindRunManifest {
            schema_version: ALIGNMENT_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION,
            manifest_id: "frozen-c137".to_string(),
            dataset_version: "2026-07-13".to_string(),
            cases: vec![AlignmentBenchmarkBlindCase {
                case_id: "case-001".to_string(),
                source: AlignmentBenchmarkBlindMediaInput {
                    path: r"C:\private\reference.mkv".to_string(),
                    audio_stream_index: 2,
                    video_stream_index: Some(0),
                    content_identity: identity.clone(),
                    version_note: "reference".to_string(),
                    license_note: "local-only".to_string(),
                },
                target: AlignmentBenchmarkBlindMediaInput {
                    path: r"C:\private\original.mkv".to_string(),
                    audio_stream_index: 3,
                    video_stream_index: None,
                    content_identity: identity,
                    version_note: "original".to_string(),
                    license_note: "local-only".to_string(),
                },
            }],
        }
    }

    fn benchmark_test_canonical_manifest(
        manifest: &AlignmentBenchmarkBlindRunManifest,
    ) -> (String, String) {
        let value = serde_json::to_value(manifest).unwrap();
        let canonical = canonicalize_alignment_benchmark_json(&value).unwrap();
        let digest = format!(
            "sha256:{}",
            sha256_alignment_benchmark_bytes(canonical.as_bytes())
        );
        (canonical, digest)
    }

    fn benchmark_test_registered_binding(
        binding_ordinal: usize,
        pin_index: usize,
        audio_stream_index: u32,
        video_stream_index: Option<u32>,
    ) -> AlignmentBenchmarkRegisteredBinding {
        AlignmentBenchmarkRegisteredBinding {
            binding_ordinal,
            pin_index,
            audio_stream_index,
            video_stream_index,
        }
    }

    #[test]
    fn benchmark_v2_strict_manifest_binds_canonical_json_and_digest() {
        let manifest = benchmark_test_blind_manifest();
        let (canonical, digest) = benchmark_test_canonical_manifest(&manifest);
        let parsed = parse_alignment_benchmark_run_manifest(&canonical, &digest, &digest).unwrap();
        assert_eq!(parsed.cases.len(), 1);
        assert_eq!(parsed.cases[0].source.audio_stream_index, 2);

        let pretty = serde_json::to_string_pretty(&manifest).unwrap();
        assert!(parse_alignment_benchmark_run_manifest(&pretty, &digest, &digest).is_err());
        assert!(parse_alignment_benchmark_run_manifest(
            &canonical,
            &digest.to_ascii_uppercase(),
            &digest.to_ascii_uppercase(),
        )
        .is_err());
        let other = format!("sha256:{}", "d".repeat(64));
        assert!(parse_alignment_benchmark_run_manifest(&canonical, &digest, &other).is_err());
    }

    #[test]
    fn benchmark_v2_strict_manifest_rejects_unknown_missing_and_duplicate_cases() {
        let manifest = benchmark_test_blind_manifest();
        let mut value = serde_json::to_value(&manifest).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("gold".to_string(), serde_json::json!({}));
        let canonical = canonicalize_alignment_benchmark_json(&value).unwrap();
        let digest = format!(
            "sha256:{}",
            sha256_alignment_benchmark_bytes(canonical.as_bytes())
        );
        assert!(parse_alignment_benchmark_run_manifest(&canonical, &digest, &digest).is_err());

        let mut missing = serde_json::to_value(&manifest).unwrap();
        missing["cases"][0]["source"]
            .as_object_mut()
            .unwrap()
            .remove("videoStreamIndex");
        let canonical = canonicalize_alignment_benchmark_json(&missing).unwrap();
        let digest = format!(
            "sha256:{}",
            sha256_alignment_benchmark_bytes(canonical.as_bytes())
        );
        assert!(parse_alignment_benchmark_run_manifest(&canonical, &digest, &digest).is_err());

        let mut duplicate = manifest;
        duplicate.cases.push(duplicate.cases[0].clone());
        let (canonical, digest) = benchmark_test_canonical_manifest(&duplicate);
        assert!(parse_alignment_benchmark_run_manifest(&canonical, &digest, &digest).is_err());
    }

    #[test]
    fn benchmark_v2_volume_receipt_deduplicates_same_volume_by_first_binding() {
        let cases = vec![
            AlignmentBenchmarkRegisteredCase {
                case_ordinal: 0,
                source: benchmark_test_registered_binding(0, 0, 1, Some(0)),
                target: benchmark_test_registered_binding(1, 1, 2, None),
            },
            AlignmentBenchmarkRegisteredCase {
                case_ordinal: 1,
                source: benchmark_test_registered_binding(2, 2, 1, Some(0)),
                target: benchmark_test_registered_binding(3, 3, 2, None),
            },
        ];
        let measurements = vec![
            AlignmentBenchmarkVolumeMeasurement {
                stable_key: "volume-b".to_string(),
                seek_penalty: false,
            },
            AlignmentBenchmarkVolumeMeasurement {
                stable_key: "volume-b".to_string(),
                seek_penalty: false,
            },
            AlignmentBenchmarkVolumeMeasurement {
                stable_key: "volume-a".to_string(),
                seek_penalty: true,
            },
            AlignmentBenchmarkVolumeMeasurement {
                stable_key: "volume-b".to_string(),
                seek_penalty: false,
            },
        ];
        let (bindings, volumes) =
            create_alignment_benchmark_volume_receipts(&cases, &measurements).unwrap();

        assert_eq!(bindings.len(), 4);
        assert_eq!(bindings[0].volume_ordinal, 0);
        assert_eq!(bindings[1].volume_ordinal, 0);
        assert_eq!(bindings[2].volume_ordinal, 1);
        assert_eq!(bindings[3].volume_ordinal, 0);
        assert_eq!(volumes.len(), 2);
        assert_eq!(volumes[0].binding_count, 3);
        assert_eq!(volumes[0].seek_penalty, "none");
        assert_eq!(volumes[1].binding_count, 1);
        assert_eq!(volumes[1].seek_penalty, "incurs");
    }

    #[test]
    fn benchmark_volume_guid_root_is_derived_from_handle_path_for_mounted_folders() {
        let handle_path =
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\mounted\media\episode.mkv";
        let root = alignment_benchmark_volume_guid_root_from_handle_path(handle_path).unwrap();
        assert_eq!(root, r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\");
        assert!(alignment_benchmark_volume_guid_root_from_handle_path(
            r"C:\mounted\media\episode.mkv"
        )
        .is_err());
        assert!(alignment_benchmark_volume_guid_root_from_handle_path(
            r"\\?\Volume{not-a-guid}\episode.mkv"
        )
        .is_err());
    }

    #[test]
    fn benchmark_volume_guid_namespace_is_local_but_unc_and_malformed_guid_are_not() {
        let local = r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\mounted\media\episode.mkv";
        assert!(is_alignment_benchmark_local_volume_guid_path(local));
        assert!(!alignment_benchmark_path_uses_unsupported_remote_namespace(
            local
        ));

        for remote_or_invalid in [
            r"\\server\share\episode.mkv",
            r"\\?\UNC\server\share\episode.mkv",
            r"//server/share/episode.mkv",
            r"\\?\Volume{not-a-guid}\episode.mkv",
            r"\\?\C:\episode.mkv",
        ] {
            assert!(!is_alignment_benchmark_local_volume_guid_path(
                remote_or_invalid
            ));
            assert!(alignment_benchmark_path_uses_unsupported_remote_namespace(
                remote_or_invalid
            ));
        }
    }

    #[test]
    fn benchmark_manifest_accepts_local_volume_guid_and_rejects_unc_namespace() {
        let mut media = benchmark_test_blind_manifest().cases[0].source.clone();
        media.path =
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\mounted\episode.mkv".to_string();
        assert!(validate_alignment_benchmark_blind_media(&media).is_ok());

        media.path = r"\\server\share\episode.mkv".to_string();
        let error = validate_alignment_benchmark_blind_media(&media).unwrap_err();
        assert!(error.contains("本地媒体"));
        assert!(!error.contains("server"));
    }

    #[cfg(windows)]
    #[test]
    fn benchmark_hotplug_buffer_initializes_and_validates_size_and_returned_bounds() {
        use windows_sys::Win32::System::Ioctl::STORAGE_HOTPLUG_INFO;

        let mut bytes = create_alignment_benchmark_hotplug_buffer();
        let expected = std::mem::size_of::<STORAGE_HOTPLUG_INFO>() as u32;
        assert_eq!(
            read_alignment_benchmark_device_u32(
                &bytes,
                std::mem::offset_of!(STORAGE_HOTPLUG_INFO, Size),
                "size",
            )
            .unwrap(),
            expected
        );
        assert_eq!(
            parse_alignment_benchmark_hotplug_buffer(&bytes, expected).unwrap(),
            (false, false, false)
        );

        assert!(parse_alignment_benchmark_hotplug_buffer(&bytes, expected + 1).is_err());
        bytes[..4].copy_from_slice(&0_u32.to_ne_bytes());
        assert!(parse_alignment_benchmark_hotplug_buffer(&bytes, expected).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn benchmark_device_descriptor_parser_rejects_version_size_and_returned_overrun() {
        use windows_sys::Win32::System::Ioctl::STORAGE_DEVICE_DESCRIPTOR;

        let minimum = std::mem::offset_of!(STORAGE_DEVICE_DESCRIPTOR, RemovableMedia) + 1;
        let size = std::mem::size_of::<STORAGE_DEVICE_DESCRIPTOR>();
        let mut bytes = vec![0_u8; size];
        bytes[..4].copy_from_slice(&(size as u32).to_ne_bytes());
        bytes[4..8].copy_from_slice(&(size as u32).to_ne_bytes());
        assert!(!parse_alignment_benchmark_storage_device_descriptor(
            &bytes,
            size as u32,
            size as u32,
            size as u32,
        )
        .unwrap());

        assert!(parse_alignment_benchmark_storage_device_descriptor(
            &bytes,
            size as u32 + 1,
            size as u32,
            size as u32,
        )
        .is_err());
        bytes[..4].copy_from_slice(&((minimum - 1) as u32).to_ne_bytes());
        assert!(parse_alignment_benchmark_storage_device_descriptor(
            &bytes,
            size as u32,
            (minimum - 1) as u32,
            size as u32,
        )
        .is_err());
    }

    #[test]
    fn benchmark_volume_device_flags_fail_closed_for_every_removable_or_hotplug_signal() {
        assert!(
            validate_alignment_benchmark_volume_device_flags(false, false, false, false).is_ok()
        );
        for flags in [
            (true, false, false, false),
            (false, true, false, false),
            (false, false, true, false),
            (false, false, false, true),
        ] {
            let error = validate_alignment_benchmark_volume_device_flags(
                flags.0, flags.1, flags.2, flags.3,
            )
            .unwrap_err();
            assert!(error.contains("已拒绝"));
            assert!(!error.contains(r"C:\"));
            assert!(!error.contains("Volume{"));
        }
    }

    #[test]
    fn benchmark_v2_registered_case_rejects_unregistered_and_cross_pairing() {
        let cases = vec![
            AlignmentBenchmarkRegisteredCase {
                case_ordinal: 0,
                source: benchmark_test_registered_binding(0, 0, 2, Some(0)),
                target: benchmark_test_registered_binding(1, 1, 3, None),
            },
            AlignmentBenchmarkRegisteredCase {
                case_ordinal: 1,
                source: benchmark_test_registered_binding(2, 2, 4, None),
                target: benchmark_test_registered_binding(3, 3, 5, Some(1)),
            },
        ];
        assert_eq!(
            find_alignment_benchmark_registered_case(&cases, 0, 1, 2, 3, Some(0), None).unwrap(),
            0
        );
        assert!(
            find_alignment_benchmark_registered_case(&cases, 0, 3, 2, 5, Some(0), Some(1)).is_err()
        );
        assert!(
            find_alignment_benchmark_registered_case(&cases, 9, 1, 2, 3, Some(0), None).is_err()
        );
        assert!(
            find_alignment_benchmark_registered_case(&cases, 0, 1, 99, 3, Some(0), None).is_err()
        );
    }

    #[test]
    fn benchmark_v2_workload_receipt_is_path_free_and_canonically_digested() {
        let manifest = benchmark_test_blind_manifest();
        let (_, run_digest) = benchmark_test_canonical_manifest(&manifest);
        let media_set_digest = create_alignment_benchmark_media_set_digest(&manifest).unwrap();
        let mut receipt = AlignmentBenchmarkWorkloadStorageReceipt {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            run_manifest_digest: run_digest.clone(),
            workload_digest: run_digest,
            binding_count: 2,
            unique_media_count: 2,
            volume_count: 1,
            media_set_digest,
            bindings: vec![
                AlignmentBenchmarkWorkloadBindingReceipt {
                    binding_ordinal: 0,
                    case_ordinal: 0,
                    side: AlignmentBenchmarkBindingSide::Source,
                    volume_ordinal: 0,
                },
                AlignmentBenchmarkWorkloadBindingReceipt {
                    binding_ordinal: 1,
                    case_ordinal: 0,
                    side: AlignmentBenchmarkBindingSide::Target,
                    volume_ordinal: 0,
                },
            ],
            volumes: vec![AlignmentBenchmarkWorkloadVolumeReceipt {
                volume_ordinal: 0,
                binding_count: 2,
                drive_type: "fixed",
                seek_penalty: "none",
                measurement_status: "complete",
            }],
            receipt_digest: String::new(),
        };
        receipt.receipt_digest =
            create_alignment_benchmark_workload_receipt_digest(&receipt).unwrap();
        assert!(is_canonical_alignment_benchmark_sha256(
            &receipt.receipt_digest
        ));
        assert_eq!(
            receipt.receipt_digest,
            create_alignment_benchmark_workload_receipt_digest(&receipt).unwrap()
        );
        let serialized = serde_json::to_string(&receipt).unwrap();
        assert!(!serialized.contains("reference.mkv"));
        assert!(!serialized.contains("original.mkv"));
        assert!(!serialized.contains(&"c".repeat(64)));
        assert!(!serialized.to_ascii_lowercase().contains("volume{"));
        assert!(!serialized.to_ascii_lowercase().contains("serial"));
    }

    #[test]
    fn benchmark_never_commits_active_after_environment_cleanup_fault() {
        let (healthy_status, healthy_reason) = alignment_benchmark_initial_lifecycle_state(false);
        assert_eq!(healthy_status, AlignmentBenchmarkSessionStatus::Active);
        assert!(healthy_reason.is_none());

        let (faulted_status, faulted_reason) = alignment_benchmark_initial_lifecycle_state(true);
        assert_eq!(
            faulted_status,
            AlignmentBenchmarkSessionStatus::CleanupBlocked
        );
        assert_eq!(
            faulted_reason.as_deref(),
            Some(BENCHMARK_PROCESS_CLEANUP_REASON)
        );
    }

    #[test]
    fn benchmark_captures_process_baseline_before_probing_tools() {
        let order = RefCell::new(Vec::new());
        let (baseline, value) = collect_alignment_benchmark_baseline_before_probe(
            || {
                order.borrow_mut().push("baseline");
                Ok(HashSet::from([17_u32]))
            },
            || {
                assert_eq!(order.borrow().as_slice(), &["baseline"]);
                order.borrow_mut().push("probe");
                Ok(23_u32)
            },
        )
        .unwrap();

        assert_eq!(baseline, HashSet::from([17_u32]));
        assert_eq!(value, 23);
        assert_eq!(order.into_inner(), vec!["baseline", "probe"]);
    }

    #[test]
    fn benchmark_tool_version_parser_emits_only_numeric_semver() {
        let stdout = br#"ffmpeg version 7.1.2-C:\Users\alice\private-build host=secret
configuration: --extra-cflags=C:\Users\alice\sdk"#;
        let version =
            parse_alignment_benchmark_tool_semantic_version("ffmpeg", stdout, b"").unwrap();

        assert_eq!(version, "7.1.2");
        assert!(version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.'));
        assert!(!version.contains("alice"));
        assert!(!version.contains("private-build"));
        assert!(parse_alignment_benchmark_tool_semantic_version(
            "ffmpeg",
            br#"wrapper C:\Users\alice\ffmpeg.exe host=secret"#,
            b""
        )
        .is_err());
    }

    #[test]
    fn benchmark_cache_reset_receipt_is_generation_bound_and_single_use() {
        let mut receipt = AlignmentBenchmarkOutstandingReceipt {
            generation: 7,
            reset_tick_ns: 42,
            used: false,
        };
        assert_eq!(
            consume_alignment_benchmark_reset_receipt(Some(&mut receipt), 7).unwrap(),
            Some(7)
        );
        assert!(receipt.used);
        assert_eq!(
            consume_alignment_benchmark_reset_receipt(Some(&mut receipt), 7).unwrap(),
            None
        );

        let mut stale = AlignmentBenchmarkOutstandingReceipt {
            generation: 8,
            reset_tick_ns: 43,
            used: false,
        };
        assert!(consume_alignment_benchmark_reset_receipt(Some(&mut stale), 9).is_err());
        assert!(!stale.used);
    }

    #[test]
    fn benchmark_telemetry_uses_explicit_stages_and_first_cancel_tick() {
        let telemetry = AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS,
            3,
            AlignmentBenchmarkCacheCounts::default(),
        );
        telemetry.mark_started().unwrap();
        telemetry
            .transition_stage("validating", "校验输入与媒体时间线")
            .unwrap();
        telemetry
            .transition_stage("matching", "建立候选观测")
            .unwrap();
        telemetry
            .transition_stage("validating", "复核输入")
            .unwrap();
        telemetry
            .record_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Miss)
            .unwrap();
        telemetry
            .record_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Write)
            .unwrap();
        telemetry
            .record_cache_event(BenchmarkCacheKind::V2Landmarks, BenchmarkCacheEvent::Hit)
            .unwrap();
        telemetry
            .record_cache_event(
                BenchmarkCacheKind::V2Landmarks,
                BenchmarkCacheEvent::Eviction,
            )
            .unwrap();
        let first_cancel = telemetry.record_cancel_request().unwrap();
        let repeated_cancel = telemetry.record_cancel_request().unwrap();
        assert_eq!(first_cancel, repeated_cancel);
        telemetry.set_residual_process_count(0).unwrap();
        telemetry
            .finish(AudioAlignmentJobStatus::Cancelled)
            .unwrap();

        let snapshot = telemetry.snapshot().unwrap();
        assert_eq!(snapshot.stages.len(), 3);
        assert_eq!(snapshot.stages[0].stage_key, "validating");
        assert_eq!(snapshot.stages[1].stage_key, "matching");
        assert_eq!(snapshot.stages[2].occurrence, 2);
        assert_eq!(
            snapshot.stages[2].status,
            AudioAlignmentJobStatus::Cancelled
        );
        assert_eq!(snapshot.cache.landmarks.misses, 1);
        assert_eq!(snapshot.cache.landmarks.writes, 1);
        assert_eq!(snapshot.cache.landmarks.hits, 1);
        assert_eq!(snapshot.cache.landmarks.evictions, 1);
        assert!(snapshot.memory.process_tree_empty_at_terminal);
        assert!(snapshot.cancellation.unwrap().latency_ms >= 0.0);
        assert!(snapshot.end_tick_ns.is_some());
    }

    #[test]
    fn benchmark_job_snapshot_serializes_bridge_contract() {
        let telemetry = AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        );
        let snapshot =
            create_initial_alignment_benchmark_job_snapshot("session-123", "job-12345", &telemetry)
                .unwrap();
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["schemaVersion"], ALIGNMENT_BENCHMARK_SCHEMA_VERSION);
        assert_eq!(value["status"], "queued");
        assert_eq!(value["stageKey"], "queued");
        assert_eq!(
            value["telemetry"]["clock"],
            "rust-std-instant-session-relative-v1"
        );
        assert_eq!(
            value["telemetry"]["memory"]["scope"],
            "application-process-tree"
        );
    }

    #[test]
    fn benchmark_memory_telemetry_fails_closed_on_gap_or_sample_error() {
        let telemetry = AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        );
        let baseline = HashSet::new();
        let first = Instant::now();
        telemetry.record_memory_sample(
            first,
            Ok(ProcessTreeMemorySample {
                working_set_bytes: 123,
                descendants: HashSet::new(),
            }),
            &baseline,
        );
        telemetry.record_memory_sample(
            first + Duration::from_millis(DEFAULT_BENCHMARK_SAMPLE_INTERVAL_MS * 5),
            Err("sample failed".to_string()),
            &baseline,
        );
        let memory = telemetry.snapshot().unwrap().memory;
        assert_eq!(memory.sample_count, 1);
        assert_eq!(memory.failed_sample_count, 1);
        assert_eq!(memory.peak_process_tree_rss_bytes, Some(123));
        assert!(!memory.coverage_complete);
        assert!(memory.maximum_sample_gap_ms >= 100.0);
    }

    #[test]
    fn process_descendant_collection_is_transitive_and_excludes_unrelated_processes() {
        let pairs = vec![(10, 1), (11, 10), (12, 11), (20, 1), (21, 20)];
        let descendants = collect_process_descendants(10, &pairs);
        assert_eq!(descendants, HashSet::from([11, 12]));
    }

    #[cfg(windows)]
    #[test]
    fn windows_benchmark_topology_and_working_set_primitives_are_available() {
        let physical = windows_physical_core_count().unwrap();
        let logical = windows_logical_core_count().unwrap();
        assert!(physical > 0);
        assert!(logical >= physical);
        assert!(windows_total_memory_bytes().unwrap() > 0);

        // Parallel integration tests intentionally create and reap many short-lived FFmpeg
        // processes. ToolHelp sampling is fail-closed for each pass, so retry until one complete
        // snapshot proves the primitive works instead of weakening production coverage rules.
        let sample = (0..50)
            .find_map(|_| {
                let sample = sample_process_tree_memory(std::process::id()).ok();
                if sample.is_none() {
                    thread::sleep(Duration::from_millis(5));
                }
                sample
            })
            .expect("working-set primitive never produced a complete snapshot");
        assert!(sample.working_set_bytes > 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_benchmark_tool_pin_denies_write_and_delete_until_drop() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "danmaku-alignment-benchmark-tool-pin-{}-{unique}.bin",
            std::process::id()
        ));
        fs::write(&path, b"pinned-tool-fixture").unwrap();
        let canonical_path = fs::canonicalize(&path).unwrap();
        let pinned = pin_alignment_benchmark_tool(canonical_path.clone()).unwrap();

        assert!(verify_alignment_benchmark_pinned_tool("fixture", &pinned).is_ok());
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&canonical_path)
            .is_err());
        assert!(fs::remove_file(&canonical_path).is_err());

        drop(pinned);
        assert!(std::fs::OpenOptions::new()
            .write(true)
            .open(&canonical_path)
            .is_ok());
        fs::remove_file(canonical_path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_benchmark_workload_pin_hashes_distinct_media_once_and_deduplicates_aliases() {
        let path = temp_audio_cache_path("alignment-workload-media-dedup");
        fs::write(&path, b"registered-workload-media").unwrap();
        let digest = sha256_alignment_benchmark_bytes(b"registered-workload-media");
        let media = AlignmentBenchmarkBlindMediaInput {
            path: path.to_string_lossy().into_owned(),
            audio_stream_index: 1,
            video_stream_index: Some(0),
            content_identity: AlignmentBenchmarkBlindContentIdentity {
                algorithm: "sha256-full-file-v2".to_string(),
                size_bytes: b"registered-workload-media".len() as u64,
                digest,
            },
            version_note: "fixture".to_string(),
            license_note: "fixture".to_string(),
        };
        let mut pins = Vec::new();
        let mut indexes = HashMap::new();
        let first =
            register_alignment_benchmark_media_binding(&media, 0, &mut pins, &mut indexes).unwrap();
        let second =
            register_alignment_benchmark_media_binding(&media, 1, &mut pins, &mut indexes).unwrap();

        assert_eq!(pins.len(), 1);
        assert_eq!(first.pin_index, second.pin_index);
        assert!(verify_alignment_benchmark_pinned_media(&pins[0]).is_ok());
        let probed_identity = probe_media_content_identity_cancellable(&path, None).unwrap();
        assert_eq!(pins[0].expected_content_identity, probed_identity);
        assert!(fs::write(&path, b"mutated").is_err());
        assert!(fs::remove_file(&path).is_err());

        drop(pins);
        fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_benchmark_workload_pin_rejects_full_identity_mismatch() {
        let path = temp_audio_cache_path("alignment-workload-media-mismatch");
        fs::write(&path, b"registered-workload-media").unwrap();
        let media = AlignmentBenchmarkBlindMediaInput {
            path: path.to_string_lossy().into_owned(),
            audio_stream_index: 1,
            video_stream_index: None,
            content_identity: AlignmentBenchmarkBlindContentIdentity {
                algorithm: "sha256-full-file-v2".to_string(),
                size_bytes: b"registered-workload-media".len() as u64,
                digest: "f".repeat(64),
            },
            version_note: "fixture".to_string(),
            license_note: "fixture".to_string(),
        };
        let mut pins = Vec::new();
        let mut indexes = HashMap::new();
        let error = register_alignment_benchmark_media_binding(&media, 0, &mut pins, &mut indexes)
            .expect_err("mismatched full digest must fail before session publication");

        assert!(error.contains("完整身份"));
        assert!(pins.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "real Windows volume receipt smoke test"]
    fn windows_benchmark_workload_receipt_uses_actual_media_volume_without_paths() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过实际卷 GUID workload smoke：ffmpeg/ffprobe 不可用。");
            return;
        }
        let path = temp_audio_cache_path("alignment-workload-volume-receipt").with_extension("mkv");
        generate_v2_ffmpeg_fixture(&path, "[0:a]anull[main]", "0", "440");
        let original_identity = probe_media_content_identity_cancellable(&path, None).unwrap();
        let media = AlignmentBenchmarkBlindMediaInput {
            path: path.to_string_lossy().into_owned(),
            audio_stream_index: 0,
            video_stream_index: None,
            content_identity: AlignmentBenchmarkBlindContentIdentity {
                algorithm: "sha256-full-file-v2".to_string(),
                size_bytes: original_identity.size_bytes,
                digest: original_identity.first_sample_digest.clone(),
            },
            version_note: "fixture".to_string(),
            license_note: "fixture".to_string(),
        };
        let manifest = AlignmentBenchmarkBlindRunManifest {
            schema_version: ALIGNMENT_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION,
            manifest_id: "volume-fixture".to_string(),
            dataset_version: "1".to_string(),
            cases: vec![AlignmentBenchmarkBlindCase {
                case_id: "same-volume".to_string(),
                source: media.clone(),
                target: AlignmentBenchmarkBlindMediaInput {
                    audio_stream_index: 1,
                    ..media
                },
            }],
        };
        let digest = format!("sha256:{}", "e".repeat(64));
        let workload = prepare_alignment_benchmark_workload(&manifest, &digest, &digest).unwrap();

        assert_eq!(workload.pins.len(), 1);
        assert_eq!(workload.receipt.unique_media_count, 1);
        assert_eq!(workload.receipt.binding_count, 2);
        assert_eq!(workload.receipt.volume_count, 1);
        assert_eq!(workload.receipt.volumes[0].binding_count, 2);
        assert_eq!(workload.receipt.volumes[0].drive_type, "fixed");
        let canonical_path = workload.pins[0].canonical_path.clone();
        let canonical_text = canonical_path.to_string_lossy();
        assert!(is_alignment_benchmark_local_volume_guid_path(
            &canonical_text
        ));
        assert!(verify_alignment_benchmark_pinned_media(&workload.pins[0]).is_ok());
        let reopened = open_alignment_benchmark_media_read_pin(&canonical_path).unwrap();
        assert_eq!(
            windows_alignment_benchmark_file_identity(&reopened).unwrap(),
            workload.pins[0].identity
        );
        let guid_identity =
            probe_media_content_identity_cancellable(&canonical_path, None).unwrap();
        assert_eq!(guid_identity, original_identity);
        let guid_probe = probe_media_timeline_with_ffprobe(&canonical_text, Path::new("ffprobe"))
            .expect("ffprobe must consume the handle-derived volume GUID media path");
        assert_eq!(guid_probe.audio_streams.len(), 2);
        let serialized = serde_json::to_string(&workload.receipt).unwrap();
        assert!(!serialized.contains(&path.to_string_lossy().to_string()));
        assert!(!serialized.contains("Volume{"));

        drop(reopened);
        drop(workload);
        fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn alignment_media_read_lease_blocks_overwrite_and_rename_until_drop() {
        let source = temp_audio_cache_path("alignment-media-lease-source");
        let target = temp_audio_cache_path("alignment-media-lease-target");
        let renamed = source.with_extension("renamed");
        fs::write(&source, b"source-version-a").unwrap();
        fs::write(&target, b"target-version-a").unwrap();
        let lease = acquire_alignment_media_read_lease(
            &source.to_string_lossy(),
            &target.to_string_lossy(),
        )
        .unwrap();

        assert!(fs::write(&source, b"source-version-b").is_err());
        assert!(fs::rename(&source, &renamed).is_err());

        drop(lease);
        fs::write(&source, b"source-version-b").unwrap();
        fs::rename(&source, &renamed).unwrap();
        fs::remove_file(renamed).unwrap();
        fs::remove_file(target).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_benchmark_environment_hashes_resolved_media_tools_without_paths() {
        if !ffmpeg_test_tools_available() {
            eprintln!("跳过原生 benchmark 环境收据测试：ffmpeg/ffprobe 不可用。");
            return;
        }
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut workload_storage = AlignmentBenchmarkWorkloadStorageReceipt {
            schema_version: ALIGNMENT_BENCHMARK_SCHEMA_VERSION,
            run_manifest_digest: digest.clone(),
            workload_digest: digest,
            binding_count: 2,
            unique_media_count: 2,
            volume_count: 1,
            media_set_digest: format!("sha256:{}", "b".repeat(64)),
            bindings: vec![
                AlignmentBenchmarkWorkloadBindingReceipt {
                    binding_ordinal: 0,
                    case_ordinal: 0,
                    side: AlignmentBenchmarkBindingSide::Source,
                    volume_ordinal: 0,
                },
                AlignmentBenchmarkWorkloadBindingReceipt {
                    binding_ordinal: 1,
                    case_ordinal: 0,
                    side: AlignmentBenchmarkBindingSide::Target,
                    volume_ordinal: 0,
                },
            ],
            volumes: vec![AlignmentBenchmarkWorkloadVolumeReceipt {
                volume_ordinal: 0,
                binding_count: 2,
                drive_type: "fixed",
                seek_penalty: "none",
                measurement_status: "complete",
            }],
            receipt_digest: String::new(),
        };
        workload_storage.receipt_digest =
            create_alignment_benchmark_workload_receipt_digest(&workload_storage).unwrap();
        let (environment, ffmpeg_tool, ffprobe_tool) = collect_alignment_benchmark_environment(
            "ffmpeg",
            Path::new("ffprobe"),
            workload_storage,
        )
        .unwrap();
        assert!(environment.physical_core_count > 0);
        assert!(environment.logical_core_count >= environment.physical_core_count);
        assert!(environment.total_memory_bytes > 0);
        assert_eq!(environment.storage_scope, "workload-media-volumes");
        assert_eq!(environment.workload_storage.binding_count, 2);
        assert!(environment.ffmpeg.binary_digest.starts_with("sha256:"));
        assert!(environment.ffprobe.binary_digest.starts_with("sha256:"));
        for version in [&environment.ffmpeg.version, &environment.ffprobe.version] {
            let components = version.split('.').collect::<Vec<_>>();
            assert_eq!(components.len(), 3);
            assert!(components
                .iter()
                .all(|component| component.parse::<u32>().is_ok()));
        }
        assert!(verify_alignment_benchmark_pinned_tool("ffmpeg", &ffmpeg_tool).is_ok());
        assert!(verify_alignment_benchmark_pinned_tool("ffprobe", &ffprobe_tool).is_ok());
        let serialized = serde_json::to_string(&environment).unwrap();
        assert!(!serialized.to_ascii_lowercase().contains("hostname"));
        assert!(!serialized.to_ascii_lowercase().contains("executable_path"));
        assert!(!serialized.contains(&ffmpeg_tool.path.to_string_lossy().to_string()));
        assert!(!serialized.contains(&ffprobe_tool.path.to_string_lossy().to_string()));
    }
}
