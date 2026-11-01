#!/usr/bin/env bash
# Preflight for the client-only Hermes runtime and its restricted provisioner (services/hermes-provisioner).
#
# STRICTLY READ-ONLY, in the house style of scripts/hermes-a1-preflight.sh. It creates, changes, starts, stops, pulls and deletes nothing: it reads the private compose env file and
# the secret files' metadata and shape, and inspects Docker objects with fixed output templates. It never prints a secret, a key, a token, a model key or an env value other than the
# non-secret routing values it names (image references, file paths, the gateway id). Secret files are only measured (owner, mode, length, shape).
#
#   scripts/hermes-client-preflight.sh --env-file <private compose env file> [--offline-config] [--before-install]
#                                       [--project iacquire-client-hermes] [--compose-dir services/hermes-provisioner] [--pin-file <client.env.example>]
#
#   --offline-config  checks only the env file, the secret files and the compose files: no Docker, no host measurements, no network. Use it before the host exists.
#   --before-install  containers, networks and volumes that do not exist yet are a warning, not a failure (the host is being prepared). After the install they are failures.
#
# Output is one line per check, [ OK ] / [WARN] / [FAIL], then a summary. Exit status: 0 no FAIL (warnings are listed), 1 at least one FAIL, 2 usage error.
# Run it on the VPS as root, or stream it from your machine (nothing is written there):  tr -d '\r' < scripts/hermes-client-preflight.sh | ssh root@<vps> 'bash -s -- --env-file <path>'
# (when streamed, give --pin-file and --compose-dir explicitly; without them those two comparisons are skipped with a warning). The whole body sits in main() and runs with stdin
# closed, so no command in it can swallow the rest of a streamed script. Settings that are not secrets can be overridden from the environment (see the block below).

