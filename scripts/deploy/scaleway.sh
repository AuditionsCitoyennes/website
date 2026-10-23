#!/usr/bin/env bash
# The API on Scaleway Serverless Containers, for .github/workflows/deploy-staging.yml.
# Everything it needs is created on the first run, then updated in place:
#
#   scaleway.sh registry   the private Container Registry namespace; prints its
#                          endpoint (rg.<region>.scw.cloud/<name>)
#   scaleway.sh deploy     the Serverless Containers namespace and the API
#                          container, set to $IMAGE; waits until $VERSION
#                          answers on /health, then prints the container's URL
#   scaleway.sh prune      keeps the $KEEP_TAGS latest image tags, deletes older ones
#
# Environment: SCW_SECRET_KEY, SCW_PROJECT_ID, SCW_REGION, REGISTRY_NAMESPACE;
# for deploy also CONTAINERS_NAMESPACE, CONTAINER_NAME, IMAGE, VERSION,
# MIN_SCALE, MAX_SCALE, MEMORY_MB. Every ENV_<NAME> variable becomes the
# container's <NAME>, every SECRET_<NAME> a secret one (left out when empty).
# Secret values are only ever sent on stdin, never on a command line or a log.
# SCW_API_URL points it at another API (a stand-in, to try it).
set -euo pipefail

API=${SCW_API_URL:-https://api.scaleway.com}
: "${SCW_SECRET_KEY:?}" "${SCW_PROJECT_ID:?}" "${SCW_REGION:?}" "${REGISTRY_NAMESPACE:?}"

# Scaleway's answer on stdout; on an error, its message on stderr and exit 1.
call() { # METHOD PATH [-] — "-" sends stdin as the JSON body
  local method=$1 path=$2 out status
  out=$(mktemp)
  if [ "${3:-}" = "-" ]; then
    status=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
      -H "X-Auth-Token: $SCW_SECRET_KEY" -H "Content-Type: application/json" --data-binary @-)
  else
    status=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$API$path" \
      -H "X-Auth-Token: $SCW_SECRET_KEY")
  fi
  if [ "$status" -ge 300 ]; then
    echo "::error::Scaleway $method ${path%%\?*} answered $status: $(jq -c '{message, type, details}' "$out" 2>/dev/null || head -c 300 "$out")" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

# The id (or another field) of the item named $3 in a listing.
named() { # JSON-LIST-KEY FIELD NAME  (listing on stdin)
  jq -r --arg key "$1" --arg field "$2" --arg name "$3" \
    '[.[$key][] | select(.name == $name)][0][$field] // empty'
}

registry() {
  local base="/registry/v1/regions/$SCW_REGION/namespaces" endpoint
  endpoint=$(call GET "$base?project_id=$SCW_PROJECT_ID&name=$REGISTRY_NAMESPACE&page_size=100" |
    named namespaces endpoint "$REGISTRY_NAMESPACE")
  if [ -z "$endpoint" ]; then
    echo "Creating the registry namespace $REGISTRY_NAMESPACE" >&2
    endpoint=$(jq -n --arg name "$REGISTRY_NAMESPACE" --arg project "$SCW_PROJECT_ID" \
      '{name: $name, project_id: $project, is_public: false,
        description: "Auditions Citoyennes API images"}' |
      call POST "$base" - | jq -r .endpoint)
  fi
  echo "$endpoint"
}

# Waits while Scaleway is busy with the container; fails on "error".
wait_ready() { # CONTAINER-ID
  local base="/containers/v1/regions/$SCW_REGION/containers/$1" container status
  for _ in $(seq 1 90); do
    container=$(call GET "$base")
    status=$(jq -r .status <<<"$container")
    case "$status" in
      ready) return 0 ;;
      error | locked)
        echo "::error::container $status: $(jq -r '.error_message // "no message"' <<<"$container")" >&2
        return 1
        ;;
    esac
    sleep 10
  done
  echo "::error::container still \"$status\" after 15 minutes" >&2
  return 1
}

