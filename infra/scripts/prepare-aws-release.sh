#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/aws-release-common.sh"
stack="${1:-}"
validate_release_target "$stack"
[[ $# -eq 2 ]] || die "Usage: $0 production repository|preflight|candidate"
describe_active_task() {
  local cluster="$1" service="$2" current task
  validate_name "$cluster"
  validate_name "$service"
  printf 'Checking ECS service %s/%s in %s\n' "$cluster" "$service" "$AWS_REGION" >&2
  current=$(AWS_RETRY_MODE=standard AWS_MAX_ATTEMPTS=6 aws ecs describe-services \
    --cluster "$cluster" --services "$service" --output json) || return $?
  task=$(jq -er 'select((.failures | length) == 0) | .services | select(length == 1) | .[0] | select(.status == "ACTIVE") | .taskDefinition' <<<"$current") ||
    die 'ECS did not return an active service with a task definition.'
  validate_task_definition "$task"
  printf '%s\n' "$task"
}

case "$2" in
  preflight)
    read_outputs
    service=$(jq -r '.serviceName // empty' <<<"$outputs")
    if [[ -n "$service" ]]; then
      cluster=$(jq -er '.clusterName' <<<"$outputs")
      task=$(describe_active_task "$cluster" "$service")
      echo "Active ECS service $cluster/$service uses $task."
    else
      assert_no_service
      echo 'No existing ECS service to check.'
    fi
    ;;
  repository)
    read_outputs
    error_file=$(mktemp)
    trap 'rm -f "$error_file"' EXIT
    if response=$(aws ecr describe-repositories --repository-names llteacher-production/app --output json 2>"$error_file"); then
      repository=$(jq -er '.repositories | select(length == 1) | .[0].repositoryUri' <<<"$response")
    elif grep -q 'An error occurred (RepositoryNotFoundException) when calling' "$error_file"; then
      repository=$(bash "$root/infra/scripts/bootstrap-aws-infra.sh" "$stack")
    else
      cat "$error_file" >&2
      die 'ECR lookup failed; refusing bootstrap.'
    fi
    validate_repository "$repository"
    echo "repository=$repository" >> "${GITHUB_OUTPUT:?}"
    ;;
  candidate)
    [[ "${IMAGE_DIGEST:-}" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid candidate image digest.'
    [[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid release commit.'
    read_outputs
    previous=''
    previous_digest=''
    service=$(jq -r '.serviceName // empty' <<<"$outputs")
    if [[ -n "$service" ]]; then
      cluster=$(jq -er '.clusterName' <<<"$outputs")
      previous=$(describe_active_task "$cluster" "$service")
      definition=$(aws ecs describe-task-definition --task-definition "$previous" --output json)
      image=$(jq -er '[.taskDefinition.containerDefinitions[] | select(.name == "app")] | select(length == 1) | .[0].image' <<<"$definition")
      previous_digest="${image##*@}"
      [[ "$previous_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Active app image is not digest-pinned; cannot capture rollback.'
    else
      assert_no_service
    fi
    # Persist before any candidate config or update can fail.
    {
      echo "previous_task_definition=$previous"
      echo "previous_digest=$previous_digest"
    } >> "${GITHUB_OUTPUT:?}"
    pulumi -C "$root/infra" config set --stack "$stack" imageDigest "$IMAGE_DIGEST"
    pulumi -C "$root/infra" config set --stack "$stack" buildSha "$GITHUB_SHA"
    pulumi -C "$root/infra" config set --stack "$stack" serviceTaskDefinition "$previous"
    enabled=false
    [[ -z "$previous" ]] || enabled=true
    pulumi -C "$root/infra" config set --stack "$stack" provisionService "$enabled"
    pulumi -C "$root/infra" config set --stack "$stack" deployApp "$enabled"
    pulumi -C "$root/infra" preview --stack "$stack" --non-interactive
    pulumi -C "$root/infra" up --stack "$stack" --yes --non-interactive
    read_outputs
    candidate=$(jq -er '.candidateTaskDefinitionArn' <<<"$outputs")
    validate_task_definition "$candidate"
    echo "candidate=$candidate" >> "$GITHUB_OUTPUT"
    ;;
  *) die 'Unknown release preparation operation.' ;;
esac
