use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone)]
pub enum SshAuthMethod {
    Password { password: String },
    Key { key_path: String, passphrase: Option<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TunnelInfo {
    pub connection_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

pub struct SshTunnel {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub stop_signal: Arc<Mutex<bool>>,
}

static TUNNELS: OnceLock<Mutex<HashMap<String, SshTunnel>>> = OnceLock::new();

/// Resolve `host:port` (hostname, IPv4 or IPv6) and connect to the first
/// address that answers within `timeout`. `TcpStream::connect_timeout` only
/// takes a `SocketAddr`, so hostnames must be resolved first.
fn connect_ssh_tcp(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve SSH host \"{}\": {}", host, e))?
        .collect();
    let mut last_err = None;
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, timeout) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = Some(e),
        }
    }
    Err(match last_err {
        Some(e) => format!("Failed to connect to SSH server {}:{}: {}", host, port, e),
        None => format!("SSH host \"{}\" resolved to no addresses", host),
    })
}

/// Expand a leading `~` to the user's home directory (`HOME`, or
/// `USERPROFILE` on Windows) — users paste `~/.ssh/id_ed25519`.
fn expand_key_path(path: &str) -> std::path::PathBuf {
    let path = path.trim();
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

/// Public-key authentication from a private key file. The public half comes
/// from `<key>.pub` when present, otherwise libssh2 derives it from the
/// private key. (Passing the private key path as the public key — the old
/// behaviour — makes libssh2 parse `-----BEGIN …` as a public key, which the
/// server rejects.)
fn auth_with_key_file(
    sess: &ssh2::Session,
    username: &str,
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<(), String> {
    let private = expand_key_path(key_path);
    if !private.is_file() {
        return Err(format!("SSH key file not found: {}", private.display()));
    }
    let mut public = private.clone().into_os_string();
    public.push(".pub");
    let public = std::path::PathBuf::from(public);
    let public = public.is_file().then_some(public);
    sess.userauth_pubkey_file(username, public.as_deref(), &private, passphrase.filter(|p| !p.is_empty()))
        .map_err(|e| format!("SSH key authentication failed: {}", e))
}

fn get_tunnels() -> &'static Mutex<HashMap<String, SshTunnel>> {
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop `connection_id`'s registry entry only while it is still this tunnel:
/// a newer tunnel for the same connection may have replaced it.
fn unregister_tunnel(connection_id: &str, stop_signal: &Arc<Mutex<bool>>) {
    if let Ok(mut map) = get_tunnels().lock() {
        if map.get(connection_id).is_some_and(|t| Arc::ptr_eq(&t.stop_signal, stop_signal)) {
            map.remove(connection_id);
        }
    }
}

fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

// Async: it waits for the SSH handshake, which must not block the UI thread.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri command — args mirror the IPC contract
pub fn create_ssh_tunnel(
    connection_id: String,
    ssh_host: String,
    ssh_port: u16,
    ssh_username: String,
    ssh_password: Option<String>,
    ssh_key_path: Option<String>,
    ssh_key_passphrase: Option<String>,
    remote_host: String,
    remote_port: u16,
) -> Result<TunnelInfo, String> {
    let tunnels = get_tunnels();
    let mut map = tunnels.lock().map_err(|e| e.to_string())?;

    if map.contains_key(&connection_id) {
        let existing = map.get(&connection_id).unwrap();
        return Ok(TunnelInfo {
            connection_id,
            local_port: existing.local_port,
            remote_host,
            remote_port,
        });
    }

    let local_port = find_free_port()?;
    let stop_signal = Arc::new(Mutex::new(false));

    let tunnel_info = TunnelInfo {
        connection_id: connection_id.clone(),
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
    };

    let conn_id_for_thread = connection_id.clone();
    let remote_host_for_thread = remote_host.clone();
    let stop_signal_clone = stop_signal.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    thread::spawn(move || {
        let result = run_tunnel(
            &ssh_host,
            ssh_port,
            &ssh_username,
            ssh_password,
            ssh_key_path,
            ssh_key_passphrase,
            &remote_host_for_thread,
            remote_port,
            local_port,
            &stop_signal_clone,
            &ready_tx,
        );
        if let Err(e) = result {
            // Reaches the caller if the tunnel never became ready; ignored
            // (receiver gone) when it fails later.
            let _ = ready_tx.send(Err(e.clone()));
            eprintln!("SSH tunnel error: {}", e);
        }
        unregister_tunnel(&conn_id_for_thread, &stop_signal_clone);
    });

    map.insert(
        connection_id.clone(),
        SshTunnel {
            local_port,
            remote_host,
            remote_port,
            stop_signal: stop_signal.clone(),
        },
    );
    // Release the registry before waiting: the tunnel thread takes it on exit.
    drop(map);

    // Report the real failure (unknown host, refused, bad key/password) now,
    // instead of returning a port that nothing listens on — which surfaced
    // 30 s later as an opaque database "pool timed out".
    match ready_rx.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(())) => Ok(tunnel_info),
        // Unregister here rather than leave it to the exiting thread: until
        // then the dead entry would be handed to a retry as a live tunnel.
        Ok(Err(e)) => {
            unregister_tunnel(&connection_id, &stop_signal);
            Err(e)
        }
        Err(_) => {
            if let Ok(mut stop) = stop_signal.lock() {
                *stop = true;
            }
            unregister_tunnel(&connection_id, &stop_signal);
            Err(format!("SSH tunnel to {} did not come up within 45 seconds", tunnel_info.remote_host))
        }
    }
}

