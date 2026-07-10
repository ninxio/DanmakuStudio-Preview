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
const AUDIO_ALIGNMENT_CANCELLED: &str = "音频对齐任务已取消。";
const MAX_JOB_LOGS: usize = 80;
const MAX_AUDIO_FEATURE_CACHE_ENTRIES: usize = 12;
const MERGE_NEARBY_CANDIDATE_MS: u64 = 2_000;
const FINGERPRINT_BUCKET_MS: i64 = 1_000;
const MAX_COMPLETE_FINGERPRINTS_PER_KEY: usize = 32;
const MAX_SPARSE_MATCH_CANDIDATES: usize = 80_000;
const MIN_SPARSE_MATCHES: usize = 3;
const MIN_SPARSE_COVERAGE: f64 = 0.25;
const AUDIO_ALIGNMENT_STAGE_COUNT: u8 = 8;

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFeatureFrame {
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAlignmentProposal {
    anchors: Vec<SyncAnchorDto>,
    cut_candidates: Vec<CutCandidateDto>,
    confidence: f64,
    diagnostics: Vec<String>,
    evidence: Option<AlignmentEvidenceSummary>,
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
}

#[derive(Debug, Clone)]
struct CachedAudioFeatures {
    frames: Vec<AudioFeatureFrame>,
    cache_hit: bool,
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

struct SparseAudioAlignmentResult {
    matches: Vec<AudioFeatureMatch>,
    complete_fingerprint_count: usize,
    source_fingerprint_count: usize,
    fingerprint_match_count: usize,
    offset_cluster_count: usize,
    low_confidence_region_count: usize,
    diagnostics: Vec<String>,
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
    update_progress(0.15, "正在检查或提取完整版音频特征。")?;
    let complete_features =
        get_audio_features(&request.complete_path, "完整版", &options, cancel_flag)?;
    update_progress(
        0.42,
        &format_audio_feature_cache_message("完整版", &complete_features),
    )?;
    check_cancelled(cancel_flag)?;
    update_progress(0.45, "正在检查或提取当前视频音频特征。")?;
    let source_features =
        get_audio_features(&request.source_path, "当前视频", &options, cancel_flag)?;
    update_progress(
        0.72,
        &format_audio_feature_cache_message("当前视频", &source_features),
    )?;
    check_cancelled(cancel_flag)?;
    update_progress(0.76, "正在生成稀疏音频指纹。")?;
    check_cancelled(cancel_flag)?;
    update_progress(0.82, "正在匹配音频锚点。")?;
    check_cancelled(cancel_flag)?;
    update_progress(0.88, "正在拟合单调对齐路径。")?;
    check_cancelled(cancel_flag)?;
    let mut proposal = create_audio_alignment_proposal(
        &complete_features.frames,
        &source_features.frames,
        &options,
    )?;
    update_progress(0.94, "正在精修候选版本差异。")?;
    check_cancelled(cancel_flag)?;
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
    if sample_rate == 0 {
        return Err("音频采样率必须大于 0。".to_string());
    }
    if window_ms == 0 {
        return Err("音频特征窗口必须大于 0。".to_string());
    }
    if !match_threshold.is_finite() || match_threshold <= 0.0 {
        return Err("音频匹配阈值必须是大于 0 的数字。".to_string());
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
    if clamped < 0.12 {
        create_stage_range("validating", "校验输入", 1, clamped, 0.0, 0.12)
    } else if clamped < 0.44 {
        create_stage_range(
            "extracting-complete",
            "提取完整版特征",
            2,
            clamped,
            0.12,
            0.44,
        )
    } else if clamped < 0.74 {
        create_stage_range(
            "extracting-source",
            "提取删减版特征",
            3,
            clamped,
            0.44,
            0.74,
        )
    } else if clamped < 0.80 {
        create_stage_range("fingerprinting", "生成稀疏指纹", 4, clamped, 0.74, 0.80)
    } else if clamped < 0.86 {
        create_stage_range("matching", "匹配音频锚点", 5, clamped, 0.80, 0.86)
    } else if clamped < 0.92 {
        create_stage_range("fitting", "拟合单调路径", 6, clamped, 0.86, 0.92)
    } else if clamped < 0.97 {
        create_stage_range("refining", "精修候选差异", 7, clamped, 0.92, 0.97)
    } else {
        create_stage_range("reporting", "生成复核数据", 8, clamped, 0.97, 1.0)
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
        }
        let rms = (square_sum / frame_samples as f64).sqrt();
        let zero_crossing_rate = crossing_count as f64 / frame_samples as f64;
        frames.push(AudioFeatureFrame {
            time_ms: ((offset as u64 * 1000) / options.sample_rate as u64),
            values: vec![(rms * 8.0).min(1.0), (zero_crossing_rate * 12.0).min(1.0)],
        });
        offset += frame_samples;
    }
    if frames.is_empty() {
        return Err("未能提取到可用音频特征。".to_string());
    }
    Ok(frames)
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
            }),
        });
    }
    let alignment = create_multistage_audio_alignment(complete_frames, source_frames, options)?;
    let matches = alignment.matches;
    let cut_candidates = refine_cut_candidates(infer_cut_candidates(&matches, options));
    let cut_candidate_count = cut_candidates.len();
    let anchors = create_anchors(&matches, options.match_threshold);
    let coverage = matches.len() as f64 / source_frames.len().max(1) as f64;
    let strong_anchor_count = matches
        .iter()
        .filter(|item| item.distance <= options.match_threshold * 0.5)
        .count();
    let weak_anchor_count = matches.len().saturating_sub(strong_anchor_count);
    let mut diagnostics = alignment.diagnostics;
    diagnostics.push(format!(
        "音频特征匹配 {} / {} 帧，覆盖率 {}%。",
        matches.len(),
        source_frames.len(),
        (coverage * 100.0).round()
    ));
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
            quality: create_evidence_quality(
                coverage,
                strong_anchor_count,
                weak_anchor_count,
                alignment.low_confidence_region_count,
            ),
        }),
    })
}

fn create_multistage_audio_alignment(
    complete_frames: &[AudioFeatureFrame],
    source_frames: &[AudioFeatureFrame],
    options: &AudioAlignmentOptions,
) -> Result<MultistageAudioAlignmentResult, String> {
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
    })
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
