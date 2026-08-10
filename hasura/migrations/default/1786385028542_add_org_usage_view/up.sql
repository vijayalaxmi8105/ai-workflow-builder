CREATE OR REPLACE VIEW org_usage_this_month AS
SELECT
  w.org_id,
  COUNT(wr.id) AS runs_this_month,
  COUNT(wr.id) FILTER (WHERE wr.status = 'completed') AS completed_runs_this_month,
  AVG(EXTRACT(EPOCH FROM (wr.finished_at - wr.started_at)))
    FILTER (WHERE wr.finished_at IS NOT NULL) AS avg_run_duration_seconds
FROM workflow_runs wr
JOIN workflows w ON w.id = wr.workflow_id
WHERE date_trunc('month', wr.started_at) = date_trunc('month', now())
GROUP BY w.org_id;
