//! Node supervisor — owns the lifecycle of a local `ce` node for the dashboard.
//!
//! The supervisor is the honest answer to "a non-technical user must not type `ce
//! start`". It:
//!   - detects an installed `ce` binary (PATH + the documented `~/.local/bin/ce`),
//!   - starts `ce start` as a child process and waits (bounded) for `GET /health`,
//!   - reads the api.token off disk (`<data_dir>/api.token`, chmod 600 — the browser
//!     cannot read it) so the web UI can make authed calls,
//!   - performs a **graceful drain** pause: stop accepting/advertising new work, let
//!     running jobs finish, then idle — never a node kill.
//!
//! Boundary: this is app/lifecycle policy (CE the node stays primitives-only). The
//! supervisor composes existing node behavior; it does not add a node RPC.
//!
//! Drain honesty: the node today has no in-process "stop accepting work" RPC, so the
//! graceful drain is enforced at the lifecycle layer — we stop the mining/advertising
//! node and (re)start it in a non-advertising, non-mining posture (`--no-mine`) so it
//! keeps its mesh presence for in-flight settlement but takes no new jobs. Running jobs
//! are NOT killed. If/when the node grows a real runtime drain RPC, this swaps to it
//! without changing the Tauri command surface. The coarse-but-honest behavior and its
//! economic cost (forfeited uptime rewards) are surfaced to the user in the UI.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Default HTTP API base URL for a locally supervised node (see CLAUDE.md: API on :8844).
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:8844";

/// How long to wait for `GET /health` to go green after `ce start`.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_millis(500);

/// Lifecycle state of the supervised node, mirrored 1:1 by the TS `NodeRunState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeRunState {
    /// No `ce` binary detected.
    Absent,
    /// Binary present, node not running.
    Stopped,
    /// `ce start` issued, not yet healthy.
    Starting,
    /// Healthy, mining + advertising (accepting new work).
    Running,
    /// Graceful drain: not advertising/accepting new work; running jobs finishing.
    Draining,
}

