/**
 * verify-desktop-auth.ts
 *
 * Universal auth layer for all analytics edge functions.
 * Verifies a desktop JWT by delegating to the website auth authority.
 *
 * Flow:
 *   Electron app → Bearer token → Edge Function → Website auth verifies → Analytics DB queried
 *
 * No Clerk secrets or desktop JWT secrets live in the analytics project.
 * Auth and revocation are fully centralized on the website.
 */

export async function verifyDesktopAuth(req: Request): Promise<{ clerkUserId: string }> {
  const authHeader = req.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const token = authHeader.replace("Bearer ", "");

  const verifyUrl = Deno.env.get("AUTH_VERIFY_URL");
  if (!verifyUrl) {
    throw new Error("AUTH_VERIFY_URL is not configured");
  }

  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    throw new Error("Unauthorized");
  }

  const data = await res.json();

  if (!data.ok) {
    throw new Error("Invalid session");
  }

  return {
    clerkUserId: data.clerkUserId,
  };
}
