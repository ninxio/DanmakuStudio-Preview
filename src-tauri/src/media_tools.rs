use crate::process_supervision::{
    SupervisedCommand, SupervisedOutputLimits, SupervisedProcessErrorKind,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MEDIA_TOOL_DETECTION_TIMEOUT: Duration = Duration::from_secs(10);
const MEDIA_TOOL_DETECTION_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MEDIA_TOOL_DETECTION_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
const MEDIA_TOOL_DETECTION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolDetectionRequest {
    tool: String,
    executable_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolDetectionResult {
    tool: String,
    executable_path: String,
    available: bool,
    version: Option<String>,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStartRequest {
    mpv_path: String,
    media_path: String,
    start_position_ms: Option<u64>,
    start_paused: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvControlRequest {
    action: String,
    position_ms: Option<u64>,
    playback_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MpvPlaybackStatus {
    Idle,
    Playing,
    Paused,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrackSummary {
    id: i64,
    track_type: String,
    title: Option<String>,
    language: Option<String>,
    codec: Option<String>,
    selected: bool,
    external: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSidecarStatus {
    running: bool,
    backend: &'static str,
    playback_status: MpvPlaybackStatus,
    media_path: Option<String>,
    position_ms: u64,
    duration_ms: u64,
    tracks: Vec<MpvTrackSummary>,
    message: String,
    error: Option<String>,
    updated_at_ms: u64,
}

#[derive(Debug)]
struct MpvSidecarState {
    child: Option<Child>,
    ipc_path: Option<String>,
    media_path: Option<String>,
    playback_status: MpvPlaybackStatus,
    position_ms: u64,
    duration_ms: u64,
    tracks: Vec<MpvTrackSummary>,
    message: String,
    error: Option<String>,
    updated_at_ms: u64,
}

static MPV_SIDECAR: OnceLock<Mutex<MpvSidecarState>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaToolDetectionFailure {
    Spawn,
    Timeout,
    StdoutOverflow,
    StderrOverflow,
    Reader,
    Wait,
    Cleanup,
    NonZeroExit,
}

#[tauri::command]
pub fn detect_media_tool(
    request: MediaToolDetectionRequest,
) -> Result<MediaToolDetectionResult, String> {
    detect_media_tool_inner(request)
}

#[tauri::command]
pub fn start_mpv_sidecar(request: MpvStartRequest) -> Result<MpvSidecarStatus, String> {
    start_mpv_sidecar_inner(request)
}

#[tauri::command]
pub fn stop_mpv_sidecar() -> Result<MpvSidecarStatus, String> {
    let mut state = mpv_sidecar_state()
        .lock()
        .map_err(|_| "mpv 播放器状态锁已损坏。".to_string())?;
    stop_mpv_child(&mut state);
    state.playback_status = MpvPlaybackStatus::Stopped;
    state.position_ms = 0;
    state.duration_ms = 0;
    state.tracks = Vec::new();
    state.message = "mpv 播放器已停止。".to_string();
    state.error = None;
    state.updated_at_ms = current_time_ms();
    Ok(create_mpv_status(&state))
}

#[tauri::command]
pub fn get_mpv_sidecar_status() -> Result<MpvSidecarStatus, String> {
    let mut state = mpv_sidecar_state()
        .lock()
        .map_err(|_| "mpv 播放器状态锁已损坏。".to_string())?;
    refresh_mpv_state(&mut state);
    Ok(create_mpv_status(&state))
}

#[tauri::command]
pub fn control_mpv_sidecar(request: MpvControlRequest) -> Result<MpvSidecarStatus, String> {
    let mut state = mpv_sidecar_state()
        .lock()
        .map_err(|_| "mpv 播放器状态锁已损坏。".to_string())?;
    refresh_mpv_state(&mut state);
    if state.child.is_none() {
        return Err("mpv 播放器尚未启动。请先在预览区加载本地视频。".to_string());
    }
    let ipc_path = state
        .ipc_path
        .clone()
        .ok_or_else(|| "mpv IPC 通道不可用，请重新启动 mpv 预览。".to_string())?;
    run_mpv_control_command(&ipc_path, &request)?;
    state.playback_status = match request.action.as_str() {
        "play" => MpvPlaybackStatus::Playing,
        "pause" => MpvPlaybackStatus::Paused,
        _ => state.playback_status.clone(),
    };
    if let Some(position_ms) = request.position_ms {
        state.position_ms = position_ms;
    }
    refresh_mpv_state(&mut state);
    state.error = None;
    state.message = "mpv 控制命令已发送。".to_string();
    state.updated_at_ms = current_time_ms();
    Ok(create_mpv_status(&state))
}

fn detect_media_tool_inner(
    request: MediaToolDetectionRequest,
) -> Result<MediaToolDetectionResult, String> {
    let tool = normalize_media_tool(&request.tool)?;
    let executable_path = resolve_tool_executable_path(tool, request.executable_path.as_deref());
    if tool == "mpv" && executable_path.trim().is_empty() {
        return Ok(MediaToolDetectionResult {
            tool: tool.to_string(),
            executable_path: String::new(),
            available: false,
            version: None,
            message: "尚未配置 mpv 路径。请先选择 mpv 可执行文件。".to_string(),
        });
    }
    let limits = media_tool_detection_limits();
    let primary = probe_media_tool_version(tool, Path::new(&executable_path), limits);
    let primary_version = match primary {
        Ok(version) => version,
        Err(failure) => {
            return Ok(unavailable_media_tool_result(
                tool,
                executable_path,
                tool_display_name(tool),
                failure,
            ));
        }
    };

    let display_name = tool_display_name(tool);
    let version = format_detected_versions(&[(display_name, primary_version.as_deref())]);
    let message = if primary_version.is_some() {
        format!("{display_name} 可运行。")
    } else {
        format!("{display_name} 可运行，版本未知。")
    };
    Ok(MediaToolDetectionResult {
        tool: tool.to_string(),
        executable_path,
        available: true,
        version,
        message,
    })
}

fn media_tool_detection_limits() -> SupervisedOutputLimits {
    SupervisedOutputLimits {
        execution_timeout: MEDIA_TOOL_DETECTION_TIMEOUT,
        output_drain_timeout: MEDIA_TOOL_DETECTION_OUTPUT_DRAIN_TIMEOUT,
        termination_timeout: MEDIA_TOOL_DETECTION_TERMINATION_TIMEOUT,
        poll_interval: MEDIA_TOOL_DETECTION_POLL_INTERVAL,
        stdout_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
        stderr_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
    }
}

fn probe_media_tool_version(
    tool: &str,
    executable_path: &Path,
    limits: SupervisedOutputLimits,
) -> Result<Option<String>, MediaToolDetectionFailure> {
    let mut command = SupervisedCommand::new(executable_path);
    command.arg(media_tool_version_argument(tool));
    run_media_tool_version_command(tool, &command, limits)
}

fn media_tool_version_argument(tool: &str) -> &'static str {
    if tool.eq_ignore_ascii_case("mpv") {
        "--version"
    } else {
        "-version"
    }
}

fn run_media_tool_version_command(
    tool: &str,
    command: &SupervisedCommand,
    limits: SupervisedOutputLimits,
) -> Result<Option<String>, MediaToolDetectionFailure> {
    let output = command
        .output(limits, || false)
        .map_err(|error| match error.kind() {
            SupervisedProcessErrorKind::Spawn => MediaToolDetectionFailure::Spawn,
            SupervisedProcessErrorKind::Timeout => MediaToolDetectionFailure::Timeout,
            SupervisedProcessErrorKind::Cancelled => MediaToolDetectionFailure::Wait,
            SupervisedProcessErrorKind::StdoutOverflow => MediaToolDetectionFailure::StdoutOverflow,
            SupervisedProcessErrorKind::StderrOverflow => MediaToolDetectionFailure::StderrOverflow,
            SupervisedProcessErrorKind::Reader => MediaToolDetectionFailure::Reader,
            SupervisedProcessErrorKind::Wait => MediaToolDetectionFailure::Wait,
            SupervisedProcessErrorKind::Cleanup => MediaToolDetectionFailure::Cleanup,
        })?;
    if !output.status.success() {
        return Err(MediaToolDetectionFailure::NonZeroExit);
    }
    Ok(parse_media_tool_semantic_version(
        tool,
        &output.stdout,
        &output.stderr,
    ))
}

fn parse_media_tool_semantic_version(tool: &str, stdout: &[u8], stderr: &[u8]) -> Option<String> {
    for bytes in [stdout, stderr] {
        for line in String::from_utf8_lossy(bytes).lines() {
            let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
            let Some(name) = fields.first() else {
                continue;
            };
            if !name.eq_ignore_ascii_case(tool) {
                continue;
            }
            let raw_version = if tool.eq_ignore_ascii_case("mpv") {
                fields.get(1).copied()
            } else if fields
                .get(1)
                .is_some_and(|marker| marker.eq_ignore_ascii_case("version"))
            {
                fields.get(2).copied()
            } else {
                None
            };
            let Some(raw_version) = raw_version else {
                continue;
            };
            if let Some(version) = normalize_numeric_semantic_version(raw_version) {
                return Some(version);
            }
        }
    }
    None
}

fn normalize_numeric_semantic_version(raw_version: &str) -> Option<String> {
    let raw_version = raw_version
        .strip_prefix('v')
        .or_else(|| raw_version.strip_prefix('V'))
        .unwrap_or(raw_version);
    let numeric_prefix = raw_version
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    if numeric_prefix.ends_with('.') {
        return None;
    }
    let suffix = raw_version.strip_prefix(&numeric_prefix)?;
    if !suffix.is_empty() && !suffix.starts_with(['-', '+']) {
        return None;
    }
    let components = numeric_prefix.split('.').collect::<Vec<_>>();
    if !(2..=3).contains(&components.len())
        || components.iter().any(|component| component.is_empty())
    {
        return None;
    }
    let mut parsed = components
        .iter()
        .map(|component| component.parse::<u32>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    while parsed.len() < 3 {
        parsed.push(0);
    }
    Some(format!("{}.{}.{}", parsed[0], parsed[1], parsed[2]))
}

fn format_detected_versions(versions: &[(&str, Option<&str>)]) -> Option<String> {
    let labels = versions
        .iter()
        .filter_map(|(name, version)| version.map(|version| format!("{name} {version}")))
        .collect::<Vec<_>>();
    (!labels.is_empty()).then(|| labels.join("；"))
}

fn unavailable_media_tool_result(
    requested_tool: &str,
    executable_path: String,
    failed_tool_name: &str,
    failure: MediaToolDetectionFailure,
) -> MediaToolDetectionResult {
    MediaToolDetectionResult {
        tool: requested_tool.to_string(),
        executable_path,
        available: false,
        version: None,
        message: format_media_tool_detection_failure(failed_tool_name, failure),
    }
}

fn format_media_tool_detection_failure(
    tool_name: &str,
    failure: MediaToolDetectionFailure,
) -> String {
    match failure {
        MediaToolDetectionFailure::Spawn => {
            format!("{tool_name} 无法在受监督进程中启动，请检查工具配置。")
        }
        MediaToolDetectionFailure::Timeout => {
            format!("blocked:tool-timeout：{tool_name} 版本检测超过 10 秒，已终止其进程树。")
        }
        MediaToolDetectionFailure::StdoutOverflow => {
            format!("blocked:resource-limit：{tool_name} 版本检测标准输出超过 64 KiB 硬上限。")
        }
        MediaToolDetectionFailure::StderrOverflow => {
            format!("blocked:resource-limit：{tool_name} 版本检测错误输出超过 64 KiB 硬上限。")
        }
        MediaToolDetectionFailure::Reader => {
            format!("{tool_name} 版本检测的有界输出读取失败。")
        }
        MediaToolDetectionFailure::Wait => {
            format!("{tool_name} 版本检测的受监督进程状态读取失败。")
        }
        MediaToolDetectionFailure::Cleanup => {
            format!("blocked:cleanup-failed：{tool_name} 版本检测的进程树未完成有界清理。")
        }
        MediaToolDetectionFailure::NonZeroExit => {
            format!("{tool_name} 无法运行；为保护本地路径与访问凭据，未回显工具错误输出。")
        }
    }
}

fn start_mpv_sidecar_inner(request: MpvStartRequest) -> Result<MpvSidecarStatus, String> {
    let mpv_path = request.mpv_path.trim();
    if mpv_path.is_empty() {
        return Err("尚未配置 mpv 路径。请在设置中心选择 mpv 可执行文件。".to_string());
    }
    let media_path = request.media_path.trim();
    validate_mpv_media_path(media_path)?;

    let ipc_path = create_mpv_ipc_path();
    let start_position_ms = request.start_position_ms.unwrap_or(0);
    let start_paused = request.start_paused.unwrap_or(true);
    let mut command = Command::new(mpv_path);
    command
        .arg("--idle=yes")
        .arg("--force-window=yes")
        .arg("--input-terminal=no")
        .arg("--keep-open=yes")
        .arg("--no-terminal")
        .arg(format!("--input-ipc-server={ipc_path}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if start_paused {
        command.arg("--pause");
    }
    if start_position_ms > 0 {
        command.arg(format!("--start={:.3}", start_position_ms as f64 / 1000.0));
    }
    command.arg("--").arg(media_path);
    let child = command
        .spawn()
        .map_err(|error| format!("mpv 启动失败：{error}。请检查 mpv 路径和视频文件是否可访问。"))?;

    let mut state = mpv_sidecar_state()
        .lock()
        .map_err(|_| "mpv 播放器状态锁已损坏。".to_string())?;
    stop_mpv_child(&mut state);
    state.child = Some(child);
    state.ipc_path = Some(ipc_path);
    state.media_path = Some(redact_sensitive_media_text(media_path));
    state.playback_status = if start_paused {
        MpvPlaybackStatus::Paused
    } else {
        MpvPlaybackStatus::Playing
    };
    state.position_ms = start_position_ms;
    state.duration_ms = 0;
    state.tracks = Vec::new();
    state.message = "mpv 播放器已启动。".to_string();
    state.error = None;
    state.updated_at_ms = current_time_ms();
    Ok(create_mpv_status(&state))
}

fn run_mpv_control_command(ipc_path: &str, request: &MpvControlRequest) -> Result<(), String> {
    let command = match request.action.as_str() {
        "play" => json!({ "command": ["set_property", "pause", false] }),
        "pause" => json!({ "command": ["set_property", "pause", true] }),
        "seek" => {
            let position_ms = request
                .position_ms
                .ok_or_else(|| "mpv seek 需要目标时间。".to_string())?;
            json!({ "command": ["seek", position_ms as f64 / 1000.0, "absolute", "exact"] })
        }
        "setPlaybackRate" => {
            let playback_rate = request
                .playback_rate
                .filter(|rate| rate.is_finite() && *rate > 0.0)
                .ok_or_else(|| "mpv 播放速度必须是大于 0 的数字。".to_string())?;
            json!({ "command": ["set_property", "speed", playback_rate] })
        }
        _ => return Err(format!("未知 mpv 控制动作：{}", request.action)),
    };
    ensure_mpv_success(send_mpv_ipc_command(ipc_path, command)?)
}

fn refresh_mpv_state(state: &mut MpvSidecarState) {
    let wait_result = match state.child.as_mut() {
        Some(child) => child.try_wait(),
        None => return,
    };
    match wait_result {
        Ok(Some(status)) => {
            let stderr = state
                .child
                .as_mut()
                .and_then(read_child_stderr)
                .filter(|value| !value.trim().is_empty());
            state.child = None;
            state.ipc_path = None;
            state.playback_status = if status.success() {
                MpvPlaybackStatus::Stopped
            } else {
                MpvPlaybackStatus::Failed
            };
            state.tracks = Vec::new();
            state.message = "mpv 播放器已退出。".to_string();
            state.error = stderr;
            state.updated_at_ms = current_time_ms();
        }
        Ok(None) => {
            if let Some(ipc_path) = state.ipc_path.clone() {
                if let Ok(position_ms) = read_mpv_number_property_ms(&ipc_path, "time-pos") {
                    state.position_ms = position_ms;
                }
                if let Ok(duration_ms) = read_mpv_number_property_ms(&ipc_path, "duration") {
                    state.duration_ms = duration_ms;
                }
                if let Ok(tracks) = read_mpv_tracks(&ipc_path) {
                    state.tracks = tracks;
                }
                state.updated_at_ms = current_time_ms();
            }
        }
        Err(error) => {
            state.error = Some(format!("读取 mpv 状态失败：{error}"));
            state.message = "mpv 状态不可用。".to_string();
            state.updated_at_ms = current_time_ms();
        }
    }
}

fn read_mpv_number_property_ms(ipc_path: &str, property: &str) -> Result<u64, String> {
    let response =
        send_mpv_ipc_command(ipc_path, json!({ "command": ["get_property", property] }))?;
    ensure_mpv_success(response.clone())?;
    let seconds = response
        .get("data")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| format!("mpv 未返回可用的 {property}。"))?;
    Ok((seconds * 1000.0).round() as u64)
}

fn read_mpv_tracks(ipc_path: &str) -> Result<Vec<MpvTrackSummary>, String> {
    let response = send_mpv_ipc_command(
        ipc_path,
        json!({ "command": ["get_property", "track-list"] }),
    )?;
    ensure_mpv_success(response.clone())?;
    let tracks = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "mpv 未返回可用的 track-list。".to_string())?;
    Ok(parse_mpv_track_list(tracks))
}

fn parse_mpv_track_list(tracks: &[Value]) -> Vec<MpvTrackSummary> {
    tracks
        .iter()
        .filter_map(|track| {
            let track_type = normalize_mpv_track_type(track.get("type").and_then(Value::as_str));
            if track_type == "unknown" {
                return None;
            }
            Some(MpvTrackSummary {
                id: track.get("id").and_then(Value::as_i64).unwrap_or(0),
                track_type,
                title: read_mpv_optional_string(track, "title"),
                language: read_mpv_optional_string(track, "lang"),
                codec: read_mpv_optional_string(track, "codec"),
                selected: track
                    .get("selected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                external: track
                    .get("external")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn normalize_mpv_track_type(track_type: Option<&str>) -> String {
    match track_type
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "video" => "video".to_string(),
        "audio" => "audio".to_string(),
        "sub" | "subtitle" => "subtitle".to_string(),
        _ => "unknown".to_string(),
    }
}

fn read_mpv_optional_string(track: &Value, key: &str) -> Option<String> {
    track
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn ensure_mpv_success(response: Value) -> Result<(), String> {
    let error = response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if error == "success" {
        Ok(())
    } else {
        Err(format!("mpv 返回错误：{error}"))
    }
}

#[cfg(windows)]
fn send_mpv_ipc_command(ipc_path: &str, command: Value) -> Result<Value, String> {
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(ipc_path)
        .map_err(|error| format!("mpv IPC 连接失败：{error}"))?;
    let reader_pipe = pipe
        .try_clone()
        .map_err(|error| format!("mpv IPC 读取通道创建失败：{error}"))?;
    write_mpv_command(&mut pipe, command)?;
    read_mpv_response(BufReader::new(reader_pipe))
}

#[cfg(unix)]
fn send_mpv_ipc_command(ipc_path: &str, command: Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    let mut stream =
        UnixStream::connect(ipc_path).map_err(|error| format!("mpv IPC 连接失败：{error}"))?;
    let reader_stream = stream
        .try_clone()
        .map_err(|error| format!("mpv IPC 读取通道创建失败：{error}"))?;
    write_mpv_command(&mut stream, command)?;
    read_mpv_response(BufReader::new(reader_stream))
}

fn write_mpv_command<W: Write>(writer: &mut W, command: Value) -> Result<(), String> {
    let line = serde_json::to_string(&command)
        .map_err(|error| format!("mpv IPC 命令序列化失败：{error}"))?;
    writer
        .write_all(line.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("mpv IPC 命令发送失败：{error}"))
}

fn read_mpv_response<R: BufRead>(mut reader: R) -> Result<Value, String> {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("mpv IPC 响应读取失败：{error}"))?;
    if line.trim().is_empty() {
        return Err("mpv IPC 没有返回响应。".to_string());
    }
    serde_json::from_str(&line).map_err(|error| format!("mpv IPC 响应不是有效 JSON：{error}"))
}

fn mpv_sidecar_state() -> &'static Mutex<MpvSidecarState> {
    MPV_SIDECAR.get_or_init(|| {
        Mutex::new(MpvSidecarState {
            child: None,
            ipc_path: None,
            media_path: None,
            playback_status: MpvPlaybackStatus::Idle,
            position_ms: 0,
            duration_ms: 0,
            tracks: Vec::new(),
            message: "mpv 播放器尚未启动。".to_string(),
            error: None,
            updated_at_ms: current_time_ms(),
        })
    })
}

fn stop_mpv_child(state: &mut MpvSidecarState) {
    if let Some(mut child) = state.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.ipc_path = None;
    state.media_path = None;
}

fn read_child_stderr(child: &mut Child) -> Option<String> {
    let mut stderr = child.stderr.take()?;
    let mut text = String::new();
    stderr.read_to_string(&mut text).ok()?;
    Some(truncate_text(
        &redact_sensitive_media_text(text.trim()),
        600,
    ))
}

fn validate_mpv_media_path(media_path: &str) -> Result<(), String> {
    if media_path.is_empty() {
        return Err(
            "mpv 播放需要真实本地视频路径，或本次会话生成的 Emby 授权播放地址。".to_string(),
        );
    }
    if is_remote_media_url(media_path) {
        return Ok(());
    }
    if !Path::new(media_path).is_file() {
        return Err(format!(
            "mpv 无法读取本地视频文件：{}",
            redact_sensitive_media_text(media_path)
        ));
    }
    Ok(())
}

fn is_remote_media_url(media_path: &str) -> bool {
    let normalized = media_path.trim().to_ascii_lowercase();
    normalized.starts_with("http://") || normalized.starts_with("https://")
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
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(key) {
        let (prefix, tail) = rest.split_at(index);
        result.push_str(prefix);
        result.push_str(key);
        result.push_str("<已隐藏>");
        let value_start = key.len();
        let value_tail = &tail[value_start..];
        let value_end = value_tail
            .find(['&', ' ', '\n', '\r', '\t'])
            .unwrap_or(value_tail.len());
        rest = &value_tail[value_end..];
    }
    result.push_str(rest);
    result
}

fn create_mpv_status(state: &MpvSidecarState) -> MpvSidecarStatus {
    MpvSidecarStatus {
        running: state.child.is_some(),
        backend: "native-mpv",
        playback_status: state.playback_status.clone(),
        media_path: state.media_path.clone(),
        position_ms: state.position_ms,
        duration_ms: state.duration_ms,
        tracks: state.tracks.clone(),
        message: state.message.clone(),
        error: state.error.clone(),
        updated_at_ms: state.updated_at_ms,
    }
}

fn normalize_media_tool(tool: &str) -> Result<&'static str, String> {
    match tool.trim().to_ascii_lowercase().as_str() {
        "ffmpeg" => Ok("ffmpeg"),
        "mpv" => Ok("mpv"),
        _ => Err(format!("未知媒体工具：{tool}")),
    }
}

fn resolve_tool_executable_path(tool: &str, executable_path: Option<&str>) -> String {
    let trimmed = executable_path.unwrap_or("").trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if tool == "ffmpeg" {
        return "ffmpeg".to_string();
    }
    String::new()
}

fn tool_display_name(tool: &str) -> &'static str {
    match tool {
        "ffmpeg" => "FFmpeg",
        "mpv" => "mpv",
        _ => "媒体工具",
    }
}

#[cfg(windows)]
fn create_mpv_ipc_path() -> String {
    format!(
        r"\\.\pipe\danmaku_timeline_studio_mpv_{}_{}",
        std::process::id(),
        current_time_ms()
    )
}

#[cfg(unix)]
fn create_mpv_ipc_path() -> String {
    format!(
        "/tmp/danmaku_timeline_studio_mpv_{}_{}.sock",
        std::process::id(),
        current_time_ms()
    )
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    let mut truncated: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        truncated.push_str("...");
    }
    truncated
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_mpv_path_reports_unconfigured() {
        let result = detect_media_tool_inner(MediaToolDetectionRequest {
            tool: "mpv".to_string(),
            executable_path: None,
        })
        .unwrap();

        assert!(!result.available);
        assert_eq!(result.executable_path, "");
        assert!(result.message.contains("尚未配置 mpv 路径"));
    }

    #[test]
    fn ffmpeg_uses_path_when_blank() {
        assert_eq!(resolve_tool_executable_path("ffmpeg", None), "ffmpeg");
        assert_eq!(
            resolve_tool_executable_path("mpv", Some(" C:\\tools\\mpv.exe ")),
            "C:\\tools\\mpv.exe"
        );
    }

    #[test]
    fn unknown_tool_is_rejected() {
        assert!(normalize_media_tool("vlc").is_err());
    }

    #[test]
    fn detection_contract_uses_ten_second_and_64_kib_hard_limits() {
        let limits = media_tool_detection_limits();

        assert_eq!(limits.execution_timeout, Duration::from_secs(10));
        assert_eq!(limits.stdout_hard_limit, 64 * 1024);
        assert_eq!(limits.stderr_hard_limit, 64 * 1024);
    }

    #[test]
    fn detection_uses_each_tools_supported_version_switch() {
        assert_eq!(media_tool_version_argument("ffmpeg"), "-version");
        assert_eq!(media_tool_version_argument("ffprobe"), "-version");
        assert_eq!(media_tool_version_argument("mpv"), "--version");
    }

    #[test]
    fn media_tool_versions_are_reduced_to_tool_name_and_numeric_semver() {
        let ffmpeg = parse_media_tool_semantic_version(
            "ffmpeg",
            br#"ffmpeg version 7.1.1-full_build-www.example.test Copyright secret C:\Users\alice"#,
            b"",
        );
        let mpv = parse_media_tool_semantic_version(
            "mpv",
            b"unrelated banner\nmpv v0.40.0-dirty Copyright private-builder",
            b"",
        );

        assert_eq!(ffmpeg.as_deref(), Some("7.1.1"));
        assert_eq!(mpv.as_deref(), Some("0.40.0"));
        let ffmpeg_label = format_detected_versions(&[("FFmpeg", ffmpeg.as_deref())]).unwrap();
        let mpv_label = format_detected_versions(&[("mpv", mpv.as_deref())]).unwrap();
        assert_eq!(ffmpeg_label, "FFmpeg 7.1.1");
        assert_eq!(mpv_label, "mpv 0.40.0");
        assert!(!ffmpeg_label.contains("alice"));
        assert!(!mpv_label.contains("private-builder"));
    }

    #[test]
    fn successful_unknown_version_uses_the_existing_generic_contract() {
        assert_eq!(
            parse_media_tool_semantic_version(
                "ffmpeg",
                br#"wrapper ready at C:\Users\alice\private\ffmpeg.exe?token=secret"#,
                b"",
            ),
            None
        );
        assert_eq!(
            parse_media_tool_semantic_version("ffmpeg", b"ffmpeg version 7.1.private-path", b"",),
            None
        );
        assert_eq!(
            parse_media_tool_semantic_version("mpv", b"mpv v0.40secret", b""),
            None
        );
        assert_eq!(format_detected_versions(&[("FFmpeg", None)]), None);
    }

    #[test]
    fn mpv_start_requires_existing_media_file() {
        let error = start_mpv_sidecar_inner(MpvStartRequest {
            mpv_path: "mpv".to_string(),
            media_path: "Z:\\missing\\video.mkv".to_string(),
            start_position_ms: None,
            start_paused: None,
        })
        .unwrap_err();

        assert!(error.contains("无法读取本地视频文件"));
    }

    #[test]
    fn mpv_accepts_remote_authorized_media_url() {
        assert!(validate_mpv_media_path(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&MediaSourceId=source-1"
        )
        .is_ok());
    }

    #[test]
    fn mpv_status_and_errors_redact_emby_tokens() {
        let redacted = redact_sensitive_media_text(
            "https://emby.example.test/Videos/item/stream?api_key=secret-token&token=other failed",
        );

        assert_eq!(
            redacted,
            "https://emby.example.test/Videos/item/stream?api_key=<已隐藏>&token=<已隐藏> failed"
        );
    }

    #[test]
    fn mpv_control_requires_running_process() {
        let _ = stop_mpv_sidecar();
        let error = control_mpv_sidecar(MpvControlRequest {
            action: "play".to_string(),
            position_ms: None,
            playback_rate: None,
        })
        .unwrap_err();

        assert!(error.contains("尚未启动"));
    }

    #[test]
    fn mpv_success_response_accepts_only_success_error_field() {
        assert!(ensure_mpv_success(json!({ "error": "success" })).is_ok());
        assert!(ensure_mpv_success(json!({ "error": "property unavailable" })).is_err());
    }

    #[test]
    fn mpv_track_list_is_summarized_for_player_session() {
        let tracks = parse_mpv_track_list(&[
            json!({
                "id": 1,
                "type": "audio",
                "title": "日语 2.0",
                "lang": "jpn",
                "codec": "aac",
                "selected": true,
                "external": false
            }),
            json!({
                "id": 2,
                "type": "sub",
                "title": "简体中文",
                "lang": "chi",
                "codec": "ass",
                "selected": true,
                "external": true
            }),
            json!({ "id": 3, "type": "unknown" }),
        ]);

        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].track_type, "audio");
        assert_eq!(tracks[0].title.as_deref(), Some("日语 2.0"));
        assert!(tracks[1].external);
        assert_eq!(tracks[1].track_type, "subtitle");
    }

    #[cfg(windows)]
    fn supervised_detection_helper_command(test_name: &str) -> SupervisedCommand {
        let mut command = SupervisedCommand::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", test_name, "--nocapture"]);
        command
    }

    #[cfg(windows)]
    fn supervised_detection_test_limits(timeout: Duration) -> SupervisedOutputLimits {
        SupervisedOutputLimits {
            execution_timeout: timeout,
            output_drain_timeout: Duration::from_millis(200),
            termination_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(5),
            stdout_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
            stderr_hard_limit: MEDIA_TOOL_DETECTION_OUTPUT_LIMIT_BYTES,
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection timeout wrapper helper"]
    #[allow(clippy::zombie_processes)]
    fn supervised_detection_timeout_wrapper_helper() {
        use std::io::Write as _;

        let descendant = Command::new("ping.exe")
            .args(["-t", "127.0.0.1"])
            .spawn()
            .unwrap();
        writeln!(std::io::stdout(), "descendant={}", descendant.id()).unwrap();
        std::io::stdout().flush().unwrap();
        std::mem::forget(descendant);
        std::thread::sleep(Duration::from_secs(30));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection stdout overflow wrapper helper"]
    fn supervised_detection_stdout_overflow_wrapper_helper() {
        use std::io::Write as _;

        let mut stdout = std::io::stdout();
        for _ in 0..20 {
            stdout.write_all(&[b'x'; 4 * 1024]).unwrap();
        }
        stdout.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection stderr overflow wrapper helper"]
    fn supervised_detection_stderr_overflow_wrapper_helper() {
        use std::io::Write as _;

        let mut stderr = std::io::stderr();
        for _ in 0..20 {
            stderr.write_all(&[b'e'; 4 * 1024]).unwrap();
        }
        stderr.flush().unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "media-tool detection sensitive nonzero wrapper helper"]
    fn supervised_detection_sensitive_nonzero_wrapper_helper() {
        use std::io::Write as _;

        let secret = br#"C:\Users\alice\private\ffmpeg.exe?api_key=secret-token&token=other"#;
        std::io::stdout().write_all(secret).unwrap();
        std::io::stderr().write_all(secret).unwrap();
        std::io::stdout().flush().unwrap();
        std::io::stderr().flush().unwrap();
        std::process::exit(23);
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_timeout_is_bounded_and_reports_no_raw_output() {
        let command = supervised_detection_helper_command(
            "media_tools::tests::supervised_detection_timeout_wrapper_helper",
        );
        let started = std::time::Instant::now();
        let failure = run_media_tool_version_command(
            "ffmpeg",
            &command,
            supervised_detection_test_limits(Duration::from_millis(150)),
        )
        .unwrap_err();
        let message = format_media_tool_detection_failure("FFmpeg", failure);

        assert_eq!(failure, MediaToolDetectionFailure::Timeout);
        assert!(message.starts_with("blocked:tool-timeout"));
        assert!(!message.contains("descendant="));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_stdout_and_stderr_overflow_are_hard_bounded() {
        for (test_name, expected_failure) in [
            (
                "media_tools::tests::supervised_detection_stdout_overflow_wrapper_helper",
                MediaToolDetectionFailure::StdoutOverflow,
            ),
            (
                "media_tools::tests::supervised_detection_stderr_overflow_wrapper_helper",
                MediaToolDetectionFailure::StderrOverflow,
            ),
        ] {
            let command = supervised_detection_helper_command(test_name);
            let started = std::time::Instant::now();
            let failure = run_media_tool_version_command(
                "ffmpeg",
                &command,
                supervised_detection_test_limits(Duration::from_secs(3)),
            )
            .unwrap_err();

            assert_eq!(failure, expected_failure);
            assert!(format_media_tool_detection_failure("FFmpeg", failure)
                .starts_with("blocked:resource-limit"));
            assert!(started.elapsed() < Duration::from_secs(4));
        }
    }

    #[cfg(windows)]
    #[test]
    fn malicious_wrapper_nonzero_never_echoes_paths_or_secrets() {
        let command = supervised_detection_helper_command(
            "media_tools::tests::supervised_detection_sensitive_nonzero_wrapper_helper",
        );
        let failure = run_media_tool_version_command(
            "ffmpeg",
            &command,
            supervised_detection_test_limits(Duration::from_secs(3)),
        )
        .unwrap_err();
        let message = format_media_tool_detection_failure("FFmpeg", failure);

        assert_eq!(failure, MediaToolDetectionFailure::NonZeroExit);
        for secret in ["alice", "ffmpeg.exe", "secret-token", "token=other"] {
            assert!(!message.contains(secret));
        }
    }
}
