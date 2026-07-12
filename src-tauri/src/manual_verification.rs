use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const AUTHORITY_VERSION: u8 = 1;
const MAX_REQUEST_PAYLOAD_BYTES: usize = 32 * 1024;
const SIGNATURE_ALGORITHM: &str = "hmac-sha256-v1";
const ISSUE_DOMAIN: &str = "manual-time-map-verification-issue-v1";
const REVOCATION_DOMAIN: &str = "manual-time-map-verification-revocation-v1";

static AUTHORITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueManualVerificationRequest {
    request_payload: String,
    request_digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationSeal {
    verification_id: String,
    issuer_key_id: String,
    issuer_sequence: u64,
    signature_algorithm: &'static str,
    signature: String,
    request_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyManualVerificationRequest {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_payload: String,
    request_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationAuthorityResult {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_digest: String,
    status: &'static str,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeManualVerificationRequest {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_digest: String,
    reason: String,
    revoked_by: String,
    revoked_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationRevocationSeal {
    verification_id: String,
    issuer_key_id: String,
    issuer_sequence: u64,
    signature_algorithm: &'static str,
    signature: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityKeyFile {
    version: u8,
    key_id: String,
    secret_hex: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "eventType", rename_all = "camelCase")]
enum AuthorityEvent {
    Issue {
        version: u8,
        sequence: u64,
        verification_id: String,
        request_digest: String,
        signature: String,
    },
    Revoke {
        version: u8,
        sequence: u64,
        verification_id: String,
        request_digest: String,
        issue_signature: String,
        reason: String,
        revoked_by: String,
        revoked_at: String,
        signature: String,
    },
}

#[tauri::command]
pub fn issue_manual_time_map_verification(
    app: AppHandle,
    request: IssueManualVerificationRequest,
) -> Result<ManualVerificationSeal, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| issue_at(&root, request))
}

#[tauri::command]
pub fn verify_manual_time_map_verification(
    app: AppHandle,
    request: VerifyManualVerificationRequest,
) -> Result<ManualVerificationAuthorityResult, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| verify_at(&root, request))
}

#[tauri::command]
pub fn revoke_manual_time_map_verification(
    app: AppHandle,
    request: RevokeManualVerificationRequest,
) -> Result<ManualVerificationRevocationSeal, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| revoke_at(&root, request))
}

fn authority_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("manual-verification-authority-v1"))
        .map_err(|error| format!("无法定位人工验证机构目录：{error}"))
}

fn with_authority_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let guard = AUTHORITY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "人工验证机构锁已损坏；为避免错误签发，本次操作已阻断。".to_string())?;
    let result = operation();
    drop(guard);
    result
}

fn issue_at(
    root: &Path,
    request: IssueManualVerificationRequest,
) -> Result<ManualVerificationSeal, String> {
    validate_issue_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    let events = load_events(root)?;
    let sequence = next_sequence(&events)?;
    let verification_id = random_hex(16)?;
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(&verification_id, sequence, &request.request_digest).as_bytes(),
    );
    let event = AuthorityEvent::Issue {
        version: AUTHORITY_VERSION,
        sequence,
        verification_id: verification_id.clone(),
        request_digest: request.request_digest.clone(),
        signature: signature.clone(),
    };
    append_immutable_event(root, sequence, &verification_id, "issue", &event)?;
    Ok(ManualVerificationSeal {
        verification_id,
        issuer_key_id: key.key_id,
        issuer_sequence: sequence,
        signature_algorithm: SIGNATURE_ALGORITHM,
        signature,
        request_digest: request.request_digest,
    })
}

