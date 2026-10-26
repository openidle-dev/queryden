//! AI provider HTTP. Lives in Rust because the webview CSP blocks provider
//! hosts, Anthropic rejects browser origins, and local servers lack CORS.
//! The API key is only ever sent as a request header and is scrubbed from
//! every error string returned to the frontend.

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const OPENAI_BASE: &str = "https://api.openai.com";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const GOOGLE_BASE: &str = "https://generativelanguage.googleapis.com";
const OLLAMA_BASE: &str = "http://localhost:11434";
const LM_STUDIO_BASE: &str = "http://localhost:1234";

const ANTHROPIC_VERSION: &str = "2023-06-01";
// Reasoning models spend completion tokens on thinking; leave headroom.
const OPENAI_MAX_COMPLETION_TOKENS: u32 = 16_384;
// The lowest output ceiling of any Claude model the Models API still lists.
const ANTHROPIC_MAX_TOKENS: u32 = 4_096;

const MAX_PAGES: usize = 50;
const ERROR_BODY_LIMIT: usize = 600;

// Name segments of model families that cannot answer a text chat request
// (embeddings, speech, image generation, moderation, legacy completions).
const NON_CHAT_MARKERS: &[&str] = &[
    "embed",
    "whisper",
    "tts",
    "dall",
    "davinci",
    "babbage",
    "moderation",
    "transcribe",
    "realtime",
    "audio",
    "image",
    "sora",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AiModel {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    OpenAi,
    Anthropic,
    Google,
    Local,
}

impl Provider {
    fn parse(name: &str) -> Result<Self, String> {
        match name {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "google" => Ok(Self::Google),
            "local" => Ok(Self::Local),
            other => Err(format!("Unknown AI provider '{other}'")),
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Google => "Google Gemini",
            Self::Local => "Local model server",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalFlavor {
    Ollama,
    OpenAiCompatible,
}

impl LocalFlavor {
    fn display_name(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::OpenAiCompatible => "OpenAI-compatible server",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EndpointBase {
    base: String,
    hint: Option<LocalFlavor>,
}

#[derive(Debug, PartialEq, Eq)]
struct ModelPage {
    models: Vec<AiModel>,
    next_cursor: Option<String>,
}

struct Session {
    client: reqwest::Client,
    api_key: Option<String>,
    endpoint: Option<EndpointBase>,
}

impl Session {
    fn new(endpoint: Option<String>, api_key: Option<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        let endpoint = match non_empty(endpoint) {
            Some(raw) => Some(derive_base(&raw)?),
            None => None,
        };
        Ok(Self {
            client,
            api_key: non_empty(api_key),
            endpoint,
        })
    }

    fn base_or(&self, default: &str) -> String {
        self.endpoint
            .as_ref()
            .map_or_else(|| default.to_string(), |e| e.base.clone())
    }

    fn require_key(&self, provider: Provider) -> Result<&str, String> {
        self.api_key
            .as_deref()
            .ok_or_else(|| format!("{} needs an API key", provider.display_name()))
    }

    fn with_bearer(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.api_key.as_deref() {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }
}

#[tauri::command]
pub async fn ai_list_models(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<AiModel>, String> {
    let provider = Provider::parse(&provider)?;
    let session = Session::new(endpoint, api_key)?;
    list_models(provider, &session)
        .await
        .map_err(|e| redact(e, session.api_key.as_deref()))
}

#[tauri::command]
pub async fn ai_complete(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<String, String> {
    let provider = Provider::parse(&provider)?;
    let model = model.trim();
    if model.is_empty() {
        return Err("No AI model selected. Pick one in Settings → AI Assistant.".to_string());
    }
    let session = Session::new(endpoint, api_key)?;
    complete(provider, &session, model, &system_prompt, &user_prompt)
        .await
        .map_err(|e| redact(e, session.api_key.as_deref()))
}

// ─── Listing ─────────────────────────────────────────────────────────────────

async fn list_models(provider: Provider, session: &Session) -> Result<Vec<AiModel>, String> {
    match provider {
        Provider::OpenAi => {
            if session.endpoint.is_none() {
                session.require_key(provider)?;
            }
            let base = session.base_or(OPENAI_BASE);
            list_openai_compatible(session, &base, provider.display_name()).await
        }
        Provider::Anthropic => list_anthropic(session).await,
        Provider::Google => list_google(session).await,
        Provider::Local => find_local_server(session).await.map(|server| server.models),
    }
}

async fn list_openai_compatible(
    session: &Session,
    base: &str,
    label: &str,
) -> Result<Vec<AiModel>, String> {
    let url = format!("{base}/v1/models");
    let request = session.with_bearer(session.client.get(&url).timeout(LIST_TIMEOUT));
    let body = send_json(request, label, &url).await?;
    parse_openai_models(&body)
}

async fn list_anthropic(session: &Session) -> Result<Vec<AiModel>, String> {
    let key = session.require_key(Provider::Anthropic)?;
    let url = format!("{}/v1/models", session.base_or(ANTHROPIC_BASE));
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("limit", "1000".to_string())];
        if let Some(after_id) = &cursor {
            query.push(("after_id", after_id.clone()));
        }
        let request = session
            .client
            .get(&url)
            .query(&query)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .timeout(LIST_TIMEOUT);
        let page = parse_anthropic_models_page(&send_json(request, "Anthropic", &url).await?)?;
        models.extend(page.models);
        match page.next_cursor {
            Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
            _ => break,
        }
    }
    Ok(models)
}

async fn list_google(session: &Session) -> Result<Vec<AiModel>, String> {
    let key = session.require_key(Provider::Google)?;
    let url = format!("{}/v1beta/models", session.base_or(GOOGLE_BASE));
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("pageSize", "1000".to_string())];
        if let Some(token) = &cursor {
            query.push(("pageToken", token.clone()));
        }
        // Header instead of `?key=` keeps the key out of URLs and error text.
        let request = session
            .client
            .get(&url)
            .query(&query)
            .header("x-goog-api-key", key)
            .timeout(LIST_TIMEOUT);
        let page = parse_google_models_page(&send_json(request, "Google Gemini", &url).await?)?;
        models.extend(page.models);
        match page.next_cursor {
            Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
            _ => break,
        }
    }
    Ok(models)
}

struct LocalServer {
    flavor: LocalFlavor,
    base: String,
    models: Vec<AiModel>,
}

fn local_candidates(endpoint: Option<&EndpointBase>) -> Vec<(LocalFlavor, String)> {
    match endpoint {
        Some(EndpointBase {
            base,
            hint: Some(flavor),
        }) => vec![(*flavor, base.clone())],
        Some(EndpointBase { base, hint: None }) => vec![
            (LocalFlavor::Ollama, base.clone()),
            (LocalFlavor::OpenAiCompatible, base.clone()),
        ],
        None => vec![
            (LocalFlavor::Ollama, OLLAMA_BASE.to_string()),
            (LocalFlavor::OpenAiCompatible, LM_STUDIO_BASE.to_string()),
        ],
    }
}

async fn list_local_flavor(
    session: &Session,
    flavor: LocalFlavor,
    base: &str,
) -> Result<Vec<AiModel>, String> {
    match flavor {
        LocalFlavor::Ollama => {
            let url = format!("{base}/api/tags");
            let request = session.with_bearer(session.client.get(&url).timeout(LIST_TIMEOUT));
            parse_ollama_tags(&send_json(request, flavor.display_name(), &url).await?)
        }
        LocalFlavor::OpenAiCompatible => {
            list_openai_compatible(session, base, flavor.display_name()).await
        }
    }
}

async fn find_local_server(session: &Session) -> Result<LocalServer, String> {
    let candidates = local_candidates(session.endpoint.as_ref());
    let mut failures = Vec::with_capacity(candidates.len());
    for (flavor, base) in candidates {
        match list_local_flavor(session, flavor, &base).await {
            Ok(models) => return Ok(LocalServer { flavor, base, models }),
            Err(e) => failures.push(e),
        }
    }
    if failures.len() == 1 {
        return Err(failures.remove(0));
    }
    Err(format!("No local model server responded.\n{}", failures.join("\n")))
}

// ─── Completion ──────────────────────────────────────────────────────────────

async fn complete(
    provider: Provider,
    session: &Session,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    match provider {
        Provider::OpenAi => {
            if session.endpoint.is_none() {
                session.require_key(provider)?;
            }
            let url = format!("{}/v1/chat/completions", session.base_or(OPENAI_BASE));
            let body = openai_chat_body(
                model,
                system_prompt,
                user_prompt,
                Some(OPENAI_MAX_COMPLETION_TOKENS),
            );
            let request =
                session.with_bearer(session.client.post(&url).json(&body).timeout(COMPLETE_TIMEOUT));
            parse_openai_chat(&send_json(request, provider.display_name(), &url).await?)
        }
        Provider::Anthropic => {
            let key = session.require_key(provider)?;
            let url = format!("{}/v1/messages", session.base_or(ANTHROPIC_BASE));
            let request = session
                .client
                .post(&url)
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&anthropic_message_body(model, system_prompt, user_prompt))
                .timeout(COMPLETE_TIMEOUT);
            parse_anthropic_message(&send_json(request, provider.display_name(), &url).await?)
        }
        Provider::Google => {
            let key = session.require_key(provider)?;
            let model_id = gemini_model_id(model)?;
            let url = format!(
                "{}/v1beta/models/{model_id}:generateContent",
                session.base_or(GOOGLE_BASE)
            );
            let request = session
                .client
                .post(&url)
                .header("x-goog-api-key", key)
                .json(&gemini_body(system_prompt, user_prompt))
                .timeout(COMPLETE_TIMEOUT);
            parse_gemini_response(&send_json(request, provider.display_name(), &url).await?)
        }
        Provider::Local => {
            // A typed route (/api/chat, /v1/...) names the server kind; otherwise
            // probe the candidates and use whichever answers.
            let (flavor, base) = match local_candidates(session.endpoint.as_ref()).as_slice() {
                [(flavor, base)] => (*flavor, base.clone()),
                _ => {
                    let server = find_local_server(session).await?;
                    (server.flavor, server.base)
                }
            };
            complete_local(session, flavor, &base, model, system_prompt, user_prompt).await
        }
    }
}

async fn complete_local(
    session: &Session,
    flavor: LocalFlavor,
    base: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    match flavor {
        LocalFlavor::Ollama => {
            let url = format!("{base}/api/chat");
            let body = ollama_chat_body(model, system_prompt, user_prompt);
            let request =
                session.with_bearer(session.client.post(&url).json(&body).timeout(COMPLETE_TIMEOUT));
            parse_ollama_chat(&send_json(request, flavor.display_name(), &url).await?)
        }
        LocalFlavor::OpenAiCompatible => {
            let url = format!("{base}/v1/chat/completions");
            let body = openai_chat_body(model, system_prompt, user_prompt, None);
            let request =
                session.with_bearer(session.client.post(&url).json(&body).timeout(COMPLETE_TIMEOUT));
            parse_openai_chat(&send_json(request, flavor.display_name(), &url).await?)
        }
    }
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

async fn send_json(
    request: reqwest::RequestBuilder,
    label: &str,
    url: &str,
) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| format!("Could not reach {label} at {url}: {}", describe_transport_error(&e)))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read {label} response: {}", describe_transport_error(&e)))?;
    if !status.is_success() {
        return Err(format!(
            "{label} returned HTTP {}: {}",
            status.as_u16(),
            extract_error_message(&body)
        ));
    }
    serde_json::from_str(&body).map_err(|e| format!("{label} returned invalid JSON from {url}: {e}"))
}

// reqwest's own Display embeds the request URL; build the message from the
// source chain instead so nothing request-specific leaks.
fn describe_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "request timed out".to_string();
    }
    let kind = if error.is_connect() {
        "connection failed"
    } else {
        "request failed"
    };
    let mut innermost = None;
    let mut source = std::error::Error::source(error);
    while let Some(inner) = source {
        innermost = Some(inner.to_string());
        source = inner.source();
    }
    match innermost {
        Some(detail) => format!("{kind} ({detail})"),
        None => kind.to_string(),
    }
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn redact(message: String, api_key: Option<&str>) -> String {
    match api_key {
        Some(key) if key.len() >= 4 => message.replace(key, "[redacted]"),
        _ => message,
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

fn extract_error_message(body: &str) -> String {
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        let candidates = [
            json.pointer("/error/message"),
            json.get("error"),
            json.get("message"),
            json.get("detail"),
        ];
        for candidate in candidates.into_iter().flatten() {
            if let Some(text) = candidate.as_str().map(str::trim).filter(|t| !t.is_empty()) {
                return truncate_chars(text, ERROR_BODY_LIMIT);
            }
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "empty response body".to_string()
    } else {
        truncate_chars(trimmed, ERROR_BODY_LIMIT)
    }
}

fn is_version_segment(segment: &str) -> bool {
    let Some(rest) = segment.strip_prefix('v') else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// Reduces a user-entered endpoint (bare host, base URL, or a full chat URL)
/// to `scheme://host[:port][/prefix]`, dropping credentials, query, and any
/// API-version or route suffix so callers can append their own route.
fn derive_base(endpoint: &str) -> Result<EndpointBase, String> {
    let raw = endpoint.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|e| format!("Invalid endpoint URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Endpoint must use http or https, not '{}'", url.scheme()));
    }
    let host = url.host_str().ok_or("Endpoint URL has no host")?;
    let mut base = match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    };

    let segments: Vec<&str> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    let (kept, hint) = if let Some(pos) = segments.iter().position(|s| is_version_segment(s)) {
        (&segments[..pos], Some(LocalFlavor::OpenAiCompatible))
    } else if let Some(pos) = segments.iter().rposition(|s| *s == "api") {
        let tail = &segments[pos + 1..];
        if tail.is_empty() || (tail.len() == 1 && matches!(tail[0], "chat" | "generate" | "tags")) {
            (&segments[..pos], Some(LocalFlavor::Ollama))
        } else {
            (&segments[..], None)
        }
    } else {
        (&segments[..], None)
    };
    for segment in kept {
        base.push('/');
        base.push_str(segment);
    }
    Ok(EndpointBase { base, hint })
}

fn looks_like_chat_model(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    !lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|segment| NON_CHAT_MARKERS.iter().any(|marker| segment.starts_with(marker)))
}

fn gemini_model_id(model: &str) -> Result<&str, String> {
    let id = model.strip_prefix("models/").unwrap_or(model);
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
    if valid {
        Ok(id)
    } else {
        Err(format!("'{model}' is not a valid Gemini model id"))
    }
}

fn parse_openai_models(body: &Value) -> Result<Vec<AiModel>, String> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Unexpected models response: missing 'data' array")?;
    let mut models: Vec<AiModel> = data
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim();
            if id.is_empty() || !looks_like_chat_model(id) {
                return None;
            }
            let label = entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(id);
            Some(AiModel {
                id: id.to_string(),
                label: label.to_string(),
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn parse_anthropic_models_page(body: &Value) -> Result<ModelPage, String> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Unexpected Anthropic models response: missing 'data' array")?;
    let models = data
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            let label = entry
                .get("display_name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(id);
            Some(AiModel {
                id: id.to_string(),
                label: label.to_string(),
            })
        })
        .collect();
    let has_more = body.get("has_more").and_then(Value::as_bool).unwrap_or(false);
    let next_cursor = if has_more {
        body.get("last_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    Ok(ModelPage { models, next_cursor })
}

fn parse_google_models_page(body: &Value) -> Result<ModelPage, String> {
    let Some(entries) = body.get("models") else {
        // An account with no models returns `{}`; anything else is malformed.
        return if body.as_object().is_some_and(|o| o.is_empty()) {
            Ok(ModelPage {
                models: Vec::new(),
                next_cursor: None,
            })
        } else {
            Err("Unexpected Gemini models response: missing 'models' array".to_string())
        };
    };
    let entries = entries
        .as_array()
        .ok_or("Unexpected Gemini models response: 'models' is not an array")?;
    let models = entries
        .iter()
        .filter_map(|entry| {
            let supports_chat = entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_some_and(|methods| methods.iter().any(|m| m.as_str() == Some("generateContent")));
            if !supports_chat {
                return None;
            }
            let name = entry.get("name")?.as_str()?;
            let id = name.strip_prefix("models/").unwrap_or(name);
            if id.is_empty() || !looks_like_chat_model(id) {
                return None;
            }
            let label = entry
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(id);
            Some(AiModel {
                id: id.to_string(),
                label: label.to_string(),
            })
        })
        .collect();
    let next_cursor = body
        .get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    Ok(ModelPage { models, next_cursor })
}

fn parse_ollama_tags(body: &Value) -> Result<Vec<AiModel>, String> {
    let entries = body
        .get("models")
        .and_then(Value::as_array)
        .ok_or("Unexpected Ollama response: missing 'models' array")?;
    let mut models: Vec<AiModel> = entries
        .iter()
        .filter_map(|entry| {
            let name = entry
                .get("name")
                .or_else(|| entry.get("model"))?
                .as_str()?
                .trim();
            if name.is_empty() || !looks_like_chat_model(name) {
                return None;
            }
            Some(AiModel {
                id: name.to_string(),
                label: name.to_string(),
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    Ok(models)
}

fn openai_chat_body(
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_completion_tokens: Option<u32>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt },
        ],
    });
    if let Some(limit) = max_completion_tokens {
        body["max_completion_tokens"] = json!(limit);
    }
    body
}

fn anthropic_message_body(model: &str, system_prompt: &str, user_prompt: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": system_prompt,
        "messages": [{ "role": "user", "content": user_prompt }],
    })
}

fn gemini_body(system_prompt: &str, user_prompt: &str) -> Value {
    json!({
        "systemInstruction": { "parts": [{ "text": system_prompt }] },
        "contents": [{ "role": "user", "parts": [{ "text": user_prompt }] }],
    })
}

fn ollama_chat_body(model: &str, system_prompt: &str, user_prompt: &str) -> Value {
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt },
        ],
        "stream": false,
    })
}

