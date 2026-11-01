#!/usr/bin/env bash
# Creates the private files the client-only Hermes runtime mounts, with the exact owner and mode the worker and the gateway demand (DEPLOYMENT.md, "Private files").
#
#   sudo ops/make-secrets.sh --dir /srv/iacquire-client-hermes/secrets \
#        [--config-example <file>] [--only config,api-key,provisioner-token,model-env,tunnel-token] \
#        [--model-env-name OPENAI_API_KEY --model-key-stdin]   (the model provider key is read from stdin: it cannot be generated)
#        [--tunnel-token-stdin]                                 (the Cloudflare tunnel token is read from stdin; only for compose.tunnel.yaml)
#
# File                      Owner:group     Mode  Content
#   config.yaml             0:10000         0440  copy of client-config.yaml.example (secret-free; edit the model line afterwards and re-run the preflight)
#   hermes-api-key          0:10000         0440  64 random lowercase hex characters (the default profile's read-only inventory probe)
#   provisioner-token       10000:10000     0400  64 random hex characters; set the SAME value as HERMES_PROVISIONER_TOKEN in the portal (read it from the file, never from here)
#   profile-model-env.json  10000:10000     0400  {"schemaVersion":1,"environment":<name>,"value":<key from stdin>}
#   tunnel-token            65532:65532     0400  the tunnel token from stdin (optional)
#
# It refuses to overwrite: if any file it was asked to create already exists, it stops before writing anything. It prints only paths, owner, mode and the first 8 hex characters of each
# file's sha256, never a secret. Only one --*-stdin option can be used in a run (there is one stdin); use --only for the rest. Needs root (it assigns other owners).
# Run it with no shell tracing; it turns tracing off itself. It never touches Docker.

