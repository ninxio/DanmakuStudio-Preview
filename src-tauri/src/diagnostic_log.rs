use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

const ALIGNMENT_DIAGNOSTIC_DIRECTORY: &str = "alignment-diagnostics";
const ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION: u8 = 1;
const MAX_ALIGNMENT_DIAGNOSTIC_FILES: usize = 32;
const MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ALIGNMENT_DIAGNOSTIC_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct AlignmentDiagnosticLogWriter {
    run_id: String,
    written_bytes: u64,
    writer: BufWriter<File>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentDiagnosticHeader<'a> {
    schema_version: u8,
    record_type: &'static str,
    run_id: &'a str,
    created_at_ms: u64,
    app_version: &'static str,
    privacy_mode: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentDiagnosticEventRecord<'a, T> {
    schema_version: u8,
    record_type: &'static str,
    run_id: &'a str,
    event: &'a T,
}

pub(crate) fn alignment_diagnostic_log_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(ALIGNMENT_DIAGNOSTIC_DIRECTORY))
        .map_err(|_| "无法定位桌面对齐诊断日志目录。".to_string())
}

pub(crate) fn create_alignment_diagnostic_log(
    root: &Path,
    run_id: &str,
    created_at_ms: u64,
) -> Result<AlignmentDiagnosticLogWriter, String> {
    validate_run_id(run_id)?;
    fs::create_dir_all(root).map_err(|_| "无法创建桌面对齐诊断日志目录。".to_string())?;
    rotate_alignment_diagnostic_logs(root)?;
    let path = root.join(format!("{run_id}.jsonl"));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建本次对齐诊断日志。".to_string())?;
    let mut log = AlignmentDiagnosticLogWriter {
        run_id: run_id.to_string(),
        written_bytes: 0,
        writer: BufWriter::new(file),
    };
    log.write_record(&AlignmentDiagnosticHeader {
        schema_version: ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION,
        record_type: "runHeader",
        run_id,
        created_at_ms,
        app_version: env!("CARGO_PKG_VERSION"),
        privacy_mode: "path-free-content-free-v1",
    })?;
    Ok(log)
}

impl AlignmentDiagnosticLogWriter {
    pub(crate) fn append_event<T: Serialize>(&mut self, event: &T) -> Result<(), String> {
        let run_id = self.run_id.clone();
        self.write_record(&AlignmentDiagnosticEventRecord {
            schema_version: ALIGNMENT_DIAGNOSTIC_SCHEMA_VERSION,
            record_type: "diagnosticEvent",
            run_id: &run_id,
            event,
        })
    }

    fn write_record<T: Serialize>(&mut self, record: &T) -> Result<(), String> {
        let mut encoded =
            serde_json::to_vec(record).map_err(|_| "无法序列化对齐诊断事件。".to_string())?;
        encoded.push(b'\n');
        let encoded_bytes =
            u64::try_from(encoded.len()).map_err(|_| "对齐诊断事件长度无效。".to_string())?;
        let next_bytes = self
            .written_bytes
            .checked_add(encoded_bytes)
            .ok_or_else(|| "对齐诊断日志大小溢出。".to_string())?;
        if next_bytes > MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES {
            return Err("本次对齐诊断日志已达到大小上限。".to_string());
        }
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.flush())
            .map_err(|_| "写入对齐诊断日志失败。".to_string())?;
        self.written_bytes = next_bytes;
        Ok(())
    }
}

#[tauri::command]
pub fn open_alignment_diagnostic_log_directory(app: AppHandle) -> Result<(), String> {
    let root = alignment_diagnostic_log_root(&app)?;
    fs::create_dir_all(&root).map_err(|_| "无法创建桌面对齐诊断日志目录。".to_string())?;
    open_directory(&root)
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > 96
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("对齐诊断运行编号无效。".to_string());
    }
    Ok(())
}

fn rotate_alignment_diagnostic_logs(root: &Path) -> Result<(), String> {
    let mut files = fs::read_dir(root)
        .map_err(|_| "无法读取桌面对齐诊断日志目录。".to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file()
                || !entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                entry.path(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let mut total_bytes = files
        .iter()
        .fold(0_u64, |total, (_, _, bytes)| total.saturating_add(*bytes));
    while files.len() >= MAX_ALIGNMENT_DIAGNOSTIC_FILES
        || total_bytes.saturating_add(MAX_ALIGNMENT_DIAGNOSTIC_FILE_BYTES)
            > MAX_ALIGNMENT_DIAGNOSTIC_TOTAL_BYTES
    {
        let (path, _, bytes) = files.remove(0);
        fs::remove_file(path).map_err(|_| "无法轮转旧的桌面对齐诊断日志。".to_string())?;
        total_bytes = total_bytes.saturating_sub(bytes);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(target_os = "macos")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|_| "打开桌面对齐诊断日志目录失败。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_directory(label: &str) -> PathBuf {
        let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "danmaku-timeline-diagnostic-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn writes_path_free_jsonl_header_and_events() {
        let root = test_directory("write");
        let run_id = "audio-align-batch-123-456-1";
        let mut writer = create_alignment_diagnostic_log(&root, run_id, 123).expect("create log");
        writer
            .append_event(&json!({
                "sequence": 1,
                "stageKey": "batch.queued",
                "message": "批量匹配已进入原生任务队列。"
            }))
            .expect("append event");
        drop(writer);

        let content = fs::read_to_string(root.join(format!("{run_id}.jsonl"))).expect("read log");
        let lines = content.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains(r#""privacyMode":"path-free-content-free-v1""#));
        assert!(lines[1].contains(r#""recordType":"diagnosticEvent""#));
        assert!(!content.contains(std::env::temp_dir().to_string_lossy().as_ref()));

        fs::remove_dir_all(root).expect("cleanup log root");
    }

    #[test]
    fn rejects_run_ids_that_could_escape_the_log_directory() {
        let root = test_directory("invalid");
        assert!(create_alignment_diagnostic_log(&root, "../private", 0).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn rotates_old_jsonl_files_before_starting_a_new_run() {
        let root = test_directory("rotate");
        fs::create_dir_all(&root).expect("create root");
        for index in 0..MAX_ALIGNMENT_DIAGNOSTIC_FILES {
            fs::write(root.join(format!("old-{index:02}.jsonl")), b"{}\n").expect("write old log");
        }
        fs::write(root.join("keep.txt"), b"not a diagnostic log").expect("write unrelated");

        let writer =
            create_alignment_diagnostic_log(&root, "audio-align-batch-new", 0).expect("new log");
        drop(writer);
        let jsonl_count = fs::read_dir(&root)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "jsonl")
            })
            .count();
        assert!(jsonl_count <= MAX_ALIGNMENT_DIAGNOSTIC_FILES);
        assert!(root.join("keep.txt").exists());

        fs::remove_dir_all(root).expect("cleanup log root");
    }
}
