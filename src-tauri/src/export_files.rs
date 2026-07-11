use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::Command,
};

use crate::media_probe::{probe_media_content_identity, MediaContentIdentity};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveExportFileRequest {
    directory_path: String,
    file_name: String,
    content_bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVerifiedExportFileRequest {
    directory_path: String,
    file_name: String,
    content_bytes: Vec<u8>,
    verification: VerifiedExportVerification,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportVerification {
    project_id: String,
    project_updated_at: String,
    snapshot_digest: String,
    dependencies: Vec<VerifiedMediaDependency>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedMediaDependency {
    media_id: String,
    path: String,
    expected_identity: ExpectedMediaContentIdentity,
    #[serde(default)]
    map_ids: Vec<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExpectedMediaContentIdentity {
    algorithm: String,
    size_bytes: u64,
    modified_unix_ms: u64,
    first_sample_digest: String,
    middle_sample_digest: String,
    last_sample_digest: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    write_export_file(&directory, &file_name, &request.content_bytes)
}

/// Saves a time-map-derived export only after re-reading every dependent media identity.
///
/// Keeping verification and the write in one backend command closes the UI/preflight gap: a
/// browser fallback or an unavailable verification bridge can never silently become approval.
#[tauri::command]
pub fn save_verified_export_file(
    request: SaveVerifiedExportFileRequest,
) -> Result<SaveExportFileResult, String> {
    let directory = validate_export_directory(&request.directory_path)?;
    let file_name = validate_export_file_name(&request.file_name)?;
    verify_export_dependencies(&request.verification)?;
    write_export_file(&directory, &file_name, &request.content_bytes)
}

fn write_export_file(
    directory: &Path,
    requested_file_name: &str,
    content_bytes: &[u8],
) -> Result<SaveExportFileResult, String> {
    let (base, extension) = split_file_name(requested_file_name);
    for duplicate_number in 1..=9999 {
        let candidate_name = if duplicate_number == 1 {
            requested_file_name.to_string()
        } else {
            format!("{base} ({duplicate_number}){extension}")
        };
        let target = directory.join(&candidate_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format_export_write_error(directory, &target, error)),
        };
        if let Err(error) = file.write_all(content_bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format_export_write_error(directory, &target, error));
        }
        return Ok(SaveExportFileResult {
            file_name: candidate_name,
            file_path: target.to_string_lossy().to_string(),
            directory_path: directory.to_string_lossy().to_string(),
            was_renamed: duplicate_number != 1,
        });
    }
    Err("导出文件夹里已有太多同名文件，请更换文件名或清理目录。".to_string())
}

fn verify_export_dependencies(verification: &VerifiedExportVerification) -> Result<(), String> {
    if verification.project_id.trim().is_empty()
        || verification.project_updated_at.trim().is_empty()
        || verification.snapshot_digest.trim().is_empty()
    {
        return Err("导出快照守卫不完整，已拒绝写入。".to_string());
    }
    if verification.dependencies.is_empty() {
        return Err("高精度分集导出没有携带媒体身份依赖，已拒绝写入。".to_string());
    }

    for dependency in &verification.dependencies {
        let media_id = dependency.media_id.trim();
        let path = dependency.path.trim();
        if media_id.is_empty() || path.is_empty() || path.contains("://") {
            return Err("导出媒体身份依赖包含无效的本地文件信息，已拒绝写入。".to_string());
        }
        let media_path = Path::new(path);
        if !media_path.is_absolute() || !media_path.is_file() {
            return Err(format!(
                "导出依赖媒体 {media_id} 不存在或不是本地绝对路径，已拒绝写入。"
            ));
        }
        let actual = probe_media_content_identity(media_path)
            .map_err(|error| format!("导出依赖媒体 {media_id} 的身份复核失败：{error}"))?;
        if !identity_matches(&dependency.expected_identity, &actual) {
            let map_diagnostic = if dependency.map_ids.is_empty() {
                String::new()
            } else {
                format!("（时间图：{}）", dependency.map_ids.join("、"))
            };
            return Err(format!(
                "导出依赖媒体 {media_id}{map_diagnostic} 已在预检后被替换或修改，已拒绝写入；请重新分析并确认匹配。"
            ));
        }
    }
    Ok(())
}

fn identity_matches(
    expected: &ExpectedMediaContentIdentity,
    actual: &MediaContentIdentity,
) -> bool {
    let content_fields_match = expected.algorithm == actual.algorithm
        && expected.size_bytes == actual.size_bytes
        && expected.first_sample_digest == actual.first_sample_digest
        && expected.middle_sample_digest == actual.middle_sample_digest
        && expected.last_sample_digest == actual.last_sample_digest;
    if expected.algorithm == "sha256-full-file-v2" {
        // v2 is a whole-file content identity. mtime remains useful diagnostics but touching an
        // otherwise identical file must not invalidate a confirmed map.
        content_fields_match
    } else {
        // Legacy sampled identities require every persisted field for conservative compatibility.
        content_fields_match && expected.modified_unix_ms == actual.modified_unix_ms
    }
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
        ErrorKind::AlreadyExists => format!(
            "导出文件已存在且无法自动改名：{}。",
            target.to_string_lossy()
        ),
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
        assert_eq!(
            split_file_name("episode.xml"),
            ("episode".to_string(), ".xml".to_string())
        );
        assert_eq!(
            split_file_name("archive"),
            ("archive".to_string(), "".to_string())
        );
    }

    #[test]
    fn existing_file_is_never_overwritten_when_choosing_a_duplicate_name() {
        let unique = tempfile_like_path("danmaku-export-unique");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        fs::write(unique.join("episode.xml"), "old").unwrap();

        let result = write_export_file(&unique, "episode.xml", b"new").unwrap();

        assert_eq!(result.file_name, "episode (2).xml");
        assert!(result.was_renamed);
        assert_eq!(fs::read(unique.join("episode.xml")).unwrap(), b"old");
        assert_eq!(fs::read(unique.join("episode (2).xml")).unwrap(), b"new");
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn concurrent_writers_atomically_claim_distinct_file_names() {
        use std::collections::HashSet;
        use std::sync::{Arc, Barrier};
        use std::thread;

        let unique = tempfile_like_path("danmaku-export-concurrent");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let directory = Arc::new(unique.clone());
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let directory = Arc::clone(&directory);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let content = format!("writer-{index}");
                    barrier.wait();
                    let result =
                        write_export_file(directory.as_path(), "episode.xml", content.as_bytes())
                            .unwrap();
                    (result.file_name, content)
                })
            })
            .collect::<Vec<_>>();

        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        let file_names = results
            .iter()
            .map(|(file_name, _)| file_name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(file_names.len(), 8);
        for (file_name, expected_content) in results {
            assert_eq!(
                fs::read_to_string(unique.join(file_name)).unwrap(),
                expected_content
            );
        }
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_rechecks_media_identity_before_writing() {
        let unique = tempfile_like_path("danmaku-export-verified");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let media_path = unique.join("source.bin");
        fs::write(&media_path, vec![7_u8; 256 * 1024]).unwrap();
        let identity = probe_media_content_identity(&media_path).unwrap();
        let request = verified_request(&unique, &media_path, expected_identity(&identity));

        let result = save_verified_export_file(request).unwrap();

        assert_eq!(result.file_name, "episode.xml");
        assert_eq!(fs::read(unique.join("episode.xml")).unwrap(), b"<i />");
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_refuses_a_media_replaced_after_preflight() {
        let unique = tempfile_like_path("danmaku-export-replaced");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let media_path = unique.join("source.bin");
        fs::write(&media_path, vec![7_u8; 256 * 1024]).unwrap();
        let identity = probe_media_content_identity(&media_path).unwrap();
        fs::write(&media_path, vec![9_u8; 256 * 1024]).unwrap();

        let error = save_verified_export_file(verified_request(
            &unique,
            &media_path,
            expected_identity(&identity),
        ))
        .unwrap_err();

        assert!(error.contains("已在预检后被替换或修改"));
        assert!(!unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_refuses_an_empty_dependency_set() {
        let unique = tempfile_like_path("danmaku-export-no-dependency");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let error = save_verified_export_file(SaveVerifiedExportFileRequest {
            directory_path: unique.to_string_lossy().to_string(),
            file_name: "episode.xml".to_string(),
            content_bytes: b"<i />".to_vec(),
            verification: VerifiedExportVerification {
                project_id: "project-1".to_string(),
                project_updated_at: "2026-07-12T00:00:00.000Z".to_string(),
                snapshot_digest: "fnv1a32:12345678".to_string(),
                dependencies: vec![],
            },
        })
        .unwrap_err();

        assert!(error.contains("没有携带媒体身份依赖"));
        assert!(!unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    fn verified_request(
        directory: &Path,
        media_path: &Path,
        expected_identity: ExpectedMediaContentIdentity,
    ) -> SaveVerifiedExportFileRequest {
        SaveVerifiedExportFileRequest {
            directory_path: directory.to_string_lossy().to_string(),
            file_name: "episode.xml".to_string(),
            content_bytes: b"<i />".to_vec(),
            verification: VerifiedExportVerification {
                project_id: "project-1".to_string(),
                project_updated_at: "2026-07-12T00:00:00.000Z".to_string(),
                snapshot_digest: "fnv1a32:12345678".to_string(),
                dependencies: vec![VerifiedMediaDependency {
                    media_id: "source-1".to_string(),
                    path: media_path.to_string_lossy().to_string(),
                    expected_identity,
                    map_ids: vec!["map-1".to_string()],
                }],
            },
        }
    }

    fn expected_identity(identity: &MediaContentIdentity) -> ExpectedMediaContentIdentity {
        ExpectedMediaContentIdentity {
            algorithm: identity.algorithm.to_string(),
            size_bytes: identity.size_bytes,
            modified_unix_ms: identity.modified_unix_ms,
            first_sample_digest: identity.first_sample_digest.clone(),
            middle_sample_digest: identity.middle_sample_digest.clone(),
            last_sample_digest: identity.last_sample_digest.clone(),
        }
    }

    fn tempfile_like_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", std::process::id()))
    }
}
