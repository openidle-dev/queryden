use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command;
use sha2::{Sha256, Digest};
use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2,
};
use keyring::Entry;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

static FAILED_ATTEMPTS: AtomicU32 = AtomicU32::new(0);
static LOCKOUT_UNTIL: AtomicU64 = AtomicU64::new(0);

// Sentinel returned when platform-specific machine-ID detection fails entirely.
// Kept as a literal because legacy decrypt paths (pre-1.0) used this value as
// part of the key seed — removing it would brick those users' data.
const FALLBACK_MACHINE_ID: &str = "default-machine-id";

// Returns the platform machine ID, or `FALLBACK_MACHINE_ID` if detection fails.
// Use `try_get_machine_id()` for new encryption — it errors instead of weakening
// the key with a globally-known sentinel.
fn get_machine_id() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = fs::read_to_string("/etc/machine-id") {
            return id.trim().to_string();
        }
        if let Ok(id) = fs::read_to_string("/var/lib/dbus/machine-id") {
            return id.trim().to_string();
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if let Ok(output) = Command::new("powershell")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-Command", "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"])
            .output() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() { return s; }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("ioreg")
            .args(&["-rd1", "-c", "IOPlatformExpertDevice"])
            .output() {
            let s = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = s.lines().find(|l| l.contains("IOPlatformUUID")) {
                if let Some(uuid) = line.split('"').nth(3) {
                    return uuid.to_string();
                }
            }
        }
    }

    FALLBACK_MACHINE_ID.to_string()
}

// Strict variant — errors if no platform path produced a real machine ID.
// New encryption must use this so a key derived from a known constant is never
// silently produced.
fn try_get_machine_id() -> Result<String, String> {
    let id = get_machine_id();
    if id == FALLBACK_MACHINE_ID || id.is_empty() {
        Err("Failed to detect machine ID; encryption requires a real hardware identifier".into())
    } else {
        Ok(id)
    }
}

fn get_machine_fingerprint() -> String {
    let id = get_machine_id();
    let mut hasher = Sha256::new();
    hasher.update(id.as_bytes());
    hasher.update(b"queryden-machine-lock-v1");
    hex::encode(hasher.finalize())
}

fn get_master_app_key(app_dir: &Path) -> Result<String, String> {
    if let Ok(entry) = Entry::new("queryden", "master_app_key") {
        if let Ok(key) = entry.get_password() {
            return Ok(key);
        }
    }

    let mk_path = app_dir.join(".master_key");
    if mk_path.exists() {
        if let Ok(key) = fs::read_to_string(&mk_path) {
            return Ok(key);
        }
    }

    let mut key_bytes = [0u8; 32];
    rand::thread_rng().fill(&mut key_bytes);
    let new_key = hex::encode(key_bytes);

    // At least one persistence path MUST succeed, otherwise the next run will
    // generate a different key and the user's data becomes unrecoverable.
    let mut persisted = false;
    if let Ok(entry) = Entry::new("queryden", "master_app_key") {
        if entry.set_password(&new_key).is_ok() {
            persisted = true;
        } else {
            warn!("Failed to persist master key to OS keyring");
        }
    }
    if let Err(e) = fs::write(&mk_path, &new_key) {
        warn!("Failed to persist master key to {mk_path:?}: {e}");
    } else {
        persisted = true;
    }

    if !persisted {
        return Err("Cannot persist master encryption key: OS keyring and app data directory are both unavailable".into());
    }
    Ok(new_key)
}

