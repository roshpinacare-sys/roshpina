// Owner-gate client helper — the console never stores secrets at rest.
// The unlock token (derived server-side from the vault passphrase) lives in
// sessionStorage for the tab's lifetime only and rides the x-owner-token
// header on every mutating call. Read-only truth surfaces stay public.

export const OWNER_TOKEN_KEY = "saos-owner-token";

export function getOwnerToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(OWNER_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setOwnerToken(token: string): void {
  try {
    window.sessionStorage.setItem(OWNER_TOKEN_KEY, token);
  } catch {
    /* private mode — gate stays locked, read-only still works */
  }
}

export function clearOwnerToken(): void {
  try {
    window.sessionStorage.removeItem(OWNER_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export function ownerHeaders(): Record<string, string> {
  const t = getOwnerToken();
  return t ? { "x-owner-token": t } : {};
}

export function isOwnerDenied(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { error?: string }).error === "owner_auth_required";
}
