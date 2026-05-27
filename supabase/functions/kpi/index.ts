import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";
import {
  resolvePipelineDateRange,
  previousPipelineRange,
  resolveRealtimeBounds,
  previousRealtimeBounds,
} from "../_shared/date-utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);
    console.log("[kpi] AUTH OK");

    const url = new URL(req.url);
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");

    const pipelineCurrent = resolvePipelineDateRange(rawFrom, rawTo);
    const pipelinePrev = previousPipelineRange(pipelineCurrent.from, pipelineCurrent.to);
    const realtimeCurrent = resolveRealtimeBounds(rawFrom, rawTo);
    const realtimePrev = previousRealtimeBounds(realtimeCurrent.utcStart, realtimeCurrent.utcEnd);

    // ====================================================================
    // CURRENT PERIOD
    // ====================================================================

    const currentMessagesResult = await admin
      .from("community_messages")
      .select("message_id", { count: "exact", head: true })
      .gte("created_at", realtimeCurrent.utcStart)
      .lte("created_at", realtimeCurrent.utcEnd);
    if (currentMessagesResult.error) throw currentMessagesResult.error;
    const totalMessages = currentMessagesResult.count ?? 0;

    const currentSummaryResult = await admin
      .from("pipeline_daily_summaries")
      .select("sentiment, severity, message_count")
      .gte("processing_date", pipelineCurrent.from)
      .lte("processing_date", pipelineCurrent.to);
    if (currentSummaryResult.error) throw currentSummaryResult.error;
    const currentSummaries = currentSummaryResult.data ?? [];
    const totalClusters = currentSummaries.length;

    const highSeverityCount = currentSummaries.filter(
      (s) => s.severity === "high" || s.severity === "critical",
    ).length;

    const frustratedCount = currentSummaries.filter(
      (s) => s.sentiment === "frustrated",
    ).length;
    const frustratedPercentage = totalClusters > 0
      ? Math.round((frustratedCount / totalClusters) * 1000) / 10
      : 0;

    const rangeStart = new Date(realtimeCurrent.utcStart);
    const rangeEnd = new Date(realtimeCurrent.utcEnd);
    const totalHours = Math.max(
      1,
      (rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60),
    );
    const avgMessagesPerHour = Math.round((totalMessages / totalHours) * 100) / 100;

    const currentUserIdsResult = await admin
      .from("community_messages")
      .select("user_id")
      .gte("created_at", realtimeCurrent.utcStart)
      .lte("created_at", realtimeCurrent.utcEnd);
    if (currentUserIdsResult.error) throw currentUserIdsResult.error;
    const totalUsers = new Set(
      (currentUserIdsResult.data ?? []).map((r: { user_id: string }) => r.user_id),
    ).size;

    const sentimentCounts: Record<string, number> = {};
    const severityCounts: Record<string, number> = {};
    for (const s of currentSummaries) {
      const sentiment = (s.sentiment as string) || "unknown";
      const severity = (s.severity as string) || "unknown";
      sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
      severityCounts[severity] = (severityCounts[severity] || 0) + 1;
    }

    // ====================================================================
    // PREVIOUS PERIOD
    // ====================================================================

    const previousMessagesResult = await admin
      .from("community_messages")
      .select("message_id", { count: "exact", head: true })
      .gte("created_at", realtimePrev.utcStart)
      .lte("created_at", realtimePrev.utcEnd);
    if (previousMessagesResult.error) throw previousMessagesResult.error;
    const prevTotalMessages = previousMessagesResult.count ?? 0;

    const previousSummaryResult = await admin
      .from("pipeline_daily_summaries")
      .select("sentiment, severity, message_count")
      .gte("processing_date", pipelinePrev.from)
      .lte("processing_date", pipelinePrev.to);
    if (previousSummaryResult.error) throw previousSummaryResult.error;
    const previousSummaries = previousSummaryResult.data ?? [];
    const prevTotalClusters = previousSummaries.length;

    const prevHighSeverityCount = previousSummaries.filter(
      (s) => s.severity === "high" || s.severity === "critical",
    ).length;

    const prevFrustratedCount = previousSummaries.filter(
      (s) => s.sentiment === "frustrated",
    ).length;
    const prevFrustratedPercentage = prevTotalClusters > 0
      ? Math.round((prevFrustratedCount / prevTotalClusters) * 1000) / 10
      : 0;

    const prevRangeStart = new Date(realtimePrev.utcStart);
    const prevRangeEnd = new Date(realtimePrev.utcEnd);
    const prevTotalHours = Math.max(
      1,
      (prevRangeEnd.getTime() - prevRangeStart.getTime()) / (1000 * 60 * 60),
    );
    const prevAvgMessagesPerHour = Math.round((prevTotalMessages / prevTotalHours) * 100) / 100;

    const previousUserIdsResult = await admin
      .from("community_messages")
      .select("user_id")
      .gte("created_at", realtimePrev.utcStart)
      .lte("created_at", realtimePrev.utcEnd);
    if (previousUserIdsResult.error) throw previousUserIdsResult.error;
    const prevTotalUsers = new Set(
      (previousUserIdsResult.data ?? []).map((r: { user_id: string }) => r.user_id),
    ).size;

    // ====================================================================
    // RESPONSE
    // ====================================================================

    console.log("[kpi] OK:", { totalMessages, totalClusters, totalUsers });

    return Response.json(
      {
        ok: true,
        data: {
          range: { from: pipelineCurrent.from, to: pipelineCurrent.to },
          comparison_range: { from: pipelinePrev.from, to: pipelinePrev.to },
          total_messages: { value: totalMessages, delta: totalMessages - prevTotalMessages },
          total_clusters: { value: totalClusters, delta: totalClusters - prevTotalClusters },
          high_severity_count: { value: highSeverityCount, delta: highSeverityCount - prevHighSeverityCount },
          frustrated_percentage: {
            value: frustratedPercentage,
            delta: Math.round((frustratedPercentage - prevFrustratedPercentage) * 10) / 10,
          },
          avg_messages_per_hour: {
            value: avgMessagesPerHour,
            delta: Math.round((avgMessagesPerHour - prevAvgMessagesPerHour) * 100) / 100,
          },
          total_users: { value: totalUsers, delta: totalUsers - prevTotalUsers },
          sentiment: {
            counts: sentimentCounts,
            percentages: Object.fromEntries(
              Object.entries(sentimentCounts).map(([k, v]) => [
                k,
                totalClusters > 0 ? Math.round((v / totalClusters) * 10000) / 100 : 0,
              ]),
            ),
          },
          severity: {
            counts: severityCounts,
            percentages: Object.fromEntries(
              Object.entries(severityCounts).map(([k, v]) => [
                k,
                totalClusters > 0 ? Math.round((v / totalClusters) * 10000) / 100 : 0,
              ]),
            ),
          },
        },
      },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