fn get_encryption_key(vault_password: Option<&str>, use_machine_id: bool, app_dir: &Path) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];

    let machine_id = if use_machine_id {
        try_get_machine_id()?
    } else {
        "universal-legacy-id".to_string()
    };

    let master_key = get_master_app_key(app_dir)?;

    let salt_text = "queryden-production-salt-2024-v2";
    let seed = if let Some(pwd) = vault_password {
        format!("{}:{}:{}:{}", pwd, machine_id, master_key, salt_text)
    } else {
        format!("{}:{}:{}", machine_id, master_key, salt_text)
    };

    let argon2 = Argon2::default();
    let salt = SaltString::from_b64("cXVlcnlkZW5fc2FsdF8wMQ")
        .expect("static salt string is valid base64");

    let hash = argon2
        .hash_password(seed.as_bytes(), &salt)
        .map_err(|e| format!("Argon2 key derivation failed: {e}"))?;
    let output = hash.hash.ok_or("Argon2 produced no hash output")?;
    key.copy_from_slice(&output.as_bytes()[..32]);

    Ok(key)
}

fn get_app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn ensure_app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = get_app_data_dir(app);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn encrypt(data: &str, vault_password: Option<&str>, app_dir: &Path) -> Result<String, String> {
    // New data always uses machine-locked encryption.
    let key = get_encryption_key(vault_password, true, app_dir)?;
    let cipher = Aes256Gcm::new(&key.into());
    let nonce_bytes: [u8; 12] = rand::thread_rng().gen();
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, data.as_bytes())
        .map_err(|e| format!("AES-256-GCM encryption failed: {e}"))?;
    let mut combined = nonce_bytes.to_vec();
    combined.extend(ciphertext);
    Ok(BASE64.encode(combined))
}

