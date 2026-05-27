import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";
import { fillDateGaps } from "../_shared/date-utils.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);

    const url = new URL(req.url);
    const clusterId = Number(url.searchParams.get("cluster_id"));
    const date = url.searchParams.get("date");

    if (!clusterId || !date) {
      return Response.json(
        { ok: false, error: "cluster_id and date are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // 1. Cluster lookup
    const { data: cluster, error: clusterError } = await admin
      .from("pipeline_daily_clusters")
      .select("*")
      .eq("cluster_id", clusterId)
      .eq("processing_date", date)
      .single();

    if (clusterError || !cluster) {
      return Response.json(
        { ok: false, error: "Cluster not found" },
        { status: 404, headers: corsHeaders },
      );
    }

    // 2. Topic summary
    const { data: summary } = await admin
      .from("pipeline_daily_summaries")
      .select("*")
      .eq("cluster_id", clusterId)
      .eq("processing_date", date)
      .maybeSingle();

    // 3. Sibling clusters
    const { data: siblings } = await admin
      .from("pipeline_daily_clusters")
      .select("cluster_id, topic_label, message_count, unique_users")
      .eq("processing_date", date)
      .neq("cluster_id", clusterId);

    // 4. Sparkline
    const targetDate = new Date(date + "T00:00:00Z");
    const sparklineStart = new Date(targetDate.getTime() - 7 * DAY_MS);
    const sparklineEnd = new Date(targetDate.getTime() + 7 * DAY_MS);
    const sparklineStartStr = sparklineStart.toISOString().split("T")[0];
    const sparklineEndStr = sparklineEnd.toISOString().split("T")[0];

    const { data: sparklineData } = await admin
      .from("pipeline_daily_clusters")
      .select("processing_date, cluster_id, message_count")
      .gte("processing_date", sparklineStartStr)
      .lte("processing_date", sparklineEndStr);

    const sparklineMap = new Map<string, number>();
    for (const row of sparklineData ?? []) {
      if (row.cluster_id === clusterId) {
        sparklineMap.set(row.processing_date, row.message_count);
      }
    }

    const sparkline = Array.from(
      fillDateGaps(sparklineMap, sparklineStartStr, sparklineEndStr, 0),
      ([d, c]) => ({ date: d, message_count: c }),
    );

    // 5. Messages in this cluster
    const { data: clusterMessages } = await admin
      .from("pipeline_cluster_messages")
      .select("message_id")
      .eq("cluster_id", clusterId)
      .eq("processing_date", date);

    const messageIds = (clusterMessages ?? []).map(
      (m: { message_id: string }) => m.message_id,
    );

    let messages: Record<string, unknown>[] = [];
    if (messageIds.length > 0) {
      const { data: msgData } = await admin
        .from("community_messages_clean")
        .select("message_id, content, username, user_id, timestamp, channel_id")
        .in("message_id", messageIds)
        .order("timestamp", { ascending: true });

      messages = msgData ?? [];
    }

    console.log("[cluster-detail] OK:", {
      clusterId,
      date,
      siblings: siblings?.length,
      messages: messages.length,
    });

    return Response.json(
      {
        ok: true,
        data: {
          cluster,
          summary: summary ?? null,
          siblings: siblings ?? [],
          sparkline,
          messages,
        },
      },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
