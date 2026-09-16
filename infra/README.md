# Local AWS-shaped deployment

This directory provisions the approved one-service topology through Pulumi.
The `local` stack is hard-wired to Floci at `http://localhost:4566`; it does
not use an AWS account. Staging and production use the same program without
endpoint overrides.

Prerequisites: Docker Desktop, Node 24, Pulumi 3.234+, AWS CLI, and `mkcert`
(`brew install mkcert`). Floci is run as `floci/floci:latest` with persistent
data under `.floci/data`.

Run the initial local setup:

```sh
export PULUMI_STACK=local
export PULUMI_CONFIG_PASSPHRASE='choose-a-local-passphrase'
./infra/scripts/install-local-cert.sh
sudo sh -c 'echo "127.0.0.1 llteacher.local" >> /etc/hosts'
pulumi -C infra config set --stack local --secret databasePassword 'local-only-password'
./infra/scripts/local-up.sh
```

The first pass intentionally leaves the ECS service absent. That creates ECR
before an image exists. The launcher then builds a Docker image tagged with
Floci's ECR-shaped URI, enables the service, and reruns Pulumi. Floci ECS uses
that local image directly; production CI performs a real ECR push.
`floci-down.sh` stops only the local emulator and keeps its development
resources intact.

`verify-local-stack.sh` uses certificate verification, never `--insecure`.
Production requires an externally validated ACM certificate and real secret
values before its stack is applied.

## Current Floci limitation

The topology and resource APIs have been applied successfully with Floci
0.2.3. At the final ECS launch, that release can report that the locally tagged
ECR-shaped image is absent even when Docker reports it present. This is a
Floci ECS image-discovery defect (the ECR registry proxy can also return 503).
The launcher retains the correct image-before-service order and will complete
once the emulator accepts the local image or its registry proxy is fixed.
