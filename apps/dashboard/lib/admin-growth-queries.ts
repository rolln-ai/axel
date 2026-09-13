// Cross-workspace reads used only after requireSuperAdmin. Kept independent of
// clients so the actual SQL can run against disposable Postgres and ClickHouse.
export const GROWTH_WORKSPACES_SQL = `
  SELECT w.id, w.created_at::text AS created_at,
         COALESCE(a.metadata->>'signup_source', 'unknown') AS signup_source
  FROM workspaces w
  LEFT JOIN LATERAL (
    SELECT metadata FROM audit_log
    WHERE workspace_id = w.id AND action = 'workspace.created'
    ORDER BY created_at ASC, id ASC LIMIT 1
  ) a ON true
  WHERE w.created_at >= $1::timestamptz AND w.created_at < $2::timestamptz
    AND COALESCE(w.billing_exempt, false) = false
    AND COALESCE(w.status, 'active') NOT IN ('deleted', 'deleting')
  ORDER BY w.created_at DESC, w.id
  LIMIT 1001
`;

export const GROWTH_ACTIVITY_SQL = `
  WITH cohorts AS (
    SELECT item.1 AS workspace_id, parseDateTime64BestEffort(item.2, 3) AS joined_at
    FROM (SELECT arrayJoin(arrayZip(JSONExtract({workspace_ids:String}, 'Array(String)'), JSONExtract({signup_times:String}, 'Array(String)'))) AS item)
  ), activity AS (
    SELECT e.workspace_id AS workspace_id,
           max(e.received_at < c.joined_at + INTERVAL 7 DAY) AS received_first_week,
           max(e.received_at >= c.joined_at + INTERVAL 7 DAY
               AND e.received_at < c.joined_at + INTERVAL 14 DAY) AS received_second_week,
           toUInt8(0) AS delivered_first_week
    FROM events e INNER JOIN cohorts c ON e.workspace_id = c.workspace_id
    WHERE e.is_test = false
      AND e.workspace_id IN JSONExtract({workspace_ids:String}, 'Array(String)')
      AND e.received_at >= parseDateTime64BestEffort({since:String}, 3)
      AND e.received_at < parseDateTime64BestEffort({until:String}, 3)
      AND e.received_at >= c.joined_at
    GROUP BY e.workspace_id
    UNION ALL
    SELECT d.workspace_id AS workspace_id, toUInt8(0), toUInt8(0),
           max(d.created_at < c.joined_at + INTERVAL 7 DAY)
    FROM delivery_attempts d INNER JOIN cohorts c ON d.workspace_id = c.workspace_id
    WHERE d.is_test = false AND d.status = 'success'
      AND d.workspace_id IN JSONExtract({workspace_ids:String}, 'Array(String)')
      AND d.created_at >= parseDateTime64BestEffort({since:String}, 3)
      AND d.created_at < parseDateTime64BestEffort({until:String}, 3)
      AND d.created_at >= c.joined_at
    GROUP BY d.workspace_id
  )
  SELECT workspace_id,
         max(received_first_week) AS received_first_week,
         max(received_second_week) AS received_second_week,
         max(delivered_first_week) AS delivered_first_week
  FROM activity GROUP BY workspace_id
`;
