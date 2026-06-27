//! CE Desktop — Tauri shell library (repo: ce-host).
//!
//! Hosts the exact pure-web bundle in a native window and exposes the node supervisor
//! over IPC commands the front-end calls through `src/lib/tauri.ts`. A system tray gives
//! quick pause/resume + show without the window. The supervisor (see `supervisor.rs`)
//! owns the local `ce` node lifecycle; CE the node stays primitives-only.

mod supervisor;

use supervisor::{AppCmdResult, AppmgrStatus, CeInstall, NodeSnapshot, Supervisor};
#[cfg(desktop)]
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};
#[cfg(desktop)]
use tracing::warn;

/// IPC command errors are surfaced to the front-end as plain strings.
fn err_to_string(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
async fn detect_ce(sup: tauri::State<'_, Supervisor>) -> Result<CeInstall, String> {
    Ok(sup.detect().await)
}

#[tauri::command]
async fn install_ce(sup: tauri::State<'_, Supervisor>) -> Result<CeInstall, String> {
    Ok(sup.install().await)
}

#[tauri::command]
async fn start_node(sup: tauri::State<'_, Supervisor>) -> Result<NodeSnapshot, String> {
    sup.start(false).await.map_err(err_to_string)
}

#[tauri::command]
async fn node_status(sup: tauri::State<'_, Supervisor>) -> Result<NodeSnapshot, String> {
    sup.snapshot().await.map_err(err_to_string)
}

#[tauri::command]
async fn read_token(sup: tauri::State<'_, Supervisor>) -> Result<Option<String>, String> {
    Ok(sup.token())
}

/// Graceful-drain pause — stop accepting new jobs, let running jobs finish, then idle.
/// NOT a node kill (see `supervisor::Supervisor::pause`).
#[tauri::command]
async fn pause_hosting(sup: tauri::State<'_, Supervisor>) -> Result<NodeSnapshot, String> {
    sup.pause().await.map_err(err_to_string)
}

#[tauri::command]
async fn resume_hosting(sup: tauri::State<'_, Supervisor>) -> Result<NodeSnapshot, String> {
    sup.resume().await.map_err(err_to_string)
}

#[tauri::command]
async fn appmgr_status(sup: tauri::State<'_, Supervisor>) -> Result<AppmgrStatus, String> {
    Ok(sup.appmgr_status().await)
}

#[tauri::command]
async fn app_list_raw(sup: tauri::State<'_, Supervisor>) -> Result<String, String> {
    sup.app_list_raw().await.map_err(err_to_string)
}

#[tauri::command]
async fn app_ps_raw(sup: tauri::State<'_, Supervisor>) -> Result<String, String> {
    sup.app_ps_raw().await.map_err(err_to_string)
}

#[tauri::command]
async fn app_install(
    sup: tauri::State<'_, Supervisor>,
    name: String,
) -> Result<AppCmdResult, String> {
    sup.app_install(&name).await.map_err(err_to_string)
}

/// Which shell this is running in. The front-end's host seam uses this to decide whether to
/// supervise a local node (desktop) or run as a companion against a paired/remote node
/// (ios/android), since mobile sandboxes cannot install or spawn the `ce` binary.
#[tauri::command]
fn platform() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tracing, not println — honor CE standards.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Supervisor::new());

    // Desktop-only lifecycle: a system tray (show / pause / resume / quit) and closing the
    // window hides it to the tray so the node keeps earning in the background. Mobile has no
    // tray and a different lifecycle, so the companion build skips both.
    #[cfg(desktop)]
    let builder = builder
        .setup(|app| {
            build_tray(app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            detect_ce,
            install_ce,
            start_node,
            node_status,
            read_token,
            pause_hosting,
            resume_hosting,
            appmgr_status,
            app_list_raw,
            app_ps_raw,
            app_install,
            platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CE Desktop");
}

/// System tray: show window, pause/resume hosting, quit. Desktop-only.
#[cfg(desktop)]
fn build_tray(app: tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(&app, "show", "Show CE Desktop", true, None::<&str>)?;
    let pause = MenuItem::with_id(&app, "pause", "Pause hosting (drain)", true, None::<&str>)?;
    let resume = MenuItem::with_id(&app, "resume", "Resume hosting", true, None::<&str>)?;
    let quit = MenuItem::with_id(&app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(&app, &[&show, &pause, &resume, &quit])?;

    // A fully-owned (`'static`) icon: cloning `app.default_window_icon()` would borrow
    // app's pixel data and the tray's `'static` closures forbid that. Packaged builds
    // surface the bundle icon for the window regardless.
    TrayIconBuilder::with_id("ce-host-tray")
        .icon(default_icon())
        .tooltip("CE Desktop — your node on the mesh")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "pause" => {
                let sup = app.state::<Supervisor>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sup.pause().await {
                        warn!(error = %e, "tray pause failed");
                    }
                });
            }
            "resume" => {
                let sup = app.state::<Supervisor>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sup.resume().await {
                        warn!(error = %e, "tray resume failed");
                    }
                });
            }
            "quit" => {
                let sup = app.state::<Supervisor>().inner().clone();
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    sup.stop().await;
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click the tray icon → bring the window forward.
            if let TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(&app)?;
    Ok(())
}

/// A minimal embedded fallback icon so the tray always has something to show even when
/// the bundled window icon is unavailable (e.g. dev builds without an icon set). Desktop-only.
#[cfg(desktop)]
fn default_icon() -> tauri::image::Image<'static> {
    // 1x1 transparent RGBA pixel; replaced by the real bundle icon in packaged builds.
    tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
}