fn verify_at(
    root: &Path,
    request: VerifyManualVerificationRequest,
) -> Result<ManualVerificationAuthorityResult, String> {
    validate_verification_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    let base = |status: &'static str, reason: String| ManualVerificationAuthorityResult {
        verification_id: request.verification_id.clone(),
        issuer_key_id: request.issuer_key_id.clone(),
        signature: request.signature.clone(),
        request_digest: request.request_digest.clone(),
        status,
        reason,
    };
    if request.issuer_key_id != key.key_id {
        return Ok(base(
            "unknown",
            "该凭据由另一安装签发，或本机安装级密钥已丢失；必须重新完成人工复核。".to_string(),
        ));
    }
    if digest_payload(&request.request_payload) != request.request_digest {
        return Ok(base(
            "invalid",
            "项目中的签发请求摘要与当前规范化时间图内容不一致。".to_string(),
        ));
    }
    let events = load_events(root)?;
    let issue = events.iter().find_map(|event| match event {
        AuthorityEvent::Issue {
            sequence,
            verification_id,
            request_digest,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, request_digest.as_str(), signature.as_str()))
        }
        _ => None,
    });
    let Some((issue_sequence, registered_digest, registered_signature)) = issue else {
        return Ok(base(
            "unknown",
            "本机签发注册表中不存在该人工验证编号。".to_string(),
        ));
    };
    if registered_digest != request.request_digest || registered_signature != request.signature {
        return Ok(base(
            "invalid",
            "项目凭据与本机签发注册表不一致。".to_string(),
        ));
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(
            &request.verification_id,
            issue_sequence,
            &request.request_digest,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected_signature, &request.signature) {
        return Ok(base("invalid", "人工验证 HMAC 签名无效。".to_string()));
    }
    if events.iter().any(|event| {
        matches!(
            event,
            AuthorityEvent::Revoke { verification_id, .. }
                if verification_id == &request.verification_id
        )
    }) {
        return Ok(base(
            "revoked",
            "本机撤销注册表已撤销该人工验证；项目 JSON 不能恢复它。".to_string(),
        ));
    }
    Ok(base(
        "active",
        "签名、规范化摘要和本机撤销注册表均已验证。".to_string(),
    ))
}

fn revoke_at(
    root: &Path,
    request: RevokeManualVerificationRequest,
) -> Result<ManualVerificationRevocationSeal, String> {
    validate_revocation_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    if request.issuer_key_id != key.key_id {
        return Err("只能由原签发安装撤销该人工验证；当前安装密钥不匹配。".to_string());
    }
    let events = load_events(root)?;
    let issue = events.iter().find_map(|event| match event {
        AuthorityEvent::Issue {
            sequence,
            verification_id,
            request_digest,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, request_digest.as_str(), signature.as_str()))
        }
        _ => None,
    });
    let Some((issue_sequence, registered_digest, registered_signature)) = issue else {
        return Err("本机签发注册表中不存在该人工验证，不能生成撤销回执。".to_string());
    };
    if registered_digest != request.request_digest || registered_signature != request.signature {
        return Err("待撤销凭据与本机签发注册表不一致。".to_string());
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_issue_signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(
            &request.verification_id,
            issue_sequence,
            &request.request_digest,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected_issue_signature, &request.signature) {
        return Err("待撤销人工验证的签名无效。".to_string());
    }
    if let Some(existing) = events.iter().find_map(|event| match event {
        AuthorityEvent::Revoke {
            sequence,
            verification_id,
            reason,
            revoked_by,
            revoked_at,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, reason, revoked_by, revoked_at, signature))
        }
        _ => None,
    }) {
        if existing.1 == &request.reason
            && existing.2 == &request.revoked_by
            && existing.3 == &request.revoked_at
        {
            return Ok(ManualVerificationRevocationSeal {
                verification_id: request.verification_id,
                issuer_key_id: key.key_id,
                issuer_sequence: existing.0,
                signature_algorithm: SIGNATURE_ALGORITHM,
                signature: existing.4.clone(),
            });
        }
        return Err("该人工验证已经撤销，撤销审计内容不能覆盖。".to_string());
    }
    let sequence = next_sequence(&events)?;
    let signature = hmac_sha256_hex(
        &secret,
        revocation_signature_message(sequence, &request).as_bytes(),
    );
    let event = AuthorityEvent::Revoke {
        version: AUTHORITY_VERSION,
        sequence,
        verification_id: request.verification_id.clone(),
        request_digest: request.request_digest,
        issue_signature: request.signature,
        reason: request.reason,
        revoked_by: request.revoked_by,
        revoked_at: request.revoked_at,
        signature: signature.clone(),
    };
    append_immutable_event(root, sequence, &request.verification_id, "revoke", &event)?;
    Ok(ManualVerificationRevocationSeal {
        verification_id: request.verification_id,
        issuer_key_id: key.key_id,
        issuer_sequence: sequence,
        signature_algorithm: SIGNATURE_ALGORITHM,
        signature,
    })
}

