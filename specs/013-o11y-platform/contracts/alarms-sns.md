# Contract — Independent-path alarms → existing SNS/email

**Within 013.** The alerting that survives total o11y-stack failure (US3).

## The contract

All three paths publish `alarm_actions` (and `ok_actions` where applicable) to the
**existing** topic `aws_sns_topic.backup_alarms` (RD-8) — the same path carrying the
backup-freshness alarm, subscribed via `var.alarm_email`. No new topic, no rename.

| Alarm | Metric | Threshold / config | FR / RD |
|---|---|---|---|
| CloudFront 5xx | `AWS/CloudFront 5xxErrorRate` (Avg) | `>= var.cf_5xx_threshold` (5%), `period=60`, `eval=5`, `datapoints=5`, `treat_missing=notBreaching` | FR-010, RD-6 |
| CloudFront Requests anomaly | `AWS/CloudFront Requests` + `ANOMALY_DETECTION_BAND(m1, var.requests_anomaly_stddev)` | `GreaterThanUpperOrLowerThreshold`, band σ=2 | FR-011, RD-6 |
| `/ready` synthetic | `aws_route53_health_check` `HTTPS_STR_MATCH` → `AWS/Route53 HealthCheckStatus` (Min) | health check path `/ready`, fqdn `app.squiredocs.com`, `search_string`, interval 30, failure_threshold 3; alarm `< 1`, `treat_missing=breaching` | FR-012, RD-6/RD-7 |

## Invariants review asserts (SC-005, FR-013)

- **Shared-nothing**: a dependency review finds **0** references from any alarm (or
  the Route 53 health check) to the monitoring node, OpenObserve, or the Collector.
  These are pure CloudFront/Route53-native paths — they fire even when everything
  013 builds is down.
- **Not a Synthetics canary**: the synthetic is a Route 53 health check
  (`HTTPS_STR_MATCH`), explicitly not `aws_synthetics_canary` (FR-012).
- **Fail-closed / safe-missing**: `/ready` health check treats missing as breaching
  (site-down = page); 5xx treats missing as not-breaching (no traffic ≠ outage — the
  health check owns "unreachable"). (Edge Cases: low-traffic false alarms, anomaly
  cold start.)
- **Existing topic**: SNS ARN = `aws_sns_topic.backup_alarms.arn`; no new
  `aws_sns_topic` / `aws_sns_topic_subscription` declared (RD-8).

## Ops-track dependency

Confirm `var.ready_health_check_search_string` against the live `/ready` response
body before trusting the alarm (RD-7, promotion-notes). Trip each alarm synthetically
post-apply (SC-008).
