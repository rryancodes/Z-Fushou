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
    console.log("[live-timeline] AUTH OK");

    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status") || "open";
    const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 200);
    const attentionFilter = url.searchParams.get("attention");

    // Build case query
    let caseQuery = admin
      .from("live_cases")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (statusFilter === "open") {
      caseQuery = caseQuery.eq("status", "open");
    } else if (statusFilter === "closed") {
      caseQuery = caseQuery.eq("status", "closed");
    }
    // "all" or anything else → no status filter

    const { data: cases, error: caseError } = await caseQuery;
    if (caseError) throw caseError;

    if (!cases || cases.length === 0) {
      console.log("[live-timeline] OK:", { total: 0 });
      return Response.json(
        { ok: true, data: [], stats: { open: 0, closed: 0 } },
        { headers: corsHeaders },
      );
    }

    // Filter by attention score if requested
    let filtered = cases;
    if (attentionFilter) {
      const validScores = attentionFilter.split(",");
      filtered = filtered.filter((c: Record<string, unknown>) =>
        validScores.includes(c.attention_score as string)
      );
    }

    // Fetch recent events for all returned cases
    const caseIds = filtered.map((c: Record<string, unknown>) => c.id as string);

    const { data: events, error: eventsError } = await admin
      .from("live_case_events")
      .select("id, case_id, event_type, event_summary, created_at")
      .in("case_id", caseIds)
      .order("created_at", { ascending: false })
      .limit(caseIds.length * 5);

    if (eventsError) throw eventsError;

    // Group events by case_id (last 5 per case)
    const eventsByCase = new Map<string, unknown[]>();
    const eventCounts = new Map<string, number>();
    for (const ev of events || []) {
      const cid = ev.case_id as string;
      const count = eventCounts.get(cid) || 0;
      if (count < 5) {
        if (!eventsByCase.has(cid)) eventsByCase.set(cid, []);
        eventsByCase.get(cid)!.push({
          event_type: ev.event_type,
          event_summary: ev.event_summary,
          created_at: ev.created_at,
        });
        eventCounts.set(cid, count + 1);
      }
    }

    // Merge cases with their events
    const data = filtered.map((c: Record<string, unknown>) => ({
      id: c.id,
      guild_id: c.guild_id,
      channel_id: c.channel_id,
      thread_id: c.thread_id,
      status: c.status,
      state: c.state,
      summary: c.summary,
      current_status: c.current_status,
      routing_type: c.routing_type,
      attention_score: c.attention_score,
      timeline: c.timeline,
      unresolved_questions: c.unresolved_questions,
      message_count: c.message_count,
      update_count: c.update_count,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
      updated_at: c.updated_at,
      confidence: c.confidence,
      latest_events: eventsByCase.get(c.id as string) || [],
    }));

    // Stats: open + closed today
    const today = new Date().toISOString().split("T")[0];
    const [openResult, closedTodayResult] = await Promise.all([
      admin
        .from("live_cases")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),
      admin
        .from("live_cases")
        .select("id", { count: "exact", head: true })
        .eq("status", "closed")
        .gte("updated_at", `${today}T00:00:00Z`),
    ]);

    if (openResult.error) throw openResult.error;
    if (closedTodayResult.error) throw closedTodayResult.error;

    console.log("[live-timeline] OK:", { returned: data.length, open: openResult.count, closedToday: closedTodayResult.count });

    return Response.json(
      {
        ok: true,
        data,
        stats: {
          open: openResult.count || 0,
          closed_today: closedTodayResult.count || 0,
        },
      },
      { headers: corsHeaders },
    );
  } catch (err: unknown) {
    return handleEdgeError(err);
  }
});