fn no_text_error(stop_reason: Option<&str>, token_limit_reasons: &[&str]) -> String {
    match stop_reason {
        Some(reason) if token_limit_reasons.contains(&reason) => {
            "The model used its whole output budget before producing an answer.".to_string()
        }
        Some(reason) => format!("The model returned no text (stop reason: {reason})."),
        None => "The model returned no text.".to_string(),
    }
}

fn parse_openai_chat(body: &Value) -> Result<String, String> {
    let choice = body
        .pointer("/choices/0")
        .ok_or("Unexpected chat response: no choices returned")?;
    let message = choice.get("message");
    let content = message.and_then(|m| m.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    };
    if !text.trim().is_empty() {
        return Ok(text);
    }
    if let Some(refusal) = message
        .and_then(|m| m.get("refusal"))
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
    {
        return Err(format!("The model refused the request: {refusal}"));
    }
    Err(no_text_error(
        choice.get("finish_reason").and_then(Value::as_str),
        &["length"],
    ))
}

fn parse_anthropic_message(body: &Value) -> Result<String, String> {
    let blocks = body
        .get("content")
        .and_then(Value::as_array)
        .ok_or("Unexpected Anthropic response: missing 'content' array")?;
    let text: String = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    Err(no_text_error(
        body.get("stop_reason").and_then(Value::as_str),
        &["max_tokens"],
    ))
}