#[allow(clippy::too_many_arguments)] // tightly coupled to create_ssh_tunnel's signature
fn run_tunnel(
    ssh_host: &str,
    ssh_port: u16,
    ssh_username: &str,
    ssh_password: Option<String>,
    ssh_key_path: Option<String>,
    ssh_key_passphrase: Option<String>,
    remote_host: &str,
    remote_port: u16,
    local_port: u16,
    stop_signal: &Arc<Mutex<bool>>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let tcp = connect_ssh_tcp(ssh_host, ssh_port, Duration::from_secs(15))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    // A second handle on the same underlying socket, so it can be switched to
    // non-blocking once the (deliberately blocking) handshake and auth are done.
    let tcp_ctl = tcp.try_clone().map_err(|e| e.to_string())?;

    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;

    if let Some(key_path) = ssh_key_path.as_deref().filter(|p| !p.trim().is_empty()) {
        auth_with_key_file(&sess, ssh_username, key_path, ssh_key_passphrase.as_deref())?;
    } else if let Some(password) = ssh_password {
        sess.userauth_password(ssh_username, &password)
            .map_err(|e| format!("SSH password authentication failed: {}", e))?;
    } else {
        return Err("No SSH authentication method provided".to_string());
    }

    if !sess.authenticated() {
        return Err("SSH authentication failed".to_string());
    }

    // -- Switch to non-blocking I/O ------------------------------------------
    // The forwarding pump below serves both directions of a connection from a
    // single thread. On a blocking session it cannot do that correctly:
    // reading the local socket blocks while the server has bytes waiting, and
    // reading the channel blocks while the client has a query to send. The
    // previous implementation worked around this with a 500ms read timeout on
    // the local socket and treated *any* read error as end-of-stream -- so an
    // ordinary timeout (the user simply pausing between queries) tore the
    // tunnel down. libssh2 needs both its own non-blocking flag and a
    // non-blocking socket beneath it, or it still blocks inside recv().
    tcp_ctl.set_nonblocking(true).map_err(|e| e.to_string())?;
    sess.set_blocking(false);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port))
        .map_err(|e| format!("Failed to bind local port: {}", e))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    // Authenticated and listening: the database connection can use it now.
    let _ = ready.send(Ok(()));

    loop {
        {
            let should_stop = stop_signal.lock().map_err(|e| e.to_string())?;
            if *should_stop {
                break;
            }
        }

        match listener.accept() {
            Ok((local_stream, _)) => {
                local_stream
                    .set_nonblocking(true)
                    .map_err(|e| e.to_string())?;

                // Channel opening is non-blocking too now, so it can legitimately
                // report "would block" while the open handshake is still in
                // flight. Retry instead of dropping the accepted connection.
                let channel =
                    match open_direct_tcpip(&sess, remote_host, remote_port, stop_signal) {
                        Ok(ch) => ch,
                        Err(e) => {
                            eprintln!("Failed to open SSH channel: {}", e);
                            continue;
                        }
                    };

                let stop_clone = stop_signal.clone();
                thread::spawn(move || pump(local_stream, channel, stop_clone));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                eprintln!("Listener accept error: {}", e);
                break;
            }
        }
    }

    Ok(())
}

