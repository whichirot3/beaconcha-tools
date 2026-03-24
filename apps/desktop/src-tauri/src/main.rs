#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs::{create_dir_all, read_to_string, remove_dir_all, write, OpenOptions},
    io::Write,
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const DEFAULT_DAEMON_BASE_URL: &str = "http://127.0.0.1:8742/api/v1";
const DEFAULT_CONFIG_TEMPLATE: &str = include_str!("../../../../config/beaconops.example.toml");
const WEBVIEW_CACHE_SCHEMA_VERSION: &str = "v2026-03-20-en-only";

#[derive(Default)]
struct DaemonRuntimeState {
    inner: Mutex<ManagedDaemon>,
}

#[derive(Default)]
struct ManagedDaemon {
    child: Option<Child>,
    executable_path: Option<String>,
    config_path: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonRuntimePayload {
    running: bool,
    managed: bool,
    pid: Option<u32>,
    endpoint: String,
    executable_path: Option<String>,
    config_path: Option<String>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonEnsurePayload {
    running: bool,
    started: bool,
    managed: bool,
    pid: Option<u32>,
    endpoint: String,
    executable_path: Option<String>,
    config_path: Option<String>,
    message: String,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonDefaultsPayload {
    endpoint: String,
    executable_path: Option<String>,
    config_path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct EnsureDaemonRequest {
    executable_path: Option<String>,
    config_path: Option<String>,
    startup_timeout_ms: Option<u64>,
}

#[tauri::command]
fn daemon_base_url() -> String {
    daemon_endpoint()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLogEntry {
    timestamp: String,
    level: String,
    scope: String,
    message: String,
    context: Option<String>,
    session_id: Option<String>,
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    for _ in 0..8 {
        let Some(path) = current else {
            break;
        };
        if path.join("Cargo.toml").exists() && path.join("crates").exists() {
            return Some(path.to_path_buf());
        }
        current = path.parent();
    }
    None
}

fn daemon_endpoint() -> String {
    std::env::var("BEACONOPS_DAEMON_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_DAEMON_BASE_URL.to_string())
}

fn daemon_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "beaconops-daemon.exe"
    } else {
        "beaconops-daemon"
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn daemon_socket_target() -> (String, u16) {
    let endpoint = daemon_endpoint();
    if let Ok(parsed) = Url::parse(&endpoint) {
        let host = parsed
            .host_str()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port = parsed.port_or_known_default().unwrap_or(8742);
        return (host, port);
    }

    ("127.0.0.1".to_string(), 8742)
}

fn daemon_is_reachable() -> bool {
    let (host, port) = daemon_socket_target();
    let target = format!("{host}:{port}");

    let Ok(addresses) = target.to_socket_addrs() else {
        return false;
    };

    addresses.into_iter().any(|address| {
        TcpStream::connect_timeout(&address, Duration::from_millis(450)).is_ok()
    })
}

fn wait_for_daemon_ready(timeout: Duration) -> bool {
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if daemon_is_reachable() {
            return true;
        }
        sleep(Duration::from_millis(220));
    }
    daemon_is_reachable()
}

fn refresh_managed_daemon(inner: &mut ManagedDaemon) {
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                inner.last_error = Some(format!("managed daemon exited: {status}"));
                inner.child = None;
            }
            Ok(None) => {}
            Err(err) => {
                inner.last_error = Some(format!("failed to inspect managed daemon: {err}"));
            }
        }
    }
}

fn build_runtime_payload(inner: &ManagedDaemon, running: bool) -> DaemonRuntimePayload {
    DaemonRuntimePayload {
        running,
        managed: inner.child.is_some(),
        pid: inner.child.as_ref().map(|child| child.id()),
        endpoint: daemon_endpoint(),
        executable_path: inner.executable_path.clone(),
        config_path: inner.config_path.clone(),
        last_error: inner.last_error.clone(),
    }
}

fn resolve_default_daemon_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(explicit) = clean_optional(std::env::var("BEACONOPS_DAEMON_BIN").ok()) {
        return Some(PathBuf::from(explicit));
    }

    if let Some(appdir) = clean_optional(std::env::var("APPDIR").ok()) {
        let appdir = PathBuf::from(appdir);
        let candidates = [
            appdir
                .join("usr")
                .join("lib")
                .join("Beaconcha Tools")
                .join("bin")
                .join(daemon_binary_name()),
            appdir.join("usr").join("bin").join(daemon_binary_name()),
            appdir
                .join("usr")
                .join("lib")
                .join(daemon_binary_name()),
        ];

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = find_repo_root(&cwd) {
        let candidate = root.join("target").join("debug").join(daemon_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let candidate = parent.join(daemon_binary_name());
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join(daemon_binary_name());
        if candidate.exists() {
            return Some(candidate);
        }

        let nested = resource_dir.join("bin").join(daemon_binary_name());
        if nested.exists() {
            return Some(nested);
        }
    }

    None
}

fn ensure_default_config_exists(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    if !path.exists() {
        write(path, DEFAULT_CONFIG_TEMPLATE).map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn resolve_default_daemon_config(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(explicit) = clean_optional(std::env::var("BEACONOPS_CONFIG_PATH").ok()) {
        return Some(PathBuf::from(explicit));
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = find_repo_root(&cwd) {
        let primary = root.join("config").join("beaconops.toml");
        if primary.exists() {
            return Some(primary);
        }

        let fallback = root.join("config").join("beaconops.example.toml");
        if fallback.exists() {
            return Some(fallback);
        }
    }

    if let Ok(config_dir) = app.path().app_config_dir() {
        let target = config_dir.join("beaconops.toml");
        if ensure_default_config_exists(&target).is_ok() {
            return Some(target);
        }
    }

    None
}

fn resolve_launch_executable_path(
    app: &tauri::AppHandle,
    requested: Option<String>,
) -> Option<PathBuf> {
    if let Some(explicit) = clean_optional(requested) {
        let candidate = PathBuf::from(explicit);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    resolve_default_daemon_executable(app)
}

fn resolve_launch_config_path(
    app: &tauri::AppHandle,
    requested: Option<String>,
) -> Option<PathBuf> {
    if let Some(explicit) = clean_optional(requested) {
        let candidate = PathBuf::from(explicit);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    resolve_default_daemon_config(app)
}

fn spawn_daemon_process(executable: &Path, config_path: Option<&Path>) -> Result<Child, String> {
    let mut command = Command::new(executable);
    if let Some(config) = config_path {
        command.arg("--config").arg(config);
        if let Some(parent) = config.parent() {
            command.current_dir(parent);
        }
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .spawn()
        .map_err(|err| format!("failed to spawn {}: {err}", executable.display()))
}

fn ensure_daemon_running_impl(
    app: &tauri::AppHandle,
    state: &DaemonRuntimeState,
    request: EnsureDaemonRequest,
) -> Result<DaemonEnsurePayload, String> {
    let startup_timeout_ms = request.startup_timeout_ms.unwrap_or(16_000).clamp(3_000, 90_000);
    let startup_timeout = Duration::from_millis(startup_timeout_ms);

    {
        let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
        refresh_managed_daemon(&mut inner);
        if daemon_is_reachable() {
            let runtime = build_runtime_payload(&inner, true);
            return Ok(DaemonEnsurePayload {
                running: runtime.running,
                started: false,
                managed: runtime.managed,
                pid: runtime.pid,
                endpoint: runtime.endpoint,
                executable_path: runtime.executable_path,
                config_path: runtime.config_path,
                message: "Daemon already reachable".to_string(),
                last_error: runtime.last_error,
            });
        }

        if inner.child.is_some() {
            drop(inner);
            if wait_for_daemon_ready(startup_timeout) {
                let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
                refresh_managed_daemon(&mut inner);
                let runtime = build_runtime_payload(&inner, true);
                return Ok(DaemonEnsurePayload {
                    running: runtime.running,
                    started: false,
                    managed: runtime.managed,
                    pid: runtime.pid,
                    endpoint: runtime.endpoint,
                    executable_path: runtime.executable_path,
                    config_path: runtime.config_path,
                    message: "Managed daemon became reachable".to_string(),
                    last_error: runtime.last_error,
                });
            }
            let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
            inner.last_error = Some(format!(
                "managed daemon did not become reachable within {}ms",
                startup_timeout_ms
            ));
            return Err(
                "Daemon did not become reachable within startup timeout".to_string()
            );
        }
    }

    let executable_path = resolve_launch_executable_path(app, request.executable_path.clone())
        .unwrap_or_else(|| PathBuf::from(daemon_binary_name()));

    let config_path = resolve_launch_config_path(app, request.config_path.clone());

    let child = spawn_daemon_process(&executable_path, config_path.as_deref())?;
    let pid = child.id();

    {
        let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
        inner.child = Some(child);
        inner.executable_path = Some(executable_path.to_string_lossy().to_string());
        inner.config_path = config_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        inner.last_error = None;
    }

    if wait_for_daemon_ready(startup_timeout) {
        let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
        refresh_managed_daemon(&mut inner);
        let runtime = build_runtime_payload(&inner, true);
        return Ok(DaemonEnsurePayload {
            running: runtime.running,
            started: true,
            managed: runtime.managed,
            pid: runtime.pid,
            endpoint: runtime.endpoint,
            executable_path: runtime.executable_path,
            config_path: runtime.config_path,
            message: format!("Daemon started (pid {pid})"),
            last_error: runtime.last_error,
        });
    }

    let mut inner = state.inner.lock().map_err(|_| "daemon state lock poisoned")?;
    if let Some(mut managed) = inner.child.take() {
        let _ = managed.kill();
        let _ = managed.wait();
    }
    inner.last_error = Some(format!(
        "daemon failed to become reachable in {}ms after spawn",
        startup_timeout_ms
    ));

    Err(format!(
        "Daemon spawn timeout: endpoint {} is still unreachable",
        daemon_endpoint()
    ))
}

fn resolve_log_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("BEACONOPS_LOG_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = find_repo_root(&cwd) {
        return root.join("data").join("logs");
    }

    cwd.join("data").join("logs")
}

fn purge_stale_webview_cache(app: &tauri::AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };

    let marker_path = config_dir.join("webview-cache-schema.txt");
    let current_version = read_to_string(&marker_path).unwrap_or_default();
    if current_version.trim() == WEBVIEW_CACHE_SCHEMA_VERSION {
        return;
    }

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let cache_dir = app_data_dir.join("WebKitCache");
        if cache_dir.exists() {
            let _ = remove_dir_all(&cache_dir);
        }
    }

    if let Ok(home_dir) = app.path().home_dir() {
        let legacy_cache_dir = home_dir
            .join(".local")
            .join("share")
            .join("io.beaconops.desktop")
            .join("WebKitCache");
        if legacy_cache_dir.exists() {
            let _ = remove_dir_all(&legacy_cache_dir);
        }
    }

    let _ = create_dir_all(&config_dir);
    let _ = write(&marker_path, format!("{WEBVIEW_CACHE_SCHEMA_VERSION}\n"));
}

#[tauri::command]
fn desktop_logs_path() -> Result<String, String> {
    Ok(resolve_log_dir()
        .join("desktop-ui.log")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn write_desktop_log(entry: DesktopLogEntry) -> Result<(), String> {
    let log_dir = resolve_log_dir();
    create_dir_all(&log_dir).map_err(|err| err.to_string())?;

    let log_path = log_dir.join("desktop-ui.log");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| err.to_string())?;

    let context = entry.context.unwrap_or_default();
    let session = entry.session_id.unwrap_or_default();
    writeln!(
        file,
        "{}\t{}\t{}\t{}\t{}\t{}",
        entry.timestamp, entry.level, entry.scope, entry.message, context, session
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

#[tauri::command]
fn daemon_default_paths(
    app: tauri::AppHandle,
) -> Result<DaemonDefaultsPayload, String> {
    Ok(DaemonDefaultsPayload {
        endpoint: daemon_endpoint(),
        executable_path: resolve_default_daemon_executable(&app)
            .map(|path| path.to_string_lossy().to_string()),
        config_path: resolve_default_daemon_config(&app)
            .map(|path| path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
fn daemon_runtime_status(
    state: State<'_, DaemonRuntimeState>,
) -> Result<DaemonRuntimePayload, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "daemon state lock poisoned".to_string())?;
    refresh_managed_daemon(&mut inner);
    Ok(build_runtime_payload(&inner, daemon_is_reachable()))
}

#[tauri::command]
fn ensure_daemon_running(
    app: tauri::AppHandle,
    state: State<'_, DaemonRuntimeState>,
    request: EnsureDaemonRequest,
) -> Result<DaemonEnsurePayload, String> {
    ensure_daemon_running_impl(&app, &state, request)
}

#[tauri::command]
fn stop_managed_daemon(
    state: State<'_, DaemonRuntimeState>,
) -> Result<DaemonRuntimePayload, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "daemon state lock poisoned".to_string())?;
    refresh_managed_daemon(&mut inner);

    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(build_runtime_payload(&inner, daemon_is_reachable()))
}

#[tauri::command]
fn restart_managed_daemon(
    app: tauri::AppHandle,
    state: State<'_, DaemonRuntimeState>,
    request: EnsureDaemonRequest,
) -> Result<DaemonEnsurePayload, String> {
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "daemon state lock poisoned".to_string())?;
        refresh_managed_daemon(&mut inner);
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    ensure_daemon_running_impl(&app, &state, request)
}

#[tauri::command]
fn unlock_and_show_main(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }

    if let Some(gate_window) = app.get_webview_window("gate") {
        let _ = gate_window.close();
    }

    Ok(())
}

#[tauri::command]
fn lock_and_show_gate(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.hide();
    }

    if let Some(gate_window) = app.get_webview_window("gate") {
        let _ = gate_window.show();
        let _ = gate_window.set_focus();
        return Ok(());
    }

    let gate_window = WebviewWindowBuilder::new(
        &app,
        "gate",
        WebviewUrl::App("/?view=gate&mode=lock".into()),
    )
    .title("Beaconcha Tools Access")
    .inner_size(620.0, 350.0)
    .resizable(false)
    .fullscreen(false)
    .decorations(false)
    .always_on_top(true)
    .center()
    .build()
    .map_err(|err| err.to_string())?;

    let _ = gate_window.show();
    let _ = gate_window.set_focus();

    Ok(())
}

#[tauri::command]
fn close_gate_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(gate_window) = app.get_webview_window("gate") {
        let _ = gate_window.close();
    }

    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            purge_stale_webview_cache(&app.handle());
            Ok(())
        })
        .manage(DaemonRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            daemon_base_url,
            daemon_default_paths,
            daemon_runtime_status,
            ensure_daemon_running,
            stop_managed_daemon,
            restart_managed_daemon,
            desktop_logs_path,
            write_desktop_log,
            unlock_and_show_main,
            lock_and_show_gate,
            close_gate_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running Beaconcha Tools desktop shell");
}