main() {
  exec 2>&1
  export LC_ALL=C
  set +x

  # --- settings ---------------------------------------------------------------------------
  local env_file="" offline_config=0 before_install=0 pin_file="" compose_dir=""
  PROJECT="${CLIENT_PROJECT:-iacquire-client-hermes}"
  OFFLINE="${PREFLIGHT_OFFLINE:-0}"
  MEMINFO="${PREFLIGHT_MEMINFO:-/proc/meminfo}"
  MIN_DISK_GIB="${PREFLIGHT_MIN_DISK_GIB:-15}"
  AGENCY_DATA="${HERMES_AGENCY_DATA_DIR:-}"
  BACKUP_DIR="${CLIENT_BACKUP_DIR:-}"
  BACKUP_MAX_DAYS="${CLIENT_BACKUP_MAX_DAYS:-8}"
  local script_dir=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi

  usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null; }
  while [ $# -gt 0 ]; do
    case "$1" in
      --env-file) [ $# -ge 2 ] || { usage; return 2; }; env_file=$2; shift 2 ;;
      --offline-config) offline_config=1; shift ;;
      --before-install) before_install=1; shift ;;
      --project) [ $# -ge 2 ] || { usage; return 2; }; PROJECT=$2; shift 2 ;;
      --compose-dir) [ $# -ge 2 ] || { usage; return 2; }; compose_dir=$2; shift 2 ;;
      --pin-file) [ $# -ge 2 ] || { usage; return 2; }; pin_file=$2; shift 2 ;;
      -h|--help) usage; return 0 ;;
      *) usage; return 2 ;;
    esac
  done
  [ -n "$env_file" ] || { usage; return 2; }
  if [ -z "$compose_dir" ] && [ -n "$script_dir" ] && [ -d "$script_dir/../services/hermes-provisioner" ]; then compose_dir="$script_dir/../services/hermes-provisioner"; fi
  if [ -z "$pin_file" ] && [ -n "$compose_dir" ] && [ -f "$compose_dir/client.env.example" ]; then pin_file="$compose_dir/client.env.example"; fi

  GATEWAY="${CLIENT_GATEWAY_CONTAINER:-${PROJECT}-hermes-client-1}"
  WORKER="${CLIENT_WORKER_CONTAINER:-${PROJECT}-hermes-provisioner-1}"
  PRIVATE_NET="${IACQUIRE_HERMES_PRIVATE_NETWORK:-iacquire-hermes-private}"
  EGRESS_NET="${PROJECT}_client_egress"
  PROFILES_VOLUME="${PROJECT}_client_profiles"
  STATE_VOLUME="${PROJECT}_worker_home"
  HOME_VOLUME="${PROJECT}_hermes_home"

  OKS=0; WARNS=0; FAILS=0
  ok()      { printf '  [ OK ] %s\n' "$*"; OKS=$((OKS + 1)); }
  warn()    { printf '  [WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
  fail()    { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
  info()    { printf '         %s\n' "$*"; }
  section() { printf '\n== %s ==\n' "$*"; }
  have()    { command -v "$1" >/dev/null 2>&1; }
  D()       { timeout 25 docker "$@"; }
  # Something that must exist once the runtime is installed: a failure afterwards, a warning while the host is still being prepared.
  missing() { if [ "$before_install" = 1 ]; then warn "$* (expected before the install)"; else fail "$*"; fi; }

  # Value of KEY in a dotenv-style file, trimmed and unquoted. Used for the NON-secret routing values only.
  dotenv_value() {
    local file=$1 key=$2 v
    v=$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}=(.*)$/\\2/p" "$file" 2>/dev/null | tail -n 1)
    v=${v%$'\r'}
    v=${v#"${v%%[![:space:]]*}"}
    v=${v%"${v##*[![:space:]]}"}
    case "$v" in
      \"*\") v=${v#\"}; v=${v%\"} ;;
      \'*\') v=${v#\'}; v=${v%\'} ;;
    esac
    printf '%s' "$v"
  }
  meta() { stat -c '%u:%g:%a' -- "$1" 2>/dev/null; }
  insp() { D inspect -f "$2" "$1" 2>/dev/null; }

  # --- 0. header --------------------------------------------------------------------------
  section "0. Read-only guarantee"
  info "This script changes nothing on this host. It reads files and inspects Docker with fixed templates."
  info "It never prints a secret, a key, a token or a model key; secret files are only measured."
  info "utc_now=$(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(hostname) user=$(id -un) uid=$(id -u) project=$PROJECT mode=$([ "$offline_config" = 1 ] && echo offline-config || echo live)"
  if [ "$(id -u)" != "0" ]; then warn "not running as root: secret-file and Docker checks may be incomplete (use sudo)"; fi

  # --- 1. env file ------------------------------------------------------------------------
  section "1. Compose env file (non-secret routing values only)"
  local key value
  if [ ! -f "$env_file" ] || [ -L "$env_file" ]; then
    fail "the env file $env_file does not exist or is a symlink"
    section "Summary"
    printf '  ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
    return 1
  fi
  for key in HERMES_BASE_IMAGE IACQUIRE_PROVISIONER_URL IACQUIRE_PROVISIONER_GATEWAY_ID HERMES_CLIENT_CONFIG_FILE HERMES_API_KEY_FILE HERMES_PROFILE_MODEL_ENV_FILE IACQUIRE_PROVISIONER_TOKEN_FILE; do
    if [ -z "$(dotenv_value "$env_file" "$key")" ]; then fail "$key is not set in the env file"; fi
  done
  local base_image pinned_base
  base_image=$(dotenv_value "$env_file" HERMES_BASE_IMAGE)
  if [ -n "$base_image" ]; then
    if printf '%s' "$base_image" | grep -Eq '^(docker\.io/)?nousresearch/hermes-agent@sha256:[0-9a-f]{64}$'; then
      ok "HERMES_BASE_IMAGE is the official Hermes image pinned by digest"
    else
      fail "HERMES_BASE_IMAGE is not the official Hermes image pinned by a sha256 digest"
    fi
    if [ -n "$pin_file" ] && [ -f "$pin_file" ]; then
      pinned_base=$(dotenv_value "$pin_file" HERMES_BASE_IMAGE)
      if [ "$base_image" = "$pinned_base" ]; then
        ok "HERMES_BASE_IMAGE digest equals the reviewed pin (sha256:$(printf '%s' "$base_image" | sed 's/.*sha256://' | cut -c1-12)...)"
      else
        fail "HERMES_BASE_IMAGE digest in the env file differs from the reviewed pin in $(basename -- "$pin_file")"
      fi
    else
      warn "no reviewed pin file to compare the Hermes image digest with (give --pin-file)"
    fi
  fi
  value=$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_URL)
  if [ -n "$value" ]; then
    if printf '%s' "$value" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' && ! printf '%s' "$value" | grep -Eq '\.invalid(/|:|$)'; then ok "IACQUIRE_PROVISIONER_URL is an HTTPS origin"; else fail "IACQUIRE_PROVISIONER_URL is not a real HTTPS origin (placeholder or a path)"; fi
  fi
  value=$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_GATEWAY_ID)
  if [ -n "$value" ]; then
    if printf '%s' "$value" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' && [ "$value" != "00000000-0000-4000-8000-000000000000" ]; then ok "IACQUIRE_PROVISIONER_GATEWAY_ID is a gateway UUID"; else fail "IACQUIRE_PROVISIONER_GATEWAY_ID is not a real gateway UUID (empty, malformed or the placeholder)"; fi
  fi
  value=$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_MAX_PROFILES)
  if [ -z "$value" ]; then warn "IACQUIRE_PROVISIONER_MAX_PROFILES is empty: the worker has no profile ceiling of its own (the capacity is a founder decision)"
  elif printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then ok "IACQUIRE_PROVISIONER_MAX_PROFILES is a positive whole number ($value)"
  else fail "IACQUIRE_PROVISIONER_MAX_PROFILES is not a positive whole number"; fi
  for key in IACQUIRE_HERMES_IMAGE IACQUIRE_PROVISIONER_IMAGE; do
    value=$(dotenv_value "$env_file" "$key")
    case "$value" in
      "") : ;;
      *:acceptance) warn "$key uses the mutable ':acceptance' tag: a rebuild changes what it points to, and a rollback has nothing to go back to (tag by version)" ;;
      *) ok "$key is not the mutable acceptance tag" ;;
    esac
  done
  local tunnel_image tunnel_token_file egress_host
  tunnel_image=$(dotenv_value "$env_file" IACQUIRE_CLOUDFLARED_IMAGE)
  tunnel_token_file=$(dotenv_value "$env_file" CLOUDFLARED_TOKEN_FILE)
  if [ -n "$tunnel_image" ]; then
    if printf '%s' "$tunnel_image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then ok "the cloudflared image is pinned by digest"; else fail "IACQUIRE_CLOUDFLARED_IMAGE is not pinned by a sha256 digest"; fi
  fi
  egress_host=$(dotenv_value "$env_file" IACQUIRE_EGRESS_PORTAL_HOST)
  if [ -n "$egress_host" ]; then
    local portal_host
    portal_host=$(printf '%s' "$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_URL)" | sed -E 's#^https://([^/:]+).*#\1#')
    if [ "$portal_host" = "$egress_host" ]; then ok "IACQUIRE_PROVISIONER_URL names the egress overlay's portal host"; else fail "IACQUIRE_PROVISIONER_URL does not name IACQUIRE_EGRESS_PORTAL_HOST: the worker would not reach the portal through the allowlist proxy"; fi
    if printf ',%s,' "$(dotenv_value "$env_file" IACQUIRE_EGRESS_ALLOWED_HOSTS | tr -d ' ')" | grep -qF ",$egress_host,"; then ok "the portal host is on the egress allowlist"; else fail "the portal host is not on IACQUIRE_EGRESS_ALLOWED_HOSTS"; fi
  fi

  # --- 2. secret files --------------------------------------------------------------------
  section "2. Private files (owner, mode and shape only; contents are never printed)"
  # check_secret LABEL PATH OWNER:GROUP MODES... (a mode is the octal digits `stat` prints, e.g. 440)
  check_secret() {
    local label=$1 path=$2 owner=$3 got want ok_mode=0 m
    shift 3
    if [ -z "$path" ]; then return 1; fi
    if [ -L "$path" ]; then fail "secret file $label is a symlink"; return 1; fi
    if [ ! -f "$path" ]; then fail "secret file $label does not exist (or is not a regular file): $path"; return 1; fi
    got=$(meta "$path")
    for m in "$@"; do want="$owner:$m"; if [ "$got" = "$want" ]; then ok_mode=1; fi; done
    if [ "$ok_mode" = 1 ]; then ok "secret file $label has owner:group:mode $got"; else fail "secret file $label has owner:group:mode ${got:-unknown}, wanted $owner:$1"; return 1; fi
  }
  local path content name
  path=$(dotenv_value "$env_file" HERMES_CLIENT_CONFIG_FILE)
  if check_secret "config.yaml" "$path" "0:10000" 440; then
    if grep -q 'REPLACE_WITH' "$path" 2>/dev/null; then fail "config.yaml still holds the REPLACE_WITH placeholder model id"; else ok "config.yaml has no placeholder model id"; fi
    if grep -Eqi '(api[_-]?key|token|secret|password)[[:space:]]*:[[:space:]]*[^[:space:]#]' "$path" 2>/dev/null; then fail "config.yaml looks like it holds a credential (it must stay secret-free)"; else ok "config.yaml holds no credential-looking field"; fi
  fi
  path=$(dotenv_value "$env_file" HERMES_API_KEY_FILE)
  if check_secret "hermes-api-key" "$path" "0:10000" 440; then
    content=$(cat -- "$path" 2>/dev/null || true)
    if [[ $content =~ ^[0-9a-f]{64}$ ]]; then ok "hermes-api-key is exactly 64 lowercase hex characters"; else fail "hermes-api-key is not exactly 64 lowercase hex characters"; fi
    content=""
  fi
  path=$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_TOKEN_FILE)
  if check_secret "provisioner-token" "$path" "10000:10000" 400 600; then
    content=$(cat -- "$path" 2>/dev/null || true)
    # The length is tested apart from the shape: some regex engines cap a repeat count at 255.
    if [[ $content =~ ^[!-~]+$ ]] && [ "${#content}" -ge 32 ] && [ "${#content}" -le 512 ]; then ok "provisioner-token is one line of 32 to 512 printable characters"; else fail "provisioner-token is not one line of 32 to 512 printable characters"; fi
    content=""
  fi
  path=$(dotenv_value "$env_file" HERMES_PROFILE_MODEL_ENV_FILE)
  if check_secret "profile-model-env.json" "$path" "10000:10000" 400 600; then
    content=$(cat -- "$path" 2>/dev/null || true)
    name=$(printf '%s' "$content" | sed -n 's/.*"environment"[[:space:]]*:[[:space:]]*"\([A-Z_]*\)".*/\1/p')
    if printf '%s' "$content" | grep -q '"schemaVersion"' && printf '%s' "$content" | grep -q '"value"' && [ -n "$name" ]; then ok "profile-model-env.json has the three fields the worker requires"; else fail "profile-model-env.json does not have schemaVersion, environment and value"; fi
    case "$name" in
      "") : ;;
      *_API_KEY) ok "the model key environment name is an API-key name" ;;
      *) fail "the model key environment name is not an API-key name" ;;
    esac
    content=""; name=""
  fi
  if [ -n "$tunnel_token_file" ]; then check_secret "tunnel-token" "$tunnel_token_file" "65532:65532" 400 || true; fi

  # --- 3. compose files -------------------------------------------------------------------
  section "3. Compose files (static)"
  if [ -n "$compose_dir" ] && [ -f "$compose_dir/compose.client.yaml" ]; then
    local f
    for f in "$compose_dir"/compose.client.yaml "$compose_dir"/compose.tunnel.yaml "$compose_dir"/compose.egress.yaml; do
      [ -f "$f" ] || continue
      if grep -Eq '^[[:space:]]+ports:' "$f"; then fail "$(basename -- "$f") publishes a host port"; else ok "$(basename -- "$f") publishes no host port"; fi
      if grep -Eq 'docker\.sock|privileged:[[:space:]]*true|network_mode:[[:space:]]*host' "$f"; then fail "$(basename -- "$f") mounts the Docker socket or asks for privileges"; else ok "$(basename -- "$f") has no Docker socket, privileged mode or host network"; fi
    done
  else
    warn "no compose directory given or found: the static compose checks were skipped (give --compose-dir)"
  fi

  if [ "$offline_config" = 1 ]; then
    info "offline-config: Docker, the host and the network were not consulted."
    section "Summary"
    printf '  ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
    info "Nothing was created, changed, started, stopped, pulled or deleted by this script."
    [ "$FAILS" -eq 0 ]
    return
  fi

  # --- 4. host ----------------------------------------------------------------------------
  section "4. Host capacity (caps are not reservations: gateway 2 GiB plus worker 512 MiB)"
  local mem_avail swap_total free_gib p docker_root=""
  mem_avail=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' "$MEMINFO" 2>/dev/null)
  swap_total=$(awk '/^SwapTotal:/ { printf "%d", $2 / 1024 }' "$MEMINFO" 2>/dev/null)
  info "cpus=$(nproc 2>/dev/null || echo ?) swap_total_mib=${swap_total:-?}"
  if [ -n "${mem_avail:-}" ]; then
    if [ "$mem_avail" -ge 4096 ]; then ok "memory available: ${mem_avail} MiB (the caps total 2560 MiB)"
    elif [ "$mem_avail" -ge 2560 ]; then warn "memory available: ${mem_avail} MiB (barely above the 2560 MiB of caps)"
    else fail "memory available: ${mem_avail} MiB (below the 2560 MiB of caps)"; fi
  else
    warn "could not read available memory"
  fi
  if [ "${swap_total:-0}" = "0" ]; then warn "the host has no swap: a memory spike kills a container instead of slowing it"; fi
  if have docker; then docker_root=$(D info --format '{{.DockerRootDir}}' 2>/dev/null); fi
  for p in ${PREFLIGHT_DISK_PATHS:-"${docker_root:-/var/lib/docker}"}; do
    [ -e "$p" ] || continue
    free_gib=$(df -Pk -- "$p" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }')
    if [ -n "${free_gib:-}" ]; then
      if [ "$free_gib" -ge "$MIN_DISK_GIB" ]; then ok "disk free under $p: ${free_gib} GiB"
      elif [ "$free_gib" -ge $((MIN_DISK_GIB / 2)) ]; then warn "disk free under $p: ${free_gib} GiB (below ${MIN_DISK_GIB} GiB)"
      else fail "disk free under $p: ${free_gib} GiB"; fi
    fi
  done
  if [ "$OFFLINE" = "1" ] || ! have curl; then
    info "clock skew measurement skipped (offline mode or curl missing)"
  else
    local date_hdr remote skew abs
    date_hdr=$(timeout 8 curl -fsSI --max-time 6 https://www.cloudflare.com 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "date" { print $2; exit }')
    if [ -n "$date_hdr" ] && remote=$(date -u -d "$date_hdr" +%s 2>/dev/null); then
      skew=$(($(date -u +%s) - remote)); abs=${skew#-}
      if [ "$abs" -le 5 ]; then ok "clock skew against an external reference: ${skew}s"
      elif [ "$abs" -le 15 ]; then warn "clock skew against an external reference: ${skew}s"
      else fail "clock skew against an external reference: ${skew}s (job leases and signed requests expire in minutes)"; fi
    else
      warn "could not read an external time reference"
    fi
  fi

  # --- 5. docker --------------------------------------------------------------------------
  section "5. Docker engine"
  if ! have docker; then
    fail "docker is not installed or not on PATH"
    section "Summary"
    printf '  ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
    return 1
  fi
  local sv cv secopts warnings
  sv=$(D version --format '{{.Server.Version}}' 2>/dev/null)
  if [ -n "$sv" ]; then ok "docker server $sv"; else fail "cannot talk to the Docker daemon (permissions or daemon down)"; fi
  cv=$(D compose version --short 2>/dev/null)
  if [ -n "$cv" ]; then ok "docker compose $cv"; else fail "docker compose v2 plugin is missing"; fi
  secopts=$(D info --format '{{json .SecurityOptions}}' 2>/dev/null)
  case "$secopts" in
    *userns*) fail "user namespace remapping is on: UID 10000 in a container is not UID 10000 on the host, so the secret-file owner checks do not hold" ;;
    *) ok "no user namespace remapping" ;;
  esac
  warnings=$(D info --format '{{json .Warnings}}' 2>/dev/null)
  case "$warnings" in
    ""|null|"[]") ok "docker reports no cgroup or swap-limit warnings" ;;
    *) warn "docker reports warnings: memory and pids limits need the matching cgroup support" ;;
  esac

  # --- 6. containers ----------------------------------------------------------------------
  section "6. Installed containers (limits, ports, mounts, privileges)"
  local expected_caps_gateway="CHOWN KILL SETGID SETUID"
  # One `docker inspect` per container with every fact in a fixed order, split on a delimiter that cannot occur in the values (the Docker daemon is a slow, shared thing to ask 20 times).
  local inspect_template='{{.State.Running}}~~~{{.HostConfig.RestartPolicy.Name}}~~~{{.HostConfig.Memory}}~~~{{.HostConfig.NanoCpus}}~~~{{.HostConfig.PidsLimit}}~~~{{.HostConfig.ReadonlyRootfs}}~~~{{.HostConfig.Privileged}}~~~{{json .HostConfig.CapDrop}}~~~{{json .HostConfig.CapAdd}}~~~{{json .HostConfig.SecurityOpt}}~~~{{json .NetworkSettings.Ports}}~~~{{json .HostConfig.PortBindings}}~~~{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}};{{end}}~~~{{json .State.Health}}~~~{{.Image}}~~~{{.Config.User}}~~~{{.HostConfig.NetworkMode}}~~~{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
  check_container() { # $1 logical name, $2 container name, $3 allowed cap_add list, $4 image reference from the env file, $5 required (1) or optional (0)
    local label=$1 name=$2 allowed=$3 image_ref=$4 required=$5 raw v caps cap bad mounts type vname src dest rw image_id ref_id
    local -a f
    if ! raw=$(D inspect -f "$inspect_template" "$name" 2>/dev/null); then
      if [ "$required" = 1 ]; then missing "container $label ($name) does not exist"; else info "container $label ($name) does not exist (it is off by default)"; fi
      return 0
    fi
    mapfile -t f <<<"${raw//'~~~'/$'\n'}"
    # f: 0 running, 1 restart, 2 memory, 3 cpus, 4 pids, 5 read-only root, 6 privileged, 7 cap_drop, 8 cap_add, 9 security_opt, 10 ports, 11 port bindings, 12 mounts, 13 health, 14 image id, 15 user, 16 network mode, 17 networks
    if [ "${f[0]}" = "true" ]; then ok "$label is running"; else if [ "$required" = 1 ]; then fail "$label is not running"; else warn "$label exists but is not running"; fi; fi
    info "$label restart policy: ${f[1]}"
    v=${f[2]}
    if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then ok "$label has a memory limit ($((v / 1048576)) MiB)"; else fail "$label has no memory limit"; fi
    v=${f[3]}
    if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then ok "$label has a CPU limit"; else fail "$label has no CPU limit"; fi
    v=${f[4]}
    if [ -n "$v" ] && [ "$v" -gt 0 ] 2>/dev/null; then ok "$label has a process limit ($v)"; else fail "$label has no process limit"; fi
    if [ "${f[5]}" = "true" ]; then ok "$label has a read-only root filesystem"; else fail "$label does not have a read-only root filesystem"; fi
    if [ "${f[6]}" = "false" ]; then ok "$label is not privileged"; else fail "$label is privileged"; fi
    case "${f[7]}" in *'"ALL"'*) ok "$label drops all capabilities" ;; *) fail "$label does not drop all capabilities" ;; esac
    caps=$(printf '%s' "${f[8]}" | tr -d '[]"' | tr ',' ' ')
    if [ "$caps" = "null" ]; then caps=""; fi
    bad=""
    for cap in $caps; do case " $allowed " in *" $cap "*) : ;; *) bad="$bad $cap" ;; esac; done
    if [ -z "$bad" ]; then ok "$label adds no capability beyond the reviewed set"; else fail "$label adds capabilities beyond the reviewed set:$bad"; fi
    case "${f[9]}" in *no-new-privileges*) ok "$label sets no-new-privileges" ;; *) fail "$label does not set no-new-privileges" ;; esac
    if printf '%s %s' "${f[10]}" "${f[11]}" | grep -q 'HostPort'; then fail "$label publishes a host port"; else ok "$label publishes no host port"; fi
    mounts=$(printf '%s' "${f[12]}" | tr ';' '\n')
    bad=""
    while IFS='|' read -r type vname src dest rw; do
      [ -n "$type" ] || continue
      case "$src" in *docker.sock*) bad="$bad socket" ;; esac
      if [ -n "$AGENCY_DATA" ]; then case "$src" in "$AGENCY_DATA"|"$AGENCY_DATA"/*) bad="$bad agency-data" ;; esac; fi
      if [ "$type" = "bind" ] && [ "$rw" = "true" ]; then bad="$bad writable-bind($dest)"; fi
      if [ "$label" = "hermes-provisioner" ] && [ "$vname" = "$HOME_VOLUME" ]; then bad="$bad hermes-home"; fi
    done <<<"$mounts"
    if [ -z "$bad" ]; then ok "$label mounts no Docker socket, no agency data directory, no writable bind and (worker) not the Hermes home"; else fail "$label has a forbidden mount:$bad"; fi
    case "${f[13]}" in
      *'"Status":"healthy"'*) ok "$label health check reports healthy" ;;
      *'"Status":"starting"'*) warn "$label health check is still starting" ;;
      *'"Status":"unhealthy"'*) fail "$label health check reports unhealthy" ;;
      *) warn "$label has no health check result" ;;
    esac
    if [ -n "$image_ref" ]; then
      image_id=${f[14]}
      ref_id=$(D image inspect -f '{{.Id}}' "$image_ref" 2>/dev/null)
      if [ -z "$ref_id" ]; then warn "the image $image_ref named in the env file is not present locally"
      elif [ "$ref_id" = "$image_id" ]; then ok "$label runs the image the env file names now"
      else fail "$label runs a different image than $image_ref resolves to now: recreate it, or roll the env file back"; fi
    fi
    if [ "$label" = "hermes-provisioner" ]; then
      if [ "${f[15]}" = "10000:10000" ]; then ok "the worker runs as 10000:10000"; else fail "the worker does not run as 10000:10000"; fi
      case "${f[16]}" in container:*) ok "the worker shares the gateway's network namespace" ;; *) fail "the worker has a network of its own (it must share the gateway's)" ;; esac
    else
      if [ "${f[16]}" = "host" ]; then fail "$label uses the host network"; fi
      case " ${f[17]} " in *" $PRIVATE_NET "*) ok "$label is attached to the private network $PRIVATE_NET" ;; *) fail "$label is not attached to the private network $PRIVATE_NET" ;; esac
    fi
  }
  check_container "hermes-client" "$GATEWAY" "$expected_caps_gateway" "$(dotenv_value "$env_file" IACQUIRE_HERMES_IMAGE)" 1
  check_container "hermes-provisioner" "$WORKER" "" "$(dotenv_value "$env_file" IACQUIRE_PROVISIONER_IMAGE)" 0

  # --- 7. networks and volumes ------------------------------------------------------------
  section "7. Networks and volumes"
  local internal
  internal=$(D network inspect -f '{{.Internal}}' "$PRIVATE_NET" 2>/dev/null)
  case "$internal" in
    true) ok "the private network $PRIVATE_NET exists and is internal" ;;
    false) fail "the private network $PRIVATE_NET is not internal: the gateway would be reachable from outside" ;;
    *) missing "the private network $PRIVATE_NET does not exist" ;;
  esac
  internal=$(D network inspect -f '{{.Internal}}' "$EGRESS_NET" 2>/dev/null)
  case "$internal" in
    true) ok "the client network $EGRESS_NET is internal (outbound traffic goes only through the allowlist proxy)" ;;
    false) warn "the client network $EGRESS_NET is an ordinary bridge: nothing enforces an outbound allowlist, so the web toolset can reach the host's network (apply compose.egress.yaml, or a host firewall rule, after approval)" ;;
    *) info "the client network $EGRESS_NET does not exist yet" ;;
  esac
  local volume attached
  for volume in "$PROFILES_VOLUME" "$STATE_VOLUME"; do
    if D volume inspect -f '{{.Name}}' "$volume" >/dev/null 2>&1; then
      ok "the volume $volume exists"
    else
      missing "the volume $volume does not exist"
    fi
  done
  attached=$(D ps -a --filter "volume=$PROFILES_VOLUME" --format '{{.Names}}' 2>/dev/null | grep -v -e "^${PROJECT}-" || true)
  if [ -z "$attached" ]; then ok "only this project's containers use the client profiles volume"; else fail "another container uses the client profiles volume: $(printf '%s' "$attached" | tr '\n' ' ')"; fi

  # --- 8. neighbours ----------------------------------------------------------------------
  if [ -z "$AGENCY_DATA" ]; then warn "HERMES_AGENCY_DATA_DIR is not set: the check that no client container mounts the agency Hermes data directory was skipped (set it to that directory on this host)"; fi
  section "8. Other containers on this host"
  local names n mem pubs
  names=$(D ps -a --format '{{.Names}}' 2>/dev/null)
  for n in $names; do
    case "$n" in "${PROJECT}-"*) continue ;; esac
    mem=$(insp "$n" '{{.HostConfig.Memory}}')
    if [ "$mem" = "0" ]; then warn "neighbour $n has no memory limit and can starve the client runtime (an internal Hermes is expected here; reserve headroom or move the client runtime)"; fi
  done
  pubs=$(D ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -E ':8642->' || true)
  if [ -z "$pubs" ]; then ok "no container publishes port 8642"; else fail "a container publishes port 8642 on the host: $(printf '%s' "$pubs" | cut -d'|' -f1 | tr '\n' ' ')"; fi

  # --- 9. backups -------------------------------------------------------------------------
  section "9. Backups"
  if [ -z "$BACKUP_DIR" ]; then
    warn "no backup directory configured (CLIENT_BACKUP_DIR): there is no restore point for the client profiles"
  else
    local newest age_days
    newest=$(ls -1t "$BACKUP_DIR"/*.header.txt 2>/dev/null | head -n 1)
    if [ -z "$newest" ]; then
      warn "no backup header found in $BACKUP_DIR"
    else
      age_days=$((( $(date -u +%s) - $(stat -c %Y -- "$newest") ) / 86400))
      if [ "$age_days" -le "$BACKUP_MAX_DAYS" ]; then ok "the newest backup is $age_days day(s) old"; else warn "the newest backup is $age_days day(s) old (limit $BACKUP_MAX_DAYS)"; fi
    fi
  fi

  # --- summary ----------------------------------------------------------------------------
  section "Summary"
  printf '  ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
  info "Nothing was created, changed, started, stopped, pulled or deleted by this script."
  [ "$FAILS" -eq 0 ]
}

main "$@" </dev/null
