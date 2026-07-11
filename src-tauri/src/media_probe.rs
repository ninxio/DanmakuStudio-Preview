use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt::Write as _,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::UNIX_EPOCH,
};

const MEDIA_IDENTITY_ALGORITHM: &str = "sha256-full-file-v2";
const MEDIA_IDENTITY_READ_BUFFER_BYTES: usize = 1024 * 1024;
const SHA256_INITIAL_STATE: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const AUDIO_TIMELINE_PROBE_MAX_BYTES: usize = 128 * 1024 * 1024;
const AUDIO_TIMELINE_PROBE_MAX_STDERR_BYTES: usize = 1024 * 1024;
const AUDIO_PTS_DISCONTINUITY_TOLERANCE_MS: i64 = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeRequest {
    path: String,
    ffprobe_path: Option<String>,
    ffmpeg_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIdentityProbeRequest {
    path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbeSnapshot {
    #[serde(skip_serializing)]
    pub path: String,
    pub presentation_origin_ms: i64,
    pub duration_ms: Option<u64>,
    pub content_identity: Option<MediaContentIdentity>,
    pub video_streams: Vec<VideoStreamProbe>,
    pub audio_streams: Vec<AudioStreamProbe>,
    pub preferred_audio_stream_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContentIdentity {
    pub algorithm: &'static str,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
    pub first_sample_digest: String,
    pub middle_sample_digest: String,
    pub last_sample_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamProbe {
    #[serde(rename = "index")]
    pub stream_index: u32,
    #[serde(rename = "codec")]
    pub codec_name: Option<String>,
    #[serde(rename = "startMs")]
    pub start_time_ms: i64,
    pub timeline_offset_ms: i64,
    pub duration_ms: Option<u64>,
    pub time_base: Option<String>,
    pub frame_rate: Option<f64>,
    pub language: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "default")]
    pub is_default: bool,
    #[serde(rename = "commentary")]
    pub is_commentary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamProbe {
    #[serde(rename = "index")]
    pub stream_index: u32,
    #[serde(rename = "codec")]
    pub codec_name: Option<String>,
    #[serde(rename = "startMs")]
    pub start_time_ms: i64,
    pub timeline_offset_ms: i64,
    pub duration_ms: Option<u64>,
    pub time_base: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    #[serde(skip_serializing)]
    pub channel_layout: Option<String>,
    pub language: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "default")]
    pub is_default: bool,
    #[serde(rename = "commentary")]
    pub is_commentary: bool,
}

/// FFprobe frame/packet evidence used to bind normalized PCM samples to presentation time.
///
/// This evidence intentionally remains internal to the Rust alignment pipeline for now. The
/// selected values are copied into the V2 cache identity and human-readable diagnostics, so a
/// cached landmark set can never be reused after the timestamp interpretation changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AudioDecodeTimelineProbe {
    pub first_decoded_pts_ms: Option<i64>,
    pub pts_discontinuity_count: u64,
    pub max_pts_gap_ms: Option<u64>,
    pub skip_samples: u64,
    pub discard_padding: u64,
    pub decoded_frame_count: u64,
    pub normalized_pcm_origin_ms: i64,
}

#[derive(Debug, Default)]
struct AudioTimelineAccumulator {
    evidence: AudioDecodeTimelineProbe,
    previous_frame_end_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawProbeOutput {
    #[serde(default)]
    streams: Vec<RawProbeStream>,
    format: Option<RawProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct RawProbeFormat {
    start_time: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProbeStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    start_time: Option<String>,
    duration: Option<String>,
    time_base: Option<String>,
    avg_frame_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    disposition: Option<RawDisposition>,
}

#[derive(Debug, Default, Deserialize)]
struct RawDisposition {
    #[serde(default)]
    default: u8,
    #[serde(default)]
    comment: u8,
}

#[tauri::command]
pub fn probe_media_timeline(request: MediaProbeRequest) -> Result<MediaProbeSnapshot, String> {
    let path = request.path.trim();
    if path.is_empty() {
        return Err("媒体路径不能为空。".to_string());
    }
    if path.contains("://") {
        return Err("高精度媒体探测只接受用户导入的本地文件。".to_string());
    }
    let media_path = Path::new(path);
    if !media_path.is_file() {
        return Err("媒体文件不存在或不可读取。".to_string());
    }

    let ffprobe_path = resolve_requested_ffprobe_path(
        request.ffprobe_path.as_deref(),
        request.ffmpeg_path.as_deref(),
    );
    probe_media_timeline_with_ffprobe(path, &ffprobe_path)
}

/// Computes only the stable content identity. This command deliberately has no FFmpeg/FFprobe
/// dependency, so export preflight cannot fail merely because a media-analysis tool moved.
#[tauri::command]
pub fn probe_media_identity(
    request: MediaIdentityProbeRequest,
) -> Result<MediaContentIdentity, String> {
    let path = request.path.trim();
    validate_local_media_path(path)?;
    probe_media_content_identity(Path::new(path))
}

fn validate_local_media_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("媒体路径不能为空。".to_string());
    }
    if path.contains("://") {
        return Err("媒体身份探测只接受用户导入的本地文件。".to_string());
    }
    if !Path::new(path).is_file() {
        return Err("媒体文件不存在或不可读取。".to_string());
    }
    Ok(())
}

