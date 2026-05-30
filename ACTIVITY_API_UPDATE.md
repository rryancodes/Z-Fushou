# Activity Edge Function — Updated Query Guide

## What Changed

Two fixes were deployed to the `/activity` edge function:

### Fix 1: Single-day queries now return data

**Before:** `from=2026-05-30&to=2026-05-30` returned 0 results because both dates resolved to the same midnight (zero-width range).

**After:** Bare date strings (no `T`) now auto-expand the `to` value to end-of-day (`23:59:59.999Z`). So `from=2026-05-30&to=2026-05-30` returns the full 24 hours.

This only applies when `to` is a bare `YYYY-MM-DD`. If you pass a timestamp with a time component, it uses the exact values — so single-hour queries still work as before.

### Fix 2: `hour` field is now always an ISO string

**Before:** `hour` could come back as an integer (e.g. `14`) or an ISO string depending on the response path, making it impossible to determine which day a bucket belonged to.

**After:** `hour` is **always** a full ISO 8601 UTC timestamp string:
```json
"hour": "2026-05-30T14:00:00.000Z"
```

---

## Response Shape (unchanged)

```json
{
  "ok": true,
  "data": {
    "hours": [
      {
        "hour": "2026-05-30T00:00:00.000Z",
        "message_count": 5,
        "unique_users": 3,
        "cluster_count": 0
      },
      {
        "hour": "2026-05-30T01:00:00.000Z",
        "message_count": 12,
        "unique_users": 7,
        "cluster_count": 1
      },
      {
        "hour": "2026-05-30T14:00:00.000Z",
        "message_count": 8,
        "unique_users": 4,
        "cluster_count": 2
      }
    ],
    "total_unique_users": 11
  }
}
```

- `hours` array: one entry per hour that had activity. Hours with zero messages are **absent** — fill with zeros client-side.
- `hour`: always ISO 8601 UTC. Extract the hour number with `new Date(hour).getHours()` (UTC) or convert to Beijing with `new Date(hour).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric' })`.
- `total_unique_users`: deduplicated count across the entire range (not a sum of per-hour `unique_users`).

---

## Query Pattern 1: 7-Day Heatmap

### Old approach (remove this)

You were making 7 overlapping 2-day requests and filtering client-side:
```
activity?from=2026-05-24&to=2026-05-25   ← returns 2 days of data, filter client-side
activity?from=2026-05-25&to=2026-05-26   ← same, filter again
...
```

### New approach

Make 7 single-day requests — each returns exactly 1 day, no overlap, no filtering needed:
```
activity?from=2026-05-24&to=2026-05-24
activity?from=2026-05-25&to=2026-05-25
activity?from=2026-05-26&to=2026-05-26
activity?from=2026-05-27&to=2026-05-27
activity?from=2026-05-28&to=2026-05-28
activity?from=2026-05-29&to=2026-05-29
activity?from=2026-05-30&to=2026-05-30
```

Each response's `hours` array contains only buckets for that day. No cross-day bleed. No client-side date filtering.

### Client-side heatmap logic per day

```typescript
function buildDayHeatmap(hours: HourRow[]): number[] {
  // Initialize 24 slots at 0
  const buckets = new Array(24).fill(0);

  for (const entry of hours) {
    // hour is always ISO string now — extract hour in Beijing time
    const date = new Date(entry.hour);
    const beijingHour = parseInt(
      date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false })
    );
    // beijingHour is 0-23 — bucket it
    buckets[beijingHour] += entry.message_count;
  }

  return buckets; // [0, 0, 0, 3, 12, ..., 8, 0, 0] — 24 elements
}
```

For today's row, zero out hours beyond the current Beijing hour:
```typescript
const nowBeijing = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
const currentBeijingHour = new Date(nowBeijing).getHours();
for (let i = currentBeijingHour + 1; i < 24; i++) {
  buckets[i] = 0;
}
```

---

## Query Pattern 2: Today's Hourly Line Graph

Single request for today, then plot each hour bucket:

```
activity?from=2026-05-30&to=2026-05-30
```

### Plotting the line graph

The `hours` array gives you one entry per active hour. To build a continuous line:

```typescript
function buildLineData(hours: HourRow[]): { hour: number; messages: number; speakers: number }[] {
  const currentBeijingHour = getCurrentBeijingHour();

  // Build map from beijing hour → data
  const hourMap = new Map<number, { messages: number; speakers: number }>();

  for (const entry of hours) {
    const date = new Date(entry.hour);
    const beijingHour = parseInt(
      date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false })
    );
    const existing = hourMap.get(beijingHour) ?? { messages: 0, speakers: 0 };
    existing.messages += entry.message_count;
    existing.speakers += entry.unique_users;
    hourMap.set(beijingHour, existing);
  }

  // Build continuous array from hour 0 to current hour
  const lineData = [];
  for (let h = 0; h <= currentBeijingHour; h++) {
    const data = hourMap.get(h) ?? { messages: 0, speakers: 0 };
    lineData.push({
      hour: h,          // x-axis: 0, 1, 2, ..., currentBeijingHour
      messages: data.messages,
      speakers: data.speakers,
    });
  }

  return lineData;
}
```

Then plot:
- **x-axis:** `hour` (0 through current hour, labeled "12 AM", "1 AM", ..., "2 PM")
- **Line 1 (messages):** `messages` at each hour
- **Line 2 (speakers):** `speakers` at each hour

Example output for May 30 at 3 PM Beijing:
```
hour 0:  messages=2,  speakers=1    (quiet overnight)
hour 1:  messages=0,  speakers=0
hour 2:  messages=0,  speakers=0
...
hour 9:  messages=15, speakers=8    (morning activity starts)
hour 10: messages=23, speakers=12
hour 11: messages=18, speakers=9
hour 12: messages=31, speakers=15   (lunch peak)
hour 13: messages=14, speakers=7
hour 14: messages=22, speakers=11
hour 15: messages=8,  speakers=4    (current hour, partial data)
```

The response's `total_unique_users` gives you the overall unique speakers for the day (deduplicated, not a sum of per-hour counts).

---

## Summary of Changes for Your Code

1. **Remove the 2-day overlap hack.** Replace `from=day-1&to=day` with `from=day&to=day`.
2. **Remove client-side date filtering.** Each response is now scoped to exactly the requested day.
3. **Remove the integer-hour fallback branch.** `hour` is always an ISO string. Parse it with `new Date(hour)` and convert to Beijing timezone.
4. **Fill zeros for missing hours.** The API only returns hours with activity. Hours with 0 messages are absent from the array.
