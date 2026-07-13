use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tauri::AppHandle;

use crate::manual_verification::lock_manual_time_map_verification_authority;
use crate::media_probe::{probe_media_content_identity, MediaContentIdentity};
use crate::physical_file::{PhysicalFileObjectKey, PinnedPhysicalFile};

const VERIFIED_EXPORT_SCHEMA_VERSION: u8 = 1;
const VERIFIED_EXPORT_MANIFEST_DOMAIN: &str = "verified-export-manifest-v1";
const MANUAL_VERIFICATION_REQUEST_DOMAIN: &str = "manual-time-map-verification-request-v1";

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
    schema_version: u8,
    project_id: String,
    project_updated_at: String,
    manifest_json: String,
    snapshot_digest: String,
    archive_file_name: String,
    archive_content_digest: String,
    outputs: Vec<VerifiedExportOutput>,
    map_proofs: Vec<VerifiedExportMapProof>,
    dependencies: Vec<VerifiedMediaDependency>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportOutput {
    file_name: String,
    content_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportMapProof {
    map_id: String,
    revision: u64,
    state: String,
    declared_quality: String,
    span_kinds: Vec<String>,
    core_digest: String,
    source_media_id: String,
    target_media_id: String,
    source_identity: ExpectedMediaContentIdentity,
    target_identity: ExpectedMediaContentIdentity,
    manual_verification: VerifiedExportManualVerification,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportManualVerification {
    verification_id: String,
    issuer_key_id: String,
    signature_algorithm: String,
    signature: String,
    request_payload: String,
    request_digest: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedMediaDependency {
    media_id: String,
    path: String,
    expected_identity: ExpectedMediaContentIdentity,
    #[serde(default)]
    map_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    app: AppHandle,
    request: SaveVerifiedExportFileRequest,
) -> Result<SaveExportFileResult, String> {
    let authority = lock_manual_time_map_verification_authority(&app)?;
    save_verified_export_file_with_authority(request, |proof| {
        let manual = &proof.manual_verification;
        authority.require_active(
            &manual.verification_id,
            &manual.issuer_key_id,
            &manual.signature,
            &manual.request_payload,
            &manual.request_digest,
        )
    })
}

fn save_verified_export_file_with_authority<F>(
    request: SaveVerifiedExportFileRequest,
    mut verify_authority: F,
) -> Result<SaveExportFileResult, String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let directory = validate_export_directory(&request.directory_path)?;
    let file_name = validate_export_file_name(&request.file_name)?;
    verify_verified_export_envelope(&request, &mut verify_authority)?;
    let dependency_pins = pin_and_verify_export_dependencies(&request.verification)?;
    let result = write_export_file(&directory, &file_name, &request.content_bytes)?;
    for pin in dependency_pins {
        if let Err(error) = pin.verify_handle_and_path() {
            let _ = fs::remove_file(&result.file_path);
            return Err(format!(
                "verified 导出写盘后的媒体 lease 复核失败，已删除本次输出：{error}"
            ));
        }
    }
    Ok(result)
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

fn pin_and_verify_export_dependencies(
    verification: &VerifiedExportVerification,
) -> Result<Vec<Arc<PinnedPhysicalFile>>, String> {
    let mut pins_by_object = HashMap::<PhysicalFileObjectKey, Arc<PinnedPhysicalFile>>::new();
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
        let pin = PinnedPhysicalFile::open(media_path)
            .map_err(|error| format!("导出依赖媒体 {media_id} 无法取得稳定只读 lease：{error}"))?;
        pin.verify_handle_and_path()?;
        let actual = probe_media_content_identity(pin.handle_final_path())
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
        pins_by_object.entry(pin.object_key()).or_insert(pin);
    }
    Ok(pins_by_object.into_values().collect())
}

fn verify_verified_export_envelope<F>(
    request: &SaveVerifiedExportFileRequest,
    verify_authority: &mut F,
) -> Result<(), String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let verification = &request.verification;
    if verification.schema_version != VERIFIED_EXPORT_SCHEMA_VERSION {
        return Err(format!(
            "高精度导出 schemaVersion 必须为 {VERIFIED_EXPORT_SCHEMA_VERSION}。"
        ));
    }
    for (label, value) in [
        ("projectId", verification.project_id.as_str()),
        ("projectUpdatedAt", verification.project_updated_at.as_str()),
        ("manifestJson", verification.manifest_json.as_str()),
        ("snapshotDigest", verification.snapshot_digest.as_str()),
        ("archiveFileName", verification.archive_file_name.as_str()),
        (
            "archiveContentDigest",
            verification.archive_content_digest.as_str(),
        ),
    ] {
        validate_nonempty_bounded(label, value, 1_048_576)?;
    }
    validate_sha256_digest("snapshotDigest", &verification.snapshot_digest)?;
    validate_sha256_digest("archiveContentDigest", &verification.archive_content_digest)?;
    if request.file_name != verification.archive_file_name {
        return Err("写盘文件名与高精度导出 manifest 不一致。".to_string());
    }
    let actual_archive_digest = sha256_digest(&request.content_bytes);
    if actual_archive_digest != verification.archive_content_digest {
        return Err("待写盘内容 SHA-256 与高精度导出 manifest 不一致。".to_string());
    }
    if verification.outputs.is_empty() {
        return Err("高精度导出 manifest 没有逻辑 XML 输出。".to_string());
    }
    if verification.map_proofs.is_empty() {
        return Err("高精度导出没有携带被引用时间图 proof。".to_string());
    }
    if verification.dependencies.is_empty() {
        return Err("高精度分集导出没有携带媒体身份依赖，已拒绝写入。".to_string());
    }

    validate_output_content_binding(request)?;
    validate_map_proofs_and_dependencies(verification, verify_authority)?;

    let canonical = canonical_verified_export_manifest(verification)?;
    let canonical_json = serde_json::to_string(&canonical)
        .map_err(|error| format!("无法重算高精度导出 manifest：{error}"))?;
    if canonical_json != verification.manifest_json {
        return Err("高精度导出 manifest 不是固定顺序规范 JSON。".to_string());
    }
    if sha256_digest(canonical_json.as_bytes()) != verification.snapshot_digest {
        return Err("高精度导出 manifest SHA-256 不匹配。".to_string());
    }
    Ok(())
}

fn validate_output_content_binding(request: &SaveVerifiedExportFileRequest) -> Result<(), String> {
    let outputs = &request.verification.outputs;
    let mut names = HashSet::new();
    for output in outputs {
        validate_export_file_name(&output.file_name)?;
        validate_sha256_digest("output contentDigest", &output.content_digest)?;
        if !names.insert(output.file_name.clone()) {
            return Err("高精度导出 manifest 含重复逻辑输出文件名。".to_string());
        }
    }
    if outputs.len() == 1 {
        let output = &outputs[0];
        if request.file_name != output.file_name
            || sha256_digest(&request.content_bytes) != output.content_digest
        {
            return Err("单文件写盘内容与 manifest 逻辑 XML 不一致。".to_string());
        }
        return Ok(());
    }
    let archive_outputs = parse_and_verify_stored_zip(&request.content_bytes)?;
    if archive_outputs.len() != outputs.len() {
        return Err("ZIP 内逻辑 XML 数量与高精度导出 manifest 不一致。".to_string());
    }
    let expected = outputs
        .iter()
        .map(|output| (output.file_name.as_str(), output.content_digest.as_str()))
        .collect::<HashMap<_, _>>();
    for (name, bytes) in archive_outputs {
        let Some(expected_digest) = expected.get(name.as_str()) else {
            return Err(format!("ZIP 含 manifest 未声明的逻辑文件：{name}"));
        };
        if sha256_digest(bytes) != *expected_digest {
            return Err(format!(
                "ZIP 内逻辑文件 {name} 的 SHA-256 与 manifest 不一致。"
            ));
        }
    }
    Ok(())
}

fn validate_map_proofs_and_dependencies<F>(
    verification: &VerifiedExportVerification,
    verify_authority: &mut F,
) -> Result<(), String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let mut proofs = HashMap::new();
    for proof in &verification.map_proofs {
        validate_nonempty_bounded("mapId", &proof.map_id, 512)?;
        if proof.revision == 0 || proof.state != "confirmed" || proof.declared_quality != "verified"
        {
            return Err(format!(
                "时间图 {} 必须为 confirmed 且 declaredQuality=verified。",
                proof.map_id
            ));
        }
        validate_sha256_digest("map coreDigest", &proof.core_digest)?;
        validate_media_identity_shape(&proof.source_identity)?;
        validate_media_identity_shape(&proof.target_identity)?;
        if proof.span_kinds.is_empty()
            || proof
                .span_kinds
                .iter()
                .any(|kind| !matches!(kind.as_str(), "matched" | "sourceOnly" | "targetOnly"))
        {
            return Err(format!(
                "时间图 {} 没有可导出的 span，或仍含 ambiguous/未知 span。",
                proof.map_id
            ));
        }
        validate_manual_request_binding(proof)?;
        if proofs.insert(proof.map_id.as_str(), proof).is_some() {
            return Err("高精度导出含重复时间图 proof。".to_string());
        }
    }

    let mut dependency_by_media = HashMap::new();
    let mut dependency_map_ids = HashSet::new();
    for dependency in &verification.dependencies {
        validate_nonempty_bounded("dependency mediaId", &dependency.media_id, 512)?;
        validate_media_identity_shape(&dependency.expected_identity)?;
        if dependency.map_ids.is_empty() {
            return Err(format!(
                "媒体依赖 {} 没有绑定任何时间图。",
                dependency.media_id
            ));
        }
        let mut local_ids = HashSet::new();
        for map_id in &dependency.map_ids {
            if !local_ids.insert(map_id.as_str()) {
                return Err(format!("媒体依赖 {} 含重复 mapId。", dependency.media_id));
            }
            if !proofs.contains_key(map_id.as_str()) {
                return Err(format!("媒体依赖引用了缺失 proof：{map_id}"));
            }
            dependency_map_ids.insert(map_id.as_str());
        }
        if dependency_by_media
            .insert(dependency.media_id.as_str(), dependency)
            .is_some()
        {
            return Err("高精度导出含重复媒体依赖。".to_string());
        }
    }
    if dependency_map_ids.len() != proofs.len() {
        return Err("时间图 proof 与媒体依赖 mapIds 未形成双向完整绑定。".to_string());
    }

    for proof in verification.map_proofs.iter() {
        let source = dependency_by_media
            .get(proof.source_media_id.as_str())
            .ok_or_else(|| format!("时间图 {} 缺少来源媒体依赖。", proof.map_id))?;
        let target = dependency_by_media
            .get(proof.target_media_id.as_str())
            .ok_or_else(|| format!("时间图 {} 缺少目标媒体依赖。", proof.map_id))?;
        if !source.map_ids.iter().any(|id| id == &proof.map_id)
            || !target.map_ids.iter().any(|id| id == &proof.map_id)
        {
            return Err(format!("时间图 {} 未同时绑定两端媒体依赖。", proof.map_id));
        }
        if !expected_identities_match(&source.expected_identity, &proof.source_identity)
            || !expected_identities_match(&target.expected_identity, &proof.target_identity)
        {
            return Err(format!(
                "时间图 {} 的 proof 身份与媒体依赖不一致。",
                proof.map_id
            ));
        }
        verify_authority(proof)
            .map_err(|error| format!("时间图 {} 的人工验证未获放行：{error}", proof.map_id))?;
    }
    Ok(())
}