pub(crate) fn probe_media_timeline_with_ffprobe(
    path: &str,
    ffprobe_path: &Path,
) -> Result<MediaProbeSnapshot, String> {
    let content_identity_before = probe_media_content_identity(Path::new(path))?;
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=start_time,duration:stream=index,codec_type,codec_name,start_time,duration,time_base,avg_frame_rate,sample_rate,channels,channel_layout:stream_tags=language,title:stream_disposition=default,comment",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| format!("FFprobe 启动失败：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("FFprobe 媒体探测失败：{}", detail.trim()));
    }
    // FFprobe re-opens the path independently. Re-hash after it exits so a path replacement or
    // in-place rewrite during analysis can never be paired with stale stream metadata.
    let content_identity_after = probe_media_content_identity(Path::new(path))?;
    if !are_media_content_identities_equal(&content_identity_before, &content_identity_after) {
        return Err(
            "媒体文件在 FFprobe 分析期间被替换或修改，请等待文件稳定后重新分析。".to_string(),
        );
    }
    let mut snapshot = parse_media_probe_json(path, &String::from_utf8_lossy(&output.stdout))?;
    snapshot.content_identity = Some(content_identity_after);
    Ok(snapshot)
}

/// Scans decoded audio frame PTS and packet skip-sample metadata without retaining FFprobe's
/// potentially very large output. The compact stream is consumed line-by-line and killed once
/// the hard metadata byte limit is exceeded.
pub(crate) fn probe_audio_decode_timelines_with_ffprobe(
    path: &str,
    ffprobe_path: &Path,
) -> Result<HashMap<u32, AudioDecodeTimelineProbe>, String> {
    let mut child = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_frames",
            "-show_packets",
            "-show_entries",
            "frame=stream_index,best_effort_timestamp_time,pts_time,pkt_duration_time,nb_samples:frame_side_data=side_data_type,skip_samples,discard_padding:packet=stream_index,pts_time,duration_time:packet_side_data=side_data_type,skip_samples,discard_padding",
            "-of",
            "compact=p=1:nk=0",
            path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("FFprobe 音频逐帧时间戳探测启动失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "FFprobe 音频逐帧时间戳标准输出不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "FFprobe 音频逐帧时间戳错误输出不可用。".to_string())?;
    let stderr_reader = thread::spawn(move || {
        read_stream_prefix_while_draining(stderr, AUDIO_TIMELINE_PROBE_MAX_STDERR_BYTES)
    });
    let mut reader = BufReader::new(stdout);
    let mut total_bytes = 0usize;
    let mut line = Vec::new();
    let mut accumulators = HashMap::<u32, AudioTimelineAccumulator>::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("FFprobe 音频逐帧时间戳输出读取失败：{error}"))?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read);
        if total_bytes > AUDIO_TIMELINE_PROBE_MAX_BYTES {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(format!(
                "blocked:resource-limit：FFprobe 音频逐帧时间戳元数据超过 {} MiB 硬上限。",
                AUDIO_TIMELINE_PROBE_MAX_BYTES / (1024 * 1024)
            ));
        }
        let record = String::from_utf8_lossy(&line);
        apply_audio_timeline_compact_record(record.trim(), &mut accumulators)?;
    }
    let status = child
        .wait()
        .map_err(|error| format!("FFprobe 音频逐帧时间戳进程等待失败：{error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "FFprobe 音频逐帧时间戳错误输出线程异常。".to_string())?
        .map_err(|error| format!("FFprobe 音频逐帧时间戳错误输出读取失败：{error}"))?;
    if !status.success() {
        return Err(format!(
            "FFprobe 音频逐帧时间戳探测失败：{}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(accumulators
        .into_iter()
        .filter_map(|(stream_index, accumulator)| {
            (accumulator.evidence.decoded_frame_count > 0)
                .then_some((stream_index, accumulator.evidence))
        })
        .collect())
}

fn read_stream_prefix_while_draining<R: Read>(
    mut reader: R,
    retained_limit: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let mut retained = Vec::new();
    let mut buffer = [0u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = retained_limit.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(retained)
}

fn apply_audio_timeline_compact_record(
    record: &str,
    accumulators: &mut HashMap<u32, AudioTimelineAccumulator>,
) -> Result<(), String> {
    if record.is_empty() {
        return Ok(());
    }
    let mut fields = record.split('|');
    let record_type = fields.next().unwrap_or_default();
    let values = fields
        .filter_map(|field| field.split_once('='))
        .collect::<HashMap<_, _>>();
    let Some(stream_index) = values
        .get("stream_index")
        .and_then(|value| value.parse::<u32>().ok())
    else {
        return Ok(());
    };
    let accumulator = accumulators.entry(stream_index).or_default();
    match record_type {
        "frame" => {
            let pts_ms = values
                .get("best_effort_timestamp_time")
                .or_else(|| values.get("pts_time"))
                .and_then(|value| parse_signed_seconds_ms(Some(value)));
            let Some(pts_ms) = pts_ms else {
                return Ok(());
            };
            let duration_ms = values
                .get("pkt_duration_time")
                .and_then(|value| parse_duration_ms(Some(value)))
                .and_then(|value| i64::try_from(value).ok())
                .filter(|value| *value > 0);
            accumulator
                .evidence
                .first_decoded_pts_ms
                .get_or_insert(pts_ms);
            accumulator.evidence.decoded_frame_count =
                accumulator.evidence.decoded_frame_count.saturating_add(1);
            if let Some(previous_end_ms) = accumulator.previous_frame_end_ms {
                let gap_ms = pts_ms.saturating_sub(previous_end_ms);
                if gap_ms.abs() > AUDIO_PTS_DISCONTINUITY_TOLERANCE_MS {
                    accumulator.evidence.pts_discontinuity_count = accumulator
                        .evidence
                        .pts_discontinuity_count
                        .saturating_add(1);
                    let absolute_gap = gap_ms.unsigned_abs();
                    accumulator.evidence.max_pts_gap_ms = Some(
                        accumulator
                            .evidence
                            .max_pts_gap_ms
                            .unwrap_or(0)
                            .max(absolute_gap),
                    );
                }
            }
            accumulator.previous_frame_end_ms =
                duration_ms.map(|duration_ms| pts_ms.saturating_add(duration_ms));
        }
        "packet" => {
            accumulator.evidence.skip_samples = accumulator.evidence.skip_samples.saturating_add(
                values
                    .get("skip_samples")
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0),
            );
            accumulator.evidence.discard_padding =
                accumulator.evidence.discard_padding.saturating_add(
                    values
                        .get("discard_padding")
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0),
                );
        }
        _ => {}
    }
    Ok(())
}

/// Creates a deterministic full-file identity for replacement detection.
///
/// The file is opened exactly once. Both metadata reads and the streaming SHA-256 hash use that
/// same handle, so swapping the directory entry cannot splice samples from different files. The
/// legacy three digest fields are intentionally all populated with the same complete-file digest
/// to keep schema v10 projects readable without a migration.
pub(crate) fn probe_media_content_identity(path: &Path) -> Result<MediaContentIdentity, String> {
    let mut file =
        File::open(path).map_err(|error| format!("无法打开媒体文件以生成身份：{error}"))?;
    let metadata_before = file
        .metadata()
        .map_err(|error| format!("无法从已打开媒体读取身份元数据：{error}"))?;
    if !metadata_before.is_file() {
        return Err("媒体身份只能从本地文件生成。".to_string());
    }
    let size_bytes = metadata_before.len();
    let modified_unix_ms = read_modified_unix_ms(&metadata_before)?;
    let mut hasher = StreamingSha256::new();
    let mut buffer = vec![0_u8; MEDIA_IDENTITY_READ_BUFFER_BYTES];
    let mut bytes_read = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("媒体身份全文件读取失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes_read = bytes_read.saturating_add(read as u64);
    }

    let metadata_after = file
        .metadata()
        .map_err(|error| format!("媒体身份读取后无法从同一文件句柄重读元数据：{error}"))?;
    if bytes_read != size_bytes
        || metadata_after.len() != size_bytes
        || read_modified_unix_ms(&metadata_after)? != modified_unix_ms
    {
        return Err("媒体文件在全文件身份读取期间发生变化，请等待写入完成后重试。".to_string());
    }
    let full_digest = sha256_hex(hasher.finalize());

    Ok(MediaContentIdentity {
        algorithm: MEDIA_IDENTITY_ALGORITHM,
        size_bytes,
        modified_unix_ms,
        first_sample_digest: full_digest.clone(),
        middle_sample_digest: full_digest.clone(),
        last_sample_digest: full_digest,
    })
}

/// Small dependency-free SHA-256 implementation used only for streaming local-file identity.
/// The implementation follows FIPS 180-4 and is covered by the NIST `abc` and million-`a`
/// vectors below. Keeping the state here avoids loading a multi-gigabyte video into memory.
struct StreamingSha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    message_len_bytes: u64,
}

impl StreamingSha256 {
    fn new() -> Self {
        Self {
            state: SHA256_INITIAL_STATE,
            buffer: [0; 64],
            buffer_len: 0,
            message_len_bytes: 0,
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.message_len_bytes = self.message_len_bytes.wrapping_add(input.len() as u64);

        if self.buffer_len > 0 {
            let missing = 64 - self.buffer_len;
            let copied = missing.min(input.len());
            self.buffer[self.buffer_len..self.buffer_len + copied]
                .copy_from_slice(&input[..copied]);
            self.buffer_len += copied;
            input = &input[copied..];
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.compress_block(&block);
                self.buffer_len = 0;
            }
        }

        while input.len() >= 64 {
            let block: &[u8; 64] = input[..64].try_into().expect("64-byte SHA-256 block slice");
            self.compress_block(block);
            input = &input[64..];
        }

        if !input.is_empty() {
            self.buffer[..input.len()].copy_from_slice(input);
            self.buffer_len = input.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.message_len_bytes.wrapping_mul(8);
        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;
        if self.buffer_len > 56 {
            self.buffer[self.buffer_len..].fill(0);
            let block = self.buffer;
            self.compress_block(&block);
            self.buffer = [0; 64];
            self.buffer_len = 0;
        }
        self.buffer[self.buffer_len..56].fill(0);
        self.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress_block(&block);

        let mut digest = [0_u8; 32];
        for (index, word) in self.state.iter().enumerate() {
            digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        digest
    }

    fn compress_block(&mut self, block: &[u8; 64]) {
        let mut schedule = [0_u32; 64];
        for (index, word) in block.chunks_exact(4).enumerate() {
            schedule[index] = u32::from_be_bytes(
                word.try_into()
                    .expect("four-byte SHA-256 message schedule word"),
            );
        }
        for index in 16..64 {
            let sigma0 = schedule[index - 15].rotate_right(7)
                ^ schedule[index - 15].rotate_right(18)
                ^ (schedule[index - 15] >> 3);
            let sigma1 = schedule[index - 2].rotate_right(17)
                ^ schedule[index - 2].rotate_right(19)
                ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(sigma0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(sigma1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let upper_sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let temporary1 = h
                .wrapping_add(upper_sigma1)
                .wrapping_add(choice)
                .wrapping_add(SHA256_ROUND_CONSTANTS[index])
                .wrapping_add(schedule[index]);
            let upper_sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temporary2 = upper_sigma0.wrapping_add(majority);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temporary1);
            d = c;
            c = b;
            b = a;
            a = temporary1.wrapping_add(temporary2);
        }

        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
}

fn sha256_hex(digest: [u8; 32]) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing SHA-256 into String cannot fail");
    }
    encoded
}

/// Content equality intentionally ignores mtime for v2. mtime remains serialized as a useful
/// cache/diagnostic hint, but copying identical bytes must not invalidate a verified time map.
pub(crate) fn are_media_content_identities_equal(
    left: &MediaContentIdentity,
    right: &MediaContentIdentity,
) -> bool {
    if left.algorithm == MEDIA_IDENTITY_ALGORITHM && right.algorithm == MEDIA_IDENTITY_ALGORITHM {
        return left.size_bytes == right.size_bytes
            && left.first_sample_digest == right.first_sample_digest
            && left.middle_sample_digest == right.middle_sample_digest
            && left.last_sample_digest == right.last_sample_digest;
    }
    left == right
}

fn read_modified_unix_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    let modified = metadata
        .modified()
        .map_err(|error| format!("无法读取媒体文件修改时间：{error}"))?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "媒体文件修改时间早于 Unix epoch，无法建立稳定身份。".to_string())?;
    u64::try_from(elapsed.as_millis()).map_err(|_| "媒体文件修改时间超出可保存范围。".to_string())
}

pub(crate) fn resolve_ffprobe_path(ffmpeg_path: &str) -> PathBuf {
    let trimmed = ffmpeg_path.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("ffmpeg") {
        return PathBuf::from("ffprobe");
    }
    let ffmpeg = Path::new(trimmed);
    let Some(file_name) = ffmpeg.file_name().and_then(|value| value.to_str()) else {
        return PathBuf::from("ffprobe");
    };
    let probe_file_name = if file_name.eq_ignore_ascii_case("ffmpeg.exe") {
        "ffprobe.exe"
    } else if file_name.eq_ignore_ascii_case("ffmpeg") {
        "ffprobe"
    } else {
        return PathBuf::from("ffprobe");
    };
    ffmpeg.with_file_name(probe_file_name)
}

fn resolve_requested_ffprobe_path(
    ffprobe_path: Option<&str>,
    ffmpeg_path: Option<&str>,
) -> PathBuf {
    ffprobe_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_ffprobe_path(ffmpeg_path.unwrap_or("ffmpeg")))
}