/// True for errors that mean "no progress right now", not "this stream is done".
///
/// Conflating the two is what made the tunnel tear itself down after 500ms of
/// an idle client.
fn is_retryable(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn stopped(stop: &Arc<Mutex<bool>>) -> bool {
    // A poisoned lock means the owning tunnel thread panicked; treat that as
    // "stop" so the pump threads wind down rather than spinning forever.
    stop.lock().map(|g| *g).unwrap_or(true)
}

/// Open a direct-tcpip channel on a non-blocking session, retrying while
/// libssh2 reports EAGAIN. Bounded so a wedged server cannot pin the thread.
fn open_direct_tcpip(
    sess: &ssh2::Session,
    remote_host: &str,
    remote_port: u16,
    stop: &Arc<Mutex<bool>>,
) -> Result<ssh2::Channel, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        match sess.channel_direct_tcpip(remote_host, remote_port, None) {
            Ok(ch) => return Ok(ch),
            Err(e) => {
                // ssh2 maps LIBSSH2_ERROR_EAGAIN onto io::ErrorKind::WouldBlock.
                if !is_retryable(&std::io::Error::from(e)) {
                    return Err("failed to open direct-tcpip channel".to_string());
                }
                if stopped(stop) {
                    return Err("tunnel stopped".to_string());
                }
                if std::time::Instant::now() >= deadline {
                    return Err("timed out opening SSH channel".to_string());
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// Write a whole buffer to a non-blocking sink, yielding while it reports
/// "would block". `write_all` cannot be used on a non-blocking stream: it
/// surfaces `WouldBlock` without reporting how much it already wrote, which
/// silently corrupts the stream.
fn write_all_retry<W: Write>(
    w: &mut W,
    mut data: &[u8],
    stop: &Arc<Mutex<bool>>,
) -> std::io::Result<()> {
    while !data.is_empty() {
        if stopped(stop) {
            return Err(std::io::Error::other("tunnel stopped"));
        }
        match w.write(data) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "peer accepted no bytes",
                ))
            }
            Ok(n) => data = &data[n..],
            Err(ref e) if is_retryable(e) => thread::sleep(Duration::from_millis(1)),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Forward bytes between the locally-accepted socket and the SSH channel.
///
/// Both ends are non-blocking, so each pass moves whatever is available in each
/// direction and the loop backs off only when *both* directions are idle. That
/// is what lets one thread serve a full-duplex connection without either side
/// starving the other -- the previous half-duplex ping-pong could not read a
/// second chunk from the server until the client happened to send more bytes,
/// which stalled every result set larger than one buffer.
fn pump(mut local: TcpStream, mut channel: ssh2::Channel, stop: Arc<Mutex<bool>>) {
    // 32 KiB, so a large result set comes back in few passes.
    let mut buf = vec![0u8; 32 * 1024];
    let mut backoff = Duration::ZERO;
    let mut local_eof = false;

    loop {
        if stopped(&stop) {
            break;
        }

        let mut moved = false;

        // client -> server
        if !local_eof {
            match local.read(&mut buf) {
                Ok(0) => {
                    local_eof = true;
                    let _ = channel.send_eof();
                }
                Ok(n) => {
                    if write_all_retry(&mut channel, &buf[..n], &stop).is_err() {
                        break;
                    }
                    let _ = channel.flush();
                    moved = true;
                }
                Err(ref e) if is_retryable(e) => {}
                Err(_) => break,
            }
        }

        // server -> client: drain everything currently buffered
        loop {
            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if write_all_retry(&mut local, &buf[..n], &stop).is_err() {
                        return;
                    }
                    moved = true;
                }
                Err(ref e) if is_retryable(e) => break,
                Err(_) => return,
            }
        }

        if channel.eof() {
            break;
        }

        if moved {
            backoff = Duration::ZERO;
        } else {
            // Ramp gently: an idle tunnel costs no CPU, a busy one keeps
            // sub-millisecond latency.
            backoff = (backoff + Duration::from_micros(200)).min(Duration::from_millis(5));
            thread::sleep(backoff);
        }
    }

    let _ = channel.close();
}

#[tauri::command(async)]
pub fn close_ssh_tunnel(connection_id: String) -> Result<bool, String> {
    let tunnels = get_tunnels();
    let mut map = tunnels.lock().map_err(|e| e.to_string())?;

    if let Some(tunnel) = map.remove(&connection_id) {
        let mut stop = tunnel.stop_signal.lock().map_err(|e| e.to_string())?;
        *stop = true;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command(async)]
pub fn get_tunnel_status(connection_id: String) -> Result<Option<TunnelInfo>, String> {
    let tunnels = get_tunnels();
    let map = tunnels.lock().map_err(|e| e.to_string())?;

    if let Some(tunnel) = map.get(&connection_id) {
        Ok(Some(TunnelInfo {
            connection_id,
            local_port: tunnel.local_port,
            remote_host: tunnel.remote_host.clone(),
            remote_port: tunnel.remote_port,
        }))
    } else {
        Ok(None)
    }
}

/// One step of the SSH tunnel test, shown as a checklist in the dialog.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshCheck {
    pub name: String,
    /// `ok`, `warn` (works, but look at this), `fail`, or `skipped`.
    pub status: &'static str,
    pub detail: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SshTestReport {
    /// True when no step failed (warnings allowed).
    pub success: bool,
    pub checks: Vec<SshCheck>,
    /// OpenSSH-style `SHA256:…` fingerprint of the server's host key.
    pub host_key_fingerprint: Option<String>,
}

struct Report(Vec<SshCheck>);

impl Report {
    fn push(&mut self, name: &str, status: &'static str, detail: impl Into<String>) {
        self.0.push(SshCheck { name: name.to_string(), status, detail: detail.into() });
    }
    fn failed(&self) -> bool {
        self.0.iter().any(|c| c.status == "fail")
    }
}

/// What a private key file is, read without using it.
#[derive(Debug, PartialEq)]
pub(crate) struct KeyFileInfo {
    pub format: &'static str,
    pub encrypted: bool,
    /// Set when other users can read the file (OpenSSH refuses such keys).
    pub permission_warning: Option<String>,
}

/// Check a private key file before authenticating with it: present, a file,
/// a private (not public) key in a format libssh2 reads, and whether it is
/// passphrase-protected.
pub(crate) fn inspect_key_file(path: &std::path::Path) -> Result<KeyFileInfo, String> {
    use base64::Engine as _;
    if !path.exists() {
        return Err(format!("Key file not found: {}", path.display()));
    }
    if path.is_dir() {
        return Err(format!("{} is a folder. Choose the private key file inside it (for example id_ed25519).", path.display()));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot read key file {}: {}", path.display(), e))?;
    if meta.len() > 64 * 1024 {
        return Err(format!("{} is too large to be an SSH private key.", path.display()));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("Cannot read key file {}: {}", path.display(), e))?;
    let trimmed = text.trim_start();

    let permission_warning = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode() & 0o777;
            (mode & 0o077 != 0).then(|| format!(
                "The key file is readable by other users (mode {:o}). OpenSSH refuses such keys; run: chmod 600 {}",
                mode, path.display()
            ))
        }
        #[cfg(not(unix))]
        {
            None
        }
    };

    if ["ssh-", "ecdsa-", "sk-ssh-", "sk-ecdsa-"].iter().any(|p| trimmed.starts_with(p)) {
        return Err(format!("{} is a public key. Choose the private key (the same name without .pub).", path.display()));
    }
    if trimmed.starts_with("PuTTY-User-Key-File") {
        return Err("PuTTY .ppk keys are not supported. Convert it: puttygen key.ppk -O private-openssh -o id_key".to_string());
    }
    if let Some(body) = pem_body(&text, "OPENSSH PRIVATE KEY") {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|_| "The OpenSSH private key is damaged (not valid base64).".to_string())?;
        let encrypted = openssh_key_cipher(&raw).map(|c| c != "none").ok_or("The OpenSSH private key is damaged.")?;
        return Ok(KeyFileInfo { format: "OpenSSH", encrypted, permission_warning });
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return Ok(KeyFileInfo { format: "PKCS#8", encrypted: true, permission_warning });
    }
    for (label, format) in [("RSA PRIVATE KEY", "PEM (RSA)"), ("EC PRIVATE KEY", "PEM (EC)"), ("DSA PRIVATE KEY", "PEM (DSA)"), ("PRIVATE KEY", "PKCS#8")] {
        if text.contains(&format!("-----BEGIN {}-----", label)) {
            let encrypted = text.contains("Proc-Type: 4,ENCRYPTED");
            return Ok(KeyFileInfo { format, encrypted, permission_warning });
        }
    }
    Err(format!("{} is not a recognised SSH private key.", path.display()))
}