fn validate_manual_request_binding(proof: &VerifiedExportMapProof) -> Result<(), String> {
    let manual = &proof.manual_verification;
    for (label, value) in [
        ("verificationId", manual.verification_id.as_str()),
        ("issuerKeyId", manual.issuer_key_id.as_str()),
        ("requestPayload", manual.request_payload.as_str()),
    ] {
        validate_nonempty_bounded(label, value, 32 * 1024)?;
    }
    if manual.signature_algorithm != "hmac-sha256-v1" {
        return Err("人工验证 proof 使用了不受支持的签名算法。".to_string());
    }
    validate_hex("manual signature", &manual.signature, 64)?;
    validate_sha256_digest("manual requestDigest", &manual.request_digest)?;
    if sha256_digest(manual.request_payload.as_bytes()) != manual.request_digest {
        return Err("人工验证 requestPayload 与 requestDigest 不一致。".to_string());
    }
    let value: Value = serde_json::from_str(&manual.request_payload)
        .map_err(|error| format!("人工验证 requestPayload 不是有效 JSON：{error}"))?;
    let fields = value
        .as_array()
        .ok_or_else(|| "人工验证 requestPayload 必须是固定顺序数组。".to_string())?;
    if fields.len() != 12
        || fields[0].as_str() != Some(MANUAL_VERIFICATION_REQUEST_DOMAIN)
        || fields[1].as_str() != Some("manual-review")
        || fields[2].as_str() != Some(proof.map_id.as_str())
        || fields[3].as_u64() != Some(proof.revision)
        || fields[4].as_str() != Some(proof.core_digest.as_str())
        || fields[5] != identity_manifest_value(&proof.source_identity)
        || fields[6] != identity_manifest_value(&proof.target_identity)
        || fields[7].as_str().is_none_or(str::is_empty)
        || fields[8].as_str().is_none_or(str::is_empty)
        || fields[9]
            .as_str()
            .is_none_or(|digest| validate_sha256_digest("reviewEvidenceDigest", digest).is_err())
        || fields[10].as_str().is_none_or(str::is_empty)
        || fields[11].as_str().is_none_or(str::is_empty)
    {
        return Err(format!(
            "时间图 {} 的人工验证请求未绑定当前 map/revision/core/两端身份。",
            proof.map_id
        ));
    }
    Ok(())
}