fn decrypt(encoded: &str, vault_password: Option<&str>, app_dir: &Path) -> String {
    let combined = match BASE64.decode(encoded) {
        Ok(c) => c,
        Err(_) => return encoded.to_string(),
    };
    if combined.len() < 12 {
        return encoded.to_string();
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    // ===== PRIMARY: Try the SAME key as encrypt() uses (Argon2id + master_key + salt-v2) =====
    // If modern key derivation fails (e.g. machine ID unavailable) we still try
    // legacy paths below — they may succeed on older data.
    if let Ok(modern_key) = get_encryption_key(vault_password, true, app_dir) {
        let cipher = Aes256Gcm::new(&modern_key.into());
        if let Ok(plain) = cipher.decrypt(nonce, ciphertext) {
            if let Ok(s) = String::from_utf8(plain) {
                return s;
            }
        }
    }

    // ===== LEGACY FALLBACKS: For data encrypted with older key derivation methods =====

    // 1. Try XOR-based Machine-Locked Key (salt-v1)
    if let Ok(plain) = cipher_decrypt(encoded, vault_password, &get_machine_id(), "queryden-production-salt-2024-v1", nonce_bytes, ciphertext) {
        return plain;
    }

    // 2. Try XOR-based Generic Machine-Locked Key (Fallback ID, salt-v1)
    if let Ok(plain) = cipher_decrypt(encoded, vault_password, "default-machine-id", "queryden-production-salt-2024-v1", nonce_bytes, ciphertext) {
        return plain;
    }

    // 3. Try Universal/Legacy Key (Prior to hardware locking)
    if let Ok(plain) = cipher_decrypt(encoded, vault_password, "universal-legacy-id", "queryden-production-salt-2024-v1", nonce_bytes, ciphertext) {
        return plain;
    }

    // 4. Try Direct Salt Key (No Machine ID at all)
    if let Ok(plain) = cipher_decrypt_no_id(encoded, vault_password, "queryden-production-salt-2024-v1", nonce_bytes, ciphertext) {
        return plain;
    }

    // 5. Try Early Development Salts
    if let Ok(plain) = cipher_decrypt(encoded, vault_password, "universal-legacy-id", "queryden-production-salt-2024", nonce_bytes, ciphertext) {
        return plain;
    }
    if let Ok(plain) = cipher_decrypt(encoded, vault_password, &get_machine_id(), "queryden-production-salt-2024", nonce_bytes, ciphertext) {
        return plain;
    }
    if let Ok(plain) = cipher_decrypt_no_id(encoded, vault_password, "queryden-production-salt-2024", nonce_bytes, ciphertext) {
        return plain;
    }

    encoded.to_string()
}

fn cipher_decrypt_no_id(_encoded: &str, vault_password: Option<&str>, salt: &str, nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<String, ()> {
    let mut key = [0u8; 32];
    let seed = if let Some(pwd) = vault_password {
        format!("{}:{}", pwd, salt)
    } else {
        salt.to_string()
    };
    let seed_bytes = seed.as_bytes();
    for i in 0..32 {
        key[i] = seed_bytes[i % seed_bytes.len()] ^ (i as u8);
    }
    let cipher = Aes256Gcm::new(&key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    match cipher.decrypt(nonce, ciphertext) {
        Ok(plain) => String::from_utf8(plain).map_err(|_| ()),
        Err(_) => Err(()),
    }
}

fn cipher_decrypt(_encoded: &str, vault_password: Option<&str>, machine_id: &str, salt: &str, nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<String, ()> {
    let mut key = [0u8; 32];
    
    let seed = if let Some(pwd) = vault_password {
        format!("{}:{}:{}", pwd, machine_id, salt)
    } else {
        format!("{}:{}", machine_id, salt)
    };
    
    let seed_bytes = seed.as_bytes();
    for i in 0..32 {
        key[i] = seed_bytes[i % seed_bytes.len()] ^ (i as u8);
    }

    let cipher = Aes256Gcm::new(&key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    match cipher.decrypt(nonce, ciphertext) {
        Ok(plain) => String::from_utf8(plain).map_err(|_| ()),
        Err(_) => Err(()),
    }
}


#[derive(Serialize, Deserialize, Clone)]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: String,
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub filepath: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_vault: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_credential_id: Option<String>,
    // SSH/Tunneling fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_key_passphrase: Option<String>,
}

impl StoredConnection {
    pub fn to_stored(&self, encrypt_passwords: bool) -> Self {
        let password = if encrypt_passwords {
            self.password.clone()
        } else {
            None
        };
        let ssh_password = if encrypt_passwords {
            self.ssh_password.clone()
        } else {
            None
        };
        let ssh_key_passphrase = if encrypt_passwords {
            self.ssh_key_passphrase.clone()
        } else {
            None
        };
        Self {
            id: self.id.clone(),
            name: self.name.clone(),
            db_type: self.db_type.clone(),
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password,
            filepath: self.filepath.clone(),
            color: self.color.clone(),
            is_vault: self.is_vault,
            vault_credential_id: self.vault_credential_id.clone(),
            ssh_enabled: self.ssh_enabled,
            ssh_host: self.ssh_host.clone(),
            ssh_port: self.ssh_port,
            ssh_username: self.ssh_username.clone(),
            ssh_password,
            ssh_key_path: self.ssh_key_path.clone(),
            ssh_key_passphrase,
        }
    }
}

#[tauri::command]
pub fn save_connections(app: tauri::AppHandle, connections: Vec<StoredConnection>, vault_password: Option<String>) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let encrypted: Vec<StoredConnection> = connections
        .into_iter()
        .map(|c| {
            let use_vault = c.is_vault.unwrap_or(false);
            let pwd = if use_vault { vault_password.as_deref() } else { None };
            let password = c.password.map(|p| encrypt(&p, pwd, &dir)).transpose()?;
            let ssh_password = c.ssh_password.map(|p| encrypt(&p, pwd, &dir)).transpose()?;
            let ssh_key_passphrase = c.ssh_key_passphrase.map(|p| encrypt(&p, pwd, &dir)).transpose()?;
            Ok(StoredConnection {
                password,
                ssh_password,
                ssh_key_passphrase,
                ..c
            })
        })
        .collect::<Result<_, String>>()?;
    let data = ConnectionData {
        connections: encrypted,
        version: 1,
        vault_credentials: None,
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let path = dir.join("connections.json");
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_connections(app: tauri::AppHandle, vault_password: Option<String>) -> Result<Vec<StoredConnection>, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("connections.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: ConnectionData = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    
    // Safety check: Machine Lock
    if data.machine_fingerprint != get_machine_fingerprint() {
        return Err("Machine Lock Error: This connections file belongs to another computer and cannot be loaded for security.".to_string());
    }

    let decrypted: Vec<StoredConnection> = data
        .connections
        .into_iter()
        .map(|mut c| {
            let use_vault = c.is_vault.unwrap_or(false);
            let pwd = if use_vault { vault_password.as_deref() } else { None };
            if let Some(enc_pw) = c.password.take() {
                c.password = Some(decrypt(&enc_pw, pwd, &dir));
            }
            if let Some(enc_ssh_pw) = c.ssh_password.take() {
                c.ssh_password = Some(decrypt(&enc_ssh_pw, pwd, &dir));
            }
            if let Some(enc_ssh_pp) = c.ssh_key_passphrase.take() {
                c.ssh_key_passphrase = Some(decrypt(&enc_ssh_pp, pwd, &dir));
            }
            c
        })
        .collect();
    Ok(decrypted)
}

#[derive(Serialize, Deserialize)]
pub struct ConnectionData {
    pub connections: Vec<StoredConnection>,
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_credentials: Option<Vec<VaultCredential>>,
    pub machine_fingerprint: String,
}

#[tauri::command]
pub fn export_connections(
    app: tauri::AppHandle,
    path: String,
    include_passwords: bool,
    vault_password: Option<String>,
) -> Result<(), String> {
    let connections = load_connections(app.clone(), vault_password.clone())?;
    let vault_creds = load_vault_credentials(app, vault_password)?;
    
    // Determine which vault credentials are actually used by the connections being exported
    let used_vault_ids: std::collections::HashSet<_> = connections.iter()
        .filter_map(|c| c.vault_credential_id.as_ref())
        .collect();
        
    let exported_vault_creds: Vec<VaultCredential> = vault_creds.into_iter()
        .filter(|vc| used_vault_ids.contains(&vc.id))
        .map(|mut vc| {
            if !include_passwords {
                vc.password = None;
            }
            vc
        })
        .collect();

    let to_export: Vec<StoredConnection> = connections
        .into_iter()
        .map(|c| c.to_stored(include_passwords))
        .collect();
        
    let data = ConnectionData {
        connections: to_export,
        version: 2,
        vault_credentials: Some(exported_vault_creds),
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn import_connections(app: tauri::AppHandle, path: String, vault_password: Option<String>) -> Result<usize, String> {
    let existing = load_connections(app.clone(), vault_password.clone())?;
    let data: ConnectionData = serde_json::from_str(
      &fs::read_to_string(&path).map_err(|e| e.to_string())?
    ).map_err(|e| e.to_string())?;

    // No machine check on import files, as they are meant to be portable (passwords stripped)
    
    // Import Vault Credentials if present
    if let Some(new_vault_creds) = data.vault_credentials {
        let mut existing_vault_creds = load_vault_credentials(app.clone(), vault_password.clone())?;
        let existing_vault_ids: std::collections::HashSet<String> = existing_vault_creds.iter().map(|vc| vc.id.clone()).collect();
        
        let mut imported_count = 0;
        for vc in new_vault_creds {
            if !existing_vault_ids.contains(&vc.id) {
                existing_vault_creds.push(vc);
                imported_count += 1;
            }
        }
        if imported_count > 0 {
            save_vault_credentials(app.clone(), existing_vault_creds, vault_password.clone())?;
        }
    }

    let existing_ids: std::collections::HashSet<_> = existing.iter().map(|c| &c.id).collect();
    let new_conns: Vec<_> = data
        .connections
        .into_iter()
        .filter(|c| !existing_ids.contains(&c.id))
        .map(|mut c| {
            if c.vault_credential_id.is_none() {
                c.password = None;
            }
            c
        })
        .collect();
        
    let count = new_conns.len();
    let mut all = existing;
    all.extend(new_conns);
    save_connections(app, all, vault_password)?;
    Ok(count)
}

#[derive(Serialize, Deserialize)]
pub struct SettingsData {
    pub settings: serde_json::Value,
    pub version: u32,
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let data = SettingsData {
        settings,
        version: 1,
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: SettingsData = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(data.settings)
}

#[derive(Serialize, Deserialize)]
pub struct QueryHistoryData {
    pub history: Vec<QueryHistoryItem>,
    pub version: u32,
    pub machine_fingerprint: String,
}

#[derive(Serialize, Deserialize)]
pub struct QueryHistoryItem {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub query: String,
    pub executed_at: i64,
    pub duration: Option<i64>,
    pub row_count: Option<i64>,
    pub success: bool,
}

#[tauri::command]
pub fn save_query_history(app: tauri::AppHandle, history: Vec<QueryHistoryItem>) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let data = QueryHistoryData {
        history,
        version: 1,
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let encrypted = encrypt(&json, None, &dir)?;
    let path = dir.join("query-history.json");
    fs::write(&path, encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_query_history(app: tauri::AppHandle) -> Result<Vec<QueryHistoryItem>, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("query-history.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json = decrypt(&content, None, &dir);
    match serde_json::from_str::<QueryHistoryData>(&json) {
        Ok(data) => {
            if data.machine_fingerprint != get_machine_fingerprint() {
                return Ok(vec![]); // Refuse to show history from another machine
            }
            Ok(data.history)
        },
        Err(_) => Ok(vec![])
    }
}

#[tauri::command]
pub fn save_keymaps(app: tauri::AppHandle, keymaps: serde_json::Value) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let json = serde_json::to_string_pretty(&keymaps).map_err(|e| e.to_string())?;
    let path = dir.join("keymaps.json");
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_keymaps(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("keymaps.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
pub fn save_templates(app: tauri::AppHandle, templates: serde_json::Value) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let json = serde_json::to_string_pretty(&templates).map_err(|e| e.to_string())?;
    let path = dir.join("templates.json");
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_templates(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("templates.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
pub fn get_app_data_path(app: tauri::AppHandle) -> String {
    get_app_data_dir(&app).to_string_lossy().to_string()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultCredential {
    pub id: String,
    pub name: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct VaultData {
    pub credentials: Vec<VaultCredential>,
    pub version: u32,
    pub machine_fingerprint: String,
}

#[tauri::command]
pub fn save_vault_credentials(app: tauri::AppHandle, credentials: Vec<VaultCredential>, vault_password: Option<String>) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let encrypted: Vec<VaultCredential> = credentials
        .into_iter()
        .map(|c| {
            let username = c.username.map(|u| encrypt(&u, vault_password.as_deref(), &dir)).transpose()?;
            let password = c.password.map(|p| encrypt(&p, vault_password.as_deref(), &dir)).transpose()?;
            Ok(VaultCredential {
                id: c.id,
                name: c.name,
                username,
                password,
            })
        })
        .collect::<Result<_, String>>()?;
    let data = VaultData {
        credentials: encrypted,
        version: 1,
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let path = dir.join("vault.json");
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_vault_credentials(app: tauri::AppHandle, vault_password: Option<String>) -> Result<Vec<VaultCredential>, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("vault.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let data: VaultData = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if data.machine_fingerprint != get_machine_fingerprint() {
        return Err("Machine Lock Error: This vault file belongs to another computer and cannot be opened.".to_string());
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let lockout = LOCKOUT_UNTIL.load(Ordering::SeqCst);
    if now < lockout {
        return Err(format!("Vault locked due to too many failed attempts. Try again in {} seconds.", lockout - now));
    }

    let mut any_failed = false;
    let decrypted: Vec<VaultCredential> = data
        .credentials
        .into_iter()
        .map(|mut c| {
            if let Some(enc_u) = c.username.clone() {
                let dec = decrypt(&enc_u, vault_password.as_deref(), &dir);
                if dec == enc_u && vault_password.is_some() { any_failed = true; }
                c.username = Some(dec);
            }
            if let Some(enc_pw) = c.password.clone() {
                let dec = decrypt(&enc_pw, vault_password.as_deref(), &dir);
                if dec == enc_pw && vault_password.is_some() { any_failed = true; }
                c.password = Some(dec);
            }
            c
        })
        .collect();

    if any_failed {
        let attempts = FAILED_ATTEMPTS.fetch_add(1, Ordering::SeqCst) + 1;
        println!("VAULT SECURITY WARNING: Failed unlock attempt {}/5", attempts);
        if attempts >= 5 {
            LOCKOUT_UNTIL.store(now + 60, Ordering::SeqCst);
            println!("VAULT SECURITY ALERT: Brute force detected. Lockout for 60 seconds.");
            return Err("Too many failed attempts. Vault locked for 1 minute.".to_string());
        }
        return Err("Invalid vault password. Decryption failed.".to_string());
    } else {
        FAILED_ATTEMPTS.store(0, Ordering::SeqCst);
        LOCKOUT_UNTIL.store(0, Ordering::SeqCst);
    }

    Ok(decrypted)
}

#[derive(Serialize, Deserialize)]
pub struct SavedQueryData {
    pub queries: Vec<SavedQueryItem>,
    pub version: u32,
    pub machine_fingerprint: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedQueryItem {
    pub id: String,
    pub name: String,
    pub query: String,
    pub database: String,
    pub connection_id: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn save_saved_queries(app: tauri::AppHandle, queries: Vec<SavedQueryItem>) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let data = SavedQueryData {
        queries,
        version: 1,
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let encrypted = encrypt(&json, None, &dir)?;
    let path = dir.join("saved-queries.json");
    fs::write(&path, encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_saved_queries(app: tauri::AppHandle) -> Result<Vec<SavedQueryItem>, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("saved-queries.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json = decrypt(&content, None, &dir);
    match serde_json::from_str::<SavedQueryData>(&json) {
        Ok(data) => {
            if data.machine_fingerprint != get_machine_fingerprint() {
                return Ok(vec![]);
            }
            Ok(data.queries)
        },
        Err(_) => Ok(vec![])
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistoryEntry {
    pub timestamp: i64,
    pub file_path: String,
    pub content: String,
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHistoryData {
    pub entries: Vec<LocalHistoryEntry>,
    pub version: u32,
    pub machine_fingerprint: String,
}

#[tauri::command]
pub fn save_local_history(app: tauri::AppHandle, entries: Vec<LocalHistoryEntry>) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let data = LocalHistoryData {
        entries,
        version: 1,
        machine_fingerprint: get_machine_fingerprint(),
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let encrypted = encrypt(&json, None, &dir)?;
    let path = dir.join("local-history.json");
    fs::write(&path, encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_local_history(app: tauri::AppHandle) -> Result<Vec<LocalHistoryEntry>, String> {
    let dir = get_app_data_dir(&app);
    let path = dir.join("local-history.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let json = decrypt(&content, None, &dir);
    match serde_json::from_str::<LocalHistoryData>(&json) {
        Ok(data) => {
            if data.machine_fingerprint != get_machine_fingerprint() {
                return Ok(vec![]);
            }
            Ok(data.entries)
        },
        Err(_) => Ok(vec![])
    }
}

#[tauri::command]
pub fn clear_local_history(app: tauri::AppHandle) -> Result<(), String> {
    let dir = ensure_app_dir(&app)?;
    let path = dir.join("local-history.json");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}