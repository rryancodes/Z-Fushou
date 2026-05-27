/**
 * date-utils.ts
 *
 * TWO SEPARATE date models. NEVER mix them.
 *
 *   1. PIPELINE BATCH (date column) — pipeline_clusters, pipeline_topic_summaries, pipeline_cluster_messages
 *      Column: processing_date (Postgres DATE)
 *      Format: YYYY-MM-DD ONLY
 *      Helper: resolvePipelineDateRange()
 *
 *   2. REALTIME (timestamptz column) — community_messages, community_messages_clean
 *      Column: timestamp, created_at (Postgres TIMESTAMPTZ)
 *      Format: Full ISO UTC string
 *      Helper: resolveRealtimeBounds()
 *
 * NEVER pass UTC ISO strings to processing_date.
 * NEVER pass YYYY-MM-DD to timestamptz columns (loses timezone precision).
 */

/** Milliseconds in one day */
export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// PIPELINE BATCH — YYYY-MM-DD ONLY
// ---------------------------------------------------------------------------

/**
 * Resolve a date range for pipeline batch queries.
 * Returns { from, to } as YYYY-MM-DD strings.
 * For use with processing_date column ONLY.
 *
 * - If both provided: use as-is (stripped to YYYY-MM-DD if ISO)
 * - If only from: to defaults to today (YYYY-MM-DD)
 * - If neither: last 30 days
 */
export function resolvePipelineDateRange(
  from?: string | null,
  to?: string | null
): { from: string; to: string } {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  if (from && to) {
    return {
      from: from.split("T")[0],
      to: to.split("T")[0],
    };
  }

  if (from) {
    return {
      from: from.split("T")[0],
      to: today,
    };
  }

  const defaultFrom = new Date(now.getTime() - 30 * DAY_MS);
  return {
    from: defaultFrom.toISOString().split("T")[0],
    to: today,
  };
}

/**
 * Compute a previous pipeline date range for comparison.
 * Shifts both dates backward by the range length.
 * Returns { from, to } as YYYY-MM-DD strings.
 */
export function previousPipelineRange(
  currentFrom: string,
  currentTo: string
): { from: string; to: string } {
  const start = new Date(currentFrom + "T00:00:00Z");
  const end = new Date(currentTo + "T00:00:00Z");
  const rangeDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);

  const prevEnd = new Date(start.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - rangeDays * DAY_MS);

  return {
    from: prevStart.toISOString().split("T")[0],
    to: prevEnd.toISOString().split("T")[0],
  };
}

// ---------------------------------------------------------------------------
// REALTIME — UTC TIMESTAMPTZ ONLY
// ---------------------------------------------------------------------------

/**
 * Resolve UTC bounds for realtime timestamptz queries.
 * Returns { utcStart, utcEnd } as full ISO strings.
 * For use with timestamp/created_at columns ONLY.
 *
 * - If both provided: use as-is
 * - If only from: utcEnd defaults to now
 * - If neither: last 30 days
 */
export function resolveRealtimeBounds(
  from?: string | null,
  to?: string | null
): { utcStart: string; utcEnd: string } {
  const now = new Date();

  if (from && to) {
    return { utcStart: from, utcEnd: to };
  }

  if (from) {
    return { utcStart: from, utcEnd: now.toISOString() };
  }

  const defaultStart = new Date(now.getTime() - 30 * DAY_MS);
  return {
    utcStart: defaultStart.toISOString(),
    utcEnd: now.toISOString(),
  };
}

/**
 * Compute a previous realtime bounds range for comparison.
 * Shifts backward by the range length.
 * Returns { utcStart, utcEnd } as ISO strings.
 */
export function previousRealtimeBounds(
  currentStart: string,
  currentEnd: string
): { utcStart: string; utcEnd: string } {
  const start = new Date(currentStart);
  const end = new Date(currentEnd);
  const rangeMs = end.getTime() - start.getTime();

  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - rangeMs);

  return {
    utcStart: prevStart.toISOString(),
    utcEnd: prevEnd.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SHARED
// ---------------------------------------------------------------------------

/**
 * Fill gaps in a date-indexed map.
 * Given a Map<YYYY-MM-DD, T>, returns a new Map with every date
 * between `minDate` and `maxDate` present, using `defaultValue`
 * for dates that had no entry.
 *
 * @param existing - Map of date string to values
 * @param minDate - Earliest date (YYYY-MM-DD)
 * @param maxDate - Latest date (YYYY-MM-DD)
 * @param defaultValue - Value to use for missing dates
 */
export function fillDateGaps<T>(
  existing: Map<string, T>,
  minDate: string,
  maxDate: string,
  defaultValue: T
): Map<string, T> {
  const filled = new Map<string, T>();
  const current = new Date(minDate + "T00:00:00Z");
  const end = new Date(maxDate + "T00:00:00Z");

  while (current <= end) {
    const key = current.toISOString().split("T")[0];
    filled.set(key, existing.get(key) ?? defaultValue);
    current.setTime(current.getTime() + DAY_MS);
  }

  return filled;
}