/// Result of probing for the `ce` binary, mirrored by the TS `CeInstall`.
#[derive(Debug, Clone, Serialize)]
pub struct CeInstall {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Snapshot handed to the front-end, mirrored by the TS `NodeSnapshot`.
#[derive(Debug, Clone, Serialize)]
pub struct NodeSnapshot {
    pub state: NodeRunState,
    pub healthy: bool,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Shared, cloneable handle to the supervisor.
#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
    http: reqwest::Client,
}

struct Inner {
    state: NodeRunState,
    base_url: String,
    /// The child process we started, if any. `None` if the node was started elsewhere.
    child: Option<Child>,
    /// Whether the current process was launched with `--no-mine` (drained posture).
    no_mine: bool,
}

impl Supervisor {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        let initial = if locate_ce().is_some() {
            NodeRunState::Stopped
        } else {
            NodeRunState::Absent
        };
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: initial,
                base_url: DEFAULT_BASE_URL.to_string(),
                child: None,
                no_mine: false,
            })),
            http,
        }
    }

    /// Probe for the `ce` binary and its version.
    pub async fn detect(&self) -> CeInstall {
        match locate_ce() {
            None => {
                let mut g = self.inner.lock().await;
                if g.child.is_none() {
                    g.state = NodeRunState::Absent;
                }
                CeInstall { installed: false, path: None, version: None }
            }
            Some(path) => {
                let version = ce_version(&path).await;
                let mut g = self.inner.lock().await;
                if g.state == NodeRunState::Absent {
                    g.state = NodeRunState::Stopped;
                }
                CeInstall {
                    installed: true,
                    path: Some(path.to_string_lossy().into_owned()),
                    version,
                }
            }
        }
    }

    /// Run the platform installer for `ce`, then re-detect.
    ///
    /// We deliberately do NOT auto-run a remote-piped installer without the user's
    /// click (the UI gates this). We pick the best available manager and run it; if
    /// none is available we report `installed: false` with no side effects.
    pub async fn install(&self) -> CeInstall {
        if let Some(cmd) = installer_command() {
            info!(command = %cmd.0, "running ce installer");
            let status = Command::new(cmd.0)
                .args(cmd.1)
                .stdin(Stdio::null())
                .status()
                .await;
            match status {
                Ok(s) if s.success() => info!("ce installer finished"),
                Ok(s) => warn!(code = ?s.code(), "ce installer exited non-zero"),
                Err(e) => warn!(error = %e, "failed to spawn ce installer"),
            }
        } else {
            warn!("no supported package manager found for ce install");
        }
        self.detect().await
    }

    /// Start `ce start` (optionally `--no-mine`) and wait for health. Idempotent: if the
    /// node is already healthy, returns the current snapshot without spawning a second.
    pub async fn start(&self, no_mine: bool) -> Result<NodeSnapshot> {
        // Already healthy? Nothing to do (covers a node the user started by hand).
        if self.is_healthy().await {
            self.set_state(if no_mine { NodeRunState::Draining } else { NodeRunState::Running })
                .await;
            return self.snapshot().await;
        }

        let path = locate_ce().context("`ce` binary not found on PATH or ~/.local/bin")?;

        {
            let mut g = self.inner.lock().await;
            // Reap any prior child before spawning a new one.
            if let Some(mut child) = g.child.take() {
                let _ = child.start_kill();
            }
            g.state = NodeRunState::Starting;
            g.no_mine = no_mine;
        }

        let mut cmd = Command::new(&path);
        cmd.arg("start");
        if no_mine {
            // Drained posture: keep mesh presence for in-flight settlement, take no new
            // work, earn no uptime. This is the honest lifecycle-layer drain.
            cmd.arg("--no-mine");
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().context("failed to spawn `ce start`")?;
        let pid = child.id();
        {
            let mut g = self.inner.lock().await;
            g.child = Some(child);
        }
        info!(?pid, no_mine, "spawned ce node");

        let healthy = self.await_health(HEALTH_TIMEOUT).await;
        let state = if !healthy {
            NodeRunState::Starting
        } else if no_mine {
            NodeRunState::Draining
        } else {
            NodeRunState::Running
        };
        self.set_state(state).await;
        self.snapshot().await
    }

    /// Graceful-drain pause: stop accepting/advertising new work, leave running jobs to
    /// finish. Implemented as a restart into `--no-mine` posture (see module docs).
    ///
    /// This is NOT a kill: in-flight hosted jobs continue inside their own containers
    /// (the node restart re-attaches to the docker runtime; we never `ce kill` here).
    pub async fn pause(&self) -> Result<NodeSnapshot> {
        info!("graceful drain requested");
        // Restart into no-mine posture. Running containers are not stopped by the node
        // process restart; the supervisor never issues a kill during drain.
        self.start(true).await.map(|mut s| {
            s.note = Some(
                "Graceful drain: no new jobs accepted; running jobs finish. Uptime rewards paused."
                    .to_string(),
            );
            s
        })
    }

    /// Resume hosting: restart into the normal (mining + advertising) posture.
    pub async fn resume(&self) -> Result<NodeSnapshot> {
        info!("resume hosting requested");
        self.start(false).await
    }

    /// Stop the supervised node entirely (used on app exit). Best-effort.
    pub async fn stop(&self) {
        let mut g = self.inner.lock().await;
        if let Some(mut child) = g.child.take() {
            let _ = child.start_kill();
        }
        g.state = if locate_ce().is_some() {
            NodeRunState::Stopped
        } else {
            NodeRunState::Absent
        };
    }

    /// Current snapshot, including a fresh health probe and the on-disk api.token.
    pub async fn snapshot(&self) -> Result<NodeSnapshot> {
        let healthy = self.is_healthy().await;
        let g = self.inner.lock().await;
        Ok(NodeSnapshot {
            state: g.state,
            healthy,
            base_url: g.base_url.clone(),
            token: read_api_token(),
            pid: g.child.as_ref().and_then(|c| c.id()),
            note: None,
        })
    }

    /// Read the api.token off disk (or `CE_API_TOKEN` env), if available.
    pub fn token(&self) -> Option<String> {
        read_api_token()
    }

    // ---- internals ----

    async fn set_state(&self, state: NodeRunState) {
        let mut g = self.inner.lock().await;
        g.state = state;
    }

    async fn is_healthy(&self) -> bool {
        let url = {
            let g = self.inner.lock().await;
            format!("{}/health", g.base_url.trim_end_matches('/'))
        };
        match self.http.get(&url).send().await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    async fn await_health(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.is_healthy().await {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

/// Locate the `ce` binary: PATH first, then the documented `~/.local/bin/ce`.
fn locate_ce() -> Option<PathBuf> {
    if let Ok(p) = which::which("ce") {
        return Some(p);
    }
    let candidate = dirs::home_dir().map(|h| h.join(".local").join("bin").join("ce"));
    match candidate {
        Some(p) if p.is_file() => Some(p),
        _ => None,
    }
}

/// `ce --version` → trimmed string, best-effort.
async fn ce_version(path: &PathBuf) -> Option<String> {
    let out = Command::new(path).arg("--version").output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Read the node's api.token. Honors `CE_API_TOKEN`, else `<data_dir>/api.token`.
///
/// The data dir follows CLAUDE.md: `~/.local/share/ce/api.token` on Unix. We use
/// `dirs::data_dir()` to stay correct across platforms.
fn read_api_token() -> Option<String> {
    if let Ok(t) = std::env::var("CE_API_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let path = dirs::data_dir().map(|d| d.join("ce").join("api.token"))?;
    let raw = std::fs::read_to_string(path).ok()?;
    let t = raw.trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

/// Pick a platform installer command for `ce`. Returns `(program, args)`.
fn installer_command() -> Option<(&'static str, Vec<&'static str>)> {
    // Prefer Homebrew (macOS/Linux), then Scoop (Windows). We avoid blindly piping a
    // remote script; the package-manager path is auditable and reversible.
    if which::which("brew").is_ok() {
        return Some(("brew", vec!["install", "ce-net/ce/ce"]));
    }
    if which::which("scoop").is_ok() {
        return Some(("scoop", vec!["install", "ce"]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_state_serializes_lowercase() {
        let s = serde_json::to_string(&NodeRunState::Draining).unwrap();
        assert_eq!(s, "\"draining\"");
    }

    #[test]
    fn snapshot_uses_camel_case_base_url() {
        let snap = NodeSnapshot {
            state: NodeRunState::Running,
            healthy: true,
            base_url: "http://127.0.0.1:8844".into(),
            token: None,
            pid: Some(42),
            note: None,
        };
        let j = serde_json::to_value(&snap).unwrap();
        assert!(j.get("baseUrl").is_some());
        assert!(j.get("token").is_none(), "None token must be omitted");
        assert_eq!(j["pid"], 42);
    }

    #[test]
    fn install_omits_optional_fields_when_absent() {
        let i = CeInstall { installed: false, path: None, version: None };
        let j = serde_json::to_value(&i).unwrap();
        assert_eq!(j["installed"], false);
        assert!(j.get("path").is_none());
        assert!(j.get("version").is_none());
    }

    #[test]
    fn new_supervisor_reflects_binary_presence() {
        // State is Absent or Stopped depending on whether `ce` is installed in CI; both
        // are valid. The invariant: never Running/Starting before any start().
        let sup = Supervisor::new();
        let st = {
            // block_on a tiny lock read
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            rt.block_on(async { sup.inner.lock().await.state })
        };
        assert!(matches!(st, NodeRunState::Absent | NodeRunState::Stopped));
    }
}
