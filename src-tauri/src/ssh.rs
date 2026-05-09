use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

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
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let tcp = TcpStream::connect(format!("{}:{}", ssh_host, ssh_port))
        .map_err(|e| format!("Failed to connect to SSH server: {}", e))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;

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

    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", local_port))
        .map_err(|e| format!("Failed to bind local port: {}", e))?;

    loop {
        {
            let should_stop = stop_signal.lock().map_err(|e| e.to_string())?;
            if *should_stop {
                break;
            }
        }

        listener.set_nonblocking(true).map_err(|e| e.to_string())?;

        match listener.accept() {
            Ok((mut local_stream, _)) => {
                local_stream
                    .set_nonblocking(false)
                    .map_err(|e| e.to_string())?;

                let channel_result =
                    sess.channel_direct_tcpip(remote_host, remote_port, None);

                match channel_result {
                    Ok(mut channel) => {
                        let stop_clone = stop_signal.clone();
                        thread::spawn(move || {
                            let mut buf = [0u8; 8192];
                            local_stream
                                .set_read_timeout(Some(Duration::from_millis(500)))
                                .ok();
                            loop {
                                {
                                    let should_stop = stop_clone.lock().unwrap();
                                    if *should_stop {
                                        break;
                                    }
                                }

                                match local_stream.read(&mut buf) {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        if channel.write_all(&buf[..n]).is_err() {
                                            break;
                                        }
                                        channel.flush().ok();
                                    }
                                    Err(_) => break,
                                }

                                match channel.read(&mut buf) {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        if local_stream.write_all(&buf[..n]).is_err() {
                                            break;
                                        }
                                        local_stream.flush().ok();
                                    }
                                    Err(_) => {}
                                }
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("Failed to open SSH channel: {}", e);
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                eprintln!("Listener accept error: {}", e);
                break;
            }
        }
    }

    Ok(())
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