/// Base64 body between `-----BEGIN {label}-----` and its END line.
fn pem_body(text: &str, label: &str) -> Option<String> {
    let begin = format!("-----BEGIN {}-----", label);
    let end = format!("-----END {}-----", label);
    let start = text.find(&begin)? + begin.len();
    let stop = text[start..].find(&end)? + start;
    Some(text[start..stop].chars().filter(|c| !c.is_whitespace()).collect())
}

/// Cipher name from an `openssh-key-v1` blob ("none" when unencrypted).
fn openssh_key_cipher(raw: &[u8]) -> Option<String> {
    const MAGIC: &[u8] = b"openssh-key-v1\0";
    let rest = raw.strip_prefix(MAGIC)?;
    let len = u32::from_be_bytes(rest.get(0..4)?.try_into().ok()?) as usize;
    let name = rest.get(4..4 + len)?;
    String::from_utf8(name.to_vec()).ok()
}

/// Plain-language reason for a failed `direct-tcpip` channel.
fn explain_forward_error(e: &ssh2::Error, target: &str) -> String {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("prohibited") {
        format!("The SSH server does not allow port forwarding (AllowTcpForwarding is off for this user): {}", msg)
    } else if lower.contains("connect failed") || lower.contains("refused") || lower.contains("timed out") || lower.contains("unreachable") {
        format!("The SSH server could not reach {} (wrong host/port as seen from the server, a firewall, or the database is down): {}", target, msg)
    } else {
        format!("Opening a forwarded connection to {} failed: {}", target, msg)
    }
}