fn canonical_verified_export_manifest(
    verification: &VerifiedExportVerification,
) -> Result<Value, String> {
    let mut outputs = verification.outputs.iter().collect::<Vec<_>>();
    outputs.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    let mut map_proofs = verification.map_proofs.iter().collect::<Vec<_>>();
    map_proofs.sort_by(|left, right| left.map_id.cmp(&right.map_id));
    let mut dependencies = verification.dependencies.iter().collect::<Vec<_>>();
    dependencies.sort_by(|left, right| left.media_id.cmp(&right.media_id));

    let output_values = outputs
        .into_iter()
        .map(|output| json!([output.file_name, output.content_digest]))
        .collect::<Vec<_>>();
    let proof_values = map_proofs
        .into_iter()
        .map(|proof| {
            json!([
                proof.map_id,
                proof.revision,
                proof.state,
                proof.declared_quality,
                proof.span_kinds,
                proof.core_digest,
                proof.source_media_id,
                proof.target_media_id,
                identity_manifest_value(&proof.source_identity),
                identity_manifest_value(&proof.target_identity),
                [
                    proof.manual_verification.verification_id,
                    proof.manual_verification.issuer_key_id,
                    proof.manual_verification.signature_algorithm,
                    proof.manual_verification.signature,
                    proof.manual_verification.request_payload,
                    proof.manual_verification.request_digest,
                ]
            ])
        })
        .collect::<Vec<_>>();
    let dependency_values = dependencies
        .into_iter()
        .map(|dependency| {
            let mut map_ids = dependency.map_ids.clone();
            map_ids.sort();
            json!([
                dependency.media_id,
                identity_manifest_value(&dependency.expected_identity),
                map_ids
            ])
        })
        .collect::<Vec<_>>();

    Ok(json!([
        VERIFIED_EXPORT_MANIFEST_DOMAIN,
        verification.schema_version,
        verification.project_id,
        verification.project_updated_at,
        verification.archive_file_name,
        verification.archive_content_digest,
        output_values,
        proof_values,
        dependency_values,
    ]))
}

