use reqwest::{
    header::{HeaderName, HeaderValue},
    Method, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

mod app_settings;
mod audio_alignment;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            app_settings::load_app_settings_file,
            app_settings::save_app_settings_file,
            app_settings::clear_app_settings_file,
            emby_http_request,
            audio_alignment::align_audio_files,
            audio_alignment::start_audio_alignment_job,
            audio_alignment::get_audio_alignment_job,
            audio_alignment::cancel_audio_alignment_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[derive(Debug, Deserialize)]
struct EmbyHttpHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct EmbyHttpRequest {
    url: String,
    method: String,
    headers: Vec<EmbyHttpHeader>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
struct EmbyHttpResponse {
    status: u16,
    body: Value,
}

#[tauri::command]
async fn emby_http_request(request: EmbyHttpRequest) -> Result<EmbyHttpResponse, String> {
    let url = parse_emby_url(&request.url)?;
    let method = parse_emby_method(&request.method)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Emby 桌面代理初始化失败：{error}"))?;
    let mut builder = client.request(method, url);

    for header in &request.headers {
        builder = append_allowed_header(builder, header)?;
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("Emby 桌面代理请求失败：{error}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Emby 桌面代理读取响应失败：{error}"))?;

    Ok(EmbyHttpResponse {
        status,
        body: parse_json_response_body(&text),
    })
}

fn parse_emby_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("Emby URL 格式无效：{error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Emby 桌面代理只允许 http 或 https 地址。".to_string()),
    }
}

fn parse_emby_method(raw: &str) -> Result<Method, String> {
    match raw.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err("Emby 桌面代理仅支持 GET 和 POST 请求。".to_string()),
    }
}

fn append_allowed_header(
    builder: reqwest::RequestBuilder,
    header: &EmbyHttpHeader,
) -> Result<reqwest::RequestBuilder, String> {
    if !is_allowed_emby_proxy_header(&header.name) {
        return Err(format!("Emby 桌面代理不允许转发请求头：{}", header.name));
    }
    let name = HeaderName::from_bytes(header.name.as_bytes())
        .map_err(|error| format!("Emby 请求头名称无效：{error}"))?;
    let value = HeaderValue::from_str(&header.value)
        .map_err(|error| format!("Emby 请求头内容无效：{error}"))?;
    Ok(builder.header(name, value))
}

fn is_allowed_emby_proxy_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "x-emby-authorization" | "x-emby-token"
    )
}

fn parse_json_response_body(text: &str) -> Value {
    if text.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(text)
        .unwrap_or_else(|_| json!({ "Message": truncate_response_text(text) }))
}

fn truncate_response_text(text: &str) -> String {
    const MAX_CHARS: usize = 400;
    let mut truncated: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        truncated.push_str("...");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emby_proxy_accepts_only_http_urls() {
        assert!(parse_emby_url("https://example.test/emby").is_ok());
        assert!(parse_emby_url("http://127.0.0.1:8096").is_ok());
        assert!(parse_emby_url("file:///tmp/emby").is_err());
    }

    #[test]
    fn emby_proxy_limits_methods_and_headers() {
        assert_eq!(parse_emby_method("post").unwrap(), Method::POST);
        assert!(parse_emby_method("DELETE").is_err());
        assert!(is_allowed_emby_proxy_header("X-Emby-Token"));
        assert!(!is_allowed_emby_proxy_header("Cookie"));
    }

    #[test]
    fn emby_proxy_keeps_non_json_errors_readable() {
        let body = parse_json_response_body("<html>not json</html>");
        assert_eq!(body["Message"], "<html>not json</html>");
    }
}
