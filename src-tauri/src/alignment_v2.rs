//! Alignment V2 的纯算法核心。
//!
//! 本模块不读取媒体文件、不依赖 Tauri，也不修改项目状态。调用方负责把媒体解码为 PCM
//! 或细粒度特征，并根据真实素材基准决定是否采用结果。本模块的测试只验证合成信号下的
//! 数学性质，不代表真实媒体已经达到产品精度门槛。

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

const SPECTRAL_BIN_COUNT: usize = 48;
const FINE_SPECTRAL_BAND_COUNT: usize = 12;
const LANDMARK_DELTA_QUANTUM_MS: i64 = 50;
const LANDMARK_DELTA_MASK: u64 = 0xff;
const MAX_MODEL_SEEDS: usize = 768;
const MAX_OBSERVATIONS: usize = 40_000;
const COST_INFINITY: i64 = i64::MAX / 16;
const STATE_MATCHED: u8 = 0;
const STATE_SOURCE_ONLY: u8 = 1;
const STATE_TARGET_ONLY: u8 = 2;
const STATE_NONE: u8 = u8::MAX;
const ALIGNMENT_V2_CANCELLED: &str = "Alignment V2 算法已取消。";

fn check_algorithm_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err(ALIGNMENT_V2_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandmarkConfig {
    pub sample_rate: u32,
    pub presentation_offset_ms: i64,
    pub window_ms: u32,
    pub hop_ms: u32,
    pub silence_rms: f64,
    pub min_peak_ratio: f64,
    pub max_peaks_per_frame: usize,
    pub fanout: usize,
    pub min_pair_delta_ms: i64,
    pub max_pair_delta_ms: i64,
    pub max_hash_occurrences: usize,
}

impl Default for LandmarkConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            presentation_offset_ms: 0,
            window_ms: 40,
            hop_ms: 25,
            silence_rms: 0.008,
            min_peak_ratio: 2.25,
            max_peaks_per_frame: 4,
            fanout: 5,
            min_pair_delta_ms: 75,
            max_pair_delta_ms: 1_000,
            max_hash_occurrences: 48,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectralLandmark {
    pub hash: u64,
    pub time_ms: i64,
    pub strength_milli: u32,
}

#[derive(Debug, Clone)]
struct SpectralPeak {
    bin: usize,
    magnitude: f64,
}

/// 从单声道 PCM i16 提取局部声谱峰值对。hash 的低 8 位是粗时间差桶，其余位是
/// 两个频率 bin；匹配时允许相邻时间差桶，从而给轻微速度差保留候选。
#[cfg(test)]
pub fn extract_landmarks(
    pcm: &[i16],
    config: &LandmarkConfig,
) -> Result<Vec<SpectralLandmark>, String> {
    extract_landmarks_with_cancel(pcm, config, None)
}

pub fn extract_landmarks_with_cancel(
    pcm: &[i16],
    config: &LandmarkConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<SpectralLandmark>, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_landmark_config(config)?;
    let window_samples = milliseconds_to_samples(config.window_ms as i64, config.sample_rate)?;
    let hop_samples = milliseconds_to_samples(config.hop_ms as i64, config.sample_rate)?;
    if pcm.len() < window_samples || window_samples < 8 || hop_samples == 0 {
        return Ok(Vec::new());
    }

    let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
    let mut spectra = Vec::with_capacity(frame_count);
    let mut active_frames = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let start = frame_index * hop_samples;
        let frame = &pcm[start..start + window_samples];
        let rms = normalized_rms(frame);
        active_frames.push(rms >= config.silence_rms);
        spectra.push(calculate_spectrum(frame, config.sample_rate));
    }

    let mut peaks_by_frame = vec![Vec::<SpectralPeak>::new(); frame_count];
    for frame_index in 0..frame_count {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        if !active_frames[frame_index] {
            continue;
        }
        let spectrum = &spectra[frame_index];
        let frame_mean = spectrum.iter().sum::<f64>() / spectrum.len().max(1) as f64;
        let mut peaks = Vec::new();
        for bin in 1..SPECTRAL_BIN_COUNT - 1 {
            let magnitude = spectrum[bin];
            let previous_time = frame_index
                .checked_sub(1)
                .map(|index| spectra[index][bin])
                .unwrap_or(0.0);
            let next_time = spectra
                .get(frame_index + 1)
                .map(|values| values[bin])
                .unwrap_or(0.0);
            if magnitude <= spectrum[bin - 1]
                || magnitude < spectrum[bin + 1]
                || magnitude < previous_time
                || magnitude <= next_time
                || magnitude < frame_mean * config.min_peak_ratio
            {
                continue;
            }
            peaks.push(SpectralPeak { bin, magnitude });
        }
        peaks.sort_by(|left, right| {
            right
                .magnitude
                .total_cmp(&left.magnitude)
                .then_with(|| left.bin.cmp(&right.bin))
        });
        peaks.truncate(config.max_peaks_per_frame);
        peaks_by_frame[frame_index] = peaks;
    }

    let frame_time_ms = |frame_index: usize| -> i64 {
        config.presentation_offset_ms
            + samples_to_milliseconds(
                frame_index * hop_samples + window_samples / 2,
                config.sample_rate,
            )
    };
    let mut landmarks = Vec::new();
    for anchor_frame in 0..frame_count {
        if anchor_frame % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        for anchor in &peaks_by_frame[anchor_frame] {
            let mut emitted = 0usize;
            for (target_frame, target_peaks) in
                peaks_by_frame.iter().enumerate().skip(anchor_frame + 1)
            {
                let delta_ms = frame_time_ms(target_frame) - frame_time_ms(anchor_frame);
                if delta_ms < config.min_pair_delta_ms {
                    continue;
                }
                if delta_ms > config.max_pair_delta_ms {
                    break;
                }
                for target in target_peaks {
                    landmarks.push(SpectralLandmark {
                        hash: create_landmark_hash(anchor.bin, target.bin, delta_ms),
                        time_ms: frame_time_ms(anchor_frame),
                        strength_milli: peak_strength_milli(anchor.magnitude, target.magnitude),
                    });
                    emitted += 1;
                    if emitted >= config.fanout {
                        break;
                    }
                }
                if emitted >= config.fanout {
                    break;
                }
            }
        }
    }

    suppress_common_landmarks(&mut landmarks, config.max_hash_occurrences);
    check_algorithm_cancelled(cancel_flag)?;
    landmarks.sort_by(|left, right| {
        left.time_ms
            .cmp(&right.time_ms)
            .then_with(|| left.hash.cmp(&right.hash))
            .then_with(|| right.strength_milli.cmp(&left.strength_milli))
    });
    Ok(landmarks)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineMatchConfig {
    pub min_scale: f64,
    pub max_scale: f64,
    pub residual_tolerance_ms: i64,
    pub min_inliers: usize,
    pub top_k: usize,
    pub max_occurrences_per_hash: usize,
}

impl Default for AffineMatchConfig {
    fn default() -> Self {
        Self {
            min_scale: 0.94,
            max_scale: 1.06,
            residual_tolerance_ms: 90,
            min_inliers: 4,
            top_k: 5,
            max_occurrences_per_hash: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineHypothesis {
    pub scale: f64,
    pub offset_ms: i64,
    pub inlier_count: usize,
    pub unique_source_count: usize,
    pub unique_source_coverage: f64,
    pub unique_target_count: usize,
    pub unique_target_coverage: f64,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub p50_residual_ms: i64,
    pub p95_residual_ms: i64,
    pub max_residual_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffineMatchResult {
    pub hypotheses: Vec<AffineHypothesis>,
    pub observation_count: usize,
    pub source_landmark_count: usize,
    pub target_landmark_count: usize,
    pub top1_top2_margin: f64,
}

#[derive(Debug, Clone)]
struct LandmarkObservation {
    source_index: usize,
    target_index: usize,
    source_time_ms: i64,
    target_time_ms: i64,
}

#[derive(Debug, Clone)]
struct ModelInlier {
    source_index: usize,
    target_index: usize,
    source_time_ms: i64,
    target_time_ms: i64,
    residual_ms: i64,
}

/// 通过 hash 倒排表建立候选，再用确定性模型采样和稳健重拟合输出 Top-K 仿射假设。
#[cfg(test)]
pub fn match_landmarks_affine(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
) -> Result<AffineMatchResult, String> {
    match_landmarks_affine_with_cancel(source, target, config, None)
}

pub fn match_landmarks_affine_with_cancel(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<AffineMatchResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_affine_config(config)?;
    if source.is_empty() || target.is_empty() {
        return Ok(AffineMatchResult {
            hypotheses: Vec::new(),
            observation_count: 0,
            source_landmark_count: source.len(),
            target_landmark_count: target.len(),
            top1_top2_margin: 0.0,
        });
    }

    let observations = create_landmark_observations(source, target, config, cancel_flag)?;
    let unique_source_total = source.len();
    let unique_target_total = target.len();
    if observations.is_empty() || unique_source_total == 0 {
        return Ok(AffineMatchResult {
            hypotheses: Vec::new(),
            observation_count: observations.len(),
            source_landmark_count: source.len(),
            target_landmark_count: target.len(),
            top1_top2_margin: 0.0,
        });
    }

    let seeds = create_model_seeds(&observations, config, cancel_flag)?;
    let mut hypotheses = Vec::new();
    for (seed_index, (seed_scale, seed_offset)) in seeds.into_iter().enumerate() {
        if seed_index % 4 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        if let Some(hypothesis) = fit_hypothesis(
            &observations,
            seed_scale,
            seed_offset,
            unique_source_total,
            unique_target_total,
            config,
        ) {
            if hypotheses.iter().any(|existing: &AffineHypothesis| {
                (existing.scale - hypothesis.scale).abs() < 0.000_5
                    && existing.offset_ms.abs_diff(hypothesis.offset_ms) < 40
            }) {
                continue;
            }
            hypotheses.push(hypothesis);
        }
    }
    hypotheses.sort_by(compare_hypotheses);
    hypotheses.truncate(config.top_k);
    let top1_top2_margin = calculate_hypothesis_margin(&hypotheses, config);
    Ok(AffineMatchResult {
        hypotheses,
        observation_count: observations.len(),
        source_landmark_count: source.len(),
        target_landmark_count: target.len(),
        top1_top2_margin,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineFeatureConfig {
    pub sample_rate: u32,
    pub presentation_offset_ms: i64,
    pub window_ms: u32,
    pub hop_ms: u32,
}

impl Default for FineFeatureConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            presentation_offset_ms: 0,
            window_ms: 50,
            hop_ms: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FineFeatureFrame {
    pub time_ms: i64,
    pub values: Vec<f32>,
}

/// 从同一份 16-bit PCM 生成细粒度、定长、归一化声谱特征。生产调用方可将 hop
/// 设为 20–50ms；时间戳始终位于媒体 presentation timeline。
#[cfg(test)]
pub fn extract_fine_features(
    pcm: &[i16],
    config: &FineFeatureConfig,
) -> Result<Vec<FineFeatureFrame>, String> {
    extract_fine_features_with_cancel(pcm, config, None)
}

pub fn extract_fine_features_with_cancel(
    pcm: &[i16],
    config: &FineFeatureConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<FineFeatureFrame>, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_fine_feature_config(config)?;
    let window_samples = milliseconds_to_samples(config.window_ms as i64, config.sample_rate)?;
    let hop_samples = milliseconds_to_samples(config.hop_ms as i64, config.sample_rate)?;
    if pcm.len() < window_samples || window_samples < 8 || hop_samples == 0 {
        return Ok(Vec::new());
    }
    let frame_count = 1 + (pcm.len() - window_samples) / hop_samples;
    let mut frames = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        if frame_index % 64 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let start = frame_index * hop_samples;
        let frame = &pcm[start..start + window_samples];
        let spectrum = calculate_spectrum(frame, config.sample_rate);
        let mut values = Vec::with_capacity(FINE_SPECTRAL_BAND_COUNT + 2);
        let rms = normalized_rms(frame);
        values.push((((rms + 1.0e-6).log10() + 6.0).clamp(0.0, 6.0) / 6.0) as f32);
        let zero_crossings = frame
            .windows(2)
            .filter(|pair| (pair[0] >= 0) != (pair[1] >= 0))
            .count();
        values.push((zero_crossings as f64 / frame.len().max(1) as f64) as f32);
        for band in 0..FINE_SPECTRAL_BAND_COUNT {
            let start_bin = band * SPECTRAL_BIN_COUNT / FINE_SPECTRAL_BAND_COUNT;
            let end_bin = (band + 1) * SPECTRAL_BIN_COUNT / FINE_SPECTRAL_BAND_COUNT;
            let energy = spectrum[start_bin..end_bin].iter().sum::<f64>();
            values.push((energy + 1.0).ln() as f32);
        }
        let norm = values
            .iter()
            .map(|value| f64::from(*value).powi(2))
            .sum::<f64>()
            .sqrt();
        if norm > f64::EPSILON {
            for value in &mut values {
                *value = (f64::from(*value) / norm) as f32;
            }
        }
        frames.push(FineFeatureFrame {
            time_ms: config.presentation_offset_ms
                + samples_to_milliseconds(start + window_samples / 2, config.sample_rate),
            values,
        });
    }
    Ok(frames)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditAlignmentMode {
    Global,
    SemiGlobal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAlignmentConfig {
    pub mode: EditAlignmentMode,
    pub band_radius_ms: i64,
    pub max_dp_cells: usize,
    pub gap_open_cost: i64,
    pub gap_extend_cost: i64,
    pub ambiguous_match_cost: i64,
}

impl Default for EditAlignmentConfig {
    fn default() -> Self {
        Self {
            mode: EditAlignmentMode::Global,
            band_radius_ms: 2_000,
            max_dp_cells: 4_000_000,
            gap_open_cost: 300,
            gap_extend_cost: 60,
            ambiguous_match_cost: 700,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EditPathKind {
    #[serde(rename = "M")]
    Matched,
    #[serde(rename = "sourceOnly")]
    SourceOnly,
    #[serde(rename = "targetOnly")]
    TargetOnly,
    #[serde(rename = "ambiguous")]
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPathStep {
    pub kind: EditPathKind,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub target_start_ms: i64,
    pub target_end_ms: i64,
    pub local_cost: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTimeSpan {
    pub kind: EditPathKind,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub target_start_ms: i64,
    pub target_end_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAlignmentResult {
    pub total_cost: i64,
    pub path: Vec<EditPathStep>,
    pub spans: Vec<EditTimeSpan>,
    pub matched_step_count: usize,
    pub ambiguous_step_count: usize,
}

/// 在粗仿射附近执行三状态 affine-gap DP。SemiGlobal 模式要求完整消费 source，
/// 但允许 target 的前后缀不进入路径；Global 模式显式保留两侧全部 gap。
#[cfg(test)]
pub fn align_features_edit_aware(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    config: &EditAlignmentConfig,
) -> Result<EditAlignmentResult, String> {
    align_features_edit_aware_with_cancel(source, target, coarse, config, None)
}

pub fn align_features_edit_aware_with_cancel(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    config: &EditAlignmentConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<EditAlignmentResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_feature_sequences(source, target)?;
    validate_edit_config(config)?;
    if source.is_empty() || target.is_empty() {
        return Err("细粒度对齐要求来源与目标特征都非空。".to_string());
    }

    let source_len = source.len();
    let target_len = target.len();
    let width = target_len + 1;
    let cell_count = (source_len + 1)
        .checked_mul(width)
        .ok_or_else(|| "细粒度 DP 尺寸溢出。".to_string())?;
    if cell_count > config.max_dp_cells {
        return Err(format!(
            "细粒度 DP 需要 {cell_count} 个索引单元，超过 maxDpCells={}；请先分块或提高特征 hop。",
            config.max_dp_cells
        ));
    }
    let mut matched_costs = vec![COST_INFINITY; cell_count];
    let mut source_only_costs = vec![COST_INFINITY; cell_count];
    let mut target_only_costs = vec![COST_INFINITY; cell_count];
    let mut matched_parents = vec![STATE_NONE; cell_count];
    let mut source_only_parents = vec![STATE_NONE; cell_count];
    let mut target_only_parents = vec![STATE_NONE; cell_count];
    matched_costs[0] = 0;

    if config.mode == EditAlignmentMode::SemiGlobal {
        for cost in matched_costs.iter_mut().take(target_len + 1).skip(1) {
            *cost = 0;
        }
    } else {
        for target_index in 1..=target_len {
            let index = target_index;
            target_only_costs[index] = config.gap_open_cost
                + config.gap_extend_cost * (target_index.saturating_sub(1) as i64);
            target_only_parents[index] = if target_index == 1 {
                STATE_MATCHED
            } else {
                STATE_TARGET_ONLY
            };
        }
    }
    for source_index in 1..=source_len {
        if source_index % 8 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let index = source_index * width;
        source_only_costs[index] =
            config.gap_open_cost + config.gap_extend_cost * (source_index.saturating_sub(1) as i64);
        source_only_parents[index] = if source_index == 1 {
            STATE_MATCHED
        } else {
            STATE_SOURCE_ONLY
        };
    }

    for source_index in 1..=source_len {
        if source_index % 8 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let (target_start, target_end) = target_band_range(
            target,
            coarse.scale * source[source_index - 1].time_ms as f64 + coarse.offset_ms as f64,
            config.band_radius_ms,
        );
        for target_index in target_start..target_end {
            if !is_inside_affine_band(
                &source[source_index - 1],
                &target[target_index - 1],
                coarse,
                config.band_radius_ms,
            ) {
                continue;
            }
            let index = source_index * width + target_index;
            let diagonal = (source_index - 1) * width + target_index - 1;
            let feature_cost = feature_distance_cost(
                &source[source_index - 1].values,
                &target[target_index - 1].values,
            );
            let (matched_parent, matched_base) = select_min_state(
                matched_costs[diagonal],
                source_only_costs[diagonal],
                target_only_costs[diagonal],
            );
            matched_costs[index] = add_cost(matched_base, feature_cost);
            matched_parents[index] = matched_parent;

            let above = (source_index - 1) * width + target_index;
            let source_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(matched_costs[above], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(source_only_costs[above], config.gap_extend_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(target_only_costs[above], config.gap_open_cost),
                ),
            ];
            let (source_parent, source_cost) = select_min_candidate(&source_candidates);
            source_only_costs[index] = source_cost;
            source_only_parents[index] = source_parent;

            let left = source_index * width + target_index - 1;
            let target_candidates = [
                (
                    STATE_MATCHED,
                    add_cost(matched_costs[left], config.gap_open_cost),
                ),
                (
                    STATE_SOURCE_ONLY,
                    add_cost(source_only_costs[left], config.gap_open_cost),
                ),
                (
                    STATE_TARGET_ONLY,
                    add_cost(target_only_costs[left], config.gap_extend_cost),
                ),
            ];
            let (target_parent, target_cost) = select_min_candidate(&target_candidates);
            target_only_costs[index] = target_cost;
            target_only_parents[index] = target_parent;
        }
    }

    let (mut source_index, mut target_index, mut state, total_cost) = select_alignment_endpoint(
        source_len,
        target_len,
        width,
        config.mode,
        &matched_costs,
        &source_only_costs,
        &target_only_costs,
    )?;
    let source_bounds = create_frame_boundaries(source)?;
    let target_bounds = create_frame_boundaries(target)?;
    let mut reversed_path = Vec::new();
    let mut backtrack_steps = 0usize;
    while source_index > 0 || (config.mode == EditAlignmentMode::Global && target_index > 0) {
        if backtrack_steps.is_multiple_of(256) {
            check_algorithm_cancelled(cancel_flag)?;
        }
        backtrack_steps = backtrack_steps.saturating_add(1);
        let index = source_index * width + target_index;
        match state {
            STATE_MATCHED if source_index > 0 && target_index > 0 => {
                let local_cost = feature_distance_cost(
                    &source[source_index - 1].values,
                    &target[target_index - 1].values,
                );
                let kind = if local_cost >= config.ambiguous_match_cost {
                    EditPathKind::Ambiguous
                } else {
                    EditPathKind::Matched
                };
                reversed_path.push(EditPathStep {
                    kind,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost,
                });
                state = matched_parents[index];
                source_index -= 1;
                target_index -= 1;
            }
            STATE_SOURCE_ONLY if source_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::SourceOnly,
                    source_start_ms: source_bounds[source_index - 1],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = source_only_parents[index];
                source_index -= 1;
            }
            STATE_TARGET_ONLY if target_index > 0 => {
                reversed_path.push(EditPathStep {
                    kind: EditPathKind::TargetOnly,
                    source_start_ms: source_bounds[source_index],
                    source_end_ms: source_bounds[source_index],
                    target_start_ms: target_bounds[target_index - 1],
                    target_end_ms: target_bounds[target_index],
                    local_cost: config.gap_extend_cost,
                });
                state = target_only_parents[index];
                target_index -= 1;
            }
            _ if config.mode == EditAlignmentMode::SemiGlobal && source_index == 0 => break,
            _ => return Err("细粒度 DP 回溯遇到不可达状态。".to_string()),
        }
    }
    reversed_path.reverse();
    let path = collapse_opposite_gap_runs(reversed_path);
    let spans = merge_path_to_spans(&path);
    validate_monotonic_spans(&spans)?;
    Ok(EditAlignmentResult {
        total_cost,
        matched_step_count: path
            .iter()
            .filter(|step| step.kind == EditPathKind::Matched)
            .count(),
        ambiguous_step_count: path
            .iter()
            .filter(|step| step.kind == EditPathKind::Ambiguous)
            .count(),
        path,
        spans,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRefinementConfig {
    pub sample_rate: u32,
    pub source_presentation_offset_ms: i64,
    pub target_presentation_offset_ms: i64,
    pub search_radius_ms: i64,
    pub window_ms: i64,
    pub score_tolerance: f64,
    pub min_correlation: f64,
    pub min_alternative_margin: f64,
    pub max_uncertainty_ms: i64,
}

impl Default for BoundaryRefinementConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            source_presentation_offset_ms: 0,
            target_presentation_offset_ms: 0,
            search_radius_ms: 500,
            window_ms: 400,
            score_tolerance: 0.01,
            min_correlation: 0.55,
            min_alternative_margin: 0.01,
            max_uncertainty_ms: 120,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRefinementResult {
    pub source_boundary_ms: i64,
    pub coarse_target_boundary_ms: i64,
    pub refined_target_boundary_ms: i64,
    pub shift_ms: i64,
    pub uncertainty_start_ms: i64,
    pub uncertainty_end_ms: i64,
    pub uncertainty_ms: i64,
    pub best_correlation: f64,
    pub alternative_margin: f64,
    pub ambiguous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BoundaryContextSide {
    Before,
    After,
}

#[derive(Debug, Clone, Copy)]
enum BoundaryWindowMode {
    Centered,
    OneSided(BoundaryContextSide),
}

/// 在粗目标边界附近按整数毫秒搜索归一化互相关峰。该实现与 GCC-PHAT 的目标相同：
/// 估计局部相对时延；它不凭单侧相关峰推断删减的语义类型。
#[cfg(test)]
pub fn refine_boundary_by_correlation(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_with_cancel(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        None,
    )
}

pub fn refine_boundary_by_correlation_with_cancel(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_mode(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        BoundaryWindowMode::Centered,
        cancel_flag,
    )
}

/// Uses only the content immediately before or after a suspected edit boundary. A centered
/// window is invalid at sourceOnly/targetOnly edges because half of it belongs to content that
/// exists on only one axis. Callers can swap source/target to refine a source-axis boundary.
pub fn refine_boundary_by_one_sided_correlation_with_cancel(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    context_side: BoundaryContextSide,
    config: &BoundaryRefinementConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    refine_boundary_by_correlation_mode(
        source_pcm,
        target_pcm,
        source_boundary_ms,
        coarse_target_boundary_ms,
        config,
        BoundaryWindowMode::OneSided(context_side),
        cancel_flag,
    )
}

#[allow(clippy::too_many_arguments)]
fn refine_boundary_by_correlation_mode(
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_boundary_ms: i64,
    coarse_target_boundary_ms: i64,
    config: &BoundaryRefinementConfig,
    window_mode: BoundaryWindowMode,
    cancel_flag: Option<&AtomicBool>,
) -> Result<BoundaryRefinementResult, String> {
    check_algorithm_cancelled(cancel_flag)?;
    validate_boundary_config(config)?;
    let window_samples = milliseconds_to_samples(config.window_ms, config.sample_rate)?;
    if window_samples < 8 {
        return Err("边界精修窗口过短。".to_string());
    }
    let source_center = timeline_ms_to_sample(
        source_boundary_ms,
        config.source_presentation_offset_ms,
        config.sample_rate,
    )?;
    let source_window = boundary_window(source_pcm, source_center, window_samples, window_mode)
        .ok_or_else(|| "来源粗边界附近没有完整相关窗口。".to_string())?;

    let mut candidates = Vec::new();
    for shift_ms in -config.search_radius_ms..=config.search_radius_ms {
        if shift_ms.rem_euclid(32) == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let target_time_ms = coarse_target_boundary_ms
            .checked_add(shift_ms)
            .ok_or_else(|| "目标边界毫秒溢出。".to_string())?;
        let target_center = timeline_ms_to_sample(
            target_time_ms,
            config.target_presentation_offset_ms,
            config.sample_rate,
        )?;
        let Some(target_window) =
            boundary_window(target_pcm, target_center, window_samples, window_mode)
        else {
            continue;
        };
        candidates.push((
            shift_ms,
            normalized_cross_correlation(source_window, target_window),
        ));
    }
    if candidates.is_empty() {
        return Err("目标粗边界搜索范围内没有完整相关窗口。".to_string());
    }
    candidates.sort_by_key(|item| item.0);
    let best_index = candidates
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| right.0.abs().cmp(&left.0.abs()))
                .then_with(|| right.0.cmp(&left.0))
        })
        .map(|(index, _)| index)
        .ok_or_else(|| "无法选择相关峰。".to_string())?;
    let (best_shift_ms, best_correlation) = candidates[best_index];
    let threshold = best_correlation - config.score_tolerance;
    let mut left = best_index;
    while left > 0 && candidates[left - 1].1 >= threshold {
        left -= 1;
    }
    let mut right = best_index;
    while right + 1 < candidates.len() && candidates[right + 1].1 >= threshold {
        right += 1;
    }
    // Adjacent integer shifts inside the same broad peak are the uncertainty interval, not
    // competing edit locations. Only a distinct peak outside that interval reduces the margin.
    let second_best = candidates
        .iter()
        .enumerate()
        .filter(|(index, _)| *index < left || *index > right)
        .map(|(_, item)| item.1)
        .max_by(f64::total_cmp)
        .unwrap_or(-1.0);
    let alternative_margin = (best_correlation - second_best).max(0.0);
    let uncertainty_ms = candidates[right].0 - candidates[left].0;
    let refined_target_boundary_ms = coarse_target_boundary_ms
        .checked_add(best_shift_ms)
        .ok_or_else(|| "精修目标边界毫秒溢出。".to_string())?;
    let uncertainty_start_ms = coarse_target_boundary_ms
        .checked_add(candidates[left].0)
        .ok_or_else(|| "边界不确定范围起点溢出。".to_string())?;
    let uncertainty_end_ms = coarse_target_boundary_ms
        .checked_add(candidates[right].0)
        .ok_or_else(|| "边界不确定范围终点溢出。".to_string())?;
    Ok(BoundaryRefinementResult {
        source_boundary_ms,
        coarse_target_boundary_ms,
        refined_target_boundary_ms,
        shift_ms: best_shift_ms,
        uncertainty_start_ms,
        uncertainty_end_ms,
        uncertainty_ms,
        best_correlation,
        alternative_margin,
        ambiguous: best_correlation < config.min_correlation
            || alternative_margin < config.min_alternative_margin
            || uncertainty_ms > config.max_uncertainty_ms,
    })
}

fn validate_landmark_config(config: &LandmarkConfig) -> Result<(), String> {
    if config.sample_rate < 1_000
        || !(20..=50).contains(&config.hop_ms)
        || config.window_ms < config.hop_ms
        || config.window_ms > 100
        || !config.silence_rms.is_finite()
        || !(0.0..1.0).contains(&config.silence_rms)
        || !config.min_peak_ratio.is_finite()
        || config.min_peak_ratio <= 1.0
        || config.max_peaks_per_frame == 0
        || config.fanout == 0
        || config.min_pair_delta_ms < config.hop_ms as i64
        || config.max_pair_delta_ms <= config.min_pair_delta_ms
        || config.max_hash_occurrences == 0
    {
        return Err(
            "LandmarkConfig 无效；hop 必须为 20–50ms，窗口、阈值和配对范围必须为正。".to_string(),
        );
    }
    Ok(())
}

fn validate_fine_feature_config(config: &FineFeatureConfig) -> Result<(), String> {
    if config.sample_rate < 1_000
        || !(20..=50).contains(&config.hop_ms)
        || config.window_ms < config.hop_ms
        || config.window_ms > 100
    {
        return Err(
            "FineFeatureConfig 无效；hop 必须为 20–50ms，窗口必须覆盖至少一个 hop。".to_string(),
        );
    }
    Ok(())
}

fn calculate_spectrum(frame: &[i16], sample_rate: u32) -> Vec<f64> {
    // 16 kHz 输入先做 2:1 抽取，再以 radix-2 FFT 复用一份窗谱。旧实现为每个
    // 频率桶各扫一遍窗口（48 次 Goertzel），长媒体会出现数十亿次样本迭代。
    let decimation = if sample_rate >= 8_000 { 2 } else { 1 };
    let effective_sample_rate = sample_rate as f64 / decimation as f64;
    let decimated_len = frame.len().div_ceil(decimation);
    let fft_len = decimated_len.max(8).next_power_of_two();
    let mut spectrum = vec![(0.0f64, 0.0f64); fft_len];
    let denominator = decimated_len.saturating_sub(1).max(1) as f64;
    for (index, sample) in frame.iter().step_by(decimation).enumerate() {
        let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * index as f64 / denominator).cos();
        spectrum[index].0 = *sample as f64 / i16::MAX as f64 * window;
    }
    radix2_fft(&mut spectrum);

    let min_frequency = 80.0;
    let max_frequency = (effective_sample_rate * 0.45).min(3_600.0);
    (0..SPECTRAL_BIN_COUNT)
        .map(|bin| {
            let ratio = bin as f64 / (SPECTRAL_BIN_COUNT - 1) as f64;
            let frequency = min_frequency * (max_frequency / min_frequency).powf(ratio);
            let fft_bin = ((frequency * fft_len as f64 / effective_sample_rate).round() as usize)
                .min(fft_len / 2);
            spectrum[fft_bin].0.hypot(spectrum[fft_bin].1)
        })
        .collect()
}

fn radix2_fft(values: &mut [(f64, f64)]) {
    let length = values.len();
    let mut reversed = 0usize;
    for index in 1..length {
        let mut bit = length >> 1;
        while reversed & bit != 0 {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;
        if index < reversed {
            values.swap(index, reversed);
        }
    }

    let mut block_len = 2usize;
    while block_len <= length {
        let angle = -2.0 * std::f64::consts::PI / block_len as f64;
        let root = (angle.cos(), angle.sin());
        for block_start in (0..length).step_by(block_len) {
            let mut twiddle = (1.0, 0.0);
            for offset in 0..block_len / 2 {
                let even = values[block_start + offset];
                let odd = values[block_start + offset + block_len / 2];
                let rotated = (
                    odd.0 * twiddle.0 - odd.1 * twiddle.1,
                    odd.0 * twiddle.1 + odd.1 * twiddle.0,
                );
                values[block_start + offset] = (even.0 + rotated.0, even.1 + rotated.1);
                values[block_start + offset + block_len / 2] =
                    (even.0 - rotated.0, even.1 - rotated.1);
                twiddle = (
                    twiddle.0 * root.0 - twiddle.1 * root.1,
                    twiddle.0 * root.1 + twiddle.1 * root.0,
                );
            }
        }
        block_len *= 2;
    }
}

fn normalized_rms(frame: &[i16]) -> f64 {
    let square_sum = frame
        .iter()
        .map(|sample| {
            let value = *sample as f64 / i16::MAX as f64;
            value * value
        })
        .sum::<f64>();
    (square_sum / frame.len().max(1) as f64).sqrt()
}

fn create_landmark_hash(anchor_bin: usize, target_bin: usize, delta_ms: i64) -> u64 {
    let delta_bucket = ((delta_ms + LANDMARK_DELTA_QUANTUM_MS / 2) / LANDMARK_DELTA_QUANTUM_MS)
        .clamp(0, LANDMARK_DELTA_MASK as i64) as u64;
    ((anchor_bin as u64) << 16) | ((target_bin as u64) << 8) | delta_bucket
}

fn landmark_family(hash: u64) -> u64 {
    hash >> 8
}

fn landmark_delta_bucket(hash: u64) -> i64 {
    (hash & LANDMARK_DELTA_MASK) as i64
}

fn peak_strength_milli(left: f64, right: f64) -> u32 {
    ((left.min(right) + 1.0).ln() * 1_000.0)
        .round()
        .clamp(0.0, u32::MAX as f64) as u32
}

fn suppress_common_landmarks(landmarks: &mut Vec<SpectralLandmark>, max_occurrences: usize) {
    let mut by_family = HashMap::<u64, Vec<SpectralLandmark>>::new();
    for landmark in std::mem::take(landmarks) {
        by_family
            .entry(landmark_family(landmark.hash))
            .or_default()
            .push(landmark);
    }
    for mut family in by_family.into_values() {
        family.sort_by_key(|item| item.time_ms);
        if family.len() <= max_occurrences {
            landmarks.extend(family);
            continue;
        }
        // 常见频率对不再整族删除；按时间均匀保留上限个观测，使长片的后半段仍
        // 有机会进入仿射估计，同时限制重复片头造成的笛卡尔候选爆炸。
        for selected in 0..max_occurrences {
            let index = selected * family.len() / max_occurrences;
            landmarks.push(family[index].clone());
        }
    }
}

fn validate_affine_config(config: &AffineMatchConfig) -> Result<(), String> {
    if !config.min_scale.is_finite()
        || !config.max_scale.is_finite()
        || config.min_scale < 0.94
        || config.max_scale > 1.06
        || config.min_scale >= config.max_scale
        || config.residual_tolerance_ms <= 0
        || config.min_inliers < 2
        || config.top_k == 0
        || config.max_occurrences_per_hash == 0
    {
        return Err("AffineMatchConfig 无效；scale 必须限制在 0.94–1.06。".to_string());
    }
    Ok(())
}

fn create_landmark_observations(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<LandmarkObservation>, String> {
    let mut source_family_counts = HashMap::<u64, usize>::new();
    let mut target_by_family = HashMap::<u64, Vec<(usize, &SpectralLandmark)>>::new();
    for landmark in source {
        *source_family_counts
            .entry(landmark_family(landmark.hash))
            .or_default() += 1;
    }
    for (target_index, landmark) in target.iter().enumerate() {
        target_by_family
            .entry(landmark_family(landmark.hash))
            .or_default()
            .push((target_index, landmark));
    }

    let mut observations = Vec::new();
    let sampled_source_limit = (MAX_OBSERVATIONS / 8).max(1);
    let source_step = source.len().div_ceil(sampled_source_limit).max(1);
    for (source_index, source_landmark) in source.iter().enumerate().step_by(source_step) {
        if source_index % 256 == 0 {
            check_algorithm_cancelled(cancel_flag)?;
        }
        let family = landmark_family(source_landmark.hash);
        let Some(target_items) = target_by_family.get(&family) else {
            continue;
        };
        if source_family_counts.get(&family).copied().unwrap_or(0) > config.max_occurrences_per_hash
            || target_items.len() > config.max_occurrences_per_hash
        {
            continue;
        }
        let source_bucket = landmark_delta_bucket(source_landmark.hash);
        let target_step = target_items.len().div_ceil(8).max(1);
        for (target_index, target_landmark) in target_items.iter().step_by(target_step) {
            if source_bucket.abs_diff(landmark_delta_bucket(target_landmark.hash)) > 1 {
                continue;
            }
            observations.push(LandmarkObservation {
                source_index,
                target_index: *target_index,
                source_time_ms: source_landmark.time_ms,
                target_time_ms: target_landmark.time_ms,
            });
            if observations.len() >= MAX_OBSERVATIONS {
                return Ok(observations);
            }
        }
    }
    observations.sort_by(|left, right| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
            .then_with(|| left.source_index.cmp(&right.source_index))
    });
    Ok(observations)
}

fn create_model_seeds(
    observations: &[LandmarkObservation],
    config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<(f64, f64)>, String> {
    let mut seeds = Vec::new();
    let single_step = (observations.len() / 96).max(1);
    for observation in observations.iter().step_by(single_step) {
        seeds.push((
            1.0,
            (observation.target_time_ms - observation.source_time_ms) as f64,
        ));
        if seeds.len() >= MAX_MODEL_SEEDS / 3 {
            break;
        }
    }
    let pair_step = (observations.len() / 48).max(1);
    'outer: for first_index in (0..observations.len()).step_by(pair_step) {
        check_algorithm_cancelled(cancel_flag)?;
        for second_index in (first_index + 1..observations.len()).step_by(pair_step) {
            let first = &observations[first_index];
            let second = &observations[second_index];
            let source_delta = second.source_time_ms - first.source_time_ms;
            let target_delta = second.target_time_ms - first.target_time_ms;
            if first.source_index == second.source_index || source_delta.abs() < 500 {
                continue;
            }
            let scale = target_delta as f64 / source_delta as f64;
            if scale < config.min_scale || scale > config.max_scale {
                continue;
            }
            let offset = first.target_time_ms as f64 - scale * first.source_time_ms as f64;
            seeds.push((scale, offset));
            if seeds.len() >= MAX_MODEL_SEEDS {
                break 'outer;
            }
        }
    }
    Ok(seeds)
}

fn fit_hypothesis(
    observations: &[LandmarkObservation],
    seed_scale: f64,
    seed_offset: f64,
    unique_source_total: usize,
    unique_target_total: usize,
    config: &AffineMatchConfig,
) -> Option<AffineHypothesis> {
    let mut scale = seed_scale;
    let mut offset = seed_offset;
    let mut inliers =
        select_unique_monotonic_inliers(observations, scale, offset, config.residual_tolerance_ms);
    for _ in 0..2 {
        if inliers.len() < config.min_inliers {
            return None;
        }
        let (next_scale, next_offset) = least_squares_affine(&inliers)?;
        if next_scale < config.min_scale || next_scale > config.max_scale {
            return None;
        }
        scale = next_scale;
        offset = next_offset;
        inliers = select_unique_monotonic_inliers(
            observations,
            scale,
            offset,
            config.residual_tolerance_ms,
        );
    }
    if inliers.len() < config.min_inliers {
        return None;
    }
    let mut residuals = inliers
        .iter()
        .map(|item| item.residual_ms)
        .collect::<Vec<_>>();
    residuals.sort_unstable();
    let source_start_ms = inliers.iter().map(|item| item.source_time_ms).min()?;
    let source_end_ms = inliers.iter().map(|item| item.source_time_ms).max()?;
    Some(AffineHypothesis {
        scale,
        offset_ms: offset.round() as i64,
        inlier_count: inliers.len(),
        unique_source_count: inliers.len(),
        unique_source_coverage: inliers.len() as f64 / unique_source_total.max(1) as f64,
        unique_target_count: inliers.len(),
        unique_target_coverage: inliers.len() as f64 / unique_target_total.max(1) as f64,
        source_start_ms,
        source_end_ms,
        p50_residual_ms: percentile(&residuals, 0.50),
        p95_residual_ms: percentile(&residuals, 0.95),
        max_residual_ms: *residuals.last().unwrap_or(&0),
    })
}

fn select_unique_monotonic_inliers(
    observations: &[LandmarkObservation],
    scale: f64,
    offset: f64,
    tolerance_ms: i64,
) -> Vec<ModelInlier> {
    let mut best_by_source = HashMap::<usize, ModelInlier>::new();
    for observation in observations {
        let predicted = scale * observation.source_time_ms as f64 + offset;
        let residual = (observation.target_time_ms as f64 - predicted)
            .abs()
            .round() as i64;
        if residual > tolerance_ms {
            continue;
        }
        let candidate = ModelInlier {
            source_index: observation.source_index,
            target_index: observation.target_index,
            source_time_ms: observation.source_time_ms,
            target_time_ms: observation.target_time_ms,
            residual_ms: residual,
        };
        let replace = best_by_source
            .get(&observation.source_index)
            .map(|current| {
                candidate.residual_ms < current.residual_ms
                    || (candidate.residual_ms == current.residual_ms
                        && candidate.target_time_ms < current.target_time_ms)
            })
            .unwrap_or(true);
        if replace {
            best_by_source.insert(observation.source_index, candidate);
        }
    }
    let mut candidates = best_by_source.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.source_index.cmp(&right.source_index))
    });
    let mut used_targets = HashSet::new();
    let mut monotonic = Vec::new();
    let mut previous_target_ms = i64::MIN;
    for candidate in candidates {
        if candidate.target_time_ms <= previous_target_ms
            || !used_targets.insert(candidate.target_index)
        {
            continue;
        }
        previous_target_ms = candidate.target_time_ms;
        monotonic.push(candidate);
    }
    monotonic
}

fn least_squares_affine(inliers: &[ModelInlier]) -> Option<(f64, f64)> {
    if inliers.len() < 2 {
        return None;
    }
    let source_mean = inliers
        .iter()
        .map(|item| item.source_time_ms as f64)
        .sum::<f64>()
        / inliers.len() as f64;
    let target_mean = inliers
        .iter()
        .map(|item| item.target_time_ms as f64)
        .sum::<f64>()
        / inliers.len() as f64;
    let numerator = inliers
        .iter()
        .map(|item| {
            (item.source_time_ms as f64 - source_mean) * (item.target_time_ms as f64 - target_mean)
        })
        .sum::<f64>();
    let denominator = inliers
        .iter()
        .map(|item| (item.source_time_ms as f64 - source_mean).powi(2))
        .sum::<f64>();
    if denominator <= f64::EPSILON {
        return None;
    }
    let scale = numerator / denominator;
    Some((scale, target_mean - scale * source_mean))
}

fn compare_hypotheses(left: &AffineHypothesis, right: &AffineHypothesis) -> std::cmp::Ordering {
    right
        .inlier_count
        .cmp(&left.inlier_count)
        .then_with(|| left.p95_residual_ms.cmp(&right.p95_residual_ms))
        .then_with(|| {
            right
                .unique_source_coverage
                .total_cmp(&left.unique_source_coverage)
        })
        .then_with(|| {
            right
                .unique_target_coverage
                .total_cmp(&left.unique_target_coverage)
        })
        .then_with(|| left.offset_ms.abs().cmp(&right.offset_ms.abs()))
        .then_with(|| left.scale.total_cmp(&right.scale))
}

fn calculate_hypothesis_margin(hypotheses: &[AffineHypothesis], config: &AffineMatchConfig) -> f64 {
    let Some(first) = hypotheses.first() else {
        return 0.0;
    };
    let score = |item: &AffineHypothesis| {
        item.inlier_count as f64
            - item.p95_residual_ms as f64 / (config.residual_tolerance_ms as f64 * 2.0)
    };
    let first_score = score(first).max(0.001);
    let second_score = hypotheses.get(1).map(score).unwrap_or(0.0);
    ((first_score - second_score) / first_score).clamp(0.0, 1.0)
}

fn percentile(sorted: &[i64], quantile: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) as f64 * quantile).ceil() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn validate_feature_sequences(
    source: &[FineFeatureFrame],
    target: &[FineFeatureFrame],
) -> Result<(), String> {
    for (label, frames) in [("来源", source), ("目标", target)] {
        let mut previous_time = None;
        for frame in frames {
            if frame.values.is_empty() || frame.values.iter().any(|value| !value.is_finite()) {
                return Err(format!("{label}细粒度特征为空或包含非有限值。"));
            }
            if previous_time.is_some_and(|previous| frame.time_ms <= previous) {
                return Err(format!("{label}细粒度特征时间戳不是严格递增。"));
            }
            previous_time = Some(frame.time_ms);
        }
    }
    if let (Some(source_width), Some(target_width)) = (
        source.first().map(|frame| frame.values.len()),
        target.first().map(|frame| frame.values.len()),
    ) {
        if source_width != target_width
            || source
                .iter()
                .any(|frame| frame.values.len() != source_width)
            || target
                .iter()
                .any(|frame| frame.values.len() != target_width)
        {
            return Err("来源与目标细粒度特征维度不一致。".to_string());
        }
    }
    Ok(())
}

fn validate_edit_config(config: &EditAlignmentConfig) -> Result<(), String> {
    if config.band_radius_ms <= 0
        || config.max_dp_cells == 0
        || config.gap_open_cost <= 0
        || config.gap_extend_cost <= 0
        || config.gap_open_cost < config.gap_extend_cost
        || config.ambiguous_match_cost <= 0
    {
        return Err("EditAlignmentConfig 的窄带与 affine gap 参数必须为正。".to_string());
    }
    Ok(())
}

fn target_band_range(
    target: &[FineFeatureFrame],
    predicted_target_ms: f64,
    band_radius_ms: i64,
) -> (usize, usize) {
    let lower = (predicted_target_ms - band_radius_ms as f64).floor() as i64;
    let upper = (predicted_target_ms + band_radius_ms as f64).ceil() as i64;
    let start = target.partition_point(|frame| frame.time_ms < lower);
    let end = target.partition_point(|frame| frame.time_ms <= upper);
    // DP 的矩阵索引比 frame 索引大 1，end 本身就是半开上界所需的矩阵索引。
    (start + 1, end + 1)
}

fn is_inside_affine_band(
    source: &FineFeatureFrame,
    target: &FineFeatureFrame,
    coarse: &AffineHypothesis,
    band_radius_ms: i64,
) -> bool {
    let predicted = coarse.scale * source.time_ms as f64 + coarse.offset_ms as f64;
    (target.time_ms as f64 - predicted).abs() <= band_radius_ms as f64
}

fn feature_distance_cost(left: &[f32], right: &[f32]) -> i64 {
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| *left as f64 * *right as f64)
        .sum::<f64>();
    let left_norm = left
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    let right_norm = right
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        return 1_000;
    }
    ((1.0 - dot / (left_norm * right_norm)).clamp(0.0, 2.0) * 1_000.0).round() as i64
}

fn select_min_state(matched: i64, source_only: i64, target_only: i64) -> (u8, i64) {
    select_min_candidate(&[
        (STATE_MATCHED, matched),
        (STATE_SOURCE_ONLY, source_only),
        (STATE_TARGET_ONLY, target_only),
    ])
}

fn select_min_candidate(candidates: &[(u8, i64)]) -> (u8, i64) {
    candidates
        .iter()
        .copied()
        .min_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)))
        .unwrap_or((STATE_NONE, COST_INFINITY))
}

fn add_cost(base: i64, addition: i64) -> i64 {
    if base >= COST_INFINITY {
        COST_INFINITY
    } else {
        base.saturating_add(addition).min(COST_INFINITY)
    }
}

#[allow(clippy::too_many_arguments)]
fn select_alignment_endpoint(
    source_len: usize,
    target_len: usize,
    width: usize,
    mode: EditAlignmentMode,
    matched_costs: &[i64],
    source_only_costs: &[i64],
    target_only_costs: &[i64],
) -> Result<(usize, usize, u8, i64), String> {
    let mut endpoints = Vec::new();
    if mode == EditAlignmentMode::Global {
        let index = source_len * width + target_len;
        for (state, cost) in [
            (STATE_MATCHED, matched_costs[index]),
            (STATE_SOURCE_ONLY, source_only_costs[index]),
            (STATE_TARGET_ONLY, target_only_costs[index]),
        ] {
            endpoints.push((source_len, target_len, state, cost));
        }
    } else {
        for target_index in 0..=target_len {
            let index = source_len * width + target_index;
            for (state, cost) in [
                (STATE_MATCHED, matched_costs[index]),
                (STATE_SOURCE_ONLY, source_only_costs[index]),
                (STATE_TARGET_ONLY, target_only_costs[index]),
            ] {
                endpoints.push((source_len, target_index, state, cost));
            }
        }
    }
    let endpoint = endpoints
        .into_iter()
        .min_by(|left, right| {
            left.3
                .cmp(&right.3)
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| left.2.cmp(&right.2))
        })
        .ok_or_else(|| "细粒度 DP 没有终点。".to_string())?;
    if endpoint.3 >= COST_INFINITY {
        return Err("粗仿射窄带内不存在完整单调路径。".to_string());
    }
    Ok(endpoint)
}

fn create_frame_boundaries(frames: &[FineFeatureFrame]) -> Result<Vec<i64>, String> {
    if frames.is_empty() {
        return Err("无法为空特征创建时间边界。".to_string());
    }
    let hop_ms = if frames.len() >= 2 {
        let mut differences = frames
            .windows(2)
            .map(|window| window[1].time_ms - window[0].time_ms)
            .collect::<Vec<_>>();
        differences.sort_unstable();
        differences[differences.len() / 2]
    } else {
        1
    };
    let mut boundaries = frames.iter().map(|frame| frame.time_ms).collect::<Vec<_>>();
    boundaries.push(
        frames
            .last()
            .and_then(|frame| frame.time_ms.checked_add(hop_ms))
            .ok_or_else(|| "特征尾边界毫秒溢出。".to_string())?,
    );
    Ok(boundaries)
}

fn collapse_opposite_gap_runs(path: Vec<EditPathStep>) -> Vec<EditPathStep> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < path.len() {
        if !matches!(
            path[index].kind,
            EditPathKind::SourceOnly | EditPathKind::TargetOnly
        ) {
            output.push(path[index].clone());
            index += 1;
            continue;
        }
        let start = index;
        let mut has_source_only = false;
        let mut has_target_only = false;
        while index < path.len()
            && matches!(
                path[index].kind,
                EditPathKind::SourceOnly | EditPathKind::TargetOnly
            )
        {
            has_source_only |= path[index].kind == EditPathKind::SourceOnly;
            has_target_only |= path[index].kind == EditPathKind::TargetOnly;
            index += 1;
        }
        if has_source_only && has_target_only {
            let run = &path[start..index];
            let source_start_ms = run
                .iter()
                .map(|step| step.source_start_ms)
                .min()
                .unwrap_or(0);
            let source_end_ms = run
                .iter()
                .map(|step| step.source_end_ms)
                .max()
                .unwrap_or(source_start_ms);
            let target_start_ms = run
                .iter()
                .map(|step| step.target_start_ms)
                .min()
                .unwrap_or(0);
            let target_end_ms = run
                .iter()
                .map(|step| step.target_end_ms)
                .max()
                .unwrap_or(target_start_ms);
            output.push(EditPathStep {
                kind: EditPathKind::Ambiguous,
                source_start_ms,
                source_end_ms,
                target_start_ms,
                target_end_ms,
                local_cost: run.iter().map(|step| step.local_cost).sum(),
            });
        } else {
            output.extend(path[start..index].iter().cloned());
        }
    }
    output
}

fn merge_path_to_spans(path: &[EditPathStep]) -> Vec<EditTimeSpan> {
    let mut spans = Vec::<EditTimeSpan>::new();
    for step in path {
        if let Some(previous) = spans.last_mut() {
            if previous.kind == step.kind
                && previous.source_end_ms == step.source_start_ms
                && previous.target_end_ms == step.target_start_ms
            {
                previous.source_end_ms = step.source_end_ms;
                previous.target_end_ms = step.target_end_ms;
                continue;
            }
        }
        spans.push(EditTimeSpan {
            kind: step.kind,
            source_start_ms: step.source_start_ms,
            source_end_ms: step.source_end_ms,
            target_start_ms: step.target_start_ms,
            target_end_ms: step.target_end_ms,
        });
    }
    spans
}

fn validate_monotonic_spans(spans: &[EditTimeSpan]) -> Result<(), String> {
    for span in spans {
        if span.source_end_ms < span.source_start_ms || span.target_end_ms < span.target_start_ms {
            return Err("编辑路径生成了反向区间。".to_string());
        }
    }
    for pair in spans.windows(2) {
        if pair[0].source_end_ms != pair[1].source_start_ms
            || pair[0].target_end_ms != pair[1].target_start_ms
        {
            return Err("编辑路径生成了交叉或不连续区间。".to_string());
        }
    }
    Ok(())
}

fn validate_boundary_config(config: &BoundaryRefinementConfig) -> Result<(), String> {
    if config.sample_rate == 0
        || config.search_radius_ms < 0
        || config.window_ms <= 0
        || !config.score_tolerance.is_finite()
        || config.score_tolerance < 0.0
        || !config.min_correlation.is_finite()
        || !(-1.0..=1.0).contains(&config.min_correlation)
        || !config.min_alternative_margin.is_finite()
        || config.min_alternative_margin < 0.0
        || config.max_uncertainty_ms < 0
    {
        return Err("BoundaryRefinementConfig 无效。".to_string());
    }
    Ok(())
}

fn timeline_ms_to_sample(
    time_ms: i64,
    presentation_offset_ms: i64,
    sample_rate: u32,
) -> Result<usize, String> {
    let relative_ms = time_ms
        .checked_sub(presentation_offset_ms)
        .ok_or_else(|| "时间减 presentation offset 溢出。".to_string())?;
    if relative_ms < 0 {
        return Err("边界早于 PCM presentation offset。".to_string());
    }
    milliseconds_to_samples(relative_ms, sample_rate)
}

fn milliseconds_to_samples(milliseconds: i64, sample_rate: u32) -> Result<usize, String> {
    if milliseconds < 0 || sample_rate == 0 {
        return Err("毫秒或采样率无效。".to_string());
    }
    let samples = (milliseconds as i128 * sample_rate as i128 + 500) / 1_000;
    usize::try_from(samples).map_err(|_| "毫秒换算采样点溢出。".to_string())
}

fn samples_to_milliseconds(samples: usize, sample_rate: u32) -> i64 {
    ((samples as i128 * 1_000 + sample_rate as i128 / 2) / sample_rate as i128) as i64
}

fn centered_window(samples: &[i16], center: usize, length: usize) -> Option<&[i16]> {
    let start = center.checked_sub(length / 2)?;
    let end = start.checked_add(length)?;
    samples.get(start..end)
}

fn boundary_window(
    samples: &[i16],
    center: usize,
    length: usize,
    mode: BoundaryWindowMode,
) -> Option<&[i16]> {
    match mode {
        BoundaryWindowMode::Centered => centered_window(samples, center, length),
        BoundaryWindowMode::OneSided(BoundaryContextSide::Before) => {
            let start = center.checked_sub(length)?;
            samples.get(start..center)
        }
        BoundaryWindowMode::OneSided(BoundaryContextSide::After) => {
            let end = center.checked_add(length)?;
            samples.get(center..end)
        }
    }
}

fn normalized_cross_correlation(left: &[i16], right: &[i16]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return -1.0;
    }
    let left_mean = left.iter().map(|value| *value as f64).sum::<f64>() / left.len() as f64;
    let right_mean = right.iter().map(|value| *value as f64).sum::<f64>() / right.len() as f64;
    let mut numerator = 0.0;
    let mut left_energy = 0.0;
    let mut right_energy = 0.0;
    for (left, right) in left.iter().zip(right) {
        let centered_left = *left as f64 - left_mean;
        let centered_right = *right as f64 - right_mean;
        numerator += centered_left * centered_right;
        left_energy += centered_left * centered_left;
        right_energy += centered_right * centered_right;
    }
    let denominator = (left_energy * right_energy).sqrt();
    if denominator <= f64::EPSILON {
        0.0
    } else {
        (numerator / denominator).clamp(-1.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landmark_extraction_uses_presentation_offset_and_suppresses_silence() {
        let config = LandmarkConfig {
            sample_rate: 8_000,
            presentation_offset_ms: 750,
            max_hash_occurrences: 20,
            ..LandmarkConfig::default()
        };
        let pcm = synth_tone_bursts(config.sample_rate, &[310, 470, 690, 930, 1_270, 1_610]);
        let landmarks = extract_landmarks(&pcm, &config).unwrap();
        assert!(!landmarks.is_empty());
        assert!(landmarks.iter().all(|item| item.time_ms >= 750));
        let mut family_counts = HashMap::<u64, usize>::new();
        for landmark in &landmarks {
            *family_counts
                .entry(landmark_family(landmark.hash))
                .or_default() += 1;
        }
        assert!(family_counts.values().all(|count| *count <= 20));
        assert!(extract_landmarks(&vec![0; pcm.len()], &config)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn affine_matching_recovers_speed_drift_and_ignores_repeated_intro_decoy() {
        let mut source = Vec::new();
        let mut target = Vec::new();
        for index in 0..12usize {
            let hash = (((100 + index) as u64) << 8) | 5;
            let source_time_ms = index as i64 * 1_000;
            source.push(test_landmark(hash, source_time_ms));
            target.push(test_landmark(
                hash,
                (source_time_ms as f64 * 1.02).round() as i64 + 5_000,
            ));
            if index < 3 {
                target.push(test_landmark(hash, source_time_ms));
            }
        }
        source.push(test_landmark((999u64 << 8) | 5, 12_000));
        target.sort_by_key(|item| item.time_ms);
        let result =
            match_landmarks_affine(&source, &target, &AffineMatchConfig::default()).unwrap();
        let best = result.hypotheses.first().unwrap();
        assert!((best.scale - 1.02).abs() < 0.001);
        assert!(best.offset_ms.abs_diff(5_000) <= 2);
        assert_eq!(best.unique_source_count, 12);
        assert!((best.unique_source_coverage - 12.0 / 13.0).abs() < 0.000_1);
        assert_eq!(best.unique_target_count, 12);
        assert!((best.unique_target_coverage - 12.0 / 15.0).abs() < 0.000_1);
        assert!(best.p95_residual_ms <= 1);
        assert!(result.top1_top2_margin > 0.4);
    }

    #[test]
    fn fine_features_keep_presentation_timeline_and_requested_hop() {
        let pcm = synth_tone_bursts(16_000, &[330, 510, 770, 1_130]);
        let frames = extract_fine_features(
            &pcm,
            &FineFeatureConfig {
                presentation_offset_ms: 375,
                ..FineFeatureConfig::default()
            },
        )
        .unwrap();
        assert!(!frames.is_empty());
        assert_eq!(frames[0].time_ms, 400);
        assert_eq!(frames[1].time_ms - frames[0].time_ms, 50);
        assert_eq!(frames[0].values.len(), FINE_SPECTRAL_BAND_COUNT + 2);
        assert!(frames
            .iter()
            .flat_map(|frame| &frame.values)
            .all(|value| value.is_finite()));
    }

    #[test]
    fn edit_dp_models_source_and_target_deletions_symmetrically() {
        let source = feature_sequence(&[0, 1, 2, 3, 4, 5, 6], 0, 100);
        let target = feature_sequence(&[0, 1, 3, 7, 4, 5, 6], 0, 100);
        let result = align_features_edit_aware(
            &source,
            &target,
            &identity_hypothesis(),
            &EditAlignmentConfig {
                band_radius_ms: 1_000,
                gap_open_cost: 250,
                gap_extend_cost: 40,
                ambiguous_match_cost: 700,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        let kinds = result
            .spans
            .iter()
            .map(|span| span.kind)
            .collect::<Vec<_>>();
        assert!(kinds.contains(&EditPathKind::SourceOnly));
        assert!(kinds.contains(&EditPathKind::TargetOnly));
        assert_monotonic(&result.spans);
    }

    #[test]
    fn edit_dp_marks_opposite_gap_replacement_as_ambiguous() {
        let source = feature_sequence(&[0, 1, 2], 0, 100);
        let target = feature_sequence(&[0, 3, 2], 0, 100);
        let result = align_features_edit_aware(
            &source,
            &target,
            &identity_hypothesis(),
            &EditAlignmentConfig {
                band_radius_ms: 500,
                gap_open_cost: 220,
                gap_extend_cost: 40,
                ambiguous_match_cost: 700,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert!(result
            .spans
            .iter()
            .any(|span| span.kind == EditPathKind::Ambiguous));
        assert_monotonic(&result.spans);
    }

    #[test]
    fn narrow_band_dp_follows_coarse_speed_scale() {
        let source = feature_sequence(&[0, 1, 2, 3, 4, 5, 6, 7], 0, 1_000);
        let mut target = feature_sequence(&[0, 1, 2, 3, 4, 5, 6, 7], 4_000, 1_020);
        for (index, frame) in target.iter_mut().enumerate() {
            frame.time_ms = 4_000 + index as i64 * 1_020;
        }
        let coarse = AffineHypothesis {
            scale: 1.02,
            offset_ms: 4_000,
            ..identity_hypothesis()
        };
        let result = align_features_edit_aware(
            &source,
            &target,
            &coarse,
            &EditAlignmentConfig {
                band_radius_ms: 80,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result.matched_step_count, source.len());
        assert_eq!(result.spans.len(), 1);
        assert_eq!(result.spans[0].kind, EditPathKind::Matched);
    }

    #[test]
    fn semi_global_dp_aligns_complete_source_inside_target() {
        let source = feature_sequence(&[1, 2, 3], 0, 100);
        let target = feature_sequence(&[7, 1, 2, 3, 6], 0, 100);
        let coarse = AffineHypothesis {
            offset_ms: 100,
            ..identity_hypothesis()
        };
        let result = align_features_edit_aware(
            &source,
            &target,
            &coarse,
            &EditAlignmentConfig {
                mode: EditAlignmentMode::SemiGlobal,
                band_radius_ms: 120,
                ..EditAlignmentConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result.matched_step_count, source.len());
        assert!(result
            .path
            .iter()
            .all(|step| step.kind == EditPathKind::Matched));
        assert_eq!(result.spans[0].target_start_ms, 100);
        assert_eq!(result.spans[0].target_end_ms, 400);
    }

    #[test]
    fn correlation_refines_integer_millisecond_boundary_and_reports_ambiguity() {
        let source = deterministic_noise(5_000);
        let mut target = vec![0i16; 123];
        target.extend_from_slice(&source);
        let config = BoundaryRefinementConfig {
            sample_rate: 1_000,
            search_radius_ms: 50,
            window_ms: 400,
            score_tolerance: 0.001,
            min_correlation: 0.8,
            min_alternative_margin: 0.000_1,
            max_uncertainty_ms: 5,
            ..BoundaryRefinementConfig::default()
        };
        let result =
            refine_boundary_by_correlation(&source, &target, 2_000, 2_100, &config).unwrap();
        assert_eq!(result.refined_target_boundary_ms, 2_123);
        assert_eq!(result.shift_ms, 23);
        assert!(result.best_correlation > 0.999);
        assert!(result.uncertainty_ms <= 2);
        assert!(!result.ambiguous);

        let periodic_source = (0..5_000)
            .map(|index| if index % 20 < 10 { 12_000 } else { -12_000 })
            .collect::<Vec<_>>();
        let periodic = refine_boundary_by_correlation(
            &periodic_source,
            &periodic_source,
            2_000,
            2_000,
            &BoundaryRefinementConfig {
                min_alternative_margin: 0.01,
                ..config
            },
        )
        .unwrap();
        assert!(periodic.ambiguous);
        assert!(periodic.alternative_margin < 0.001);
    }

    #[test]
    fn one_sided_correlation_recovers_both_edges_of_inserted_content() {
        let source = deterministic_noise(5_000);
        let insertion = (0..700)
            .map(|index| if index % 37 < 13 { 20_000 } else { -7_000 })
            .collect::<Vec<_>>();
        let mut target = source[..2_500].to_vec();
        target.extend_from_slice(&insertion);
        target.extend_from_slice(&source[2_500..]);
        let config = BoundaryRefinementConfig {
            sample_rate: 1_000,
            search_radius_ms: 80,
            window_ms: 400,
            score_tolerance: 0.001,
            min_correlation: 0.9,
            min_alternative_margin: 0.01,
            max_uncertainty_ms: 5,
            ..BoundaryRefinementConfig::default()
        };

        let before = refine_boundary_by_one_sided_correlation_with_cancel(
            &source,
            &target,
            2_500,
            2_470,
            BoundaryContextSide::Before,
            &config,
            None,
        )
        .unwrap();
        let after = refine_boundary_by_one_sided_correlation_with_cancel(
            &source,
            &target,
            2_500,
            3_230,
            BoundaryContextSide::After,
            &config,
            None,
        )
        .unwrap();

        assert_eq!(before.refined_target_boundary_ms, 2_500);
        assert_eq!(after.refined_target_boundary_ms, 3_200);
        for (result, expected) in [(&before, 2_500), (&after, 3_200)] {
            assert!(result.uncertainty_start_ms <= expected);
            assert!(result.uncertainty_end_ms >= expected);
            assert!(result.uncertainty_ms <= 2);
            assert!(!result.ambiguous);
        }
    }

    #[test]
    fn cancellable_algorithm_entrypoints_honor_cancel_token() {
        let cancelled = AtomicBool::new(true);
        let pcm = synth_tone_bursts(16_000, &[330, 510, 770, 1_130]);
        assert_eq!(
            extract_landmarks_with_cancel(&pcm, &LandmarkConfig::default(), Some(&cancelled),)
                .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        assert_eq!(
            extract_fine_features_with_cancel(
                &pcm,
                &FineFeatureConfig::default(),
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
        let source = feature_sequence(&[0, 1, 2], 0, 100);
        let target = feature_sequence(&[0, 1, 2], 0, 100);
        assert_eq!(
            align_features_edit_aware_with_cancel(
                &source,
                &target,
                &identity_hypothesis(),
                &EditAlignmentConfig::default(),
                Some(&cancelled),
            )
            .unwrap_err(),
            ALIGNMENT_V2_CANCELLED
        );
    }

    fn synth_tone_bursts(sample_rate: u32, frequencies: &[u32]) -> Vec<i16> {
        let burst_samples = sample_rate as usize / 4;
        let mut output = Vec::new();
        for (burst_index, frequency) in frequencies.iter().enumerate() {
            for sample_index in 0..burst_samples {
                let phase = sample_index as f64 / sample_rate as f64;
                let envelope = (std::f64::consts::PI * sample_index as f64
                    / burst_samples.max(1) as f64)
                    .sin()
                    .max(0.0);
                let carrier = (2.0 * std::f64::consts::PI * *frequency as f64 * phase).sin();
                let overtone = (2.0
                    * std::f64::consts::PI
                    * (*frequency as f64 * 1.5 + burst_index as f64 * 7.0)
                    * phase)
                    .sin();
                output.push(((carrier * 0.75 + overtone * 0.25) * envelope * 24_000.0) as i16);
            }
        }
        output
    }

    fn test_landmark(hash: u64, time_ms: i64) -> SpectralLandmark {
        SpectralLandmark {
            hash,
            time_ms,
            strength_milli: 1_000,
        }
    }

    fn feature_sequence(labels: &[usize], start_ms: i64, hop_ms: i64) -> Vec<FineFeatureFrame> {
        labels
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let mut values = vec![0.0; 8];
                values[*label] = 1.0;
                FineFeatureFrame {
                    time_ms: start_ms + index as i64 * hop_ms,
                    values,
                }
            })
            .collect()
    }

    fn identity_hypothesis() -> AffineHypothesis {
        AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: 0,
            unique_source_count: 0,
            unique_source_coverage: 0.0,
            unique_target_count: 0,
            unique_target_coverage: 0.0,
            source_start_ms: 0,
            source_end_ms: 0,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
        }
    }

    fn deterministic_noise(length: usize) -> Vec<i16> {
        let mut state = 0x1234_5678u32;
        (0..length)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) as i16).saturating_div(2)
            })
            .collect()
    }

    fn assert_monotonic(spans: &[EditTimeSpan]) {
        for pair in spans.windows(2) {
            assert_eq!(pair[0].source_end_ms, pair[1].source_start_ms);
            assert_eq!(pair[0].target_end_ms, pair[1].target_start_ms);
        }
    }
}
