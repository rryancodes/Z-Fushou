-- RPC function for the /activity edge function.
-- Aggregates community_messages and pipeline_daily_clusters into hourly buckets.
-- All aggregation is done in Postgres — the edge function only formats the result.

CREATE OR REPLACE FUNCTION public.get_hourly_activity(
  p_start TIMESTAMPTZ,
  p_end   TIMESTAMPTZ
)
RETURNS TABLE (
  hour          TIMESTAMPTZ,
  message_count BIGINT,
  unique_users  BIGINT,
  cluster_count BIGINT
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH msg_hours AS (
    SELECT
      date_trunc('hour', created_at) AS hour,
      COUNT(message_id)              AS message_count,
      COUNT(DISTINCT user_id)        AS unique_users
    FROM community_messages
    WHERE created_at >= p_start
      AND created_at <= p_end
    GROUP BY date_trunc('hour', created_at)
  ),
  cluster_hours AS (
    SELECT
      date_trunc('hour', start_timestamp) AS hour,
      COUNT(*)                            AS cluster_count
    FROM pipeline_daily_clusters
    WHERE start_timestamp >= p_start
      AND start_timestamp <= p_end
    GROUP BY date_trunc('hour', start_timestamp)
  )
  SELECT
    COALESCE(m.hour, c.hour)             AS hour,
    COALESCE(m.message_count, 0)::BIGINT AS message_count,
    COALESCE(m.unique_users,  0)::BIGINT AS unique_users,
    COALESCE(c.cluster_count, 0)::BIGINT AS cluster_count
  FROM msg_hours m
  FULL OUTER JOIN cluster_hours c ON m.hour = c.hour
  ORDER BY COALESCE(m.hour, c.hour) ASC;
END;
$$;
