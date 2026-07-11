use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{ChildStderr, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_SAMPLE_RATE: u32 = 8_000;
const DEFAULT_WINDOW_MS: u64 = 1_000;
const DEFAULT_MATCH_THRESHOLD: f64 = 0.18;
const DEFAULT_MIN_GAP_MS: u64 = 1_000;
const DEFAULT_MAX_CELLS: usize = 16_000_000;
const DEFAULT_VISUAL_SAMPLE_INTERVAL_MS: u64 = 5_000;
const VISUAL_SAMPLE_WIDTH: usize = 32;
const VISUAL_SAMPLE_HEIGHT: usize = 18;
const VISUAL_GRID_COLUMNS: usize = 4;
const VISUAL_GRID_ROWS: usize = 2;
const VISUAL_MATCH_THRESHOLD: f64 = 0.16;
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

const DIRECTION_SKIP_COMPLETE: u8 = 1;
const DIRECTION_SKIP_SOURCE: u8 = 2;
const DIRECTION_MATCH: u8 = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentRequest {
    complete_path: String,
    source_path: String,
    ffmpeg_path: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

struct AudioAlignmentOptions {
    sample_rate: u32,
    window_ms: u64,
    match_threshold: f64,
    min_gap_ms: u64,
    max_cells: usize,
    ffmpeg_path: String,
    enable_visual_evidence: bool,
    visual_sample_interval_ms: u64,
    localization_mode: bool,
}

#[derive(Debug, Clone)]
struct CachedAudioFeatures {
    frames: Vec<AudioFeatureFrame>,
    cache_hit: bool,
}

#[derive(Debug, Clone)]
struct CachedVisualFeatures {
    frames: Vec<VisualFeatureFrame>,
    cache_hit: bool,
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

static AUDIO_ALIGNMENT_JOBS: OnceLock<Mutex<HashMap<String, AudioAlignmentJobEntry>>> =
    OnceLock::new();
static AUDIO_ALIGNMENT_JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static AUDIO_FEATURE_CACHE: OnceLock<Mutex<HashMap<String, Vec<AudioFeatureFrame>>>> =
    OnceLock::new();
static VISUAL_FEATURE_CACHE: OnceLock<Mutex<HashMap<String, Vec<VisualFeatureFrame>>>> =
    OnceLock::new();

#[tauri::command]
pub async fn align_audio_files(
    request: AudioAlignmentRequest,
) -> Result<AudioAlignmentProposal, String> {
    tauri::async_runtime::spawn_blocking(move || align_audio_files_inner(request))
        .await
        .map_err(|error| format!("本地音频对齐任务启动失败：{error}"))?
}

#[tauri::command]
pub async fn start_audio_alignment_job(
    request: AudioAlignmentRequest,
) -> Result<AudioAlignmentJobSnapshot, String> {
    let job_id = next_audio_alignment_job_id();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    insert_audio_alignment_job(job_id.clone(), cancel_flag.clone())?;
    let worker_job_id = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
        entry.snapshot.status = AudioAlignmentJobStatus::Cancelled;
        entry.snapshot.progress = 1.0;
        entry.snapshot.message = "已请求取消音频对齐任务。".to_string();
        let stage = create_audio_alignment_stage_snapshot(
            &AudioAlignmentJobStatus::Cancelled,
            entry.snapshot.progress,
        );
        apply_audio_alignment_stage_snapshot(&mut entry.snapshot, stage);
        append_audio_alignment_log(&mut entry.snapshot.logs, "已请求取消音频对齐任务。");
        entry.snapshot.updated_at_ms = current_time_ms();
    }
    Ok(entry.snapshot.clone())
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
    check_cancelled(cancel_flag)?;
    update_progress(0.05, "正在校验本地媒体路径。")?;
    validate_media_input(&request.complete_path, "完整版")?;
    validate_media_input(&request.source_path, "当前视频")?;
    let options = create_options(&request)?;
    update_progress(0.10, "已确认本地媒体路径和对齐参数。")?;
    check_cancelled(cancel_flag)?;
    update_progress(0.12, "正在检查或提取完整版音频特征。")?;
    let complete_features =
        get_audio_features(&request.complete_path, "完整版", &options, cancel_flag)?;
    update_progress(
        0.36,
        &format_audio_feature_cache_message("完整版", &complete_features),
    )?;
    check_cancelled(cancel_flag)?;
    update_progress(0.40, "正在检查或提取当前视频音频特征。")?;
    let source_features =
        get_audio_features(&request.source_path, "当前视频", &options, cancel_flag)?;
    update_progress(
        0.64,
        &format_audio_feature_cache_message("当前视频", &source_features),
    )?;
    check_cancelled(cancel_flag)?;
    let mut visual_features: Option<(CachedVisualFeatures, CachedVisualFeatures)> = None;
    let mut visual_error: Option<String> = None;
    if options.enable_visual_evidence {
        update_progress(0.68, "正在提取鲁棒视觉证据。")?;
        match (
            get_visual_features(&request.complete_path, "完整版", &options, cancel_flag),
            get_visual_features(&request.source_path, "当前视频", &options, cancel_flag),
        ) {
            (Ok(complete_visual), Ok(source_visual)) => {
                update_progress(0.74, "鲁棒视觉证据提取完成。")?;
                visual_features = Some((complete_visual, source_visual));
            }
            (Err(error), _) | (_, Err(error)) => {
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
    update_progress(0.97, "正在生成对齐复核数据。")?;
    Ok(proposal)
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
    Ok(AudioAlignmentOptions {
        sample_rate,
        window_ms,
        match_threshold,
        min_gap_ms,
        max_cells,
        ffmpeg_path: request
            .ffmpeg_path
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("ffmpeg")
            .to_string(),
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
        return Ok(());
    }
    if !Path::new(trimmed).is_file() {
        return Err(format!("{label}不是可读取的本地文件：{path}"));
    }
    Ok(())
}

fn is_remote_media_input(path: &str) -> bool {
    let lower = path.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn get_audio_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedAudioFeatures, String> {
    check_cancelled(cancel_flag)?;
    let cache_key = create_audio_feature_cache_key(media_path, options)?;
    if let Some(frames) = read_audio_feature_cache(&cache_key)? {
        return Ok(CachedAudioFeatures {
            frames,
            cache_hit: true,
        });
    }

    let frames = extract_audio_features(media_path, label, options, cancel_flag)?;
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
    Ok(cache.get(cache_key).cloned())
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
    }
    cache.insert(cache_key, frames.to_vec());
    Ok(())
}

fn create_audio_feature_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
) -> Result<String, String> {
    if is_remote_media_input(media_path) {
        return Ok(format!(
            "remote:{}|sampleRate={}|windowMs={}|ffmpeg={}",
            redact_sensitive_media_text(media_path),
            options.sample_rate,
            options.window_ms,
            options.ffmpeg_path
        ));
    }
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
        "{}|len={}|modified={modified_ms}|sampleRate={}|windowMs={}|ffmpeg={}",
        canonical_path.to_string_lossy(),
        metadata.len(),
        options.sample_rate,
        options.window_ms,
        options.ffmpeg_path
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
    cancel_flag: Option<&AtomicBool>,
) -> Result<CachedVisualFeatures, String> {
    check_cancelled(cancel_flag)?;
    let cache_key = create_visual_feature_cache_key(media_path, options)?;
    if let Some(frames) = read_visual_feature_cache(&cache_key)? {
        return Ok(CachedVisualFeatures {
            frames,
            cache_hit: true,
        });
    }

    let frames = extract_visual_features(media_path, label, options, cancel_flag)?;
    write_visual_feature_cache(cache_key, &frames)?;
    Ok(CachedVisualFeatures {
        frames,
        cache_hit: false,
    })
}

fn visual_feature_cache() -> &'static Mutex<HashMap<String, Vec<VisualFeatureFrame>>> {
    VISUAL_FEATURE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_visual_feature_cache(cache_key: &str) -> Result<Option<Vec<VisualFeatureFrame>>, String> {
    let cache = visual_feature_cache()
        .lock()
        .map_err(|_| "视觉特征缓存锁已损坏。".to_string())?;
    Ok(cache.get(cache_key).cloned())
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
    }
    cache.insert(cache_key, frames.to_vec());
    Ok(())
}

fn create_visual_feature_cache_key(
    media_path: &str,
    options: &AudioAlignmentOptions,
) -> Result<String, String> {
    if is_remote_media_input(media_path) {
        return Ok(format!(
            "remote:{}|visualInterval={}|ffmpeg={}",
            redact_sensitive_media_text(media_path),
            options.visual_sample_interval_ms,
            options.ffmpeg_path
        ));
    }
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
        "{}|len={}|modified={modified_ms}|visualInterval={}|ffmpeg={}",
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
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<VisualFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let fps = 1000.0 / options.visual_sample_interval_ms.max(1) as f64;
    let filter = format!(
        "fps={fps:.6},scale={VISUAL_SAMPLE_WIDTH}:{VISUAL_SAMPLE_HEIGHT}:flags=bilinear,format=gray"
    );
    let mut child = Command::new(&options.ffmpeg_path)
        .args(["-v", "error", "-i", media_path, "-vf", &filter, "-an", "-f", "rawvideo", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("FFmpeg 启动视觉采样失败：{error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "FFmpeg 视觉采样标准输出管道不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "FFmpeg 视觉采样错误输出管道不可用。".to_string())?;
    let stdout_reader = thread::spawn(move || read_child_stdout(stdout));
    let stderr_reader = thread::spawn(move || read_child_stderr(stderr));

    let status = loop {
        if let Err(error) = check_cancelled(cancel_flag) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_child_output(stdout_reader, "stdout");
            let _ = join_child_output(stderr_reader, "stderr");
            return Err(error);
        }
        match child
            .try_wait()
            .map_err(|error| format!("FFmpeg 视觉采样状态读取失败：{error}"))?
        {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(100)),
        }
    };

    let stdout = join_child_output(stdout_reader, "stdout")?;
    let stderr = join_child_output(stderr_reader, "stderr")?;
    if !status.success() {
        let detail = redact_sensitive_media_text(&String::from_utf8_lossy(&stderr));
        return Err(format!("FFmpeg 提取视觉证据失败：{detail}"));
    }
    let frames = raw_visual_frames_to_features(&stdout, options.visual_sample_interval_ms)?;
    if frames.is_empty() {
        return Err(format!("{label}未能提取到可用视觉证据。"));
    }
    Ok(frames)
}

fn raw_visual_frames_to_features(
    raw: &[u8],
    sample_interval_ms: u64,
) -> Result<Vec<VisualFeatureFrame>, String> {
    let frame_size = VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT;
    if raw.len() < frame_size {
        return Ok(Vec::new());
    }
    let mut frames = Vec::new();
    for (index, chunk) in raw.chunks_exact(frame_size).enumerate() {
        frames.push(VisualFeatureFrame {
            time_ms: index as u64 * sample_interval_ms,
            values: create_robust_visual_values(chunk),
        });
    }
    Ok(frames)
}

fn create_robust_visual_values(pixels: &[u8]) -> Vec<f64> {
    let mut totals = vec![0.0; VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS];
    let mut counts = vec![0usize; VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS];
    for y in 0..VISUAL_SAMPLE_HEIGHT {
        for x in 0..VISUAL_SAMPLE_WIDTH {
            if !is_core_visual_pixel(x, y) {
                continue;
            }
            let column = (x * VISUAL_GRID_COLUMNS / VISUAL_SAMPLE_WIDTH).min(VISUAL_GRID_COLUMNS - 1);
            let row = ((y.saturating_sub(1)) * VISUAL_GRID_ROWS / 13).min(VISUAL_GRID_ROWS - 1);
            let index = row * VISUAL_GRID_COLUMNS + column;
            totals[index] += pixels[y * VISUAL_SAMPLE_WIDTH + x] as f64 / 255.0;
            counts[index] += 1;
        }
    }
    let global_count = counts.iter().sum::<usize>().max(1);
    let global_mean = totals.iter().sum::<f64>() / global_count as f64;
    totals
        .into_iter()
        .zip(counts)
        .map(|(total, count)| {
            if count == 0 {
                global_mean
            } else {
                total / count as f64
            }
        })
        .collect()
}

fn is_core_visual_pixel(x: usize, y: usize) -> bool {
    if x < 2 || x >= VISUAL_SAMPLE_WIDTH - 2 || y == 0 || y >= 14 {
        return false;
    }
    !(x >= 24 && y <= 5)
}

fn extract_audio_features(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<AudioFeatureFrame>, String> {
    check_cancelled(cancel_flag)?;
    let mut child = Command::new(&options.ffmpeg_path)
        .args([
            "-v",
            "error",
            "-i",
            media_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            &options.sample_rate.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("FFmpeg 启动失败：{error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "FFmpeg 标准输出管道不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "FFmpeg 错误输出管道不可用。".to_string())?;
    let stdout_reader = thread::spawn(move || read_child_stdout(stdout));
    let stderr_reader = thread::spawn(move || read_child_stderr(stderr));

    let status = loop {
        if let Err(error) = check_cancelled(cancel_flag) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_child_output(stdout_reader, "stdout");
            let _ = join_child_output(stderr_reader, "stderr");
            return Err(error);
        }
        match child
            .try_wait()
            .map_err(|error| format!("FFmpeg 状态读取失败：{error}"))?
        {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(100)),
        }
    };

    let stdout = join_child_output(stdout_reader, "stdout")?;
    let stderr = join_child_output(stderr_reader, "stderr")?;
    if !status.success() {
        let detail = redact_sensitive_media_text(&String::from_utf8_lossy(&stderr));
        return Err(format!("FFmpeg 提取音频失败：{detail}"));
    }
    let frames = pcm_to_feature_frames(&stdout, options)?;
    if frames.is_empty() {
        return Err(format!("{label}未能提取到可用音频特征。"));
    }
    Ok(frames)
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
            .find(|character: char| matches!(character, '&' | ' ' | '\n' | '\r' | '"' | '\''))
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

fn read_child_stdout(mut stdout: ChildStdout) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stdout
        .read_to_end(&mut bytes)
        .map_err(|error| format!("FFmpeg stdout 读取失败：{error}"))?;
    Ok(bytes)
}

fn read_child_stderr(mut stderr: ChildStderr) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stderr
        .read_to_end(&mut bytes)
        .map_err(|error| format!("FFmpeg stderr 读取失败：{error}"))?;
    Ok(bytes)
}

fn join_child_output(
    handle: thread::JoinHandle<Result<Vec<u8>, String>>,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    handle
        .join()
        .map_err(|_| format!("FFmpeg {stream_name} 读取线程异常。"))?
}

fn pcm_to_feature_frames(
    bytes: &[u8],
    options: &AudioAlignmentOptions,
) -> Result<Vec<AudioFeatureFrame>, String> {
    let frame_samples = ((options.sample_rate as u64 * options.window_ms) / 1000).max(1) as usize;
    let sample_count = bytes.len() / 4;
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset + frame_samples <= sample_count {
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
        }
        let rms = (square_sum / frame_samples as f64).sqrt();
        let zero_crossing_rate = crossing_count as f64 / frame_samples as f64;
        let mut values = vec![(rms * 8.0).min(1.0), (zero_crossing_rate * 12.0).min(1.0)];
        values.extend(calculate_spectral_features(
            &frame_samples_values,
            options.sample_rate,
        ));
        frames.push(AudioFeatureFrame {
            time_ms: ((offset as u64 * 1000) / options.sample_rate as u64),
            values,
        });
        offset += frame_samples;
    }
    if frames.is_empty() {
        return Err("未能提取到可用音频特征。".to_string());
    }
    Ok(frames)
}

fn calculate_spectral_features(samples: &[f64], sample_rate: u32) -> Vec<f64> {
    let powers: Vec<f64> = SPECTRAL_FREQUENCIES_HZ
        .iter()
        .map(|frequency| calculate_goertzel_power(samples, f64::from(sample_rate), *frequency))
        .collect();
    let total_power = powers.iter().sum::<f64>().max(0.000_001);
    powers
        .into_iter()
        .map(|power| (power / total_power).sqrt().min(1.0))
        .collect()
}

fn calculate_goertzel_power(samples: &[f64], sample_rate: f64, frequency: f64) -> f64 {
    if samples.is_empty() || sample_rate <= 0.0 {
        return 0.0;
    }
    let normalized_frequency = frequency / sample_rate;
    let coefficient = 2.0 * (2.0 * std::f64::consts::PI * normalized_frequency).cos();
    let mut previous = 0.0;
    let mut previous2 = 0.0;
    for sample in samples {
        let current = sample + coefficient * previous - previous2;
        previous2 = previous;
        previous = current;
    }
    previous2 * previous2 + previous * previous - coefficient * previous * previous2
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
        });
    }
    let alignment = if options.localization_mode {
        create_localization_audio_alignment(complete_frames, source_frames, options)
    } else {
        create_multistage_audio_alignment(complete_frames, source_frames, options)?
    };
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
    })
}