fn validate_issue_request(request: &IssueManualVerificationRequest) -> Result<(), String> {
    if request.request_payload.len() > MAX_REQUEST_PAYLOAD_BYTES {
        return Err("人工验证规范化请求超过 32 KiB 限制。".to_string());
    }
    if digest_payload(&request.request_payload) != request.request_digest {
        return Err("人工验证请求的 SHA-256 摘要不正确。".to_string());
    }
    let value: Value = serde_json::from_str(&request.request_payload)
        .map_err(|error| format!("人工验证规范化请求不是有效 JSON：{error}"))?;
    let fields = value
        .as_array()
        .ok_or_else(|| "人工验证规范化请求必须是固定顺序数组。".to_string())?;
    if fields.len() != 12
        || fields[0].as_str() != Some("manual-time-map-verification-request-v1")
        || fields[1].as_str() != Some("manual-review")
        || !is_bounded_string(&fields[2], 1, 512)
        || fields[3].as_u64().is_none_or(|revision| revision == 0)
        || !is_sha256_digest_value(&fields[4])
        || !is_content_identity_array(&fields[5])
        || !is_content_identity_array(&fields[6])
        || !is_bounded_string(&fields[7], 1, 512)
        || !is_bounded_string(&fields[8], 1, 512)
        || !is_sha256_digest_value(&fields[9])
        || !is_bounded_string(&fields[10], 1, 512)
        || !is_bounded_string(&fields[11], 1, 512)
    {
        return Err(
            "人工验证请求缺少 manual-review、时间图摘要、媒体身份或复核证据摘要。".to_string(),
        );
    }
    Ok(())
}

fn validate_verification_request(request: &VerifyManualVerificationRequest) -> Result<(), String> {
    validate_bounded_text("verificationId", &request.verification_id)?;
    validate_bounded_text("issuerKeyId", &request.issuer_key_id)?;
    validate_hex("signature", &request.signature, 64)?;
    validate_sha256_digest("requestDigest", &request.request_digest)?;
    if request.request_payload.len() > MAX_REQUEST_PAYLOAD_BYTES {
        return Err("人工验证规范化请求超过 32 KiB 限制。".to_string());
    }
    Ok(())
}

fn validate_revocation_request(request: &RevokeManualVerificationRequest) -> Result<(), String> {
    validate_bounded_text("verificationId", &request.verification_id)?;
    validate_bounded_text("issuerKeyId", &request.issuer_key_id)?;
    validate_hex("signature", &request.signature, 64)?;
    validate_sha256_digest("requestDigest", &request.request_digest)?;
    validate_bounded_text("reason", &request.reason)?;
    validate_bounded_text("revokedBy", &request.revoked_by)?;
    validate_bounded_text("revokedAt", &request.revoked_at)
}

