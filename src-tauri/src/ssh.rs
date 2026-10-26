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

/// Test SSH connectivity in isolation — TCP connect, handshake, authenticate,
/// and disconnect. No port forward, no DB connect. Used by the connection
/// dialog's "Test SSH tunnel" button so users can distinguish SSH auth
/// failures from DB connection failures.
#[tauri::command(async)]
pub fn test_ssh_connection(
    ssh_host: String,
    ssh_port: u16,
    ssh_username: String,
    ssh_password: Option<String>,
    ssh_key_path: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> Result<(), String> {
    let tcp = connect_ssh_tcp(&ssh_host, ssh_port, Duration::from_secs(10))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;

    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    if let Some(key_path) = ssh_key_path.as_deref().filter(|p| !p.trim().is_empty()) {
        auth_with_key_file(&sess, &ssh_username, key_path, ssh_key_passphrase.as_deref())?;
    } else if let Some(password) = ssh_password.as_ref().filter(|p| !p.is_empty()) {
        sess.userauth_password(&ssh_username, password)
            .map_err(|e| format!("SSH password authentication failed: {}", e))?;
    } else {
        return Err("No SSH authentication credentials provided".to_string());
    }

    if !sess.authenticated() {
        return Err("SSH authentication failed".to_string());
    }

    Ok(())
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
