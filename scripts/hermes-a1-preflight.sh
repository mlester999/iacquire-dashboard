#!/usr/bin/env bash
# A1 preflight for the restricted Hermes inference worker.
#
# STRICTLY READ-ONLY. It creates, changes, starts, stops, pulls and deletes nothing on the VPS:
# it only reads files, inspects Docker objects with fixed output templates, and (unless
# PREFLIGHT_OFFLINE=1) makes three outbound read lookups (a HEAD request for the clock, a DNS
# lookup of api.deepseek.com, and a registry manifest lookup). It never prints profile contents,
# API keys, the tunnel token or any env value.
#
# Run it from your own machine so nothing is written on the VPS (stdin streaming, Git Bash):
#
#   tr -d '\r' < scripts/hermes-a1-preflight.sh | ssh root@<vps> 'bash -s' | tee a1-preflight-vps.txt
#
# (or 'sudo bash -s' with passwordless sudo). The whole body sits in main() and runs with stdin
# closed, so no command in it can swallow the rest of a streamed script.
#
# Everything is overridable from the environment; none of the settings below is a secret.

main() {
  exec 2>&1
  export LC_ALL=C

  # --- settings ---------------------------------------------------------------------------
  GATEWAY="${HERMES_GATEWAY_CONTAINER:-hermes-agent-wpwm-hermes-agent-1}"
  TUNNEL="${HERMES_TUNNEL_CONTAINER:-iacquire-hermes-tunnel}"
  DATA="${HERMES_DATA_DIR:-}"
  COMPOSE_ROOT="${IACQUIRE_INFERENCE_ROOT:-/docker/iacquire-hermes-inference}"
  HMAC_FILE="${IACQUIRE_INFERENCE_HMAC_FILE:-/etc/iacquire-hermes-inference/inference_hmac}"
  OFFLINE="${PREFLIGHT_OFFLINE:-0}"
  ALLOW_EXEC="${PREFLIGHT_ALLOW_EXEC:-0}"
  WORKER_UID=10000
  WORKER_GID=10000
  BASE_IMAGE="docker.io/nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d"
  WORKER_IMAGE_REPO="iacquire/hermes-inference-worker"
  ALLOWED_MODELS="deepseek-flash deepseek-v4-pro"
  # role id -> profile directory under <data>/profiles (the analyst's directory is iacquire-analyst)
  ROLES=(
    "operations_manager iacquire-operations-manager"
    "lead_hunter iacquire-lead-hunter"
    "appointment_setter iacquire-appointment-setter"
    "sales_assistant iacquire-sales-assistant"
    "crm_manager iacquire-crm-manager"
    "performance_analyst iacquire-analyst"
  )

  OKS=0; WARNS=0; FAILS=0
  ok()      { printf '  [ OK ] %s\n' "$*"; OKS=$((OKS + 1)); }
  warn()    { printf '  [WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
  fail()    { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
  info()    { printf '         %s\n' "$*"; }
  section() { printf '\n== %s ==\n' "$*"; }
  have()    { command -v "$1" >/dev/null 2>&1; }
  D()       { timeout 25 docker "$@"; }

  # Does uid/gid 10000 (no supplementary groups) have the wanted access? Mode bits only; the
  # caller flags ACLs separately. $2 is r (read) or rx (read and traverse).
  worker_can() {
    local path=$1 need=$2 u g m bits
    read -r u g m < <(stat -Lc '%u %g %a' -- "$path" 2>/dev/null) || return 2
    m=$((8#$m))
    if [ "$u" = "$WORKER_UID" ]; then bits=$(((m >> 6) & 7))
    elif [ "$g" = "$WORKER_GID" ]; then bits=$(((m >> 3) & 7))
    else bits=$((m & 7)); fi
    case "$need" in
      r) [ $((bits & 4)) -ne 0 ] ;;
      rx) [ $((bits & 5)) -eq 5 ] ;;
      *) return 2 ;;
    esac
  }

  # Value of KEY in a dotenv-style file, trimmed and unquoted. Used only to measure it; the
  # callers never print it (except DEEPSEEK_BASE_URL, which is a URL and is sanitised first).
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

  is_private_ip() {
    case "$1" in
      10.*|127.*|0.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
      100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
      ::1|::|fc*|fd*|fe8*|fe9*|fea*|feb*) return 0 ;;
    esac
    return 1
  }

  # --- 0. header --------------------------------------------------------------------------
  section "0. Read-only guarantee"
  info "This script changes nothing on this host. It reads files and inspects Docker with fixed templates."
  info "It never prints profile contents, API keys, the tunnel token or environment values."
  info "utc_now=$(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(hostname) user=$(id -un) uid=$(id -u)"
  info "kernel=$(uname -sr) arch=$(uname -m)"
  if [ -r /etc/os-release ]; then info "os=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"; fi
  if [ "$(id -u)" != "0" ]; then warn "not running as root: profile, Docker and permission checks may be incomplete (use sudo)"; fi

  # --- 1. clock ---------------------------------------------------------------------------
  section "1. Clock (worker requests expire after 30 s, so skew matters)"
  if have timedatectl; then
    info "timezone=$(timedatectl show -p Timezone --value 2>/dev/null) ntp_synchronized=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
    if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then ok "system clock reports NTP synchronised"; else warn "system clock is not reported as NTP synchronised"; fi
  else
    warn "timedatectl not available; cannot read the synchronisation state"
  fi
  if [ "$OFFLINE" = "1" ] || ! have curl; then
    info "skew measurement skipped (offline mode or curl missing)"
  else
    date_hdr=$(timeout 8 curl -fsSI --max-time 6 https://www.cloudflare.com 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "date" { print $2; exit }')
    if [ -n "$date_hdr" ] && remote=$(date -u -d "$date_hdr" +%s 2>/dev/null); then
      skew=$(($(date -u +%s) - remote))
      abs=${skew#-}
      if [ "$abs" -le 5 ]; then ok "clock skew against an external reference: ${skew}s"
      elif [ "$abs" -le 15 ]; then warn "clock skew against an external reference: ${skew}s (above 5 s)"
      else fail "clock skew against an external reference: ${skew}s (signed requests would be rejected)"; fi
    else
      warn "could not read an external time reference"
    fi
  fi

  # --- 2. capacity ------------------------------------------------------------------------
  section "2. Capacity (six workers cap at 3 GiB, the proxy at 64 MiB; caps are not reservations)"
  mem_avail=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null)
  mem_total=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null)
  swap_total=$(awk '/^SwapTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null)
  info "cpus=$(nproc 2>/dev/null) load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null) mem_total_mib=${mem_total:-?} swap_total_mib=${swap_total:-?}"
  if [ -n "${mem_avail:-}" ]; then
    if [ "$mem_avail" -ge 4096 ]; then ok "memory available: ${mem_avail} MiB (needs 3136 MiB of caps plus headroom)"
    elif [ "$mem_avail" -ge 3200 ]; then warn "memory available: ${mem_avail} MiB (barely above the 3136 MiB of caps)"
    else fail "memory available: ${mem_avail} MiB (below the 3136 MiB of caps)"; fi
  else
    warn "could not read available memory"
  fi
  docker_root=""
  if have docker; then docker_root=$(D info --format '{{.DockerRootDir}}' 2>/dev/null); fi
  for p in "${docker_root:-/var/lib/docker}" "${DATA:-/docker}" "$(dirname "$COMPOSE_ROOT")"; do
    [ -e "$p" ] || continue
    free_gib=$(df -Pk -- "$p" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }')
    if [ -n "${free_gib:-}" ]; then
      if [ "$free_gib" -ge 15 ]; then ok "disk free under $p: ${free_gib} GiB"
      elif [ "$free_gib" -ge 8 ]; then warn "disk free under $p: ${free_gib} GiB (image pull and build need room)"
      else fail "disk free under $p: ${free_gib} GiB"; fi
    fi
  done

  # --- 3. docker --------------------------------------------------------------------------
  section "3. Docker engine"
  if ! have docker; then
    fail "docker is not installed or not on PATH"
  else
    sv=$(D version --format '{{.Server.Version}}' 2>/dev/null)
    if [ -n "$sv" ]; then ok "docker server $sv"; else fail "cannot talk to the Docker daemon (permissions or daemon down)"; fi
    cv=$(D compose version --short 2>/dev/null)
    if [ -n "$cv" ]; then ok "docker compose $cv"; else fail "docker compose v2 plugin is missing"; fi
    info "storage_driver=$(D info --format '{{.Driver}}' 2>/dev/null) cgroup=$(D info --format '{{.CgroupVersion}}/{{.CgroupDriver}}' 2>/dev/null) root=${docker_root:-?}"
    secopts=$(D info --format '{{.SecurityOptions}}' 2>/dev/null)
    info "security_options=$secopts"
    case "$secopts" in
      *userns*) fail "user namespace remapping is on: UID 10000 inside a container is not UID 10000 on the host, so the profile ownership check below does not hold" ;;
      *) ok "no user namespace remapping" ;;
    esac
    warnings=$(D info --format '{{range .Warnings}}{{.}}{{"\n"}}{{end}}' 2>/dev/null)
    if [ -n "$warnings" ]; then
      warn "docker reports warnings (memory and pids limits need the matching cgroup support):"
      printf '%s\n' "$warnings" | sed 's/^/           /'
    else
      ok "docker reports no cgroup or swap-limit warnings"
    fi
    info "containers now (name, image, status):"
    D ps -a --format '{{.Names}}   {{.Image}}   {{.Status}}' 2>/dev/null | sed 's/^/           /'

    section "3a. Name collisions with what A1 would create"
    clash=$(D ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^(iacquire-hermes-inference-worker-|iacquire-deepseek-egress-proxy$)' || true)
    if [ -z "$clash" ]; then ok "no worker or proxy container exists yet"; else fail "these containers already exist: $(printf '%s' "$clash" | tr '\n' ' ')"; fi
    nclash=$(D network ls --format '{{.Name}}' 2>/dev/null | grep -E '^iacquire-hermes-inference-' || true)
    if [ -z "$nclash" ]; then ok "no iacquire-hermes-inference-* network exists yet"; else fail "these networks already exist: $(printf '%s' "$nclash" | tr '\n' ' ')"; fi
    iclash=$(D image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E "^${WORKER_IMAGE_REPO}:" || true)
    if [ -z "$iclash" ]; then ok "no ${WORKER_IMAGE_REPO} image exists locally yet"; else warn "a worker image already exists locally: $(printf '%s' "$iclash" | tr '\n' ' ')"; fi
    info "all networks (name, driver, internal):"
    D network ls --format '{{.Name}}   {{.Driver}}   internal={{.Internal}}' 2>/dev/null | sed 's/^/           /'
    info "docker disk usage:"
    D system df 2>/dev/null | sed 's/^/           /'

    section "3b. Existing Hermes gateway (must stay untouched)"
    if D inspect "$GATEWAY" >/dev/null 2>&1; then
      info "container=$GATEWAY"
      info "state:    $(D inspect -f '{{.State.Status}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$GATEWAY")"
      info "image:    $(D inspect -f '{{.Config.Image}}' "$GATEWAY")"
      info "restart:  $(D inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$GATEWAY")"
      info "networks: $(D inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$GATEWAY")"
      info "ports:    $(D inspect -f '{{json .NetworkSettings.Ports}}' "$GATEWAY")"
      info "mounts:   $(D inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}}({{if .RW}}rw{{else}}ro{{end}}) {{end}}' "$GATEWAY")"
      if [ "$(D inspect -f '{{.State.Status}}' "$GATEWAY")" = "running" ]; then ok "gateway container is running"; else fail "gateway container is not running"; fi
      if [ -z "$DATA" ]; then
        DATA=$(D inspect -f '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}' "$GATEWAY" 2>/dev/null)
        [ -n "$DATA" ] && info "Hermes data directory taken from the gateway bind mount: $DATA"
      fi
    else
      fail "no container named $GATEWAY (set HERMES_GATEWAY_CONTAINER to its real name; the list above shows what exists)"
    fi

    section "3c. Existing tunnel connector (must stay untouched)"
    if D inspect "$TUNNEL" >/dev/null 2>&1; then
      info "container=$TUNNEL"
      info "state:    $(D inspect -f '{{.State.Status}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$TUNNEL")"
      info "image:    $(D inspect -f '{{.Config.Image}}' "$TUNNEL")"
      info "restart:  $(D inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$TUNNEL")"
      info "networks: $(D inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$TUNNEL")"
      info "mounts:   $(D inspect -f '{{range .Mounts}}{{.Source}}->{{.Destination}}({{if .RW}}rw{{else}}ro{{end}}) {{end}}' "$TUNNEL")"
      if D inspect -f '{{json .Config.Env}} {{json .Config.Cmd}} {{json .Config.Entrypoint}} {{json .Args}}' "$TUNNEL" 2>/dev/null | grep -Eq 'TUNNEL_TOKEN|--token'; then
        ok "connector is token-managed (routes live in the Cloudflare dashboard); the token value was NOT printed"
      else
        warn "could not tell whether the connector is token-managed; check how it is configured before editing routes"
      fi
      if [ "$ALLOW_EXEC" = "1" ]; then
        info "cloudflared version (docker exec, --version only): $(timeout 15 docker exec "$TUNNEL" cloudflared --version 2>/dev/null | head -n 1)"
      else
        info "cloudflared version: not read from the container (set PREFLIGHT_ALLOW_EXEC=1 to run 'cloudflared --version' inside it); the Cloudflare script reports connector versions from the API"
      fi
      if [ "$(D inspect -f '{{.State.Status}}' "$TUNNEL")" = "running" ]; then ok "tunnel container is running"; else fail "tunnel container is not running"; fi
    else
      warn "no container named $TUNNEL (set HERMES_TUNNEL_CONTAINER, or the connector runs on the host; see section 6)"
    fi
  fi

  # --- 4. profiles ------------------------------------------------------------------------
  section "4. Six Hermes profiles (read only; contents are never printed)"
  : "${DATA:=/docker/hermes-agent-wpwm/data}"
  PROFILES="$DATA/profiles"
  info "profile base (HERMES_PROFILE_BASE) = $PROFILES"
  if [ ! -d "$PROFILES" ]; then
    fail "profile base does not exist or is unreadable: $PROFILES"
  else
    info "directories under the profile base: $(ls -A "$PROFILES" 2>/dev/null | tr '\n' ' ')"
    seen=""
    for entry in "${ROLES[@]}"; do
      role=${entry%% *}; dir=${entry##* }
      d="$PROFILES/$dir"
      printf '\n  -- %s  (%s)\n' "$role" "$dir"
      case " $seen " in *" $dir "*) fail "duplicate directory mapping for $dir" ;; esac
      seen="$seen $dir"
      if [ ! -d "$d" ] || [ -L "$d" ]; then fail "$dir is missing or is a symlink"; continue; fi
      info "dir: $(stat -c '%U:%G (%u:%g) %A' -- "$d")  entries: $(find "$d" -maxdepth 1 -mindepth 1 -printf '%f ' 2>/dev/null)"
      if worker_can "$d" rx; then ok "UID/GID 10000 can enter and list $dir"; else fail "UID/GID 10000 cannot enter or list $dir (mode bits)"; fi
      case "$(stat -c '%A' -- "$d")" in *+) warn "$dir has an ACL; mode bits alone are not the full picture, so recheck with the real container at A1" ;; esac
      links=$(find "$d" -maxdepth 1 -mindepth 1 -type l -printf '%f ' 2>/dev/null)
      if [ -n "$links" ]; then warn "symlinks inside $dir (they may not resolve inside the container): $links"; fi

      soul="$d/SOUL.md"
      if [ -L "$soul" ] || [ ! -f "$soul" ]; then
        fail "SOUL.md is missing, not a regular file or a symlink (the worker refuses it)"
      else
        size=$(stat -c '%s' -- "$soul")
        if [ "$size" -ge 1 ] && [ "$size" -le 16384 ]; then ok "SOUL.md is a regular file of $size bytes (limit 16384)"; else fail "SOUL.md is $size bytes (the worker needs 1 to 16384)"; fi
        if worker_can "$soul" r; then ok "UID/GID 10000 can read SOUL.md"; else fail "UID/GID 10000 cannot read SOUL.md"; fi
        info "sha256 SOUL.md = $(sha256sum -- "$soul" | cut -d' ' -f1)"
      fi

      cfg="$d/config.yaml"
      if [ ! -f "$cfg" ]; then
        fail "config.yaml is missing"
      else
        if worker_can "$cfg" r; then ok "UID/GID 10000 can read config.yaml"; else fail "UID/GID 10000 cannot read config.yaml"; fi
        info "sha256 config.yaml = $(sha256sum -- "$cfg" | cut -d' ' -f1)"
        parsed=$(awk '
          /^model:[[:space:]]*$/ { inm = 1; next }
          /^model:[[:space:]]*[^[:space:]#]/ { print "scalar"; exit }
          inm && /^[^[:space:]#]/ { inm = 0 }
          inm && /^[[:space:]]+(provider|default|name|model):/ {
            line = $0; sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+#.*$/, "", line); print line
          }' "$cfg" | tr -d '"'"'"'\r')
        if [ "$parsed" = "scalar" ]; then
          fail "config.yaml sets model as a plain string; the worker needs a model: block with default/provider"
        else
          provider=$(printf '%s\n' "$parsed" | sed -n 's/^provider:[[:space:]]*//p' | head -n 1)
          model=""
          for k in default name model; do
            v=$(printf '%s\n' "$parsed" | sed -n "s/^${k}:[[:space:]]*//p" | head -n 1)
            if [ -n "$v" ]; then model=$v; break; fi
          done
          info "configured provider='${provider:-<unset>}' model='${model:-<unset>}'"
          case "${provider:-}" in ""|auto|deepseek) ok "provider is acceptable (${provider:-unset})" ;; *) fail "provider '$provider' is not deepseek/auto/unset (the worker would refuse it)" ;; esac
          case " $ALLOWED_MODELS " in *" $model "*) [ -n "$model" ] && ok "model '$model' is in the worker allow-list" ;; *) fail "model '${model:-<unset>}' is not one of: $ALLOWED_MODELS" ;; esac
        fi
      fi

      envf="$d/.env"
      if [ ! -f "$envf" ]; then
        fail ".env is missing in the profile: the worker finds no DeepSeek credential there (it has no other source)"
      else
        if worker_can "$envf" r; then ok "UID/GID 10000 can read the profile .env"; else fail "UID/GID 10000 cannot read the profile .env"; fi
        keyval=$(dotenv_value "$envf" DEEPSEEK_API_KEY)
        if [ "${#keyval}" -ge 12 ]; then ok "DEEPSEEK_API_KEY is present with 12 or more characters (value not shown)"
        elif [ -n "$keyval" ]; then fail "DEEPSEEK_API_KEY is present but shorter than 12 characters"
        else fail "DEEPSEEK_API_KEY is not set in the profile .env"; fi
        keyval=""
        base=$(dotenv_value "$envf" DEEPSEEK_BASE_URL)
        if [ -z "$base" ]; then ok "DEEPSEEK_BASE_URL is not set (the provider default is used)"
        else
          safe=$(printf '%s' "$base" | sed -E 's#(://)[^/@]*@#\1***@#; s#[?#].*$##')
          info "DEEPSEEK_BASE_URL = $safe (must equal the Hermes provider default exactly or the worker refuses it)"
          case "$safe" in https://api.deepseek.com|https://api.deepseek.com/*) warn "DEEPSEEK_BASE_URL is set; confirm it equals the default" ;; *) fail "DEEPSEEK_BASE_URL points somewhere other than api.deepseek.com" ;; esac
        fi
        base=""
      fi
    done
  fi
  if [ -f "$DATA/.env" ]; then
    if [ -n "$(dotenv_value "$DATA/.env" DEEPSEEK_API_KEY)" ]; then
      info "note: the shared $DATA/.env also holds a DeepSeek key, but the worker mounts one profile only and never sees that file"
    fi
  fi

  # --- 5. network and secrets location ------------------------------------------------------
  section "5. Network, DNS and where the new secret would live"
  if have ss; then
    listening=$(ss -H -ltn 2>/dev/null | awk '{ print $4 }' | sort -u | tr '\n' ' ')
    info "host TCP listeners: $listening"
    case " $listening " in
      *":8786 "*|*":3128 "*) warn "something already listens on 8786 or 3128 on the host (the workers publish no host ports, so this is unrelated but worth knowing)" ;;
      *) ok "nothing on the host listens on 8786 or 3128" ;;
    esac
  else
    warn "ss is not available"
  fi
  if [ "$OFFLINE" = "1" ]; then
    info "DNS check skipped (offline mode)"
  elif have getent; then
    addrs=$(timeout 10 getent ahosts api.deepseek.com 2>/dev/null | awk '{ print $1 }' | sort -u)
    if [ -z "$addrs" ]; then
      fail "api.deepseek.com does not resolve from the host resolver"
    else
      bad=""
      for a in $addrs; do if is_private_ip "$a"; then bad="$bad $a"; fi; done
      info "api.deepseek.com resolves to: $(printf '%s' "$addrs" | tr '\n' ' ')"
      if [ -z "$bad" ]; then ok "all resolved addresses are public (the egress proxy rejects private ones)"; else fail "resolved to non-public address(es):$bad (the egress proxy would reject them)"; fi
    fi
  fi
  if have ufw; then info "ufw: $(ufw status 2>/dev/null | head -n 1)  (the design makes no firewall change)"; fi
  info "planned project root (Compose project and build context): $COMPOSE_ROOT"
  if [ -e "$COMPOSE_ROOT" ]; then warn "$COMPOSE_ROOT already exists: $(ls -A "$COMPOSE_ROOT" 2>/dev/null | tr '\n' ' ')"; else ok "$COMPOSE_ROOT does not exist yet (A1 would create it)"; fi
  info "planned HMAC file (IACQUIRE_INFERENCE_HMAC_FILE): $HMAC_FILE"
  if [ -e "$HMAC_FILE" ]; then warn "the HMAC file already exists; A1 must not overwrite it without a decision"; else ok "the HMAC file does not exist yet (expected before A1)"; fi
  case "$HMAC_FILE" in
    "$DATA"/*) fail "the HMAC file would live inside the Hermes data directory, which the gateway container mounts" ;;
    "$COMPOSE_ROOT"/*) fail "the HMAC file would live inside the Docker build context, so the build would send it to the daemon" ;;
    *) ok "the HMAC file location is outside the Hermes data directory and the build context" ;;
  esac
  hdir=$(dirname "$HMAC_FILE")
  if [ -d "$hdir" ]; then info "HMAC parent exists: $(stat -c '%U:%G %A' -- "$hdir")"; else info "HMAC parent $hdir does not exist yet (A1 would create it, mode 0700)"; fi

  # --- 6. cloudflared on the host (token redacted) -------------------------------------------
  section "6. cloudflared outside Docker (token never printed)"
  if have cloudflared; then
    info "host binary: $(cloudflared --version 2>/dev/null | head -n 1)"
  else
    info "no cloudflared binary on the host PATH"
  fi
  if have systemctl; then
    units=$(systemctl list-units --type=service --all --no-legend 2>/dev/null | awk '{ print $1 " " $3 " " $4 }' | grep -i cloudflared || true)
    if [ -n "$units" ]; then info "systemd units: $units"; else info "no cloudflared systemd unit"; fi
  fi
  procs=$(ps -eo pid,etime,comm 2>/dev/null | awk '$3 ~ /cloudflared/' || true)
  if [ -n "$procs" ]; then info "host processes (command names only; the arguments carry the token and are not shown): $procs"; fi

  # --- 7. images --------------------------------------------------------------------------
  section "7. Pinned base image availability"
  if have docker; then
    if D image inspect "$BASE_IMAGE" >/dev/null 2>&1; then ok "the pinned base image is already present locally"; else info "the pinned base image is not present locally (A1 would pull it)"; fi
  fi
  if [ "$OFFLINE" = "1" ] || ! have docker; then
    info "registry lookup skipped (offline mode or docker missing)"
  else
    manifest=$(timeout 40 docker manifest inspect "$BASE_IMAGE" 2>/dev/null)
    if [ -z "$manifest" ]; then
      warn "could not read the manifest for the pinned digest from the registry (rate limit, egress, or the digest is gone)"
    else
      archs=$(printf '%s' "$manifest" | grep -o '"architecture": *"[a-z0-9]*"' | sed 's/.*: *//; s/"//g' | sort -u | tr '\n' ' ')
      host_arch=$(uname -m)
      case "$host_arch" in x86_64) want=amd64 ;; aarch64|arm64) want=arm64 ;; *) want=$host_arch ;; esac
      if [ -z "$archs" ]; then info "the digest is a single-platform manifest; platform not listed"; ok "the pinned digest resolves in the registry"
      else
        info "published platforms: $archs (host wants linux/$want)"
        case " $archs " in *" $want "*) ok "the pinned digest resolves and includes linux/$want" ;; *) fail "the pinned digest has no linux/$want build" ;; esac
      fi
    fi
  fi

  # --- summary ----------------------------------------------------------------------------
  section "Summary"
  printf '  ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
  info "Nothing was created, changed, started, stopped, pulled or deleted by this script."
  info "Keep the sha256 lines above: recompute them after A1 to prove the profiles were not touched."
  [ "$FAILS" -eq 0 ]
}

main "$@" </dev/null
