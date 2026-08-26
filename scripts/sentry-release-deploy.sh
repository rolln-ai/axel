#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 prepare <release-url> | record <deployment-name> <deployment-url>" >&2
  exit 2
}

action="${1:-}"
shift || true

: "${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN is required}"
: "${SENTRY_ORG:?SENTRY_ORG is required}"
: "${SENTRY_PROJECT:?SENTRY_PROJECT is required}"
: "${SENTRY_RELEASE:?SENTRY_RELEASE is required}"

if [[ ! "$SENTRY_ORG" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid SENTRY_ORG slug" >&2
  exit 2
fi
if [[ ! "$SENTRY_PROJECT" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid SENTRY_PROJECT slug" >&2
  exit 2
fi
if [[ ! "$SENTRY_RELEASE" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "SENTRY_RELEASE must be a full Git commit SHA" >&2
  exit 2
fi

command -v curl >/dev/null
command -v jq >/dev/null

api_base="${SENTRY_API_URL:-https://sentry.io/api/0}"
api_base="${api_base%/}"
repository="${SENTRY_REPOSITORY:-rolln-ai/axel}"
if [[ ! "$repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "invalid SENTRY_REPOSITORY slug" >&2
  exit 2
fi
releases_url="${api_base}/organizations/${SENTRY_ORG}/releases/"
release_url="${releases_url}${SENTRY_RELEASE}/"
deploys_url="${release_url}deploys/"

readonly -a curl_read_args=(
  --fail-with-body
  --silent
  --show-error
  --retry 3
  --retry-all-errors
  --retry-delay 2
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"
)

case "$action" in
  prepare)
    commit_url="${1:-}"
    [[ -n "$commit_url" ]] || usage

    payload="$(
      jq -n \
        --arg version "$SENTRY_RELEASE" \
        --arg project "$SENTRY_PROJECT" \
        --arg url "$commit_url" \
        --arg repository "$repository" \
        '{
          version: $version,
          projects: [$project],
          url: $url,
          refs: [{ repository: $repository, commit: $version }]
        }'
    )"

    # Sentry responds with 208 when this release already exists. That is a
    # successful, idempotent result and also ensures the project association.
    curl "${curl_read_args[@]}" \
      -X POST \
      -H 'Content-Type: application/json' \
      --data-binary "$payload" \
      "$releases_url" \
      >/dev/null
    echo "Sentry release ready: ${SENTRY_RELEASE}"
    ;;

  record)
    deployment_name="${1:-}"
    deployment_url="${2:-}"
    [[ -n "$deployment_name" && -n "$deployment_url" ]] || usage

    release="$(curl "${curl_read_args[@]}" "$release_url")"
    if [[ "$(jq -r '.dateReleased // empty' <<<"$release")" == "" ]]; then
      released_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
      payload="$(
        jq -n \
          --arg date_released "$released_at" \
          '{ dateReleased: $date_released }'
      )"
      curl "${curl_read_args[@]}" \
        -X PUT \
        -H 'Content-Type: application/json' \
        --data-binary "$payload" \
        "$release_url" \
        >/dev/null
      echo "Finalized Sentry release: ${SENTRY_RELEASE}"
    else
      echo "Sentry release already finalized: ${SENTRY_RELEASE}"
    fi

    deploys="$(curl "${curl_read_args[@]}" "$deploys_url")"
    if jq -e \
      --arg environment production \
      --arg name "$deployment_name" \
      'any(.[]; .environment == $environment and .name == $name)' \
      <<<"$deploys" \
      >/dev/null; then
      echo "Sentry deployment already recorded: ${deployment_name}"
      exit 0
    fi

    payload="$(
      jq -n \
        --arg environment production \
        --arg name "$deployment_name" \
        --arg url "$deployment_url" \
        '{ environment: $environment, name: $name, url: $url }'
    )"

    # The release already carries the project association from `prepare`.
    # Supplying `projects` again makes Sentry require broader project-write
    # access, which a least-privilege org:ci release token intentionally lacks.
    # Do not automatically retry this non-idempotent POST. If the response is
    # lost after Sentry accepts it, rerunning the workflow finds the stable
    # deployment name above and exits without creating a duplicate.
    curl \
      --fail-with-body \
      --silent \
      --show-error \
      -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
      -H 'Content-Type: application/json' \
      -X POST \
      --data-binary "$payload" \
      "$deploys_url" \
      >/dev/null
    echo "Recorded Sentry deployment: ${deployment_name}"
    ;;

  *)
    usage
    ;;
esac