fn identity_manifest_value(identity: &ExpectedMediaContentIdentity) -> Value {
    json!([
        identity.algorithm,
        identity.size_bytes,
        identity.modified_unix_ms,
        identity.first_sample_digest,
        identity.middle_sample_digest,
        identity.last_sample_digest,
    ])
}

fn validate_media_identity_shape(identity: &ExpectedMediaContentIdentity) -> Result<(), String> {
    if identity.algorithm != "sha256-full-file-v2" {
        return Err("高精度导出只接受 sha256-full-file-v2 全文件媒体身份。".to_string());
    }
    for digest in [
        identity.first_sample_digest.as_str(),
        identity.middle_sample_digest.as_str(),
        identity.last_sample_digest.as_str(),
    ] {
        validate_hex("media identity digest", digest, 64)?;
    }
    Ok(())
}

fn validate_nonempty_bounded(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(format!("高精度导出字段 {label} 为空或超过大小限制。"));
    }
    Ok(())
}

fn validate_sha256_digest(label: &str, value: &str) -> Result<(), String> {
    if !value.starts_with("sha256:") || validate_hex(label, &value[7..], 64).is_err() {
        return Err(format!("高精度导出字段 {label} 不是规范 SHA-256 摘要。"));
    }
    Ok(())
}

fn validate_hex(label: &str, value: &str, expected_len: usize) -> Result<(), String> {
    if value.len() != expected_len
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(format!(
            "高精度导出字段 {label} 必须是 {expected_len} 位小写十六进制。"
        ));
    }
    Ok(())
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex_encode(&Sha256::digest(bytes)))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

