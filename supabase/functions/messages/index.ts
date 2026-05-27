import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);

    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "50");
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await admin
      .from("community_messages_clean")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;

    console.log("[messages] OK:", { total: count, returned: data?.length });

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