fn load_or_create_authority_key(root: &Path) -> Result<AuthorityKeyFile, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建人工验证机构目录：{error}"))?;
    let key_path = root.join("authority-key-v1.json");
    if key_path.exists() {
        return read_authority_key(&key_path);
    }
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).map_err(|error| format!("无法生成安装级随机密钥：{error}"))?;
    let secret_hex = hex_encode(&secret);
    let key_id = format!("install-sha256:{}", &sha256_hex(&secret)[..32]);
    let key = AuthorityKeyFile {
        version: AUTHORITY_VERSION,
        key_id,
        secret_hex,
    };
    let bytes =
        serde_json::to_vec(&key).map_err(|error| format!("无法序列化安装级验证密钥：{error}"))?;
    write_atomic_new(&key_path, &bytes)?;
    read_authority_key(&key_path)
}

fn read_authority_key(path: &Path) -> Result<AuthorityKeyFile, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("无法读取安装级验证密钥：{error}"))?;
    let key: AuthorityKeyFile = serde_json::from_slice(&bytes)
        .map_err(|_| "安装级验证密钥文件已损坏；所有持久化人工验证均按不可信处理。".to_string())?;
    if key.version != AUTHORITY_VERSION
        || !key.key_id.starts_with("install-sha256:")
        || decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥").is_err()
    {
        return Err("安装级验证密钥格式无效；所有持久化人工验证均按不可信处理。".to_string());
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_id = format!("install-sha256:{}", &sha256_hex(&secret)[..32]);
    if key.key_id != expected_id {
        return Err("安装级验证密钥 ID 与密钥内容不一致；已阻断验证。".to_string());
    }
    Ok(key)
}

fn load_events(root: &Path) -> Result<Vec<AuthorityEvent>, String> {
    let events_dir = root.join("events");
    if !events_dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(&events_dir)
        .map_err(|error| format!("无法读取人工验证撤销注册表：{error}"))?
        .map(|entry| entry.map(|value| value.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法枚举人工验证撤销注册表：{error}"))?;
    paths.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "json")
    });
    paths.sort();
    let mut events = Vec::with_capacity(paths.len());
    let mut previous_sequence = 0_u64;
    for path in paths {
        let bytes = fs::read(&path)
            .map_err(|error| format!("无法读取人工验证注册事件 {}：{error}", path.display()))?;
        let event: AuthorityEvent = serde_json::from_slice(&bytes).map_err(|_| {
            format!(
                "人工验证注册事件 {} 已损坏；为防止撤销丢失，所有验证均已阻断。",
                path.display()
            )
        })?;
        let sequence = event_sequence(&event);
        if sequence <= previous_sequence || event_version(&event) != AUTHORITY_VERSION {
            return Err(
                "人工验证注册表序号或版本无效；为避免回滚攻击，所有验证均已阻断。".to_string(),
            );
        }
        previous_sequence = sequence;
        events.push(event);
    }
    Ok(events)
}

fn append_immutable_event(
    root: &Path,
    sequence: u64,
    verification_id: &str,
    kind: &str,
    event: &AuthorityEvent,
) -> Result<(), String> {
    let events_dir = root.join("events");
    fs::create_dir_all(&events_dir)
        .map_err(|error| format!("无法创建人工验证注册表目录：{error}"))?;
    let safe_id: String = verification_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(64)
        .collect();
    let path = events_dir.join(format!("{sequence:020}-{safe_id}-{kind}.json"));
    let bytes = serde_json::to_vec(event)
        .map_err(|error| format!("无法序列化人工验证注册事件：{error}"))?;
    write_atomic_new(&path, &bytes)
}

fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "人工验证持久化路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建人工验证持久化目录：{error}"))?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("event"),
        random_hex(8)?
    ));
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("无法创建人工验证临时文件：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法同步人工验证临时文件：{error}"))?;
        fs::rename(&temp_path, path)
            .map_err(|error| format!("无法原子提交人工验证记录：{error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn next_sequence(events: &[AuthorityEvent]) -> Result<u64, String> {
    events
        .last()
        .map(event_sequence)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| "人工验证注册表序号已经溢出。".to_string())
}

