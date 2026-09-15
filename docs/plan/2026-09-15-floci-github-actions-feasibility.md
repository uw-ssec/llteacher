# Floci in GitHub Actions: feasibility note

## Answer

This is **straightforward for per-branch integration verification**, but it is not a way to publish a durable preview environment from GitHub-hosted runners. Floci is a local AWS emulator: its own documentation explicitly supports unrestricted CI use and provides a GitHub Actions service-container example. [Floci overview](https://floci.io/floci/) · [Floci CI example](https://floci.io/floci/configuration/docker-compose/)

On every branch push, Actions can start Floci, apply the local infrastructure definition against its AWS-compatible endpoint, build/run the two app containers, and execute smoke or end-to-end tests. This provisions only resources inside that job's Docker environment; no real AWS account or cloud resource is touched. Floci documents the same endpoint-override model for IaC, including that each AWS service endpoint used must be configured. [Floci IaC endpoint guidance](https://floci.io/floci/getting-started/terraform/)

## Hosted runners vs. persistent environments

| Runner model | What it provides | What happens after the job |
| --- | --- | --- |
| GitHub-hosted (`ubuntu-latest`) | A clean, branch-specific disposable test environment. GitHub states that every hosted job runs in a fresh runner instance. | The runner is discarded, so the Floci container, local images, volumes, resource state, and reachable URLs disappear. This is the recommended CI mode. [GitHub runner selection](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job) |
| Self-hosted runner | A machine we operate, which can retain Docker volumes and a running Floci environment between jobs. GitHub notes that such runners do not need to be clean for every job. | It can support a persistent internal preview, but it requires explicit branch isolation, cleanup, concurrency control, disk management, and network exposure. It is not an internet-hosted production deployment. [GitHub self-hosted runners](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners) |

Floci's storage modes confirm the distinction: `memory` is intended for CI; durable modes require an attached volume/path and are intended for development. RDS also creates Docker volumes for database data, and RDS/ECS-style container services require Docker-socket access. [Floci storage modes](https://floci.io/floci/configuration/storage/) · [Floci Docker configuration](https://floci.io/floci/configuration/docker-compose/)

## Minimum workflow shape

1. Trigger on `push` (and preferably `pull_request`) for the intended branches; use a per-ref concurrency group so a newer push supersedes an older run for that branch.
2. Use a Docker-capable Linux runner, check out the repository, and start a pinned Floci image as a service/container. For the planned RDS and ECS resources, pass the Docker socket and the documented RDS port range to Floci. [Floci RDS Docker requirements](https://floci.io/floci/configuration/docker-compose/)
3. Wait for Floci readiness, then run the local infrastructure apply with all AWS-provider endpoints directed to Floci. Use non-production test credentials (`test`) and `AWS_ENDPOINT_URL`; do not grant AWS credentials.
4. Build the `web` and `admin` images, deploy them to the emulated ECS environment, and run health/smoke/E2E checks through the local ALB hostname routing.
5. Upload test logs and diagnostics as workflow artifacts; cleanup is automatic for hosted runners. Pin the Floci image rather than relying on `latest` once the integration is established.

## Recommendation

Add this as a **CI verification workflow**, not a per-branch deployment promise. It is a small-to-medium addition once the local compose/IaC command path exists: the main work is making the local stack non-interactive, deterministic, and testable. A persistent branch environment is a separate operational feature and should be considered only after the disposable CI job is stable.

The eventual Pulumi implementation should retain an explicit local endpoint mode so the same resource definitions can be applied to Floci in CI and to AWS only in a separately authorized deployment workflow. Floci's published IaC example is Terraform-specific; endpoint support for the chosen Pulumi AWS provider must be verified during implementation rather than assumed from that example.