main() {
  set +x
  set -eu
  umask 077
  export LC_ALL=C

  local dir="" example="" only="" model_name="" model_stdin=0 tunnel_stdin=0
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  example="$script_dir/../client-config.yaml.example"

  usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2; }
  die() { printf 'make-secrets: %s\n' "$*" >&2; exit 1; }

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || { usage; exit 2; }; dir=$2; shift 2 ;;
      --config-example) [ $# -ge 2 ] || { usage; exit 2; }; example=$2; shift 2 ;;
      --only) [ $# -ge 2 ] || { usage; exit 2; }; only=$2; shift 2 ;;
      --model-env-name) [ $# -ge 2 ] || { usage; exit 2; }; model_name=$2; shift 2 ;;
      --model-key-stdin) model_stdin=1; shift ;;
      --tunnel-token-stdin) tunnel_stdin=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
  done
  [ -n "$dir" ] || { usage; exit 2; }
  if [ "$model_stdin" = 1 ] && [ "$tunnel_stdin" = 1 ]; then
    die "only one of --model-key-stdin and --tunnel-token-stdin can be used in one run (there is one stdin); run again with --only for the other"
  fi
  if [ "$model_stdin" = 1 ] && [ -z "$model_name" ]; then die "--model-key-stdin needs --model-env-name"; fi
  if [ "$model_stdin" = 0 ] && [ -n "$model_name" ]; then die "--model-env-name needs --model-key-stdin"; fi

  # The explicit allowlist the worker applies to the profile model key (worker.py MODEL_API_KEY_ENV_NAMES); tests keep the two lists equal.
  local allowed_names=" AI_GATEWAY_API_KEY ANTHROPIC_API_KEY DEEPINFRA_API_KEY DEEPSEEK_API_KEY FIREWORKS_API_KEY GEMINI_API_KEY GLM_API_KEY GOOGLE_API_KEY MISTRAL_API_KEY NEBIUS_API_KEY NVIDIA_API_KEY NOVITA_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY OPENCODE_GO_API_KEY OPENCODE_ZEN_API_KEY RAMP_ROUTER_API_KEY STEPFUN_API_KEY XAI_API_KEY ZAI_API_KEY "
  if [ -n "$model_name" ]; then
    case "$allowed_names" in *" $model_name "*) ;; *) die "--model-env-name is not one of the model-provider key names the worker accepts" ;; esac
  fi

  # What to create: the default is everything that can be generated or copied, plus whatever secret arrives on stdin.
  local want=""
  if [ -n "$only" ]; then
    local item
    for item in $(printf '%s' "$only" | tr ',' ' '); do
      case "$item" in
        config|api-key|provisioner-token|model-env|tunnel-token) want="$want $item" ;;
        *) die "--only knows config, api-key, provisioner-token, model-env and tunnel-token" ;;
      esac
    done
  else
    want=" config api-key provisioner-token"
    [ "$model_stdin" = 1 ] && want="$want model-env"
    [ "$tunnel_stdin" = 1 ] && want="$want tunnel-token"
  fi
  case "$want" in *" model-env"*) [ "$model_stdin" = 1 ] || die "model-env needs --model-env-name and --model-key-stdin" ;; esac
  case "$want" in *" tunnel-token"*) [ "$tunnel_stdin" = 1 ] || die "tunnel-token needs --tunnel-token-stdin" ;; esac
  [ -n "${want# }" ] || die "nothing to create"

  if [ "$(id -u)" != "0" ]; then die "run as root: the files are handed to other owners (UID 10000, root:10000, UID 65532)"; fi

  file_name() {
    case "$1" in
      config) echo "config.yaml" ;; api-key) echo "hermes-api-key" ;; provisioner-token) echo "provisioner-token" ;;
      model-env) echo "profile-model-env.json" ;; tunnel-token) echo "tunnel-token" ;;
    esac
  }
  file_owner() {
    case "$1" in
      config|api-key) echo "0:10000:440" ;;
      provisioner-token|model-env) echo "10000:10000:400" ;;
      tunnel-token) echo "65532:65532:400" ;;
    esac
  }

  # Refuse before anything is written: an existing file, a link, or a directory that is not private.
  if [ -L "$dir" ]; then die "$dir is a symlink"; fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then die "$dir exists and is not a directory"; fi
  local item target
  for item in $want; do
    target="$dir/$(file_name "$item")"
    if [ -e "$target" ] || [ -L "$target" ]; then die "$target already exists; it is never overwritten (move it away deliberately, or use --only for the files that are still missing)"; fi
  done
  if [ "$want" != "${want#* config}" ]; then
    [ -f "$example" ] && [ ! -L "$example" ] || die "the config example $example was not found (use --config-example)"
  fi
  mkdir -p -m 0700 -- "$dir"
  local dir_mode
  dir_mode=$(stat -c '%a' -- "$dir")
  case "$dir_mode" in
    700|750|500|550) ;;
    *) die "$dir has mode $dir_mode; use a directory that is private to root (0700 or 0750)" ;;
  esac

  # The secrets that come from outside are read now, validated, and kept only in shell variables.
  local model_value="" tunnel_value=""
  if [ "$model_stdin" = 1 ]; then
    model_value=$(cat)
    model_value=${model_value%$'\n'}; model_value=${model_value%$'\r'}
    printf '%s' "$model_value" | grep -Eq '^[A-Za-z0-9._~+/=:@-]{8,4096}$' || die "the model key read from stdin is empty or has characters the worker refuses"
  fi
  if [ "$tunnel_stdin" = 1 ]; then
    tunnel_value=$(cat)
    tunnel_value=${tunnel_value%$'\n'}; tunnel_value=${tunnel_value%$'\r'}
    printf '%s' "$tunnel_value" | grep -Eq '^[A-Za-z0-9._~+/=:@-]{32,4096}$' || die "the tunnel token read from stdin is empty or malformed"
  fi

  random_hex() { head -c 32 /dev/urandom | od -An -vtx1 | tr -d ' \n'; }

  create_one() {
    local name=$1 final tmp meta expect owner mode
    final="$dir/$(file_name "$name")"
    expect=$(file_owner "$name")
    tmp=$(mktemp "$dir/.new.XXXXXX")
    case "$name" in
      config) cat -- "$example" >"$tmp" ;;
      api-key|provisioner-token) printf '%s' "$(random_hex)" >"$tmp" ;;
      model-env) printf '{"schemaVersion":1,"environment":"%s","value":"%s"}' "$model_name" "$model_value" >"$tmp" ;;
      tunnel-token) printf '%s' "$tunnel_value" >"$tmp" ;;
    esac
    owner=${expect%:*}
    mode=${expect##*:}
    chown "${owner%%:*}:${owner##*:}" "$tmp"
    chmod "0$mode" "$tmp"
    meta=$(stat -c '%u:%g:%a' -- "$tmp")
    if [ "$meta" != "$expect" ]; then rm -f -- "$tmp"; die "could not set owner and mode on $final (wanted $expect, got $meta); nothing was left behind"; fi
    # mv -n never replaces: if something appeared under the final name in the meantime the temporary file stays and we stop.
    mv -n -- "$tmp" "$final"
    if [ -e "$tmp" ]; then rm -f -- "$tmp"; die "$final appeared while it was being created; it was not replaced"; fi
    printf '  created %s  owner=%s:%s mode=0%s  sha256:%s\n' "$final" "${owner%%:*}" "${owner##*:}" "$mode" "$(sha256sum -- "$final" | cut -c1-8)"
  }

  printf 'Creating private files under %s (values are never printed):\n' "$dir"
  for item in $want; do create_one "$item"; done
  case "$want" in
    *" config"*) printf '  note: config.yaml still holds the placeholder model id; edit the model line, then confirm owner 0:10000 and mode 0440 are unchanged (the preflight checks both).\n' ;;
  esac
  case "$want" in
    *" provisioner-token"*) printf '  note: set the same value as HERMES_PROVISIONER_TOKEN in the portal by reading the file on this host; do not paste it into a chat or a ticket.\n' ;;
  esac
  case "$want" in
    *" model-env"*) : ;;
    *) [ -n "$only" ] || printf '  pending: profile-model-env.json was not created (it needs the model provider key: --model-env-name NAME --model-key-stdin). The preflight fails until it exists.\n' ;;
  esac
}

main "$@"