fn event_sequence(event: &AuthorityEvent) -> u64 {
    match event {
        AuthorityEvent::Issue { sequence, .. } | AuthorityEvent::Revoke { sequence, .. } => {
            *sequence
        }
    }
}

fn event_version(event: &AuthorityEvent) -> u8 {
    match event {
        AuthorityEvent::Issue { version, .. } | AuthorityEvent::Revoke { version, .. } => *version,
    }
}

fn issue_signature_message(verification_id: &str, sequence: u64, request_digest: &str) -> String {
    format!("{ISSUE_DOMAIN}\0{verification_id}\0{sequence}\0{request_digest}")
}

fn revocation_signature_message(
    sequence: u64,
    request: &RevokeManualVerificationRequest,
) -> String {
    format!(
        "{REVOCATION_DOMAIN}\0{}\0{}\0{}\0{}\0{}\0{}",
        request.verification_id,
        sequence,
        request.request_digest,
        request.reason,
        request.revoked_by,
        request.revoked_at
    )
}

fn digest_payload(payload: &str) -> String {
    format!("sha256:{}", sha256_hex(payload.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hmac_sha256_hex(key: &[u8; 32], message: &[u8]) -> String {
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    hex_encode(&outer.finalize())
}

fn random_hex(byte_count: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|error| format!("系统随机数生成失败：{error}"))?;
    Ok(hex_encode(&bytes))
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

fn decode_fixed_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    if value.len() != N * 2 {
        return Err(format!("{label}长度无效。"));
    }
    let mut output = [0_u8; N];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] =
            (hex_value(pair[0]).ok_or_else(|| format!("{label}包含非十六进制字符。"))? << 4)
                | hex_value(pair[1]).ok_or_else(|| format!("{label}包含非十六进制字符。"))?;
    }
    Ok(output)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn constant_time_hex_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn validate_bounded_text(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 {
        return Err(format!("人工验证字段 {label} 必须是 1 到 512 个字符。"));
    }
    Ok(())
}

fn validate_sha256_digest(label: &str, value: &str) -> Result<(), String> {
    if !value.starts_with("sha256:") || validate_hex(label, &value[7..], 64).is_err() {
        return Err(format!("人工验证字段 {label} 不是规范 SHA-256 摘要。"));
    }
    Ok(())
}

fn validate_hex(label: &str, value: &str, length: usize) -> Result<(), String> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "人工验证字段 {label} 不是 {length} 位小写十六进制。"
        ));
    }
    Ok(())
}

fn is_bounded_string(value: &Value, minimum: usize, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.trim().len() >= minimum && text.len() <= maximum)
}

fn is_sha256_digest_value(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| validate_sha256_digest("digest", text).is_ok())
}

