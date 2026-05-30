import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";

// ---------------------------------------------------------------------------
// Date validation (strict — rejects bad inputs, never silently falls back)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function isValidIso(str: string): boolean {
  if (!str) return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

interface DateBounds {
  utcStart: string;
  utcEnd: string;
}

function resolveBounds(
  from?: string | null,
  to?: string | null,
): DateBounds | string {
  if (from && to) {
    if (!isValidIso(from)) return 'Invalid "from" date: not a valid ISO timestamp';
    if (!isValidIso(to)) return 'Invalid "to" date: not a valid ISO timestamp';
    if (new Date(from) > new Date(to)) return '"from" must be before or equal to "to"';

    const startDate = new Date(from);
    let endDate = new Date(to);

    // Bare date strings (YYYY-MM-DD, no time component) → expand 'to' to
    // end of day so from=day&to=day returns the full 24 hours instead of
    // a zero-width range at midnight. If either has a 'T' (time component),
    // use exact values — this preserves single-hour queries like
    // from=...T14:00:00Z&to=...T15:00:00Z.
    if (!to.includes('T')) {
      endDate = new Date(endDate.getTime() + DAY_MS - 1); // 23:59:59.999
    }

    return {
      utcStart: startDate.toISOString(),
      utcEnd: endDate.toISOString(),
    };
  }

  if (from) {
    if (!isValidIso(from)) return 'Invalid "from" date: not a valid ISO timestamp';
    return {
      utcStart: new Date(from).toISOString(),
      utcEnd: new Date().toISOString(),
    };
  }

  const now = new Date();
  return {
    utcStart: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    utcEnd: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sanitiser — no null / undefined / NaN in response
// ---------------------------------------------------------------------------

interface HourRow {
  hour: string;
  message_count: number;
  unique_users: number;
  cluster_count: number;
}

function sanitise(rows: unknown[]): HourRow[] {
  return rows.map((raw: Record<string, unknown>) => {
    const h = raw.hour;
    const hourIso =
      typeof h === 'number'
        ? new Date(h).toISOString()     // defensive: epoch ms (shouldn't happen)
        : new Date(String(h)).toISOString(); // normal: ISO string from TIMESTAMPTZ
    return {
      hour: hourIso,
      message_count: Number(raw.message_count) || 0,
      unique_users: Number(raw.unique_users) || 0,
      cluster_count: Number(raw.cluster_count) || 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Edge function
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);
    console.log("[activity] AUTH OK");

    // dateFrom/dateTo kept for backward compat until Electron confirms from/to
    const url = new URL(req.url);
    const rawFrom =
      url.searchParams.get("from") || url.searchParams.get("dateFrom");
    const rawTo =
      url.searchParams.get("to") || url.searchParams.get("dateTo");

    const boundsResult = resolveBounds(rawFrom, rawTo);
    if (typeof boundsResult === "string") {
      return Response.json(
        { ok: false, error: boundsResult },
        { status: 400, headers: corsHeaders },
      );
    }

    const { utcStart, utcEnd } = boundsResult;

    const result = await admin.rpc("get_hourly_activity", {
      p_start: utcStart,
      p_end: utcEnd,
    });
    if (result.error) throw result.error;

    const hours: HourRow[] = sanitise(result.data ?? []);

    // Count truly unique users across the entire date range (avoids
    // double-counting users who post in multiple hours). Per-hour
    // unique_users in the hours array remains correct for chart bars.
    const totalUsersResult = await admin
      .from("community_messages")
      .select("user_id")
      .gte("created_at", utcStart)
      .lte("created_at", utcEnd);
    if (totalUsersResult.error) throw totalUsersResult.error;
    const totalUniqueUsers = new Set(
      (totalUsersResult.data ?? []).map((r: { user_id: string }) => r.user_id),
    ).size;

    console.log("[activity] OK:", { hours: hours.length, total_unique_users: totalUniqueUsers });

    return Response.json(
      { ok: true, data: { hours, total_unique_users: totalUniqueUsers } },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
