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
