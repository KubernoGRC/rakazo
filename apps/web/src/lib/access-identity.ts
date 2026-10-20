import { fetchAuthCapabilities } from "./auth-capabilities";

/**
 * Fork: under access identity the access proxy has already authenticated the
 * visitor, so the sign-in page exchanges its verified assertion for a session.
 */
export type AccessSignIn =
  | { kind: "signed-in"; created: boolean }
  /** The server refused this identity: only the portal can change that. */
  | { kind: "refused" }
  /** The network or the server failed; asking again may work. */
  | { kind: "unavailable" };

export async function signInWithAccessIdentity(): Promise<AccessSignIn> {
  let response: Response;
  try {
    response = await fetch("/api/auth/access-identity/sign-in", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "refused" };
  if (!response.ok) return { kind: "unavailable" };
  const body: unknown = await response.json().catch(() => null);
  const created =
    typeof body === "object" && body !== null && (body as { created?: unknown }).created === true;
  return { kind: "signed-in", created };
}

/**
 * Fork: ending only the Rakazo session lets the access proxy sign the visitor
 * straight back in. After a successful sign-out, continue to the proxy's logout
 * when the deployment names one. Returns true when the browser is leaving.
 */
export async function leaveThroughAccessLogout(signedOut: boolean): Promise<boolean> {
  if (!signedOut) return false;
  let url: string | undefined;
  try {
    const capabilities = await fetchAuthCapabilities();
    url = capabilities.accessIdentity ? capabilities.accessLogoutUrl : undefined;
  } catch {
    return false;
  }
  if (!url) return false;
  window.location.assign(url);
  return true;
}
