## Changelog — Activity Endpoint Fixes

### `supabase/functions/activity/index.ts`

#### Fix: Single-day queries return zero results

`from=2026-05-30&to=2026-05-30` resolved both bounds to the same midnight (`00:00:00.000Z`), creating a zero-width range. The RPC's `WHERE created_at >= p_start AND created_at <= p_end` matched nothing since no real message lands at exactly midnight to the millisecond.

**Fix:** `resolveBounds` now detects bare date strings (no `T` in the `to` param) and expands the upper bound to `23:59:59.999Z`. Timestamps with time components (e.g. `from=...T14:00:00Z&to=...T15:00:00Z`) pass through untouched — single-hour precision is preserved.

```
Before: from=day&to=day → 00:00:00.000Z to 00:00:00.000Z → 0 results
After:  from=day&to=day → 00:00:00.000Z to 23:59:59.999Z → full 24h of data
```

#### Fix: Inconsistent `hour` field format

The `sanitise` function assumed `raw.hour` was always a string. Depending on PostgREST serialization, it could arrive as an integer (e.g. `14`), making it impossible for the dashboard to determine which day a bucket belonged to.

**Fix:** `sanitise` now handles both `number` and `string` inputs and always outputs a full ISO 8601 UTC timestamp. Every `hour` value in the response is now guaranteed to be `"2026-05-30T14:00:00.000Z"` — never a bare integer.

#### Dashboard impact

- **7-day heatmap:** Replace 7 overlapping 2-day requests (`from=day-1&to=day` + client-side filtering) with 7 clean single-day requests (`from=day&to=day`). No more cross-day bleed, no client-side date filtering needed.
- **Today's line graph:** Single `from=today&to=today` request returns all active hours. Plot from hour 0 to current Beijing hour, zero-filling gaps.
- **Data accuracy:** Per-day message sums from activity should now match `total_messages` from the KPI endpoint for the same date range. Previously, the zero-width range + cross-day bleed caused undercounts.

See `ACTIVITY_API_UPDATE.md` for the full integration guide.
