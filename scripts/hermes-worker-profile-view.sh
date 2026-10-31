#!/usr/bin/env bash
# Worker-only profile view for the six Hermes inference workers (O2).
#
# The inference workers need three things from an employee's profile: SOUL.md, config.yaml and the DeepSeek
# settings in .env. Mounting the whole live profile gives them far more: state.db, sessions, memories, backups,
# every other secret in .env and, once business tools are on, that employee's business MCP credential. This
# script builds, and later verifies, one directory per employee that holds exactly those three files, and the
# workers mount that instead (IACQUIRE_WORKER_PROFILE_BASE in compose.internal.yaml).
#
#   sync   validate everything first, then build or refresh the view, then verify it
#   check  verify the view against the live profiles (and, with --containers, the running workers' mounts)
#
#   scripts/hermes-worker-profile-view.sh sync  --live <live profiles dir> --view <worker view dir> [--dry-run]
#   scripts/hermes-worker-profile-view.sh check --live <live profiles dir> --view <worker view dir> [--containers]
#
# What it will and will not do:
#   * It writes ONLY inside the view directory. It never changes, moves or deletes anything in the live profiles,
#     and it refuses a view that is, contains or sits inside the live directory.
#   * It deletes nothing except its own leftover temporary files (.new.*) in the view. Any other unexpected entry
#     there is reported as a failure for an operator to look at.
#   * Files are replaced one by one inside the existing directory (write, then rename), so a running worker keeps
#     a valid mount; a worker reads the new files on its next request.
#   * It never prints profile text or any value from .env. Output is names, byte counts, 12-character hashes of
#     SOUL.md and config.yaml, presence flags and verdicts. Secrets exist only in shell variables and in the files
#     it writes. The only Docker commands are `docker ps` and `docker inspect` with a fixed mount template (never
#     the environment).
#   * The .env in the view is derived with the same rules as the worker's own filter (_provider_dotenv in
#     services/hermes-inference-worker/worker.py): only DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL, values of 8 to 512
#     plain characters, one optional layer of matching quotes, a later line overrides an earlier one.
#
# Exit status: 0 = every check passed (warnings allowed), 1 = at least one failure, 2 = bad usage.
# Run as root on the VPS (it sets the files to the workers' uid); as another user it still works and says so.