fn is_content_identity_array(value: &Value) -> bool {
    value.as_array().is_some_and(|fields| {
        fields.len() == 6
            && is_bounded_string(&fields[0], 1, 128)
            && fields[1].as_u64().is_some()
            && fields[2].as_u64().is_some()
            && is_bounded_string(&fields[3], 1, 256)
            && is_bounded_string(&fields[4], 1, 256)
            && is_bounded_string(&fields[5], 1, 256)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn issued_record_survives_reload_and_payload_tampering_fails_closed() {
        let root = test_root("issue-verify");
        let request = issue_request("map-1");
        let seal = issue_at(&root, request).unwrap();
        let active = verify_at(&root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(active.status, "active");

        let tampered = verify_at(&root, verify_request(&seal, "map-2")).unwrap();
        assert_eq!(tampered.status, "invalid");
        assert!(tampered.reason.contains("摘要"));
        assert_no_temp_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoke_is_durable_idempotent_and_cannot_be_reactivated_by_project_record() {
        let root = test_root("revoke");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        let request = RevokeManualVerificationRequest {
            verification_id: seal.verification_id.clone(),
            issuer_key_id: seal.issuer_key_id.clone(),
            signature: seal.signature.clone(),
            request_digest: seal.request_digest.clone(),
            reason: "边界复核失败".to_string(),
            revoked_by: "reviewer-1".to_string(),
            revoked_at: "2026-07-12T00:00:00.000Z".to_string(),
        };
        let first = revoke_at(&root, clone_revocation_request(&request)).unwrap();
        let repeated = revoke_at(&root, request).unwrap();
        assert_eq!(first.signature, repeated.signature);

        let result = verify_at(&root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(result.status, "revoked");
        assert!(result.reason.contains("不能恢复"));
        assert_no_temp_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_installation_or_lost_key_never_trusts_existing_project_signature() {
        let first_root = test_root("first-install");
        let second_root = test_root("second-install");
        let seal = issue_at(&first_root, issue_request("map-1")).unwrap();
        let result = verify_at(&second_root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(result.status, "unknown");
        assert!(result.reason.contains("另一安装"));
        fs::remove_file(first_root.join("authority-key-v1.json")).unwrap();
        let lost_key_result = verify_at(&first_root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(lost_key_result.status, "unknown");
        assert!(lost_key_result.reason.contains("密钥已丢失"));
        fs::remove_dir_all(first_root).unwrap();
        fs::remove_dir_all(second_root).unwrap();
    }

    #[test]
    fn corrupted_registry_blocks_all_verification_instead_of_ignoring_revocations() {
        let root = test_root("corrupt-registry");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        let events = root.join("events");
        fs::write(
            events.join("99999999999999999999-corrupt-revoke.json"),
            b"{",
        )
        .unwrap();
        let error = verify_at(&root, verify_request(&seal, "map-1")).unwrap_err();
        assert!(error.contains("所有验证均已阻断"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hmac_sha256_matches_known_vector() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 32], b"Hi There"),
            "198a607eb44bfbc69903a0f1cf2bbdc5ba0aa3f3d9ae3c1c7a3b1696a0b68cf7"
        );
    }

    fn issue_request(map_id: &str) -> IssueManualVerificationRequest {
        let payload = payload(map_id);
        IssueManualVerificationRequest {
            request_digest: digest_payload(&payload),
            request_payload: payload,
        }
    }

    fn verify_request(
        seal: &ManualVerificationSeal,
        map_id: &str,
    ) -> VerifyManualVerificationRequest {
        VerifyManualVerificationRequest {
            verification_id: seal.verification_id.clone(),
            issuer_key_id: seal.issuer_key_id.clone(),
            signature: seal.signature.clone(),
            request_payload: payload(map_id),
            request_digest: seal.request_digest.clone(),
        }
    }

    fn payload(map_id: &str) -> String {
        serde_json::json!([
            "manual-time-map-verification-request-v1",
            "manual-review",
            map_id,
            1,
            format!("sha256:{}", "1".repeat(64)),
            ["sha256-full-file-v2", 1000, 100, "1", "2", "3"],
            ["sha256-full-file-v2", 2000, 200, "4", "5", "6"],
            "manual-a-b-review",
            "1",
            format!("sha256:{}", "2".repeat(64)),
            "reviewer-1",
            "2026-07-12T00:00:00.000Z"
        ])
        .to_string()
    }

    fn clone_revocation_request(
        request: &RevokeManualVerificationRequest,
    ) -> RevokeManualVerificationRequest {
        RevokeManualVerificationRequest {
            verification_id: request.verification_id.clone(),
            issuer_key_id: request.issuer_key_id.clone(),
            signature: request.signature.clone(),
            request_digest: request.request_digest.clone(),
            reason: request.reason.clone(),
            revoked_by: request.revoked_by.clone(),
            revoked_at: request.revoked_at.clone(),
        }
    }

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "danmaku-manual-verification-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn assert_no_temp_files(root: &Path) {
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    assert_ne!(
                        path.extension().and_then(|extension| extension.to_str()),
                        Some("tmp")
                    );
                }
            }
        }
    }
}