/// Test the SSH tunnel step by step, the way the real tunnel will run:
/// key file, TCP reachability, handshake, host key against known_hosts
/// (stopping before credentials are sent on a mismatch), offered auth
/// methods, authentication, and a forwarded connection to the database host
/// and port as the SSH server sees them. Each step is reported, so the
/// dialog can say exactly what is wrong.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri command — args mirror the IPC contract
pub fn test_ssh_connection(
    ssh_host: String,
    ssh_port: u16,
    ssh_username: String,
    ssh_password: Option<String>,
    ssh_key_path: Option<String>,
    ssh_key_passphrase: Option<String>,
    remote_host: Option<String>,
    remote_port: Option<u16>,
) -> Result<SshTestReport, String> {
    let mut report = Report(Vec::new());
    let finish = |report: Report, fingerprint: Option<String>| Ok(SshTestReport {
        success: !report.failed(),
        checks: report.0,
        host_key_fingerprint: fingerprint,
    });

    let host = ssh_host.trim().to_string();
    let username = ssh_username.trim().to_string();
    if host.is_empty() || username.is_empty() || ssh_port == 0 {
        report.push("Settings", "fail", "SSH host, port and username are required.");
        return finish(report, None);
    }
    let key_path = ssh_key_path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let password = ssh_password.as_deref().filter(|p| !p.is_empty());
    let passphrase = ssh_key_passphrase.as_deref().filter(|p| !p.is_empty());
    if key_path.is_none() && password.is_none() {
        report.push("Settings", "fail", "Enter a password or choose a private key file.");
        return finish(report, None);
    }

    // 1. Key file, before touching the network.
    if let Some(path) = key_path {
        let expanded = expand_key_path(path);
        match inspect_key_file(&expanded) {
            Ok(info) if info.encrypted && passphrase.is_none() => {
                report.push("Key file", "fail", format!("{} ({} format) is protected by a passphrase. Enter it under Key Passphrase.", expanded.display(), info.format));
                return finish(report, None);
            }
            Ok(info) => {
                let state = if info.encrypted { "passphrase-protected" } else { "not passphrase-protected" };
                match info.permission_warning {
                    Some(w) => report.push("Key file", "warn", format!("{} format, {}. {}", info.format, state, w)),
                    None => report.push("Key file", "ok", format!("{} format, {}.", info.format, state)),
                }
            }
            Err(e) => {
                report.push("Key file", "fail", e);
                return finish(report, None);
            }
        }
    }

    // 2. Network reachability.
    let started = std::time::Instant::now();
    let tcp = match connect_ssh_tcp(&host, ssh_port, Duration::from_secs(10)) {
        Ok(tcp) => {
            report.push("Reach SSH server", "ok", format!("{}:{} answered in {} ms.", host, ssh_port, started.elapsed().as_millis()));
            tcp
        }
        Err(e) => {
            report.push("Reach SSH server", "fail", e);
            return finish(report, None);
        }
    };
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(15)));

    // 3. Handshake.
    let mut sess = match ssh2::Session::new() {
        Ok(s) => s,
        Err(e) => {
            report.push("SSH handshake", "fail", e.to_string());
            return finish(report, None);
        }
    };
    sess.set_tcp_stream(tcp);
    sess.set_timeout(15_000);
    if let Err(e) = sess.handshake() {
        report.push("SSH handshake", "fail", format!("{} (is this port an SSH server?)", e));
        return finish(report, None);
    }
    let key_type = sess.host_key().map(|(_, t)| format!("{:?}", t)).unwrap_or_else(|| "unknown".into());
    let banner = sess.banner().unwrap_or("").to_string();
    report.push("SSH handshake", "ok", if banner.is_empty() { format!("Host key type {}.", key_type) } else { format!("{} · host key type {}.", banner, key_type) });

    // 4. Host key against ~/.ssh/known_hosts.
    let fingerprint = {
        use base64::Engine as _;
        sess.host_key_hash(ssh2::HashType::Sha256)
            .map(|h| format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(h)))
    };
    {
        let fp = fingerprint.clone().unwrap_or_else(|| "unavailable".into());
        let known_hosts = expand_key_path("~/.ssh/known_hosts");
        let verdict = if !known_hosts.is_file() {
            Err(format!("No {} file to check against. Confirm the fingerprint {} with the server's administrator.", known_hosts.display(), fp))
        } else {
            match (sess.known_hosts(), sess.host_key()) {
                (Ok(mut kh), Some((key, _))) => match kh.read_file(&known_hosts, ssh2::KnownHostFileKind::OpenSSH) {
                    Ok(_) => Ok(kh.check_port(&host, ssh_port, key)),
                    Err(e) => Err(format!("Could not read {}: {}. Fingerprint {}.", known_hosts.display(), e, fp)),
                },
                _ => Err(format!("Could not check the host key. Fingerprint {}.", fp)),
            }
        };
        match verdict {
            Ok(ssh2::CheckResult::Match) => report.push("Host key", "ok", format!("Matches {} ({}).", known_hosts.display(), fp)),
            Ok(ssh2::CheckResult::Mismatch) => {
                report.push("Host key", "fail", format!(
                    "The server's key ({}) does NOT match the one in {}. The server was reinstalled or someone may be intercepting the connection. Stopped before sending any credentials.",
                    fp, known_hosts.display()
                ));
                return finish(report, fingerprint);
            }
            Ok(_) => report.push("Host key", "warn", format!(
                "This server is not in {}. Confirm the fingerprint {} with the server's administrator.",
                known_hosts.display(), fp
            )),
            Err(e) => report.push("Host key", "warn", e),
        }
    }

    // 5. Does the server accept the chosen method?
    let wanted = if key_path.is_some() { "publickey" } else { "password" };
    match sess.auth_methods(&username) {
        Ok(methods) => {
            let offered: Vec<&str> = methods.split(',').map(str::trim).collect();
            let accepted = offered.contains(&wanted) || (wanted == "password" && offered.contains(&"keyboard-interactive"));
            if accepted {
                report.push("Sign-in methods", "ok", format!("Server accepts: {}.", methods));
            } else {
                report.push("Sign-in methods", "fail", format!(
                    "The server does not accept {} sign-in for {}. It accepts: {}.",
                    if wanted == "publickey" { "key" } else { "password" }, username, methods
                ));
                return finish(report, fingerprint);
            }
        }
        // `none` auth succeeded: the server needs no credentials.
        Err(_) if sess.authenticated() => report.push("Sign-in methods", "ok", "The server needs no credentials."),
        Err(e) => report.push("Sign-in methods", "warn", format!("The server did not list its sign-in methods: {}", e)),
    }

    // 6. Authenticate.
    if !sess.authenticated() {
        let result = match key_path {
            Some(path) => auth_with_key_file(&sess, &username, path, passphrase),
            None => sess.userauth_password(&username, password.unwrap_or(""))
                .map_err(|e| format!("Password rejected for {}: {}", username, e)),
        };
        match result {
            Ok(()) if sess.authenticated() => report.push("Sign in", "ok", format!("Signed in as {}.", username)),
            Ok(()) => {
                report.push("Sign in", "fail", "The server needs more than one sign-in step (for example key and password), which QueryDen tunnels don't support.");
                return finish(report, fingerprint);
            }
            Err(e) => {
                report.push("Sign in", "fail", e);
                return finish(report, fingerprint);
            }
        }
    } else {
        report.push("Sign in", "ok", format!("Signed in as {}.", username));
    }

    // 7. Forward to the database, as the tunnel will.
    match (remote_host.as_deref().map(str::trim).filter(|h| !h.is_empty()), remote_port.filter(|p| *p != 0)) {
        (Some(target_host), Some(target_port)) => {
            let target = format!("{}:{}", target_host, target_port);
            match sess.channel_direct_tcpip(target_host, target_port, None) {
                Ok(mut channel) => {
                    let _ = channel.close();
                    report.push("Forward to database", "ok", format!("The SSH server opened a connection to {} (the database host as the server sees it).", target));
                }
                Err(e) => report.push("Forward to database", "fail", explain_forward_error(&e, &target)),
            }
        }
        _ => report.push("Forward to database", "skipped", "Enter the database host and port to check the tunnel can reach it."),
    }

    let _ = sess.disconnect(None, "QueryDen tunnel test complete", None);
    finish(report, fingerprint)
}