# Waits until /health answers with $VERSION.
wait_version() { # URL
  local seen
  for _ in $(seq 1 30); do
    seen=$(curl -sS --max-time 10 "$1/health" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
    [ "$seen" = "$VERSION" ] && return 0
    sleep 10
  done
  echo "::warning::$1/health still answers version \"${seen:-nothing}\", not $VERSION" >&2
  return 1
}

deploy() {
  : "${CONTAINERS_NAMESPACE:?}" "${CONTAINER_NAME:?}" "${IMAGE:?}" "${VERSION:?}"
  : "${MIN_SCALE:?}" "${MAX_SCALE:?}" "${MEMORY_MB:?}"
  local base="/containers/v1/regions/$SCW_REGION" ns id body url
  ns=$(call GET "$base/namespaces?project_id=$SCW_PROJECT_ID&name=$CONTAINERS_NAMESPACE&page_size=100" |
    named namespaces id "$CONTAINERS_NAMESPACE")
  if [ -z "$ns" ]; then
    echo "Creating the containers namespace $CONTAINERS_NAMESPACE" >&2
    ns=$(jq -n --arg name "$CONTAINERS_NAMESPACE" --arg project "$SCW_PROJECT_ID" \
      '{name: $name, project_id: $project, description: "Auditions Citoyennes"}' |
      call POST "$base/namespaces" - | jq -r .id)
    for _ in $(seq 1 30); do
      [ "$(call GET "$base/namespaces/$ns" | jq -r .status)" = "ready" ] && break
      sleep 5
    done
  fi

  # What the container is, all of it, every deploy: nothing set by hand in
  # the console survives, so nothing drifts from this file.
  body=$(jq -n \
    --arg image "$IMAGE" \
    --argjson min "$MIN_SCALE" --argjson max "$MAX_SCALE" \
    --argjson memory "$((MEMORY_MB * 1024 * 1024))" \
    '{
      image: $image,
      port: 8080,
      min_scale: $min,
      max_scale: $max,
      memory_limit_bytes: $memory,
      privacy: "public",
      protocol: "http1",
      environment_variables: ($ENV | with_entries(select(.key | startswith("ENV_")) | .key |= .[4:])),
      secret_environment_variables: ($ENV | with_entries(select((.key | startswith("SECRET_")) and .value != "") | .key |= .[7:]))
    }')

  id=$(call GET "$base/containers?namespace_id=$ns&name=$CONTAINER_NAME&page_size=100" |
    named containers id "$CONTAINER_NAME")
  if [ -z "$id" ]; then
    echo "Creating the container $CONTAINER_NAME" >&2
    id=$(jq --arg ns "$ns" --arg name "$CONTAINER_NAME" '. + {namespace_id: $ns, name: $name}' <<<"$body" |
      call POST "$base/containers" - | jq -r .id)
  else
    echo "Updating the container $CONTAINER_NAME" >&2
    call PATCH "$base/containers/$id" - <<<"$body" >/dev/null
  fi

  wait_ready "$id"
  url=$(call GET "$base/containers/$id" | jq -r .public_endpoint)
  case "$url" in http://* | https://*) ;; *) url="https://$url" ;; esac
  # An update that left the old instances serving: roll them over once.
  if ! wait_version "$url"; then
    echo "Redeploying" >&2
    echo '{}' | call POST "$base/containers/$id/redeploy" - >/dev/null
    wait_ready "$id"
    wait_version "$url"
  fi
  echo "$url"
}

prune() {
  : "${KEEP_TAGS:?}"
  local base="/registry/v1/regions/$SCW_REGION" ns image tags
  ns=$(call GET "$base/namespaces?project_id=$SCW_PROJECT_ID&name=$REGISTRY_NAMESPACE&page_size=100" |
    named namespaces id "$REGISTRY_NAMESPACE")
  image=$(call GET "$base/images?namespace_id=$ns&name=api&page_size=100" | named images id api)
  [ -n "$image" ] || return 0
  # Newest first; the build cache is not a version.
  tags=$(call GET "$base/images/$image/tags?order_by=created_at_desc&page_size=100" |
    jq -r --argjson keep "$KEEP_TAGS" '[.tags[] | select(.name != "buildcache")][$keep:][] | .id')
  for tag in $tags; do
    call DELETE "$base/tags/$tag" >/dev/null && echo "Deleted an old image tag ($tag)" >&2
  done
}

case "${1:-}" in
  registry | deploy | prune) "$1" ;;
  *)
    echo "usage: $0 registry|deploy|prune" >&2
    exit 2
    ;;
esac
