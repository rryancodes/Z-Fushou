import { admin } from "../_shared/admin.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyDesktopAuth } from "../_shared/verify-desktop-auth.ts";
import { handleEdgeError } from "../_shared/error-handler.ts";
import {
  resolvePipelineDateRange,
  resolveRealtimeBounds,
  fillDateGaps,
} from "../_shared/date-utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await verifyDesktopAuth(req);

    const url = new URL(req.url);
    const rawFrom = url.searchParams.get("from");
    const rawTo = url.searchParams.get("to");

    const pipelineRange = resolvePipelineDateRange(rawFrom, rawTo);
    const realtimeBounds = resolveRealtimeBounds(rawFrom, rawTo);

    const [pipelineResult, messagesResult] = await Promise.all([
      admin
        .from("pipeline_clusters")
        .select("processing_date")
        .gte("processing_date", pipelineRange.from)
        .lte("processing_date", pipelineRange.to),
      admin
        .from("community_messages_clean")
        .select("timestamp")
        .gte("timestamp", realtimeBounds.utcStart)
        .lte("timestamp", realtimeBounds.utcEnd),
    ]);

    if (pipelineResult.error) throw pipelineResult.error;
    if (messagesResult.error) throw messagesResult.error;

    const pipelineMap = new Map<string, boolean>();
    for (const row of pipelineResult.data ?? []) {
      if (row.processing_date) {
        pipelineMap.set(row.processing_date, true);
      }
    }

    const realtimeMap = new Map<string, boolean>();
    for (const row of messagesResult.data ?? []) {
      if (row.timestamp) {
        const dateKey = (row.timestamp as string).split("T")[0];
        realtimeMap.set(dateKey, true);
      }
    }

    const filledPipeline = fillDateGaps(pipelineMap, pipelineRange.from, pipelineRange.to, false);
    const filledRealtime = fillDateGaps(realtimeMap, pipelineRange.from, pipelineRange.to, false);

    const dates: {
      date: string;
      pipeline_available: boolean;
      realtime_available: boolean;
    }[] = [];

    for (const [dateKey] of filledPipeline) {
      dates.push({
        date: dateKey,
        pipeline_available: filledPipeline.get(dateKey) ?? false,
        realtime_available: filledRealtime.get(dateKey) ?? false,
      });
    }

    console.log("[date-availability] OK:", { dates: dates.length });

    return Response.json(
      { ok: true, data: dates },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
