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

#[derive(Serialize, Deserialize, Clone)]
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

fn get_tunnels() -> &'static Mutex<HashMap<String, SshTunnel>> {
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn find_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

#[tauri::command]
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
        );
        if let Err(e) = result {
            eprintln!("SSH tunnel error: {}", e);
        }
        let mut map = get_tunnels().lock().unwrap();
        map.remove(&conn_id_for_thread);
    });

    map.insert(
        connection_id,
        SshTunnel {
            local_port,
            remote_host,
            remote_port,
            stop_signal,
        },
    );

    Ok(tunnel_info)
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
) -> Result<(), String> {
    let tcp = TcpStream::connect(format!("{}:{}", ssh_host, ssh_port))
        .map_err(|e| format!("Failed to connect to SSH server: {}", e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    // A second handle on the same underlying socket, so it can be switched to
    // non-blocking once the (deliberately blocking) handshake and auth are done.
    let tcp_ctl = tcp.try_clone().map_err(|e| e.to_string())?;

    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;

    if let Some(key_path) = ssh_key_path {
        sess.userauth_pubkey_file(
            ssh_username,
            Some(std::path::Path::new(&key_path)),
            std::path::Path::new(&key_path),
            ssh_key_passphrase.as_deref(),
        )
        .map_err(|e| format!("SSH key authentication failed: {}", e))?;
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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
pub fn test_ssh_connection(
    ssh_host: String,
    ssh_port: u16,
    ssh_username: String,
    ssh_password: Option<String>,
    ssh_key_path: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> Result<(), String> {
    use std::net::TcpStream;
    use std::time::Duration;

    let tcp = TcpStream::connect_timeout(
        &format!("{}:{}", ssh_host, ssh_port)
            .parse()
            .map_err(|e| format!("Invalid SSH host/port: {}", e))?,
        Duration::from_secs(10),
    )
    .map_err(|e| format!("Failed to connect to SSH server: {}", e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;

    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    if let Some(key_path) = ssh_key_path.as_ref().filter(|p| !p.is_empty()) {
        sess.userauth_pubkey_file(
            &ssh_username,
            Some(std::path::Path::new(key_path)),
            std::path::Path::new(key_path),
            ssh_key_passphrase.as_deref(),
        )
        .map_err(|e| format!("SSH key authentication failed: {}", e))?;
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

#[tauri::command]
pub fn close_all_tunnels() -> Result<(), String> {
    let tunnels = get_tunnels();
    let mut map = tunnels.lock().map_err(|e| e.to_string())?;

    for (_, tunnel) in map.drain() {
        let mut stop = tunnel.stop_signal.lock().map_err(|e| e.to_string())?;
        *stop = true;
    }

    Ok(())
}