pub fn parse_media_probe_json(path: &str, text: &str) -> Result<MediaProbeSnapshot, String> {
    let raw: RawProbeOutput =
        serde_json::from_str(text).map_err(|error| format!("FFprobe JSON 无法解析：{error}"))?;
    let format_start_ms = raw
        .format
        .as_ref()
        .and_then(|format| parse_signed_seconds_ms(format.start_time.as_deref()));
    let earliest_stream_start_ms = raw
        .streams
        .iter()
        .filter(|stream| matches!(stream.codec_type.as_deref(), Some("audio" | "video")))
        .filter_map(|stream| parse_signed_seconds_ms(stream.start_time.as_deref()))
        .min();
    let presentation_origin_ms = match (format_start_ms, earliest_stream_start_ms) {
        (Some(format_start), Some(stream_start)) => format_start.min(stream_start),
        (Some(format_start), None) => format_start,
        (None, Some(stream_start)) => stream_start,
        (None, None) => 0,
    };
    let duration_ms = raw
        .format
        .as_ref()
        .and_then(|format| parse_duration_ms(format.duration.as_deref()));

    let mut video_streams = Vec::new();
    let mut audio_streams = Vec::new();
    for stream in raw.streams {
        let start_time_ms =
            parse_signed_seconds_ms(stream.start_time.as_deref()).unwrap_or(presentation_origin_ms);
        let timeline_offset_ms = start_time_ms.saturating_sub(presentation_origin_ms);
        let stream_duration_ms = parse_duration_ms(stream.duration.as_deref());
        let disposition = stream.disposition.unwrap_or_default();
        match stream.codec_type.as_deref() {
            Some("video") => video_streams.push(VideoStreamProbe {
                stream_index: stream.index,
                codec_name: stream.codec_name,
                start_time_ms,
                timeline_offset_ms,
                duration_ms: stream_duration_ms,
                time_base: normalized_optional_text(stream.time_base),
                frame_rate: parse_frame_rate(stream.avg_frame_rate.as_deref()),
                language: normalized_optional_text(stream.tags.get("language").cloned()),
                title: normalized_optional_text(stream.tags.get("title").cloned()),
                is_default: disposition.default == 1,
                is_commentary: disposition.comment == 1,
            }),
            Some("audio") => {
                let title = normalized_optional_text(stream.tags.get("title").cloned());
                let is_commentary = disposition.comment == 1
                    || title.as_deref().is_some_and(is_commentary_track_title);
                audio_streams.push(AudioStreamProbe {
                    stream_index: stream.index,
                    codec_name: stream.codec_name,
                    start_time_ms,
                    timeline_offset_ms,
                    duration_ms: stream_duration_ms,
                    time_base: normalized_optional_text(stream.time_base),
                    sample_rate: stream
                        .sample_rate
                        .as_deref()
                        .and_then(|value| value.parse::<u32>().ok()),
                    channels: stream.channels,
                    channel_layout: normalized_optional_text(stream.channel_layout),
                    language: normalized_optional_text(stream.tags.get("language").cloned()),
                    title,
                    is_default: disposition.default == 1,
                    is_commentary,
                });
            }
            _ => {}
        }
    }
    video_streams.sort_by_key(|stream| stream.stream_index);
    audio_streams.sort_by_key(|stream| stream.stream_index);
    let preferred_audio_stream_index = choose_preferred_audio_stream(&audio_streams);

    Ok(MediaProbeSnapshot {
        path: path.to_string(),
        presentation_origin_ms,
        duration_ms,
        content_identity: None,
        video_streams,
        audio_streams,
        preferred_audio_stream_index,
    })
}