main() {
  export LC_ALL=C
  umask 077

  local PROFILES=(
    iacquire-operations-manager iacquire-lead-hunter iacquire-appointment-setter
    iacquire-sales-assistant iacquire-crm-manager iacquire-analyst
  )
  local ROLES=(operations-manager lead-hunter appointment-setter sales-assistant crm-manager performance-analyst)
  local SOUL_LIMIT=16384 CONFIG_LIMIT=65536 DOTENV_LIMIT=65536
  local WORKER_UID="${IACQUIRE_WORKER_UID:-10000}" WORKER_GID="${IACQUIRE_WORKER_GID:-10000}"
  local DOTENV_KEYS=(DEEPSEEK_API_KEY DEEPSEEK_BASE_URL)
  # The worker's pattern is [A-Za-z0-9_.:/+=@~-]{8,512}. The length is checked separately because some regex engines (Git Bash) cap an interval at 255.
  local VALUE_RE='^[A-Za-z0-9_.:/+=@~-]+$' VALUE_MIN=8 VALUE_MAX=512

  local OKS=0 WARNS=0 FAILS=0
  ok()      { printf '  [ OK ] %s\n' "$*"; OKS=$((OKS + 1)); }
  warn()    { printf '  [WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
  fail()    { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
  info()    { printf '         %s\n' "$*"; }
  section() { printf '\n== %s ==\n' "$*"; }
  have()    { command -v "$1" >/dev/null 2>&1; }
  usage()   { printf 'usage: %s sync|check --live <dir> --view <dir> [--dry-run] [--containers]\n' "${0##*/}" >&2; return 2; }

  local mode="${1:-}"; [ $# -gt 0 ] && shift
  local LIVE="" VIEW="" DRY=0 CONTAINERS=0
  case "$mode" in sync|check) ;; *) usage; return 2 ;; esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --live) LIVE="${2:-}"; shift 2 || { usage; return 2; } ;;
      --view) VIEW="${2:-}"; shift 2 || { usage; return 2; } ;;
      --dry-run) DRY=1; shift ;;
      --containers) CONTAINERS=1; shift ;;
      *) usage; return 2 ;;
    esac
  done
  [ -n "$LIVE" ] && [ -n "$VIEW" ] || { usage; return 2; }
  [ "$DRY" = 1 ] && [ "$mode" != sync ] && { usage; return 2; }
  [ "$CONTAINERS" = 1 ] && [ "$mode" != check ] && { usage; return 2; }

  is_abs() { case "$1" in /*) return 0 ;; [A-Za-z]:[/\\]*) return 0 ;; *) return 1 ;; esac; }   # the drive form is for Git Bash on Windows
  is_abs "$LIVE" && is_abs "$VIEW" || { printf 'both --live and --view must be absolute paths\n' >&2; return 2; }
  [ -d "$LIVE" ] && [ ! -L "$LIVE" ] || { printf 'the live profiles directory is missing or is a symlink\n' >&2; return 2; }
  local LIVE_REAL VIEW_REAL
  LIVE_REAL=$(realpath -m -- "$LIVE") || return 2
  VIEW_REAL=$(realpath -m -- "$VIEW") || return 2
  case "$VIEW_REAL/" in "$LIVE_REAL"/*) printf 'the view must not be inside the live profiles directory\n' >&2; return 2 ;; esac
  case "$LIVE_REAL/" in "$VIEW_REAL"/*) printf 'the live profiles directory must not be inside the view\n' >&2; return 2 ;; esac
  [ -L "$VIEW" ] && { printf 'the view directory must not be a symlink\n' >&2; return 2; }

  local IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1

  size_of() { stat -c %s -- "$1" 2>/dev/null; }
  trim() { local s=$1; s="${s#"${s%%[![:space:]]*}"}"; T="${s%"${s##*[![:space:]]}"}"; }   # sets T (no subshell)
  is_dotenv_key() { local k; for k in "${DOTENV_KEYS[@]}"; do [ "$k" = "$1" ] && return 0; done; return 1; }

  # stat and sha256sum for several paths in one call each (a fork costs real time on Windows, and the tests run this a lot).
  local -A SIZE=() MODE=() OWNER=() HASH=()
  stat_into() {
    local size mode owner path
    SIZE=(); MODE=(); OWNER=()
    while IFS='|' read -r size mode owner path; do SIZE[$path]=$size; MODE[$path]=$mode; OWNER[$path]=$owner; done < <(stat -c '%s|%a|%u:%g|%n' -- "$@" 2>/dev/null)
  }
  sha_into() {
    local sum path
    HASH=()
    # Some platforms (Git Bash) print a binary-mode marker before the name.
    while read -r sum path; do path="${path#\*}"; HASH[$path]=${sum:0:12}; done < <(sha256sum -- "$@" 2>/dev/null)
  }
  not_group_or_other_writable() { [ $(( 8#${1:-777} & 8#022 )) -eq 0 ]; }

  # One KEY=value pair per output line for the allowed names only. The output is a secret: callers redirect or capture it, never print it.
  derive_dotenv() {
    local file=$1 line text name value first last key
    local -A kept=()
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      trim "$line"; text=$T
      case "$text" in export\ *) trim "${text#export }"; text=$T ;; esac
      name="${text%%=*}"
      [ "$name" = "$text" ] && continue
      trim "$name"; name=$T
      is_dotenv_key "$name" || continue
      trim "${text#*=}"; value=$T
      if [ "${#value}" -ge 2 ]; then
        first="${value:0:1}"; last="${value: -1}"
        if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then value="${value:1:${#value}-2}"; fi
      fi
      if [ "${#value}" -ge "$VALUE_MIN" ] && [ "${#value}" -le "$VALUE_MAX" ] && [[ $value =~ $VALUE_RE ]]; then kept[$name]=$value; fi
    done < "$file"
    for key in "${DOTENV_KEYS[@]}"; do
      [ -n "${kept[$key]+x}" ] && printf '%s=%s\n' "$key" "${kept[$key]}"
    done
    return 0
  }

  # Validates one live profile without printing anything but verdicts. Returns 0 when the view can be built from it.
  validate_live() {
    local profile=$1 dir="$LIVE/$1" good=1 name limit n derived
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then fail "$profile: the live profile directory is missing or is a symlink"; return 1; fi
    for name in SOUL.md config.yaml .env; do
      case "$name" in SOUL.md) limit=$SOUL_LIMIT ;; config.yaml) limit=$CONFIG_LIMIT ;; *) limit=$DOTENV_LIMIT ;; esac
      if [ -L "$dir/$name" ] || [ ! -f "$dir/$name" ]; then fail "$profile: live $name is missing, is not a regular file or is a symlink"; good=0; continue; fi
      n=$(size_of "$dir/$name")
      if [ -z "$n" ] || [ "$n" -lt 1 ] || [ "$n" -gt "$limit" ]; then fail "$profile: live $name is ${n:-unreadable} bytes; the worker accepts 1 to $limit"; good=0; fi
    done
    [ "$good" = 1 ] || return 1
    derived=$(derive_dotenv "$dir/.env")
    case "$derived" in *DEEPSEEK_API_KEY=*) ;; *) fail "$profile: the live .env has no usable DEEPSEEK_API_KEY (8 to 512 plain characters); the worker could not run"; return 1 ;; esac
    return 0
  }

  # Reports whether any value from the live .env that is NOT a DeepSeek setting appears inside the three view files. Names only.
  # A value that is the very same string as a DeepSeek setting is skipped: it is legitimately in the view's .env.
  leak_scan() {
    local profile=$1 line text name value first last leaked=0 allowed hits f
    local view="$VIEW/$profile" live="$LIVE/$profile"
    allowed=$(derive_dotenv "$live/.env")
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"; trim "$line"; text=$T
      case "$text" in export\ *) trim "${text#export }"; text=$T ;; esac
      name="${text%%=*}"; [ "$name" = "$text" ] && continue
      trim "$name"; name=$T
      is_dotenv_key "$name" && continue
      trim "${text#*=}"; value=$T
      if [ "${#value}" -ge 2 ]; then
        first="${value:0:1}"; last="${value: -1}"
        if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then value="${value:1:${#value}-2}"; fi
      fi
      [ "${#value}" -ge 8 ] || continue
      case $'\n'"$allowed"$'\n' in *"=${value}"$'\n'*) continue ;; esac
      hits=$(grep -Fl -- "$value" "$view/SOUL.md" "$view/config.yaml" "$view/.env" 2>/dev/null)
      [ -n "$hits" ] || continue
      while IFS= read -r f; do fail "$profile: the value of $name from the live .env appears in the view's ${f##*/}"; leaked=1; done <<< "$hits"
    done < "$live/.env"
    [ "$leaked" = 0 ]
  }

  check_profile() {
    local profile=$1 view="$VIEW/$1" live="$LIVE/$1" entry name derived actual want bad=0 had_dotglob=0 had_nullglob=0
    local -a entries=()
    if [ ! -d "$view" ] || [ -L "$view" ]; then fail "$profile: no worker view directory (run sync)"; return 1; fi
    # Exactly the three allowed entries, nothing else (hidden files included).
    shopt -q dotglob && had_dotglob=1; shopt -q nullglob && had_nullglob=1
    shopt -s dotglob nullglob; entries=("$view"/*)
    [ "$had_dotglob" = 1 ] || shopt -u dotglob; [ "$had_nullglob" = 1 ] || shopt -u nullglob
    for entry in "${entries[@]}"; do
      entry="${entry##*/}"
      case "$entry" in SOUL.md|config.yaml|.env) ;; *) fail "$profile: unexpected entry in the view: $entry"; bad=1 ;; esac
    done
    for name in SOUL.md config.yaml .env; do
      if [ -L "$view/$name" ] || [ ! -f "$view/$name" ]; then fail "$profile: view $name is missing, is not a regular file or is a symlink"; bad=1; fi
    done
    [ "$bad" = 0 ] || return 1
    stat_into "$view" "$view/SOUL.md" "$view/config.yaml" "$view/.env" "$live/SOUL.md" "$live/config.yaml"
    for name in SOUL.md config.yaml .env; do
      not_group_or_other_writable "${MODE[$view/$name]}" || { fail "$profile: view $name is writable by group or others (mode ${MODE[$view/$name]:-unknown})"; bad=1; }
      if [ "$IS_ROOT" = 1 ] && [ "${OWNER[$view/$name]}" != "$WORKER_UID:$WORKER_GID" ]; then warn "$profile: view $name is owned by ${OWNER[$view/$name]:-unknown}, not $WORKER_UID:$WORKER_GID"; fi
    done
    not_group_or_other_writable "${MODE[$view]}" || { fail "$profile: the view directory is writable by group or others (mode ${MODE[$view]:-unknown})"; bad=1; }
    [ "$bad" = 0 ] || return 1
    sha_into "$view/SOUL.md" "$live/SOUL.md" "$view/config.yaml" "$live/config.yaml"
    for name in SOUL.md config.yaml; do
      if [ -n "${HASH[$view/$name]}" ] && [ "${HASH[$view/$name]}" = "${HASH[$live/$name]}" ]; then
        ok "$profile: $name matches the live file (${SIZE[$view/$name]} bytes, sha256 ${HASH[$view/$name]}...)"
      else
        fail "$profile: $name differs from the live file: DRIFT (view ${HASH[$view/$name]:-unreadable}..., live ${HASH[$live/$name]:-unreadable}...); run sync"; bad=1
      fi
    done
    derived=$(derive_dotenv "$live/.env"); actual=$(<"$view/.env")
    case "$derived" in *DEEPSEEK_API_KEY=*) ;; *) fail "$profile: the live .env has no usable DEEPSEEK_API_KEY, so a worker on this profile could not run"; return 1 ;; esac
    if [ "$derived" = "$actual" ]; then
      want=""; for name in "${DOTENV_KEYS[@]}"; do case $'\n'"$actual"$'\n' in *$'\n'"$name="*) want="$want $name=present" ;; *) want="$want $name=absent" ;; esac; done
      ok "$profile: .env holds only the DeepSeek settings, as the live file would give the worker ($want )"
    else
      fail "$profile: the view's .env is not what the live .env would give the worker (extra, missing or changed lines): DRIFT; run sync"; bad=1
    fi
    # The names in the view's .env must be a subset of the allowed ones even if the comparison above passed.
    while IFS= read -r entry; do
      name="${entry%%=*}"
      is_dotenv_key "$name" || { fail "$profile: the view's .env has a line that is not a DeepSeek setting"; bad=1; }
    done <<< "$actual"
    leak_scan "$profile" || bad=1
    [ "$bad" = 0 ] && ok "$profile: no value from the live .env other than the DeepSeek settings appears in the view"
    return "$bad"
  }

  check_containers() {
    local c profile live_base_real="$LIVE_REAL" line type src dst rw role_ok mounts n_profile n_other
    if ! have docker; then warn "docker is not available here; the running workers' mounts were not checked"; return; fi
    local names
    names=$(timeout 25 docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'iacquire-hermes-inference-worker-(operations-manager|lead-hunter|appointment-setter|sales-assistant|crm-manager|performance-analyst)' | sort)
    if [ -z "$names" ]; then warn "no running worker containers were found; the mounts were not checked"; return; fi
    local role expected
    while IFS= read -r c; do
      n_profile=0; n_other=0
      role=$(printf '%s' "$c" | sed -E 's/.*iacquire-hermes-inference-worker-(operations-manager|lead-hunter|appointment-setter|sales-assistant|crm-manager|performance-analyst).*/\1/')
      case "$role" in performance-analyst) expected=iacquire-analyst ;; *) expected="iacquire-$role" ;; esac
      mounts=$(timeout 25 docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$c" 2>/dev/null)
      if [ -z "$mounts" ]; then fail "$c: could not read the container's mounts"; continue; fi
      while IFS='|' read -r type src dst rw; do
        [ -n "$type" ] || continue
        case "$dst" in
          /profiles/*)
            n_profile=$((n_profile + 1)); profile="${dst#/profiles/}"
            role_ok=0; for p in "${PROFILES[@]}"; do [ "$p" = "$profile" ] && role_ok=1; done
            [ "$role_ok" = 1 ] || { fail "$c: mounts an unexpected profile name at $dst"; continue; }
            [ "$profile" = "$expected" ] || { fail "$c: the $role worker mounts $profile, not its own profile $expected"; continue; }
            if [ "$(realpath -m -- "$src")" != "$VIEW_REAL/$profile" ]; then fail "$c: the profile mount for $profile comes from outside the worker view"
            elif [ "$rw" != "false" ]; then fail "$c: the profile mount for $profile is writable"
            else ok "$c: $profile is mounted read-only from the worker view"; fi ;;
          /run/secrets/inference_hmac)
            if [ "$rw" = "false" ]; then ok "$c: the HMAC secret file is mounted read-only"; else fail "$c: the HMAC secret file mount is writable"; fi ;;
          /opt/data)
            if [ "$type" = "volume" ]; then warn "$c: the image's anonymous /opt/data volume is present (known item O3: writable, unused, holds no profile data)"; else fail "$c: unexpected mount at /opt/data"; fi ;;
          *)
            n_other=$((n_other + 1)); fail "$c: unexpected mount at $dst" ;;
        esac
        case "$(realpath -m -- "$src" 2>/dev/null)/" in "$live_base_real"/*) fail "$c: a mount reads from the live profiles directory" ;; esac
      done <<< "$mounts"
      [ "$n_profile" = 1 ] || fail "$c: expected exactly one profile mount, found $n_profile"
    done <<< "$names"
  }

  # ---- sync ---------------------------------------------------------------------------------------------------------
  write_file_replace() {   # write_file_replace <dest dir> <name>  (content on stdin); replaces atomically inside the existing directory
    local dir=$1 name=$2 tmp
    tmp="$dir/.new.$name.$$"
    ( umask 0277; cat > "$tmp" ) || { rm -f -- "$tmp"; return 1; }
    mv -f -- "$tmp" "$dir/$name"
  }

  sync_profile() {
    local profile=$1 view="$VIEW/$1" live="$LIVE/$1" entry
    if [ -e "$view" ] && { [ -L "$view" ] || [ ! -d "$view" ]; }; then fail "$profile: the view path exists but is not a directory"; return 1; fi
    if [ ! -d "$view" ]; then mkdir -p -- "$view" && chmod 0700 -- "$view" || { fail "$profile: could not create the view directory"; return 1; }
    else chmod u+w -- "$view" 2>/dev/null; fi
    # Remove only this script's own leftovers.
    while IFS= read -r entry; do case "$entry" in .new.*) rm -f -- "$view/$entry" ;; esac; done < <(find "$view" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null)
    write_file_replace "$view" SOUL.md < "$live/SOUL.md" || { fail "$profile: could not write SOUL.md"; return 1; }
    write_file_replace "$view" config.yaml < "$live/config.yaml" || { fail "$profile: could not write config.yaml"; return 1; }
    derive_dotenv "$live/.env" | write_file_replace "$view" .env || { fail "$profile: could not write .env"; return 1; }
    chmod 0500 -- "$view" 2>/dev/null
    if [ "$IS_ROOT" = 1 ]; then chown -R "$WORKER_UID:$WORKER_GID" -- "$view" 2>/dev/null || warn "$profile: could not set the owner to $WORKER_UID:$WORKER_GID"; fi
    ok "$profile: view written (SOUL.md $(size_of "$view/SOUL.md") bytes, config.yaml $(size_of "$view/config.yaml") bytes, .env limited to the DeepSeek settings)"
  }

  printf 'worker profile view: %s\n' "$mode"
  [ "$IS_ROOT" = 1 ] || info "not running as root: file owners are not changed (the workers run as $WORKER_UID:$WORKER_GID)"

  local p rc=0
  if [ "$mode" = sync ]; then
    section "validate the live profiles (nothing is written yet)"
    local all=1
    for p in "${PROFILES[@]}"; do
      if validate_live "$p"; then ok "$p: live files are present, regular and within the worker's limits"; else all=0; fi
    done
    if [ "$all" = 0 ]; then printf '\nRESULT: FAIL (nothing was written)\n'; return 1; fi
    if [ "$DRY" = 1 ]; then printf '\nSUMMARY ok=%s warn=%s fail=%s\nRESULT: PASS (dry run: nothing was written)\n' "$OKS" "$WARNS" "$FAILS"; return 0; fi
    section "build the worker view"
    [ -d "$VIEW" ] || { mkdir -p -- "$VIEW" && chmod 0755 -- "$VIEW"; } || { fail "could not create the view base directory"; printf '\nRESULT: FAIL\n'; return 1; }
    for p in "${PROFILES[@]}"; do sync_profile "$p" || rc=1; done
  fi

  section "verify the worker view against the live profiles"
  for p in "${PROFILES[@]}"; do
    if [ "$mode" = check ] && { [ ! -d "$LIVE/$p" ] || [ -L "$LIVE/$p" ]; }; then fail "$p: the live profile directory is missing"; continue; fi
    check_profile "$p" || rc=1
  done
  if [ "$CONTAINERS" = 1 ]; then section "running workers' mounts"; check_containers; fi

  printf '\nSUMMARY ok=%s warn=%s fail=%s\n' "$OKS" "$WARNS" "$FAILS"
  if [ "$FAILS" -gt 0 ] || [ "$rc" != 0 ]; then printf 'RESULT: FAIL\n'; return 1; fi
  printf 'RESULT: PASS\n'
  return 0
}

main "$@"
