# cron-runner — working agreement

## What this is

A scheduled-job runner: register jobs with a cron expression and a shell
command; the runner fires them and records outcomes.

## Conventions

- Jobs are declared in `jobs.toml`; never hand-edit the run log.
- Every job has a timeout; a job with no timeout is a bug.
- Failures retry with backoff, max 3 attempts.

## Current focus

- [ ] cron expression parser
- [ ] job registry
- [ ] backoff retry
- [ ] run-outcome log
