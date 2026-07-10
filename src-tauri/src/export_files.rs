use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Deserialize)]
pub struct SaveExportFileRequest {
    directory_path: String,
    file_name: String,
    content_bytes: Vec<u8>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SaveExportFileResult {
    file_name: String,
    file_path: String,
    directory_path: String,
    was_renamed: bool,
}

#[tauri::command]
pub fn save_export_file(request: SaveExportFileRequest) -> Result<SaveExportFileResult, String> {
    let directory = validate_export_directory(&request.directory_path)?;
    let file_name = validate_export_file_name(&request.file_name)?;
    let target = resolve_available_export_path(&directory, &file_name)?;
    fs::write(&target, &request.content_bytes)
        .map_err(|error| format_export_write_error(&directory, &target, error))?;
    Ok(SaveExportFileResult {
        file_name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&file_name)
            .to_string(),
        file_path: target.to_string_lossy().to_string(),
        directory_path: directory.to_string_lossy().to_string(),
        was_renamed: target.file_name() != Some(std::ffi::OsStr::new(&file_name)),
    })
}

#[tauri::command]
pub fn open_export_directory(directory_path: String) -> Result<(), String> {
    let directory = validate_export_directory(&directory_path)?;
    open_directory(&directory)
}

fn validate_export_directory(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请选择导出文件夹。".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("导出文件夹需要是完整路径。".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "导出文件夹不存在，请重新选择。".to_string(),
        ErrorKind::PermissionDenied => "没有权限访问导出文件夹，请换一个目录。".to_string(),
        _ => format!("无法读取导出文件夹：{error}"),
    })?;
    if !metadata.is_dir() {
        return Err("导出位置不是文件夹，请重新选择。".to_string());
    }
    Ok(path)
}

fn validate_export_file_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("导出文件名无效。".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("导出文件名不能包含路径分隔符。".to_string());
    }
    Ok(trimmed.to_string())
}

fn resolve_available_export_path(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    let original = directory.join(file_name);
    if !original.exists() {
        return Ok(original);
    }
    let (base, extension) = split_file_name(file_name);
    for duplicate_number in 2..=9999 {
        let candidate = directory.join(format!("{base} ({duplicate_number}){extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("导出文件夹里已有太多同名文件，请更换文件名或清理目录。".to_string())
}

fn split_file_name(file_name: &str) -> (String, String) {
    match file_name.rsplit_once('.') {
        Some((base, extension)) if !base.is_empty() => (base.to_string(), format!(".{extension}")),
        _ => (file_name.to_string(), String::new()),
    }
}

fn format_export_write_error(directory: &Path, target: &Path, error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::PermissionDenied => format!(
            "没有权限写入导出文件夹：{}。请换一个目录或检查文件权限。",
            directory.to_string_lossy()
        ),
        ErrorKind::AlreadyExists => format!("导出文件已存在且无法自动改名：{}。", target.to_string_lossy()),
        _ => format!("写入导出文件失败：{error}"),
    }
}

#[cfg(target_os = "windows")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_file_names_with_path_segments() {
        assert!(validate_export_file_name("episode.xml").is_ok());
        assert!(validate_export_file_name("nested/episode.xml").is_err());
        assert!(validate_export_file_name("nested\\episode.xml").is_err());
        assert!(validate_export_file_name(" ").is_err());
    }

    #[test]
    fn splits_names_without_losing_extension() {
        assert_eq!(split_file_name("episode.xml"), ("episode".to_string(), ".xml".to_string()));
        assert_eq!(split_file_name("archive"), ("archive".to_string(), "".to_string()));
    }

    #[test]
    fn resolves_duplicate_file_names() {
        let unique = tempfile_like_path("danmaku-export-unique");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        fs::write(unique.join("episode.xml"), "old").unwrap();

        let resolved = resolve_available_export_path(&unique, "episode.xml").unwrap();

        assert_eq!(resolved.file_name().and_then(|value| value.to_str()), Some("episode (2).xml"));
        fs::remove_dir_all(unique).unwrap();
    }

    fn tempfile_like_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", std::process::id()))
    }
}
