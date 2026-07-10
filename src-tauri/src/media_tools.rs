use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

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
    let output = Command::new(&executable_path).arg("--version").output();
    match output {
        Ok(output) if output.status.success() => {
            let version = first_output_line(&output.stdout, &output.stderr);
            Ok(MediaToolDetectionResult {
                tool: tool.to_string(),
                executable_path,
                available: true,
                version: version.clone(),
                message: version.unwrap_or_else(|| format!("{} 可运行。", tool_display_name(tool))),
            })
        }
        Ok(output) => {
            let detail = first_output_line(&output.stderr, &output.stdout)
                .unwrap_or_else(|| "进程退出但没有返回可读错误。".to_string());
            Ok(MediaToolDetectionResult {
                tool: tool.to_string(),
                executable_path,
                available: false,
                version: None,
                message: format!("{} 无法运行：{detail}", tool_display_name(tool)),
            })
        }
        Err(error) => Ok(MediaToolDetectionResult {
            tool: tool.to_string(),
            executable_path,
            available: false,
            version: None,
            message: format!(
                "{} 启动失败：{}。请检查路径是否指向可执行文件。",
                tool_display_name(tool),
                error
            ),
        }),
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
    let response = send_mpv_ipc_command(ipc_path, json!({ "command": ["get_property", "track-list"] }))?;
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
    match track_type.unwrap_or("").trim().to_ascii_lowercase().as_str() {
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
    Some(truncate_text(&redact_sensitive_media_text(text.trim()), 600))
}

fn validate_mpv_media_path(media_path: &str) -> Result<(), String> {
    if media_path.is_empty() {
        return Err("mpv 播放需要真实本地视频路径，或本次会话生成的 Emby 授权播放地址。".to_string());
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
            .find(|character| matches!(character, '&' | ' ' | '\n' | '\r' | '\t'))
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

fn first_output_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    let text = if stdout.is_empty() { stderr } else { stdout };
    String::from_utf8_lossy(text)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| truncate_text(line, 160))
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
}
