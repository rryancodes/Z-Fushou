import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";
import { resolveRealtimeBounds } from "../_shared/date-utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);

    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") || "50");
    const page = Number(url.searchParams.get("page") || "1");
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const bounds = resolveRealtimeBounds(rawFrom, rawTo);

    const { data, error, count } = await admin
      .from("community_messages")
      .select("*", { count: "exact" })
      .eq("is_monitored_mention", true)
      .order("created_at", { ascending: false })
      .gte("created_at", bounds.utcStart)
      .lte("created_at", bounds.utcEnd)
      .range(from, to);

    if (error) throw error;

    console.log("[mentions] OK:", { total: count, returned: data?.length });

    return Response.json(
      {
        ok: true,
        data,
        pagination: { page, limit, total: count },
      },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