#[tauri::command(async)]
pub fn close_all_tunnels() -> Result<(), String> {
    let tunnels = get_tunnels();
    let mut map = tunnels.lock().map_err(|e| e.to_string())?;

    for (_, tunnel) in map.drain() {
        let mut stop = tunnel.stop_signal.lock().map_err(|e| e.to_string())?;
        *stop = true;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_key(name: &str, contents: &str, mode: u32) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("qd-ssh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
        path
    }

    fn openssh_key(cipher: &str) -> String {
        use base64::Engine as _;
        let mut raw = b"openssh-key-v1\0".to_vec();
        raw.extend_from_slice(&(cipher.len() as u32).to_be_bytes());
        raw.extend_from_slice(cipher.as_bytes());
        raw.extend_from_slice(&[0u8; 16]);
        let body = base64::engine::general_purpose::STANDARD.encode(raw);
        format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n", body)
    }

    #[test]
    fn key_file_checks_catch_the_common_mistakes() {
        let plain = temp_key("id_plain", &openssh_key("none"), 0o600);
        assert_eq!(inspect_key_file(&plain).unwrap(), KeyFileInfo { format: "OpenSSH", encrypted: false, permission_warning: None });

        let locked = temp_key("id_locked", &openssh_key("aes256-ctr"), 0o600);
        assert!(inspect_key_file(&locked).unwrap().encrypted);

        let pem = temp_key("id_rsa_pem", "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nAAAA\n-----END RSA PRIVATE KEY-----\n", 0o600);
        let info = inspect_key_file(&pem).unwrap();
        assert_eq!((info.format, info.encrypted), ("PEM (RSA)", true));

        let public = temp_key("id_plain.pub", "ssh-ed25519 AAAAC3Nza user@host\n", 0o644);
        assert!(inspect_key_file(&public).unwrap_err().contains("public key"));

        let ppk = temp_key("key.ppk", "PuTTY-User-Key-File-3: ssh-ed25519\n", 0o600);
        assert!(inspect_key_file(&ppk).unwrap_err().contains("puttygen"));

        let junk = temp_key("notes.txt", "hello", 0o600);
        assert!(inspect_key_file(&junk).unwrap_err().contains("not a recognised"));

        let folder = plain.parent().unwrap();
        assert!(inspect_key_file(folder).unwrap_err().contains("is a folder"));
        assert!(inspect_key_file(&folder.join("missing")).unwrap_err().contains("not found"));

        #[cfg(unix)]
        {
            let open = temp_key("id_open", &openssh_key("none"), 0o644);
            assert!(inspect_key_file(&open).unwrap().permission_warning.unwrap().contains("chmod 600"));
        }
    }

    #[test]
    fn tunnel_test_reports_unreachable_servers_as_a_step() {
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let report = test_ssh_connection(
            "127.0.0.1".into(), closed, "u".into(), Some("p".into()), None, None, Some("db".into()), Some(5432),
        )
        .unwrap();
        assert!(!report.success);
        let last = report.checks.last().unwrap();
        assert_eq!((last.name.as_str(), last.status), ("Reach SSH server", "fail"));
    }

    #[test]
    fn tunnel_test_stops_on_a_bad_key_before_the_network() {
        let public = temp_key("only.pub", "ssh-rsa AAAA x\n", 0o644);
        let report = test_ssh_connection(
            "no-such-host.invalid".into(), 22, "u".into(), None, Some(public.display().to_string()), None, None, None,
        )
        .unwrap();
        assert!(!report.success);
        assert_eq!(report.checks.len(), 1);
        assert_eq!(report.checks[0].name, "Key file");
    }

    #[test]
    fn expands_home_in_key_paths() {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap();
        assert_eq!(expand_key_path("~/.ssh/id_ed25519"), std::path::PathBuf::from(home).join(".ssh/id_ed25519"));
        assert_eq!(expand_key_path("/abs/key"), std::path::PathBuf::from("/abs/key"));
    }

    #[test]
    fn connects_to_hostnames_not_just_ip_literals() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(connect_ssh_tcp("localhost", port, Duration::from_secs(2)).is_ok());
        assert!(connect_ssh_tcp("127.0.0.1", port, Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn reports_unresolvable_hosts() {
        let err = connect_ssh_tcp("no-such-host.invalid", 22, Duration::from_secs(2)).unwrap_err();
        assert!(err.contains("Cannot resolve SSH host"), "{err}");
    }

    #[test]
    fn tunnel_creation_reports_the_real_failure_immediately() {
        let started = std::time::Instant::now();
        let err = create_ssh_tunnel(
            "qd-test-unresolvable".into(), "no-such-host.invalid".into(), 22, "u".into(),
            Some("p".into()), None, None, "db".into(), 5432,
        )
        .unwrap_err();
        assert!(err.contains("Cannot resolve SSH host"), "{err}");

        // A port nothing listens on: refused, not a silently dead tunnel.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = create_ssh_tunnel(
            "qd-test-refused".into(), "127.0.0.1".into(), closed, "u".into(),
            Some("p".into()), None, None, "db".into(), 5432,
        )
        .unwrap_err();
        assert!(err.contains("Failed to connect to SSH server"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));
        // Failed tunnels don't linger in the registry, so a retry fails
        // again instead of being handed the dead tunnel's port.
        assert!(get_tunnel_status("qd-test-refused".into()).unwrap().is_none());
        let retry = create_ssh_tunnel(
            "qd-test-refused".into(), "127.0.0.1".into(), closed, "u".into(),
            Some("p".into()), None, None, "db".into(), 5432,
        );
        assert!(retry.is_err(), "retry returned a dead tunnel: {retry:?}");
    }

    #[test]
    fn an_old_tunnel_never_unregisters_its_replacement() {
        let old_signal = Arc::new(Mutex::new(false));
        let new_signal = Arc::new(Mutex::new(false));
        get_tunnels().lock().unwrap().insert(
            "qd-test-replaced".into(),
            SshTunnel { local_port: 1, remote_host: "db".into(), remote_port: 5432, stop_signal: new_signal.clone() },
        );
        unregister_tunnel("qd-test-replaced", &old_signal);
        assert!(get_tunnel_status("qd-test-replaced".into()).unwrap().is_some());
        unregister_tunnel("qd-test-replaced", &new_signal);
        assert!(get_tunnel_status("qd-test-replaced".into()).unwrap().is_none());
    }

    #[test]
    fn missing_key_file_is_a_clear_error() {
        let sess = ssh2::Session::new().unwrap();
        let err = auth_with_key_file(&sess, "u", "/definitely/not/here", None).unwrap_err();
        assert!(err.contains("SSH key file not found"), "{err}");
    }
}
