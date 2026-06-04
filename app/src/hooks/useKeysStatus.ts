import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type KeysStatusResponse } from "../api/client";

/**
 * Shared TanStack Query hook for the sidecar's /settings/keys/status.
 *
 * Centralizing lets WelcomeScreen, SettingsModal, and any future caller
 * share one cache entry. Critically, when App.tsx pushes keychain keys
 * to the sidecar on launch (or SettingsModal saves new keys), every
 * caller refetches via a single `invalidateKeysStatus(qc)` instead of
 * each one rolling its own invalidation.
 *
 * `staleTime: 0` ensures consumers always see fresh data after an
 * invalidate; the data is cheap to fetch (one localhost HTTP call) and
 * the failure mode of showing stale "no key set" UX after the user
 * just set one is worse than a redundant refetch.
 */
export const KEYS_STATUS_QUERY_KEY = ["keys-status"] as const;

export function useKeysStatus() {
  return useQuery<KeysStatusResponse>({
    queryKey: KEYS_STATUS_QUERY_KEY,
    queryFn: () => api.keysStatus(),
    staleTime: 0,
    retry: 3,
  });
}

/** Invalidate the shared keys-status cache. Call from anywhere that
 *  mutates the sidecar's key state (App.tsx launch push, SettingsModal
 *  save, future Settings-driven clears). */
export function invalidateKeysStatus(
  qc: ReturnType<typeof useQueryClient>,
): Promise<void> {
  return qc.invalidateQueries({ queryKey: KEYS_STATUS_QUERY_KEY });
}
