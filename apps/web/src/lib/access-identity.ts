/**
 * Fork: under access identity the access proxy has already authenticated the
 * visitor, so the sign-in page exchanges its verified assertion for a session.
 */
export async function signInWithAccessIdentity(): Promise<{ created: boolean } | null> {
  try {
    const response = await fetch("/api/auth/access-identity/sign-in", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    const created =
      typeof body === "object" && body !== null && (body as { created?: unknown }).created === true;
    return { created };
  } catch {
    return null;
  }
}
