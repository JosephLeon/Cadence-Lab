// Cadence Lab — Tauri shell.
//
// Responsibilities:
//   1. Spawn the FastAPI sidecar (`uv run cadence-lab server`) on app launch.
//   2. Keep its Child handle in shared state and kill it on app exit so
//      stopping the app stops the backend too (no orphaned processes).
//   3. Show the React UI inside a native webview.
//
// Production note: the sidecar is spawned via `uv` and assumes the user has
// the Python project installed via `uv sync`. A future iteration will bundle
// a PyInstaller-frozen sidecar binary so the app is fully self-contained;
// for now, dev mode is the primary target. See docs/ARCHITECTURE.md for the
// deferred work.

use std::process::{Child, Command};
use std::sync::Mutex;

use keyring::Entry;
use tauri::{Manager, RunEvent};

/// Wrapper so we can stash the Child in app state without specifying lifetimes.
struct SidecarHandle(Mutex<Option<Child>>);

// ─── Keychain commands ──────────────────────────────────────────────────────
//
// Three thin wrappers around the `keyring` crate so the React layer can
// store per-provider API keys in the OS-native secret store (macOS
// Keychain, Windows Credential Manager, libsecret on Linux). Keys never
// touch disk in plaintext; the Settings modal reads them on mount and
// pushes them to the Python sidecar at app launch.
//
// Service is namespaced by the app identifier so a user with multiple
// Tauri apps installed won't see entries collide. `account` is the
// provider name (e.g. "anthropic", "groq").

const KEYCHAIN_SERVICE: &str = "com.cadencelab.app";

/// Explicit allowlist for the `account` parameter on every keychain
/// command. Defense-in-depth against any future XSS / supply-chain
/// compromise in the webview — a malicious script that gets `invoke`
/// access can't enumerate or fish for keys under arbitrary names
/// outside the providers we actually use.
const ALLOWED_ACCOUNTS: &[&str] = &["anthropic", "groq"];

fn validate_account(account: &str) -> Result<(), String> {
  if ALLOWED_ACCOUNTS.contains(&account) {
    Ok(())
  } else {
    Err(format!("disallowed account: {}", account))
  }
}

fn keychain_entry(account: &str) -> Result<Entry, String> {
  validate_account(account)?;
  Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get(account: String) -> Result<Option<String>, String> {
  let entry = keychain_entry(&account)?;
  match entry.get_password() {
    Ok(v) => Ok(Some(v)),
    // NoEntry → return None so the caller can distinguish "no key yet"
    // from a real failure. Any other error propagates.
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
fn keychain_set(account: String, value: String) -> Result<(), String> {
  let entry = keychain_entry(&account)?;
  entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_delete(account: String) -> Result<(), String> {
  let entry = keychain_entry(&account)?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    // Deleting a non-existent entry is a no-op from the caller's POV.
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

/// Spawn `uv run cadence-lab server` from the workspace root (where the
/// Python package and pyproject.toml live).
///
/// Walks up from the Tauri binary's executable path until it finds a directory
/// containing `pyproject.toml`. In dev that's the repo root; in a packaged
/// bundle this will need to change (the python project won't be alongside
/// the binary) — see lib doc.
fn spawn_sidecar() -> Option<Child> {
  // Best-effort: from the binary path, walk up looking for the project root.
  let exe = std::env::current_exe().ok()?;
  let project_root = exe
    .ancestors()
    .find(|p| p.join("pyproject.toml").is_file())
    .map(|p| p.to_path_buf())
    .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));

  log::info!("spawning sidecar from {}", project_root.display());

  let child = Command::new("uv")
    .args(["run", "cadence-lab", "server", "--port", "27182"])
    .current_dir(&project_root)
    .spawn();

  match child {
    Ok(c) => {
      log::info!("sidecar PID {}", c.id());
      Some(c)
    }
    Err(e) => {
      log::error!("failed to spawn sidecar: {}", e);
      None
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .invoke_handler(tauri::generate_handler![
      keychain_get,
      keychain_set,
      keychain_delete,
    ])
    .setup(|app| {
      let child = spawn_sidecar();
      app.manage(SidecarHandle(Mutex::new(child)));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Reap the sidecar when the app is exiting so we don't leave it
      // orphaned in the user's process list.
      if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
        if let Some(handle) = app_handle.try_state::<SidecarHandle>() {
          if let Ok(mut guard) = handle.0.lock() {
            if let Some(mut child) = guard.take() {
              log::info!("killing sidecar PID {}", child.id());
              let _ = child.kill();
              let _ = child.wait();
            }
          }
        }
      }
    });
}
