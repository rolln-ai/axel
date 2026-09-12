// Group by event before counting windows so ClickHouse can spill small groups
// to disk. Three uniqExact sets per source exceeded the interactive memory cap.
export const SOURCE_EVENT_COUNTS_SQL = `
SELECT source_id,
       countIf(received_at >= parseDateTime64BestEffort({since24h:String}, 3)) AS events_24h,
       countIf(received_at >= parseDateTime64BestEffort({since30d:String}, 3)) AS events_30d,
       count() AS events_all
FROM (
  SELECT source_id, event_id, max(received_at) AS received_at
  FROM events
  WHERE workspace_id = {workspace_id:String}
  GROUP BY source_id, event_id
)
GROUP BY source_id`;
