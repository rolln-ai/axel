#!/usr/bin/env bash

# Shared fail-closed service discovery for Render release helpers. Callers must
# define render_curl_read_args before invoking render_resolve_services.
render_resolve_services() {
  local api_base="${1:-}"
  shift || true
  local expected_owner_id="${1:-}"
  shift || true
  local -a expected_specs=("$@")
  local page_limit=100
  local max_pages=100
  local expected_json
  local matches='[]'
  local resolved='[]'
  local seen_cursors='[]'
  local page_url
  local page
  local metadata
  local page_count
  local encoded_cursor
  local service_name
  local expected_type
  local expected_instances
  local spec
  local service_matches
  local match_count
  local service_id
  local page_number

  if [[ -z "$api_base" || "${#expected_specs[@]}" -eq 0 ]]; then
    echo "Render service discovery configuration is invalid" >&2
    return 1
  fi
  if [[ ! "$expected_owner_id" =~ ^tea-[A-Za-z0-9_-]{1,128}$ ]]; then
    echo "Render workspace id is invalid" >&2
    return 1
  fi
  if [[ "${render_curl_read_args+x}" != "x" ]]; then
    echo "Render service discovery request configuration is missing" >&2
    return 1
  fi

  expected_json='[]'
  for spec in "${expected_specs[@]}"; do
    if [[ ! "$spec" =~ ^([A-Za-z0-9._-]+):(web_service|private_service|background_worker|cron_job|static_site)(:([1-9][0-9]*))?$ ]]; then
      echo "Render service discovery targets are invalid" >&2
      return 1
    fi
    service_name="${BASH_REMATCH[1]}"
    expected_type="${BASH_REMATCH[2]}"
    expected_instances="${BASH_REMATCH[4]:-}"
    expected_json="$(
      jq -cn \
        --argjson prior "$expected_json" \
        --arg name "$service_name" \
        --arg type "$expected_type" \
        --arg instances "$expected_instances" \
        '$prior + [{
          name: $name,
          type: $type,
          expectedInstances: (if $instances == "" then null else ($instances | tonumber) end)
        }]'
    )"
  done
  if ! jq -e 'length == ([.[].name] | unique | length)' \
    <<<"$expected_json" >/dev/null 2>&1; then
    echo "Render service discovery targets are invalid" >&2
    return 1
  fi

  page_url="${api_base}/services?ownerId=${expected_owner_id}&includePreviews=false&limit=${page_limit}"
  for ((page_number = 1; page_number <= max_pages; page_number += 1)); do
    if ! page="$(curl "${render_curl_read_args[@]}" "$page_url")"; then
      echo "Render service discovery request failed" >&2
      return 1
    fi

    if ! metadata="$(
      jq -ce \
        --argjson expected "$expected_json" \
        --arg owner "$expected_owner_id" \
        --argjson limit "$page_limit" \
        '
          if (
            type != "array"
            or length > $limit
            or any(.[];
              type != "object"
              or (.cursor | type) != "string"
              or (.cursor | length) == 0
              or (.cursor | length) > 4096
              or (.service | type) != "object"
              or (.service.name | type) != "string"
              or (.service.ownerId | type) != "string"
              or .service.ownerId != $owner
              or (.service.type | type) != "string"
            )
          ) then
            error("invalid Render services response")
          else
            {
              count: length,
              next: (if length == 0 then null else .[-1].cursor end),
              matches: [
                .[]
                | .service
                | select(.name as $name | $expected | map(.name) | index($name))
                | if (has("numInstances") and (.serviceDetails | type) == "object"
                      and (.serviceDetails | has("numInstances"))
                      and .numInstances != .serviceDetails.numInstances) then
                    error("conflicting Render instance counts")
                  else . end
                | {id, name, ownerId, type, numInstances:
                    (if (.serviceDetails | type) == "object" and (.serviceDetails | has("autoscaling"))
                         and .serviceDetails.autoscaling.enabled != false
                     then null else (.serviceDetails.numInstances // .numInstances) end)}
              ]
            }
          end
        ' \
        <<<"$page" 2>/dev/null
    )"; then
      echo "Render services response is invalid" >&2
      return 1
    fi

    matches="$(jq -cn --argjson prior "$matches" --argjson current "$metadata" '$prior + $current.matches')"
    page_count="$(jq -r '.count' <<<"$metadata")"
    if ((page_count < page_limit)); then
      break
    fi

    if jq -e --argjson current "$metadata" 'index($current.next) != null' \
      <<<"$seen_cursors" >/dev/null; then
      echo "Render services pagination cursor repeated" >&2
      return 1
    fi
    seen_cursors="$(jq -cn --argjson prior "$seen_cursors" --argjson current "$metadata" '$prior + [$current.next]')"

    if ((page_number == max_pages)); then
      echo "Render services pagination exceeded ${max_pages} pages" >&2
      return 1
    fi

    encoded_cursor="$(jq -er '.next | @uri' <<<"$metadata" 2>/dev/null)" || {
      echo "Render services pagination cursor is invalid" >&2
      return 1
    }
    page_url="${api_base}/services?ownerId=${expected_owner_id}&includePreviews=false&limit=${page_limit}&cursor=${encoded_cursor}"
  done

  for spec in "${expected_specs[@]}"; do
    service_name="${spec%%:*}"
    expected_type="${spec#*:}"
    expected_type="${expected_type%%:*}"
    expected_instances=""
    if [[ "$spec" == *:*:* ]]; then
      expected_instances="${spec##*:}"
    fi
    service_matches="$(jq -c --arg name "$service_name" '[.[] | select(.name == $name)]' <<<"$matches")"
    match_count="$(jq -r 'length' <<<"$service_matches")"
    if [[ "$match_count" != "1" ]]; then
      echo "expected exactly one Render service named ${service_name}; found ${match_count}" >&2
      return 1
    fi

    service_id="$(jq -r '.[0].id // empty' <<<"$service_matches")"
    if [[ ! "$service_id" =~ ^srv-[A-Za-z0-9_-]{1,128}$ ]]; then
      echo "Render returned an invalid service id for ${service_name}" >&2
      return 1
    fi
    if ! jq -e \
      --arg owner "$expected_owner_id" \
      --arg type "$expected_type" \
      --arg instances "$expected_instances" \
      '
        .[0].ownerId == $owner
        and .[0].type == $type
        and (
          if $instances == ""
          then true
          else .[0].numInstances == ($instances | tonumber)
          end
        )
      ' <<<"$service_matches" >/dev/null; then
      echo "Render service metadata mismatch for ${service_name}" >&2
      return 1
    fi
    resolved="$(
      jq -cn \
        --argjson prior "$resolved" \
        --argjson current "$service_matches" \
        '$prior + [$current[0]]'
    )"
  done

  if ! jq -e '([.[].id] | unique | length) == length' <<<"$resolved" >/dev/null; then
    echo "Render returned the same service id for multiple expected services" >&2
    return 1
  fi

  printf '%s\n' "$resolved"
}
