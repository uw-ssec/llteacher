---
type: Decision
title: The Fargate task runs in public subnets with a public IP and no NAT gateway
description: "To cut fixed cost, the app task gets a public IP in public subnets with ALB-only ingress; RDS stays in private subnets. This reversed the PR #458 remediation, which required private app subnets."
tags: [infra, networking, cost, security]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: context
code_refs: ["infra/src/network.ts", "infra/src/app.ts", "infra/src/resources.test.ts"]
sources:
  - resource: "docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md"
  - resource: "docs/superpowers/plans/2026-09-17-pr-458-review-remediation.md"
  - resource: "infra/README.md"
  - resource: "PR #461"
---

## Spec proposed
The PR #458 review remediation plan (2026-09-17) set a global constraint: "Staging and production must use private application/database subnets". Only local Floci could keep public-subnet behavior. Four days later, the minimal-production design (2026-09-21) reversed this. It uses one VPC across `us-west-2a`/`us-west-2b`, two public subnets for the ALB and the Fargate task, and two non-public subnets for RDS. There is no NAT Gateway, NAT EIP, or application-private route table.

## Implemented
`infra/src/network.ts` and `app.ts` follow the 09-21 design. `assignPublicIp: true` is set on the service, and it uses `network.appSubnetIds` (public). Three security groups enforce internet → ALB → app:8080 → database:5432. The app security group has no internet ingress rule. The Pulumi mock tests assert that NAT, EventBridge, SQS, CloudFront, and worker services are absent.

## Why
The design says removing the NAT Gateway and the separate scheduled task "eliminates the largest avoidable fixed/runtime costs". The task needs outbound access to WorkOS, LLMoxie/OpenRouter, and other public APIs. A public IP gives it that without NAT.

## Rejected alternatives
- Private app subnets with a NAT Gateway (the PR #458 remediation position).
- Application-private route tables.

## Consequences
`infra/README.md` records the trade-off: there is "no outbound network choke point". VPC endpoints, Flow Logs, and tighter egress are deferred compensating controls that "must be revisited before the threat model or scale changes". Unrestricted outbound security-group egress is intentional for now. Ingress still flows only through the ALB.
