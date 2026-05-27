import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";
import { resolvePipelineDateRange } from "../_shared/date-utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);

    const url = new URL(req.url);
    const page = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "50");
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");
    const sentimentFilter = url.searchParams.get("sentiment");
    const severityFilter = url.searchParams.get("severity");
    const sort = url.searchParams.get("sort") || "created_at";
    const order = url.searchParams.get("order") || "desc";

    const dateRange = resolvePipelineDateRange(rawFrom, rawTo);

    const [clusterResult, summaryResult] = await Promise.all([
      admin
        .from("pipeline_daily_clusters")
        .select("*")
        .gte("processing_date", dateRange.from)
        .lte("processing_date", dateRange.to),
      admin
        .from("pipeline_daily_summaries")
        .select("*")
        .gte("processing_date", dateRange.from)
        .lte("processing_date", dateRange.to),
    ]);

    if (clusterResult.error) throw clusterResult.error;
    if (summaryResult.error) throw summaryResult.error;

    const summaryMap = new Map<string, Record<string, unknown>>();
    for (const s of summaryResult.data ?? []) {
      const key = `${s.cluster_id}:${s.processing_date}`;
      summaryMap.set(key, s);
    }

    let joined = (clusterResult.data ?? []).map((c: Record<string, unknown>) => {
      const key = `${c.cluster_id}:${c.processing_date}`;
      const s = summaryMap.get(key);

      return {
        processing_date: c.processing_date,
        cluster_id: c.cluster_id,
        topic_label: c.topic_label,
        message_count: c.message_count,
        unique_users: c.unique_users,
        avg_boundary_score: c.avg_boundary_score,
        start_timestamp: c.start_timestamp,
        end_timestamp: c.end_timestamp,
        created_at: c.created_at,
        summary: (s?.summary as string) ?? null,
        key_issues: (s?.key_issues as unknown[]) ?? [],
        unanswered_questions: (s?.unanswered_questions as unknown[]) ?? [],
        sentiment: (s?.sentiment as string) ?? "unknown",
        severity: (s?.severity as string) ?? "unknown",
        messages_per_hour: (s?.messages_per_hour as number) ?? null,
      };
    });

    if (sentimentFilter) {
      joined = joined.filter((row) => row.sentiment === sentimentFilter);
    }
    if (severityFilter) {
      joined = joined.filter((row) => row.severity === severityFilter);
    }

    const sortKey = sort === "message_count" ? "message_count"
      : sort === "unique_users" ? "unique_users"
      : "created_at";
    const sortDir = order === "asc" ? 1 : -1;
    joined.sort((a, b) => {
      const av = a[sortKey] as number | string;
      const bv = b[sortKey] as number | string;
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * sortDir;
      }
      return ((av as number) - (bv as number)) * sortDir;
    });

    const total = joined.length;
    const fromIdx = (page - 1) * limit;
    const toIdx = fromIdx + limit;
    const paginated = joined.slice(fromIdx, toIdx);

    console.log("[clusters] OK:", { total, returned: paginated.length });

    return Response.json(
      {
        ok: true,
        data: paginated,
        pagination: { page, limit, total },
      },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