fn parse_and_verify_stored_zip(bytes: &[u8]) -> Result<Vec<(String, &[u8])>, String> {
    if bytes.len() < 22 {
        return Err("多文件高精度导出不是完整 ZIP。".to_string());
    }
    let end_offset = bytes.len() - 22;
    if read_u32(bytes, end_offset)? != 0x0605_4b50
        || read_u16(bytes, end_offset + 4)? != 0
        || read_u16(bytes, end_offset + 6)? != 0
        || read_u16(bytes, end_offset + 20)? != 0
    {
        return Err("多文件高精度导出 ZIP 终止记录无效。".to_string());
    }
    let disk_entries = usize::from(read_u16(bytes, end_offset + 8)?);
    let total_entries = usize::from(read_u16(bytes, end_offset + 10)?);
    let central_size = usize::try_from(read_u32(bytes, end_offset + 12)?)
        .map_err(|_| "ZIP 中央目录大小越界。".to_string())?;
    let central_offset = usize::try_from(read_u32(bytes, end_offset + 16)?)
        .map_err(|_| "ZIP 中央目录偏移越界。".to_string())?;
    if disk_entries != total_entries
        || total_entries == 0
        || central_offset
            .checked_add(central_size)
            .is_none_or(|value| value != end_offset)
    {
        return Err("多文件高精度导出 ZIP 中央目录边界无效。".to_string());
    }

    let mut central_cursor = central_offset;
    let mut names = HashSet::new();
    let mut entries = Vec::with_capacity(total_entries);
    for _ in 0..total_entries {
        require_range(bytes, central_cursor, 46)?;
        if read_u32(bytes, central_cursor)? != 0x0201_4b50
            || read_u16(bytes, central_cursor + 8)? != 0x0800
            || read_u16(bytes, central_cursor + 10)? != 0
        {
            return Err("ZIP 中央目录不是 UTF-8 stored entry。".to_string());
        }
        let crc = read_u32(bytes, central_cursor + 16)?;
        let compressed_size = usize::try_from(read_u32(bytes, central_cursor + 20)?)
            .map_err(|_| "ZIP entry 大小越界。".to_string())?;
        let uncompressed_size = usize::try_from(read_u32(bytes, central_cursor + 24)?)
            .map_err(|_| "ZIP entry 大小越界。".to_string())?;
        let name_len = usize::from(read_u16(bytes, central_cursor + 28)?);
        let extra_len = usize::from(read_u16(bytes, central_cursor + 30)?);
        let comment_len = usize::from(read_u16(bytes, central_cursor + 32)?);
        let local_offset = usize::try_from(read_u32(bytes, central_cursor + 42)?)
            .map_err(|_| "ZIP local header 偏移越界。".to_string())?;
        if compressed_size != uncompressed_size || extra_len != 0 || comment_len != 0 {
            return Err("高精度导出只接受无压缩、无附加字段的确定性 ZIP。".to_string());
        }
        require_range(bytes, central_cursor + 46, name_len)?;
        let central_name =
            std::str::from_utf8(&bytes[central_cursor + 46..central_cursor + 46 + name_len])
                .map_err(|_| "ZIP 文件名不是 UTF-8。".to_string())?;
        validate_export_file_name(central_name)?;
        if !names.insert(central_name.to_string()) {
            return Err("ZIP 含重复逻辑文件名。".to_string());
        }

        require_range(bytes, local_offset, 30)?;
        if read_u32(bytes, local_offset)? != 0x0403_4b50
            || read_u16(bytes, local_offset + 6)? != 0x0800
            || read_u16(bytes, local_offset + 8)? != 0
            || read_u32(bytes, local_offset + 14)? != crc
            || usize::try_from(read_u32(bytes, local_offset + 18)?).ok() != Some(compressed_size)
            || usize::try_from(read_u32(bytes, local_offset + 22)?).ok() != Some(uncompressed_size)
        {
            return Err("ZIP local header 与中央目录不一致。".to_string());
        }
        let local_name_len = usize::from(read_u16(bytes, local_offset + 26)?);
        let local_extra_len = usize::from(read_u16(bytes, local_offset + 28)?);
        require_range(bytes, local_offset + 30, local_name_len + local_extra_len)?;
        let local_name =
            std::str::from_utf8(&bytes[local_offset + 30..local_offset + 30 + local_name_len])
                .map_err(|_| "ZIP local 文件名不是 UTF-8。".to_string())?;
        if local_name != central_name || local_extra_len != 0 {
            return Err("ZIP local 文件名与中央目录不一致。".to_string());
        }
        let data_start = local_offset + 30 + local_name_len;
        require_range(bytes, data_start, compressed_size)?;
        let data = &bytes[data_start..data_start + compressed_size];
        if crc32(data) != crc {
            return Err(format!("ZIP 文件 {central_name} 的 CRC32 无效。"));
        }
        entries.push((central_name.to_string(), data));
        central_cursor = central_cursor
            .checked_add(46 + name_len + extra_len + comment_len)
            .ok_or_else(|| "ZIP 中央目录偏移溢出。".to_string())?;
    }
    if central_cursor != end_offset {
        return Err("ZIP 中央目录含未声明尾部数据。".to_string());
    }
    Ok(entries)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    require_range(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    require_range(bytes, offset, 4)?;
    Ok(u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn require_range(bytes: &[u8], offset: usize, length: usize) -> Result<(), String> {
    if offset
        .checked_add(length)
        .is_none_or(|end| end > bytes.len())
    {
        return Err("ZIP 结构越过输入边界。".to_string());
    }
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut value = 0xffff_ffff_u32;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            value = if value & 1 == 1 {
                0xedb8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
        }
    }
    value ^ 0xffff_ffff
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

fn expected_identities_match(
    left: &ExpectedMediaContentIdentity,
    right: &ExpectedMediaContentIdentity,
) -> bool {
    let content_fields_match = left.algorithm == right.algorithm
        && left.size_bytes == right.size_bytes
        && left.first_sample_digest == right.first_sample_digest
        && left.middle_sample_digest == right.middle_sample_digest
        && left.last_sample_digest == right.last_sample_digest;
    if left.algorithm == "sha256-full-file-v2" {
        content_fields_match
    } else {
        content_fields_match && left.modified_unix_ms == right.modified_unix_ms
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
    if trimmed.is_empty() || trimmed.encode_utf16().count() > 240 {
        return Err("导出文件名无效。".to_string());
    }
    let mut components = Path::new(trimmed).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("导出文件名必须是单个普通文件名，不能包含盘符、路径或前缀。".to_string());
    }
    if trimmed
        .chars()
        .any(|character| character <= '\u{001f}' || r#"<>:"/\|?*"#.contains(character))
        || trimmed.ends_with(['.', ' '])
    {
        return Err("导出文件名包含 Windows 不允许的字符或结尾。".to_string());
    }
    let device_base = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    let reserved_device = matches!(device_base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_base.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || device_base.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        });
    if reserved_device {
        return Err("导出文件名不能使用 Windows 保留设备名。".to_string());
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
        assert!(validate_export_file_name(".hidden.xml").is_ok());
        assert!(validate_export_file_name("分集😀.xml").is_ok());
        assert!(validate_export_file_name("nested/episode.xml").is_err());
        assert!(validate_export_file_name("nested\\episode.xml").is_err());
        for invalid in [
            "C:outside.xml",
            "name.xml:stream",
            "CON",
            "con.txt",
            "NUL ",
            "episode.xml.",
            "bad\u{001f}.xml",
        ] {
            assert!(
                validate_export_file_name(invalid).is_err(),
                "Windows 危险文件名必须拒绝：{invalid:?}"
            );
        }
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
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut authority_checks = 0;
        let result = save_verified_export_file_with_authority(request, |_| {
            authority_checks += 1;
            Ok(())
        })
        .unwrap();

        assert_eq!(result.file_name, "episode.xml");
        assert_eq!(authority_checks, 1);
        assert_eq!(fs::read(unique.join("episode.xml")).unwrap(), b"<i />");
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_refuses_a_media_replaced_after_preflight() {
        let unique = tempfile_like_path("danmaku-export-replaced");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        fs::write(&source_path, vec![9_u8; 256 * 1024]).unwrap();
        let error = save_verified_export_file_with_authority(
            verified_request(
                &unique,
                &source_path,
                &target_path,
                source_identity,
                target_identity,
            ),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.contains("已在预检后被替换或修改"));
        assert!(!unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_rejects_quality_span_proof_and_request_tampering() {
        let unique = tempfile_like_path("danmaku-export-proof-tamper");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let base = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut low_quality = clone_request(&base);
        low_quality.verification.map_proofs[0].declared_quality = "review".to_string();
        resign_manifest(&mut low_quality.verification);
        assert_rejected_without_write(&low_quality, &unique, "declaredQuality=verified");

        let mut ambiguous = clone_request(&base);
        ambiguous.verification.map_proofs[0]
            .span_kinds
            .push("ambiguous".to_string());
        resign_manifest(&mut ambiguous.verification);
        assert_rejected_without_write(&ambiguous, &unique, "ambiguous/未知 span");

        let mut missing_proof = clone_request(&base);
        missing_proof.verification.map_proofs.clear();
        resign_manifest(&mut missing_proof.verification);
        assert_rejected_without_write(&missing_proof, &unique, "没有携带被引用时间图 proof");

        let mut forged_request = clone_request(&base);
        forged_request.verification.map_proofs[0]
            .manual_verification
            .request_payload = "[]".to_string();
        forged_request.verification.map_proofs[0]
            .manual_verification
            .request_digest = sha256_digest(b"[]");
        resign_manifest(&mut forged_request.verification);
        assert_rejected_without_write(&forged_request, &unique, "未绑定当前 map/revision/core");

        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_rejects_content_manifest_and_dependency_tampering() {
        let unique = tempfile_like_path("danmaku-export-envelope-tamper");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let base = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut content = clone_request(&base);
        content.content_bytes = b"<i>tampered</i>".to_vec();
        assert_rejected_without_write(&content, &unique, "待写盘内容 SHA-256");

        let mut manifest = clone_request(&base);
        manifest.verification.snapshot_digest = sha256_digest(b"not-the-manifest");
        assert_rejected_without_write(&manifest, &unique, "manifest SHA-256");

        let mut dependency = clone_request(&base);
        dependency.verification.dependencies[0].map_ids.clear();
        resign_manifest(&mut dependency.verification);
        assert_rejected_without_write(&dependency, &unique, "没有绑定任何时间图");

        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_requires_active_local_authority_before_writing() {
        let unique = tempfile_like_path("danmaku-export-authority");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        for reason in ["revoked", "unknown"] {
            let error = save_verified_export_file_with_authority(clone_request(&request), |_| {
                Err(reason.to_string())
            })
            .unwrap_err();
            assert!(error.contains(reason));
            assert!(!unique.join("episode.xml").exists());
        }
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_zip_binds_every_logical_xml_and_archive_bytes() {
        let first = ("1.xml", b"<i>1</i>".as_slice());
        let second = ("2.xml", b"<i>2</i>".as_slice());
        let zip = create_test_stored_zip(&[first, second]);
        let parsed = parse_and_verify_stored_zip(&zip).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("1.xml".to_string(), first.1));
        assert_eq!(parsed[1], ("2.xml".to_string(), second.1));

        let mut tampered = zip;
        let byte = tampered.iter_mut().find(|byte| **byte == b'2').unwrap();
        *byte = b'9';
        assert!(parse_and_verify_stored_zip(&tampered).is_err());
    }

    fn assert_rejected_without_write(
        request: &SaveVerifiedExportFileRequest,
        directory: &Path,
        expected: &str,
    ) {
        let error = save_verified_export_file_with_authority(clone_request(request), |_| Ok(()))
            .unwrap_err();
        assert!(error.contains(expected), "unexpected error: {error}");
        assert!(!directory.join("episode.xml").exists());
    }

    fn create_media_pair(
        directory: &Path,
    ) -> (
        PathBuf,
        PathBuf,
        ExpectedMediaContentIdentity,
        ExpectedMediaContentIdentity,
    ) {
        let source_path = directory.join("source.bin");
        let target_path = directory.join("target.bin");
        fs::write(&source_path, vec![7_u8; 256 * 1024]).unwrap();
        fs::write(&target_path, vec![8_u8; 256 * 1024]).unwrap();
        let source_identity =
            expected_identity(&probe_media_content_identity(&source_path).unwrap());
        let target_identity =
            expected_identity(&probe_media_content_identity(&target_path).unwrap());
        (source_path, target_path, source_identity, target_identity)
    }

    fn verified_request(
        directory: &Path,
        source_path: &Path,
        target_path: &Path,
        source_identity: ExpectedMediaContentIdentity,
        target_identity: ExpectedMediaContentIdentity,
    ) -> SaveVerifiedExportFileRequest {
        let content_bytes = b"<i />".to_vec();
        let core_digest = sha256_digest(b"map-core");
        let review_digest = sha256_digest(b"review-evidence");
        let request_payload = serde_json::to_string(&json!([
            MANUAL_VERIFICATION_REQUEST_DOMAIN,
            "manual-review",
            "map-1",
            1,
            core_digest,
            identity_manifest_value(&source_identity),
            identity_manifest_value(&target_identity),
            "manual-a-b-review",
            "1",
            review_digest,
            "本机用户",
            "2026-07-12T00:00:00.000Z",
        ]))
        .unwrap();
        let request_digest = sha256_digest(request_payload.as_bytes());
        let proof = VerifiedExportMapProof {
            map_id: "map-1".to_string(),
            revision: 1,
            state: "confirmed".to_string(),
            declared_quality: "verified".to_string(),
            span_kinds: vec!["matched".to_string()],
            core_digest,
            source_media_id: "source-1".to_string(),
            target_media_id: "target-1".to_string(),
            source_identity: source_identity.clone(),
            target_identity: target_identity.clone(),
            manual_verification: VerifiedExportManualVerification {
                verification_id: "verification-1".to_string(),
                issuer_key_id: "install-sha256:fixture".to_string(),
                signature_algorithm: "hmac-sha256-v1".to_string(),
                signature: "a".repeat(64),
                request_payload,
                request_digest,
            },
        };
        let mut verification = VerifiedExportVerification {
            schema_version: VERIFIED_EXPORT_SCHEMA_VERSION,
            project_id: "project-1".to_string(),
            project_updated_at: "2026-07-12T00:00:00.000Z".to_string(),
            manifest_json: String::new(),
            snapshot_digest: sha256_digest(b"pending"),
            archive_file_name: "episode.xml".to_string(),
            archive_content_digest: sha256_digest(&content_bytes),
            outputs: vec![VerifiedExportOutput {
                file_name: "episode.xml".to_string(),
                content_digest: sha256_digest(&content_bytes),
            }],
            map_proofs: vec![proof],
            dependencies: vec![
                VerifiedMediaDependency {
                    media_id: "source-1".to_string(),
                    path: source_path.to_string_lossy().to_string(),
                    expected_identity: source_identity,
                    map_ids: vec!["map-1".to_string()],
                },
                VerifiedMediaDependency {
                    media_id: "target-1".to_string(),
                    path: target_path.to_string_lossy().to_string(),
                    expected_identity: target_identity,
                    map_ids: vec!["map-1".to_string()],
                },
            ],
        };
        resign_manifest(&mut verification);
        SaveVerifiedExportFileRequest {
            directory_path: directory.to_string_lossy().to_string(),
            file_name: "episode.xml".to_string(),
            content_bytes,
            verification,
        }
    }

    fn resign_manifest(verification: &mut VerifiedExportVerification) {
        verification.manifest_json =
            serde_json::to_string(&canonical_verified_export_manifest(verification).unwrap())
                .unwrap();
        verification.snapshot_digest = sha256_digest(verification.manifest_json.as_bytes());
    }

    fn clone_request(request: &SaveVerifiedExportFileRequest) -> SaveVerifiedExportFileRequest {
        SaveVerifiedExportFileRequest {
            directory_path: request.directory_path.clone(),
            file_name: request.file_name.clone(),
            content_bytes: request.content_bytes.clone(),
            verification: VerifiedExportVerification {
                schema_version: request.verification.schema_version,
                project_id: request.verification.project_id.clone(),
                project_updated_at: request.verification.project_updated_at.clone(),
                manifest_json: request.verification.manifest_json.clone(),
                snapshot_digest: request.verification.snapshot_digest.clone(),
                archive_file_name: request.verification.archive_file_name.clone(),
                archive_content_digest: request.verification.archive_content_digest.clone(),
                outputs: request.verification.outputs.clone(),
                map_proofs: request.verification.map_proofs.clone(),
                dependencies: request.verification.dependencies.clone(),
            },
        }
    }

    fn create_test_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut local = Vec::new();
        let mut central = Vec::new();
        for (name, data) in entries {
            let name = name.as_bytes();
            let offset = u32::try_from(local.len()).unwrap();
            let crc = crc32(data);
            let size = u32::try_from(data.len()).unwrap();
            push_u32(&mut local, 0x0403_4b50);
            push_u16(&mut local, 20);
            push_u16(&mut local, 0x0800);
            push_u16(&mut local, 0);
            push_u16(&mut local, 0);
            push_u16(&mut local, 0x0021);
            push_u32(&mut local, crc);
            push_u32(&mut local, size);
            push_u32(&mut local, size);
            push_u16(&mut local, u16::try_from(name.len()).unwrap());
            push_u16(&mut local, 0);
            local.extend_from_slice(name);
            local.extend_from_slice(data);

            push_u32(&mut central, 0x0201_4b50);
            push_u16(&mut central, 20);
            push_u16(&mut central, 20);
            push_u16(&mut central, 0x0800);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0x0021);
            push_u32(&mut central, crc);
            push_u32(&mut central, size);
            push_u32(&mut central, size);
            push_u16(&mut central, u16::try_from(name.len()).unwrap());
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u32(&mut central, 0);
            push_u32(&mut central, offset);
            central.extend_from_slice(name);
        }
        let central_offset = u32::try_from(local.len()).unwrap();
        let central_size = u32::try_from(central.len()).unwrap();
        local.extend_from_slice(&central);
        push_u32(&mut local, 0x0605_4b50);
        push_u16(&mut local, 0);
        push_u16(&mut local, 0);
        push_u16(&mut local, u16::try_from(entries.len()).unwrap());
        push_u16(&mut local, u16::try_from(entries.len()).unwrap());
        push_u32(&mut local, central_size);
        push_u32(&mut local, central_offset);
        push_u16(&mut local, 0);
        local
    }

    fn push_u16(output: &mut Vec<u8>, value: u16) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_le_bytes());
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
