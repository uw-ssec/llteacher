---
status: accepted
---

# Keep production secret values in operator-owned AWS Secrets Manager secrets

LLTeacher production will use AWS Secrets Manager as the source of truth for application runtime secrets and the initial RDS password. Pulumi will reference the operator-owned runtime secret by ARN, while reading only the separately scoped database-password secret when it must configure RDS and derive `DATABASE_URL`; this keeps runtime credentials out of GitHub and Pulumi configuration while retaining the current, simpler database connection contract.

## Consequences

- The GitHub deployment role must not read or mutate the runtime secret, but it may read the exact database-password secret needed by Pulumi.
- The ECS execution role may read the runtime secret and the Pulumi-managed `DATABASE_URL` secret, but not the database-password source secret.
- The RDS password will still appear only as encrypted secret material in Pulumi state because it is an RDS resource input.
- Runtime-secret rotation requires a new ECS task deployment. Database-password rotation is a coordinated operator procedure and is not automatic.
- A future change should move the database to RDS-managed master credentials and remove the database password from Pulumi state after LLTeacher can construct its connection settings from the RDS-managed secret.
