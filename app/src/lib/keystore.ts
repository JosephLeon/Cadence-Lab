/**
 * Frontend wrapper around the Rust-side keychain commands.
 *
 * Three IPC commands (defined in src-tauri/src/lib.rs) hit the OS-native
 * secret store via the `keyring` crate: macOS Keychain, Windows Credential
 * Manager, libsecret on Linux. Keys never persist in webview state and
 * never get written to disk in plaintext.
 *
 * Browser-dev (non-Tauri) fallback: when `window.__TAURI_INTERNALS__` is
 * absent, the wrappers no-op gracefully so opening the UI in a regular
 * browser doesn't crash. In that mode the sidecar still reads keys from
 * `.env` via python-dotenv — same as before the Settings UI existed.
 */

import { invoke } from "@tauri-apps/api/core";

export type KeyProvider = "anthropic" | "groq";

function inTauri(): boolean {
  // Tauri 2 exposes this internal marker in the webview's window. Cheaper
  // than try/catching every invoke() call.
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function keychainGet(provider: KeyProvider): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    const v = await invoke<string | null>("keychain_get", { account: provider });
    return v ?? null;
  } catch (e) {
    console.error(`keychain_get(${provider}) failed:`, e);
    return null;
  }
}

export async function keychainSet(
  provider: KeyProvider,
  value: string,
): Promise<void> {
  if (!inTauri()) return;
  await invoke("keychain_set", { account: provider, value });
}

export async function keychainDelete(provider: KeyProvider): Promise<void> {
  if (!inTauri()) return;
  await invoke("keychain_delete", { account: provider });
}
