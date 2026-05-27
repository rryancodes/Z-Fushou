import { corsHeaders } from "./cors.ts";

/**
 * Consistent error response for all edge functions.
 *
 * Auth errors → 401
 * Everything else → 500
 *
 * Error envelope always has: message, details, hint, code, raw
 */
export function handleEdgeError(err: unknown): Response {
  const e = err as Record<string, unknown>;
  const msg = e?.message ?? "";

  const isAuthError =
    typeof msg === "string" &&
    (msg === "Missing bearer token" ||
      msg === "Unauthorized" ||
      msg === "Invalid session" ||
      msg === "AUTH_VERIFY_URL is not configured");

  const status = isAuthError ? 401 : 500;

  console.error("[edge] ERROR:", {
    status,
    message: msg,
    code: e?.code ?? null,
  });

  return Response.json(
    {
      ok: false,
      error: {
        message: typeof msg === "string" ? msg : null,
        details: typeof e?.details === "string" ? e.details : null,
        hint: typeof e?.hint === "string" ? e.hint : null,
        code: typeof e?.code === "string" ? e.code : null,
        raw: JSON.stringify(err, Object.getOwnPropertyNames(err)),
      },
    },
    { status, headers: corsHeaders },
  );
}
