import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type KeysValidateResponse } from "../api/client";
import { invalidateKeysStatus, useKeysStatus } from "../hooks/useKeysStatus";
import { keychainDelete, keychainGet, keychainSet } from "../lib/keystore";

/**
 * Settings modal — API key management.
 *
 * Flow:
 * 1. On mount, read both keys from the OS keychain to populate the masked
 *    inputs. The sidecar's view of what's active comes from the shared
 *    useKeysStatus hook so this modal automatically sees updates from
 *    App.tsx's mount-time keychain→sidecar push.
 * 2. On Save, diff each input against its mount-time value. Only fields
 *    the user actually changed get pushed — untouched fields aren't sent
 *    (so they don't accidentally clear an env-var-backed key the user
 *    never meant to touch).
 * 3. Validation pings the providers. Status auto-refreshes via
 *    invalidateKeysStatus, so WelcomeScreen's banner reflects the new
 *    state without a second round-trip.
 *
 * Actual key values never persist in component state longer than they
 * need to be — closing the modal drops them.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [anthropic, setAnthropic] = useState("");
  const [groq, setGroq] = useState("");
  // Mount-time snapshots so Save can diff and only send modified fields.
  // Empty string here means "no keychain entry" — distinct from "user
  // typed empty" which only happens after they explicitly cleared it.
  const [originalAnthropic, setOriginalAnthropic] = useState("");
  const [originalGroq, setOriginalGroq] = useState("");
  const [validation, setValidation] = useState<KeysValidateResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { data: status } = useKeysStatus();

  // On mount: load keychain values to populate the inputs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, g] = await Promise.all([
          keychainGet("anthropic"),
          keychainGet("groq"),
        ]);
        if (cancelled) return;
        const aVal = a ?? "";
        const gVal = g ?? "";
        setAnthropic(aVal);
        setGroq(gVal);
        setOriginalAnthropic(aVal);
        setOriginalGroq(gVal);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc to close — matches the pattern used by ReviewPanel + CadencePanel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saving, onClose]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setValidation(null);
    try {
      const anthropicTrim = anthropic.trim();
      const groqTrim = groq.trim();
      const anthropicChanged = anthropicTrim !== originalAnthropic.trim();
      const groqChanged = groqTrim !== originalGroq.trim();

      // 1. Persist to the keychain — only for fields the user changed.
      //    Non-empty → set; empty → delete (explicit clear).
      const keychainOps: Promise<unknown>[] = [];
      if (anthropicChanged) {
        keychainOps.push(
          anthropicTrim
            ? keychainSet("anthropic", anthropicTrim)
            : keychainDelete("anthropic"),
        );
      }
      if (groqChanged) {
        keychainOps.push(
          groqTrim ? keychainSet("groq", groqTrim) : keychainDelete("groq"),
        );
      }
      await Promise.all(keychainOps);

      // 2. Push to the sidecar — only the changed fields. The setKeys
      //    contract: omit = leave alone, empty string = clear in-memory.
      const patch: { anthropic?: string; groq?: string } = {};
      if (anthropicChanged) patch.anthropic = anthropicTrim;
      if (groqChanged) patch.groq = groqTrim;
      if (Object.keys(patch).length > 0) {
        await api.setKeys(patch);
        // Update mount-snapshots so subsequent Saves diff against the
        // new baseline (user can hit Save twice without re-clearing).
        if (anthropicChanged) setOriginalAnthropic(anthropicTrim);
        if (groqChanged) setOriginalGroq(groqTrim);
      }

      // 3. Refresh the shared cache so the WelcomeScreen banner and any
      //    other consumer of useKeysStatus see the new state.
      await invalidateKeysStatus(queryClient);

      // 4. Live-check both providers.
      setValidation(await api.validateKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-[520px] max-w-[90vw] rounded-lg border border-border bg-bg-panel shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-text-primary">
            API keys
          </h3>
          <button
            onClick={onClose}
            disabled={saving}
            className="h-7 w-7 rounded text-text-secondary hover:bg-bg-elevated disabled:opacity-40 flex items-center justify-center"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>
        <p className="text-xs text-text-muted mb-4 leading-snug">
          Stored in your OS keychain (macOS Keychain / Windows Credential
          Manager / libsecret). Never written to disk in plaintext, never
          uploaded.
        </p>

        <div className="space-y-4">
          <KeyField
            label="Anthropic"
            description="Required for the pause/filler classifier and the Ask Cadence chat. Get one at console.anthropic.com/settings/keys."
            value={anthropic}
            onChange={setAnthropic}
            status={status?.anthropic ?? null}
            validation={validation?.anthropic ?? null}
            placeholder="sk-ant-…"
          />
          <KeyField
            label="Groq"
            description="Required for hosted Whisper transcription (~30× realtime). Get one at console.groq.com/keys. Optional if you only use the local Whisper backend."
            value={groq}
            onChange={setGroq}
            status={status?.groq ?? null}
            validation={validation?.groq ?? null}
            placeholder="gsk_…"
          />
        </div>

        {error && (
          <div className="mt-4 text-xs text-rose-400 border border-rose-400/30 bg-rose-400/10 rounded px-2 py-1.5">
            ✗ {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="h-8 px-4 rounded bg-accent hover:bg-accent/80 text-white text-sm font-medium disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save & validate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyField({
  label,
  description,
  value,
  onChange,
  status,
  validation,
  placeholder,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
  status: { set: boolean; source: "in_memory" | "env" | "unset" } | null;
  validation: { ok: boolean | null; error?: string | null } | null;
  placeholder: string;
}) {
  // Source ribbon: "Active: from .env" / "Active: from keychain" /
  // "Not set" — surfaces *which* key the sidecar is using so users who
  // have both env + keychain set know which one is winning.
  const sourceLabel =
    status?.source === "in_memory"
      ? "Active: from keychain"
      : status?.source === "env"
        ? "Active: from .env"
        : "Not set";

  const validationBadge =
    validation?.ok === true
      ? { text: "✓ valid", cls: "text-emerald-400" }
      : validation?.ok === false
        ? { text: "✗ invalid", cls: "text-rose-400" }
        : null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-text-muted">{sourceLabel}</span>
          {validationBadge && (
            <span className={validationBadge.cls}>{validationBadge.text}</span>
          )}
        </div>
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="w-full h-9 rounded-md border border-border bg-bg px-3 text-sm font-mono placeholder:text-text-muted focus:outline-none focus:border-accent"
      />
      <p className="text-[10px] text-text-muted leading-snug">{description}</p>
      {validation?.error && (
        <p className="text-[10px] text-rose-400 leading-snug">
          {validation.error}
        </p>
      )}
    </div>
  );
}