pub fn choose_preferred_audio_stream(streams: &[AudioStreamProbe]) -> Option<u32> {
    streams
        .iter()
        .min_by_key(|stream| {
            (
                stream.is_commentary,
                !stream.is_default,
                stream.stream_index,
            )
        })
        .map(|stream| stream.stream_index)
}

pub(crate) fn select_audio_stream(
    snapshot: &MediaProbeSnapshot,
    requested_stream_index: Option<u32>,
    label: &str,
) -> Result<AudioStreamProbe, String> {
    let selected_index = match requested_stream_index {
        Some(index) => index,
        None => snapshot
            .preferred_audio_stream_index
            .ok_or_else(|| format!("{label}没有可用音轨。"))?,
    };
    snapshot
        .audio_streams
        .iter()
        .find(|stream| stream.stream_index == selected_index)
        .cloned()
        .ok_or_else(|| format!("{label}不存在音轨 #{selected_index}。"))
}

fn parse_signed_seconds_ms(value: Option<&str>) -> Option<i64> {
    let seconds = value?.parse::<f64>().ok()?;
    if !seconds.is_finite() {
        return None;
    }
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds < i64::MIN as f64 || milliseconds > i64::MAX as f64 {
        return None;
    }
    Some(milliseconds as i64)
}

fn parse_duration_ms(value: Option<&str>) -> Option<u64> {
    let seconds = value?.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let milliseconds = (seconds * 1000.0).round();
    if milliseconds > u64::MAX as f64 {
        return None;
    }
    Some(milliseconds as u64)
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let text = value?.trim();
    let rate = if let Some((numerator, denominator)) = text.split_once('/') {
        let numerator = numerator.parse::<f64>().ok()?;
        let denominator = denominator.parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        numerator / denominator
    } else {
        text.parse::<f64>().ok()?
    };
    rate.is_finite().then_some(rate).filter(|rate| *rate > 0.0)
}