fn parse_gemini_response(body: &Value) -> Result<String, String> {
    let Some(candidate) = body.pointer("/candidates/0") else {
        let reason = body
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str);
        return Err(match reason {
            Some(reason) => format!("Gemini blocked the prompt ({reason})."),
            None => "Unexpected Gemini response: no candidates returned".to_string(),
        });
    };
    let text: String = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    Err(no_text_error(
        candidate.get("finishReason").and_then(Value::as_str),
        &["MAX_TOKENS"],
    ))
}

fn parse_ollama_chat(body: &Value) -> Result<String, String> {
    if let Some(text) = body
        .pointer("/message/content")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
    {
        return Ok(text.to_string());
    }
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        return Err(format!("Ollama error: {error}"));
    }
    Err(no_text_error(
        body.get("done_reason").and_then(Value::as_str),
        &["length"],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, label: &str) -> AiModel {
        AiModel {
            id: id.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn provider_parse_rejects_unknown() {
        assert_eq!(Provider::parse("openai"), Ok(Provider::OpenAi));
        assert_eq!(Provider::parse("local"), Ok(Provider::Local));
        assert!(Provider::parse("cohere").is_err());
    }

    #[test]
    fn derive_base_strips_routes_and_versions() {
        let cases = [
            ("https://api.openai.com/v1/chat/completions", "https://api.openai.com", Some(LocalFlavor::OpenAiCompatible)),
            ("https://openrouter.ai/api/v1", "https://openrouter.ai/api", Some(LocalFlavor::OpenAiCompatible)),
            ("http://localhost:1234/v1/models/", "http://localhost:1234", Some(LocalFlavor::OpenAiCompatible)),
            ("http://localhost:11434/api/chat", "http://localhost:11434", Some(LocalFlavor::Ollama)),
            ("http://localhost:11434/api", "http://localhost:11434", Some(LocalFlavor::Ollama)),
            ("http://localhost:11434", "http://localhost:11434", None),
            ("localhost:1234", "http://localhost:1234", None),
            ("https://proxy.example.com/llm/", "https://proxy.example.com/llm", None),
            (
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent?key=SECRET",
                "https://generativelanguage.googleapis.com",
                Some(LocalFlavor::OpenAiCompatible),
            ),
            ("http://user:pass@[::1]:8080/v1", "http://[::1]:8080", Some(LocalFlavor::OpenAiCompatible)),
        ];
        for (input, base, hint) in cases {
            let derived = derive_base(input).unwrap_or_else(|e| panic!("{input}: {e}"));
            assert_eq!(derived.base, base, "base for {input}");
            assert_eq!(derived.hint, hint, "hint for {input}");
        }
    }

    #[test]
    fn derive_base_rejects_non_http() {
        assert!(derive_base("ftp://example.com").is_err());
        assert!(derive_base("http://").is_err());
    }

    #[test]
    fn local_candidates_follow_endpoint_hint() {
        assert_eq!(
            local_candidates(None),
            vec![
                (LocalFlavor::Ollama, OLLAMA_BASE.to_string()),
                (LocalFlavor::OpenAiCompatible, LM_STUDIO_BASE.to_string()),
            ]
        );
        let lm_studio = derive_base("http://localhost:1234/v1/chat/completions").unwrap();
        assert_eq!(
            local_candidates(Some(&lm_studio)),
            vec![(LocalFlavor::OpenAiCompatible, "http://localhost:1234".to_string())]
        );
        let bare = derive_base("http://gpu-box:8000").unwrap();
        assert_eq!(
            local_candidates(Some(&bare)),
            vec![
                (LocalFlavor::Ollama, "http://gpu-box:8000".to_string()),
                (LocalFlavor::OpenAiCompatible, "http://gpu-box:8000".to_string()),
            ]
        );
    }

    #[test]
    fn openai_models_are_filtered_sorted_and_deduped() {
        let body = json!({
            "object": "list",
            "data": [
                { "id": "gpt-5.5", "object": "model", "created": 1, "owned_by": "openai" },
                { "id": "text-embedding-3-small", "object": "model" },
                { "id": "dall-e-3", "object": "model" },
                { "id": "gpt-4o-mini-tts", "object": "model" },
                { "id": "whisper-1", "object": "model" },
                { "id": "chatgpt-4o-latest", "object": "model" },
                { "id": "gpt-5.5", "object": "model" },
                { "id": "o4-mini", "object": "model" },
                { "object": "model" }
            ]
        });
        assert_eq!(
            parse_openai_models(&body).unwrap(),
            vec![
                model("chatgpt-4o-latest", "chatgpt-4o-latest"),
                model("gpt-5.5", "gpt-5.5"),
                model("o4-mini", "o4-mini"),
            ]
        );
    }

    #[test]
    fn openai_compatible_models_use_name_when_present() {
        let body = json!({ "data": [{ "id": "openai/gpt-4o", "name": "OpenAI: GPT-4o" }] });
        assert_eq!(
            parse_openai_models(&body).unwrap(),
            vec![model("openai/gpt-4o", "OpenAI: GPT-4o")]
        );
        assert!(parse_openai_models(&json!({ "error": "nope" })).is_err());
    }

    #[test]
    fn anthropic_page_reports_cursor_only_when_more() {
        let body = json!({
            "data": [
                { "type": "model", "id": "claude-opus-4-1-20250805", "display_name": "Claude Opus 4.1", "created_at": "2025-08-05T00:00:00Z" },
                { "type": "model", "id": "claude-haiku-x", "display_name": "" }
            ],
            "has_more": true,
            "first_id": "claude-opus-4-1-20250805",
            "last_id": "claude-haiku-x"
        });
        let page = parse_anthropic_models_page(&body).unwrap();
        assert_eq!(
            page.models,
            vec![
                model("claude-opus-4-1-20250805", "Claude Opus 4.1"),
                model("claude-haiku-x", "claude-haiku-x"),
            ]
        );
        assert_eq!(page.next_cursor.as_deref(), Some("claude-haiku-x"));

        let last = json!({ "data": [], "has_more": false, "last_id": null });
        assert_eq!(parse_anthropic_models_page(&last).unwrap().next_cursor, None);
    }

    #[test]
    fn google_page_keeps_generate_content_models() {
        let body = json!({
            "models": [
                { "name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "supportedGenerationMethods": ["generateContent", "countTokens"] },
                { "name": "models/text-embedding-004", "displayName": "Text Embedding 004", "supportedGenerationMethods": ["embedContent"] },
                { "name": "models/gemini-2.5-flash-preview-tts", "displayName": "TTS", "supportedGenerationMethods": ["generateContent"] },
                { "name": "models/imagen-4", "supportedGenerationMethods": ["predict"] },
                { "name": "models/gemma-3-27b-it", "supportedGenerationMethods": ["generateContent"] }
            ],
            "nextPageToken": "page-2"
        });
        let page = parse_google_models_page(&body).unwrap();
        assert_eq!(
            page.models,
            vec![
                model("gemini-2.5-flash", "Gemini 2.5 Flash"),
                model("gemma-3-27b-it", "gemma-3-27b-it"),
            ]
        );
        assert_eq!(page.next_cursor.as_deref(), Some("page-2"));

        let empty = parse_google_models_page(&json!({})).unwrap();
        assert!(empty.models.is_empty() && empty.next_cursor.is_none());
        assert!(parse_google_models_page(&json!({ "error": {} })).is_err());
    }

    #[test]
    fn ollama_tags_parse_names() {
        let body = json!({
            "models": [
                { "name": "qwen2.5-coder:7b", "model": "qwen2.5-coder:7b", "size": 1 },
                { "name": "llama3.2:latest", "model": "llama3.2:latest" },
                { "name": "nomic-embed-text:latest" }
            ]
        });
        assert_eq!(
            parse_ollama_tags(&body).unwrap(),
            vec![
                model("llama3.2:latest", "llama3.2:latest"),
                model("qwen2.5-coder:7b", "qwen2.5-coder:7b"),
            ]
        );
        assert!(parse_ollama_tags(&json!({ "error": "Unexpected endpoint" })).is_err());
    }

    #[test]
    fn openai_body_uses_max_completion_tokens_without_temperature() {
        let body = openai_chat_body("gpt-5.5", "sys", "usr", Some(123));
        assert_eq!(body["max_completion_tokens"], json!(123));
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "usr");

        let local = openai_chat_body("m", "s", "u", None);
        assert!(local.get("max_completion_tokens").is_none());
    }

    #[test]
    fn provider_bodies_carry_system_prompt() {
        let anthropic = anthropic_message_body("claude-x", "sys", "usr");
        assert_eq!(anthropic["system"], "sys");
        assert_eq!(anthropic["max_tokens"], json!(ANTHROPIC_MAX_TOKENS));
        assert_eq!(anthropic["messages"][0]["content"], "usr");

        let gemini = gemini_body("sys", "usr");
        assert_eq!(gemini["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(gemini["contents"][0]["parts"][0]["text"], "usr");

        let ollama = ollama_chat_body("llama3.2", "sys", "usr");
        assert_eq!(ollama["stream"], json!(false));
        assert_eq!(ollama["messages"][0]["content"], "sys");
    }

    #[test]
    fn openai_chat_parsing() {
        let ok = json!({ "choices": [{ "message": { "role": "assistant", "content": "SELECT 1;" }, "finish_reason": "stop" }] });
        assert_eq!(parse_openai_chat(&ok).unwrap(), "SELECT 1;");

        let truncated = json!({ "choices": [{ "message": { "content": "" }, "finish_reason": "length" }] });
        assert!(parse_openai_chat(&truncated).unwrap_err().contains("output budget"));

        let refused = json!({ "choices": [{ "message": { "content": null, "refusal": "no" }, "finish_reason": "stop" }] });
        assert!(parse_openai_chat(&refused).unwrap_err().contains("refused"));

        assert!(parse_openai_chat(&json!({ "choices": [] })).is_err());
    }

    #[test]
    fn anthropic_message_parsing_joins_text_blocks() {
        let ok = json!({
            "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "SELECT " },
                { "type": "text", "text": "1;" }
            ],
            "stop_reason": "end_turn"
        });
        assert_eq!(parse_anthropic_message(&ok).unwrap(), "SELECT 1;");

        let truncated = json!({ "content": [], "stop_reason": "max_tokens" });
        assert!(parse_anthropic_message(&truncated).unwrap_err().contains("output budget"));
    }

    #[test]
    fn gemini_parsing_skips_thoughts_and_reports_blocks() {
        let ok = json!({
            "candidates": [{
                "content": { "role": "model", "parts": [
                    { "text": "thinking...", "thought": true },
                    { "text": "SELECT 1;" }
                ] },
                "finishReason": "STOP"
            }]
        });
        assert_eq!(parse_gemini_response(&ok).unwrap(), "SELECT 1;");

        let blocked = json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert!(parse_gemini_response(&blocked).unwrap_err().contains("SAFETY"));

        let truncated = json!({ "candidates": [{ "content": { "parts": [] }, "finishReason": "MAX_TOKENS" }] });
        assert!(parse_gemini_response(&truncated).unwrap_err().contains("output budget"));
    }

    #[test]
    fn ollama_chat_parsing() {
        let ok = json!({ "model": "llama3.2", "message": { "role": "assistant", "content": "SELECT 1;" }, "done": true });
        assert_eq!(parse_ollama_chat(&ok).unwrap(), "SELECT 1;");
        let err = json!({ "error": "model 'x' not found" });
        assert!(parse_ollama_chat(&err).unwrap_err().contains("not found"));
    }

    #[test]
    fn error_message_extraction() {
        let openai = r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#;
        assert_eq!(extract_error_message(openai), "Incorrect API key provided");
        let anthropic = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(extract_error_message(anthropic), "invalid x-api-key");
        let google = r#"{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(extract_error_message(google), "API key not valid.");
        assert_eq!(extract_error_message(r#"{"error":"model not found"}"#), "model not found");
        assert_eq!(extract_error_message("  Bad Gateway  "), "Bad Gateway");
        assert_eq!(extract_error_message(""), "empty response body");
        assert_eq!(extract_error_message(&"x".repeat(700)).chars().count(), ERROR_BODY_LIMIT + 1);
    }

    #[test]
    fn redact_scrubs_key() {
        assert_eq!(
            redact("bad key sk-secret-123 rejected".to_string(), Some("sk-secret-123")),
            "bad key [redacted] rejected"
        );
        assert_eq!(redact("unchanged".to_string(), None), "unchanged");
    }

    #[test]
    fn chat_model_heuristic() {
        for id in ["gpt-5.5", "claude-sonnet-4-5", "llama3.2:latest", "o4-mini", "mattsmodel"] {
            assert!(looks_like_chat_model(id), "{id} should be kept");
        }
        for id in ["text-embedding-3-large", "tts-1-hd", "gpt-image-1", "omni-moderation-latest", "gpt-realtime"] {
            assert!(!looks_like_chat_model(id), "{id} should be dropped");
        }
    }

    #[test]
    fn gemini_model_id_validation() {
        assert_eq!(gemini_model_id("models/gemini-2.5-flash"), Ok("gemini-2.5-flash"));
        assert_eq!(gemini_model_id("gemini-2.5-pro"), Ok("gemini-2.5-pro"));
        assert!(gemini_model_id("gemini?key=x").is_err());
        assert!(gemini_model_id("../other").is_err());
        assert!(gemini_model_id("").is_err());
    }
}