fn create_multistage_audio_alignment(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Result<MultistageAudioAlignmentResult, String> {
    if source_frames.len() >= OFFSET_PATH_MIN_SOURCE_FRAMES {
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
    let reference_fingerprints = create_audio_fingerprints(reference_frames);
    let target_fingerprints = create_audio_fingerprints(target_frames);
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
        let support_score =
            (current.observation_count as f64 / OFFSET_PATH_STABLE_OBSERVATIONS as f64)
                .clamp(0.0, 1.0);
        let distance_score = (1.0 - current.mean_distance / DEFAULT_MATCH_THRESHOLD)
            .clamp(0.0, 1.0);
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
            let support_window_size = (observations.len() - index).min(
                OFFSET_PATH_STABLE_OBSERVATIONS * OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER,
            );
            let required_support = OFFSET_PATH_STABLE_OBSERVATIONS
                .min(support_window_size)
                .max((support_window_size as f64 * OFFSET_PATH_STABLE_SUPPORT_RATIO).ceil() as usize);
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
    for index in start_index..end_index {
        if round_to_step(observations[index].offset_ms, frame_step_ms).abs_diff(offset_ms)
            <= frame_step_ms
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
    let complete_fingerprints = create_audio_fingerprints(complete_frames);
    let source_fingerprints = create_audio_fingerprints(source_frames);
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
            note: "当前本地音频对齐未融合弹幕语义；弹幕线索仍保留为人工复核参考。"
                .to_string(),
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
                        candidate.note.push_str(" 鲁棒视觉辅助与音频时间映射总体一致。");
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

fn find_nearest_visual_frame(frames: &[VisualFeatureFrame], time_ms: u64) -> Option<&VisualFeatureFrame> {
    frames
        .iter()
        .min_by_key(|frame| frame.time_ms.abs_diff(time_ms))
}

fn get_visual_feature_distance(left: &VisualFeatureFrame, right: &VisualFeatureFrame) -> f64 {
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

    fn test_options() -> AudioAlignmentOptions {
        AudioAlignmentOptions {
            sample_rate: 10,
            window_ms: 1000,
            match_threshold: 0.01,
            min_gap_ms: 1000,
            max_cells: 1_000_000,
            ffmpeg_path: "ffmpeg".to_string(),
            enable_visual_evidence: false,
            visual_sample_interval_ms: DEFAULT_VISUAL_SAMPLE_INTERVAL_MS,
            localization_mode: false,
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

        assert_eq!(proposal.evidence.as_ref().unwrap().algorithm, "time-map-audio");
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

        assert_eq!(proposal.evidence.as_ref().unwrap().algorithm, "time-map-audio");
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
        let extracted = pcm_to_feature_frames(&bytes, &options).unwrap();
        assert_eq!(extracted.len(), 1);
        assert!(extracted[0].values[0] > 0.9);
        assert!(extracted[0].values[1] > 0.9);
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
        clear_audio_feature_cache_for_tests();
        let path = temp_audio_cache_path("audio-cache-hit");
        std::fs::write(&path, b"not-a-real-media-file").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let cached_frames = frames(&[0.1, 0.2]);
        let cache_key = create_audio_feature_cache_key(&path_text, &options).unwrap();
        write_audio_feature_cache(cache_key, &cached_frames).unwrap();

        let cached = get_audio_features(&path_text, "完整版", &options, None).unwrap();

        assert!(cached.cache_hit);
        assert_eq!(cached.frames.len(), cached_frames.len());
        assert_eq!(cached.frames[1].time_ms, cached_frames[1].time_ms);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn audio_feature_cache_key_changes_with_feature_window() {
        clear_audio_feature_cache_for_tests();
        let path = temp_audio_cache_path("audio-cache-key");
        std::fs::write(&path, b"media").unwrap();
        let path_text = path.to_string_lossy().to_string();
        let options = test_options();
        let mut changed_options = test_options();
        changed_options.window_ms = 2_000;

        let original_key = create_audio_feature_cache_key(&path_text, &options).unwrap();
        let changed_key = create_audio_feature_cache_key(&path_text, &changed_options).unwrap();

        assert_ne!(original_key, changed_key);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn remote_media_input_is_accepted_for_emby_streams() {
        assert!(validate_media_input(
            "https://emby.example.test/Videos/item/stream?api_key=secret",
            "完整版"
        )
        .is_ok());
        assert!(validate_media_input("ftp://example.test/item.mkv", "完整版").is_err());
    }

    #[test]
    fn remote_audio_feature_cache_key_redacts_tokens() {
        let key = create_audio_feature_cache_key(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&MediaSourceId=source-1",
            &test_options(),
        )
        .unwrap();

        assert!(key.contains("api_key=<已隐藏>"));
        assert!(key.contains("MediaSourceId=source-1"));
        assert!(!key.contains("secret-token"));
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
    fn request_validation_rejects_empty_window() {
        let request = AudioAlignmentRequest {
            complete_path: "a.mp4".to_string(),
            source_path: "b.mp4".to_string(),
            ffmpeg_path: None,
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
    fn audio_alignment_job_cancel_blocks_later_running_update() {
        let job_id = "test-audio-job-cancel".to_string();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        insert_audio_alignment_job(job_id.clone(), cancel_flag.clone()).unwrap();
        let cancelled = cancel_audio_alignment_job(job_id.clone()).unwrap();
        assert_eq!(cancelled.status, AudioAlignmentJobStatus::Cancelled);
        assert!(cancel_flag.load(Ordering::Relaxed));

        update_audio_alignment_job(
            &job_id,
            AudioAlignmentJobStatus::Running,
            0.5,
            "不应覆盖取消状态。",
            None,
            None,
        )
        .unwrap();

        let snapshot = get_audio_alignment_job(job_id).unwrap();
        assert_eq!(snapshot.status, AudioAlignmentJobStatus::Cancelled);
        assert_eq!(snapshot.message, "已请求取消音频对齐任务。");
        assert!(snapshot
            .logs
            .contains(&"已请求取消音频对齐任务。".to_string()));
    }

    #[test]
    fn cancellation_is_checked_before_ffmpeg_spawn() {
        let cancel_flag = AtomicBool::new(true);
        let error =
            extract_audio_features("missing.mp4", "完整版", &test_options(), Some(&cancel_flag))
                .unwrap_err();

        assert_eq!(error, AUDIO_ALIGNMENT_CANCELLED);
    }
}