fn normalized_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty() && text != "0/0")
}

fn is_commentary_track_title(title: &str) -> bool {
    let normalized = title.to_lowercase();
    ["commentary", "comment", "director", "评论", "解说", "导评"]
        .iter()
        .any(|marker| normalized.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE_JSON: &str = r#"
    {
      "streams": [
        {
          "index": 0,
          "codec_type": "video",
          "codec_name": "h264",
          "start_time": "-0.080000",
          "duration": "120.000000",
          "time_base": "1/90000",
          "avg_frame_rate": "24000/1001",
          "disposition": { "default": 1, "comment": 0 }
        },
        {
          "index": 1,
          "codec_type": "audio",
          "codec_name": "aac",
          "start_time": "0.000000",
          "duration": "119.920000",
          "time_base": "1/48000",
          "sample_rate": "48000",
          "channels": 2,
          "channel_layout": "stereo",
          "tags": { "language": "jpn", "title": "Main" },
          "disposition": { "default": 1, "comment": 0 }
        },
        {
          "index": 2,
          "codec_type": "audio",
          "codec_name": "aac",
          "start_time": "0.000000",
          "duration": "119.920000",
          "time_base": "1/48000",
          "sample_rate": "48000",
          "channels": 2,
          "channel_layout": "stereo",
          "tags": { "language": "eng", "title": "Director Commentary" },
          "disposition": { "default": 0, "comment": 1 }
        }
      ],
      "format": { "start_time": "-0.080000", "duration": "120.000000" }
    }
    "#;

    #[test]
    fn probe_parser_preserves_presentation_offsets_and_stream_identity() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, -80);
        assert_eq!(snapshot.duration_ms, Some(120_000));
        assert_eq!(snapshot.video_streams[0].timeline_offset_ms, 0);
        assert!((snapshot.video_streams[0].frame_rate.unwrap() - 24_000.0 / 1_001.0).abs() < 1e-9);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 80);
        assert_eq!(snapshot.audio_streams[0].language.as_deref(), Some("jpn"));
        assert_eq!(snapshot.preferred_audio_stream_index, Some(1));
        assert!(snapshot.audio_streams[1].is_commentary);
    }

    #[test]
    fn probe_snapshot_serialization_matches_the_tauri_wrapper_contract() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();
        let serialized = serde_json::to_value(snapshot).unwrap();
        let video = &serialized["videoStreams"][0];
        let audio = &serialized["audioStreams"][0];

        assert!(serialized.get("path").is_none());
        assert_eq!(video["index"], 0);
        assert_eq!(video["codec"], "h264");
        assert_eq!(video["startMs"], -80);
        assert_eq!(video["timelineOffsetMs"], 0);
        assert!((video["frameRate"].as_f64().unwrap() - 24_000.0 / 1_001.0).abs() < 1e-9);
        assert_eq!(video["default"], true);
        assert_eq!(video["commentary"], false);
        assert!(video.get("streamIndex").is_none());
        assert!(video.get("codecName").is_none());
        assert!(video.get("averageFrameRate").is_none());

        assert_eq!(audio["index"], 1);
        assert_eq!(audio["codec"], "aac");
        assert_eq!(audio["startMs"], 0);
        assert_eq!(audio["timelineOffsetMs"], 80);
        assert_eq!(audio["sampleRate"], 48_000);
        assert_eq!(audio["channels"], 2);
        assert_eq!(audio["default"], true);
        assert_eq!(audio["commentary"], false);
        assert!(audio.get("channelLayout").is_none());
    }

    #[test]
    fn probe_parser_falls_back_to_earliest_stream_start() {
        let text = r#"{
          "streams": [
            {"index": 3,"codec_type":"audio","start_time":"1.250","disposition":{}},
            {"index": 0,"codec_type":"video","start_time":"0.500","disposition":{}}
          ]
        }"#;
        let snapshot = parse_media_probe_json("clip.mp4", text).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, 500);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 750);
    }

    #[test]
    fn probe_parser_uses_earliest_origin_so_relative_timeline_is_non_negative() {
        let text = r#"{
          "streams": [
            {"index":0,"codec_type":"video","start_time":"-0.080","disposition":{}},
            {"index":1,"codec_type":"audio","start_time":"0.000","disposition":{"default":1}}
          ],
          "format":{"start_time":"0.000","duration":"10.000"}
        }"#;
        let snapshot = parse_media_probe_json("clip.mp4", text).unwrap();

        assert_eq!(snapshot.presentation_origin_ms, -80);
        assert_eq!(snapshot.video_streams[0].timeline_offset_ms, 0);
        assert_eq!(snapshot.audio_streams[0].timeline_offset_ms, 80);
        assert!(snapshot
            .video_streams
            .iter()
            .all(|stream| stream.timeline_offset_ms >= 0));
        assert!(snapshot
            .audio_streams
            .iter()
            .all(|stream| stream.timeline_offset_ms >= 0));
    }

    #[test]
    fn preferred_audio_avoids_commentary_before_considering_default_flag() {
        let mut snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();
        snapshot.audio_streams[0].is_default = false;
        snapshot.audio_streams[1].is_default = true;

        assert_eq!(
            choose_preferred_audio_stream(&snapshot.audio_streams),
            Some(1)
        );
    }

    #[test]
    fn audio_stream_selection_uses_preferred_track_but_allows_explicit_override() {
        let snapshot = parse_media_probe_json("episode.mkv", PROBE_JSON).unwrap();

        assert_eq!(
            select_audio_stream(&snapshot, None, "原片")
                .unwrap()
                .stream_index,
            1
        );
        assert_eq!(
            select_audio_stream(&snapshot, Some(2), "原片")
                .unwrap()
                .stream_index,
            2
        );
        assert_eq!(
            select_audio_stream(&snapshot, Some(9), "原片").unwrap_err(),
            "原片不存在音轨 #9。"
        );
    }

    #[test]
    fn ffprobe_path_follows_a_configured_ffmpeg_binary() {
        assert_eq!(
            resolve_ffprobe_path(r"C:\tools\ffmpeg.exe"),
            PathBuf::from(r"C:\tools\ffprobe.exe")
        );
        assert_eq!(resolve_ffprobe_path("ffmpeg"), PathBuf::from("ffprobe"));
        assert_eq!(
            resolve_ffprobe_path(r"C:\tools\custom-decoder.exe"),
            PathBuf::from("ffprobe")
        );
    }

    #[test]
    fn probe_request_prefers_explicit_ffprobe_and_otherwise_follows_ffmpeg() {
        assert_eq!(
            resolve_requested_ffprobe_path(
                Some(r"C:\probe\ffprobe.exe"),
                Some(r"C:\tools\ffmpeg.exe")
            ),
            PathBuf::from(r"C:\probe\ffprobe.exe")
        );
        assert_eq!(
            resolve_requested_ffprobe_path(None, Some(r"C:\tools\ffmpeg.exe")),
            PathBuf::from(r"C:\tools\ffprobe.exe")
        );

        let request: MediaProbeRequest = serde_json::from_str(
            r#"{"path":"episode.mkv","ffprobePath":null,"ffmpegPath":"C:\\tools\\ffmpeg.exe"}"#,
        )
        .unwrap();
        assert_eq!(request.ffmpeg_path.as_deref(), Some(r"C:\tools\ffmpeg.exe"));
    }

    #[test]
    fn compact_audio_timeline_parser_detects_pts_gap_and_skip_samples() {
        let mut accumulators = HashMap::new();
        for record in [
            "packet|stream_index=2|pts_time=-0.021333|duration_time=0.021333|side_data|side_data_type=Skip Samples|skip_samples=1024|discard_padding=0",
            "frame|stream_index=2|pts_time=0.000000|best_effort_timestamp_time=0.000000|pkt_duration_time=0.020000|nb_samples=960",
            "frame|stream_index=2|pts_time=0.020000|best_effort_timestamp_time=0.020000|pkt_duration_time=0.020000|nb_samples=960",
            "frame|stream_index=2|pts_time=5.040000|best_effort_timestamp_time=5.040000|pkt_duration_time=0.020000|nb_samples=960",
            "packet|stream_index=2|pts_time=5.040000|duration_time=0.020000|side_data|side_data_type=Skip Samples|skip_samples=0|discard_padding=256",
        ] {
            apply_audio_timeline_compact_record(record, &mut accumulators).unwrap();
        }
        let evidence = &accumulators.get(&2).unwrap().evidence;

        assert_eq!(evidence.first_decoded_pts_ms, Some(0));
        assert_eq!(evidence.decoded_frame_count, 3);
        assert_eq!(evidence.pts_discontinuity_count, 1);
        assert_eq!(evidence.max_pts_gap_ms, Some(5_000));
        assert_eq!(evidence.skip_samples, 1_024);
        assert_eq!(evidence.discard_padding, 256);
        assert_eq!(evidence.normalized_pcm_origin_ms, 0);
    }

    #[test]
    fn media_content_identity_is_stable_and_binds_every_byte_and_size() {
        let path = std::env::temp_dir().join(format!(
            "media-identity-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = (0..256 * 1024usize)
            .map(|index| (index.wrapping_mul(31) % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &bytes).unwrap();
        let stable = probe_media_content_identity(&path).unwrap();
        assert_eq!(stable, probe_media_content_identity(&path).unwrap());
        assert_eq!(stable.algorithm, "sha256-full-file-v2");
        assert_eq!(stable.first_sample_digest.len(), 64);
        assert_eq!(stable.first_sample_digest, stable.middle_sample_digest);
        assert_eq!(stable.middle_sample_digest, stable.last_sample_digest);

        let mut previous = stable;
        for index in [0usize, 96 * 1024, bytes.len() / 2, bytes.len() - 1] {
            bytes[index] ^= 0x5a;
            std::fs::write(&path, &bytes).unwrap();
            let changed = probe_media_content_identity(&path).unwrap();
            assert_ne!(previous, changed, "sample index {index} was not bound");
            previous = changed;
        }
        bytes.push(7);
        std::fs::write(&path, &bytes).unwrap();
        let resized = probe_media_content_identity(&path).unwrap();
        assert_ne!(previous, resized);
        assert_eq!(resized.size_bytes, bytes.len() as u64);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn v2_content_equality_ignores_mtime_but_legacy_equality_stays_conservative() {
        let digest = "a".repeat(64);
        let current = MediaContentIdentity {
            algorithm: MEDIA_IDENTITY_ALGORITHM,
            size_bytes: 42,
            modified_unix_ms: 100,
            first_sample_digest: digest.clone(),
            middle_sample_digest: digest.clone(),
            last_sample_digest: digest,
        };
        let mut copied = current.clone();
        copied.modified_unix_ms = 200;
        assert!(are_media_content_identities_equal(&current, &copied));

        let legacy = MediaContentIdentity {
            algorithm: "fnv1a64-first-middle-last-64k-v1",
            size_bytes: 42,
            modified_unix_ms: 100,
            first_sample_digest: "1".repeat(16),
            middle_sample_digest: "2".repeat(16),
            last_sample_digest: "3".repeat(16),
        };
        let mut legacy_rewritten = legacy.clone();
        legacy_rewritten.modified_unix_ms = 200;
        assert!(!are_media_content_identities_equal(
            &legacy,
            &legacy_rewritten
        ));
    }

    #[test]
    fn streaming_sha256_matches_nist_abc_vector() {
        let mut hasher = StreamingSha256::new();
        hasher.update(b"abc");
        assert_eq!(
            sha256_hex(hasher.finalize()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn streaming_sha256_matches_nist_million_a_vector_across_irregular_chunks() {
        let input = vec![b'a'; 1_000_000];
        let mut hasher = StreamingSha256::new();
        let chunk_sizes = [1, 7, 63, 64, 65, 1_023, 4_097];
        let mut offset = 0;
        let mut chunk_index = 0;
        while offset < input.len() {
            let end = (offset + chunk_sizes[chunk_index % chunk_sizes.len()]).min(input.len());
            hasher.update(&input[offset..end]);
            offset = end;
            chunk_index += 1;
        }
        assert_eq!(
            sha256_hex(hasher.finalize()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
