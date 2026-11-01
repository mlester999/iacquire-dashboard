#!/usr/bin/env bash
# Encrypted backup of the client-only runtime's profile data: the client_profiles volume (every client profile: SOUL, memory, sessions and the per-profile API key in its .env)
# and the worker_home volume (recovery journal, ownership markers, audit log). The default Hermes home (hermes_home) is not backed up: it holds no client data.
#
#   ops/backup-profiles.sh --out-dir <private dir> (--age-recipient <age1...> | --gpg-recipient <key id or email>) \
#        [--project iacquire-client-hermes] [--image iacquire/hermes-client:acceptance] [--allow-running]
#
# It ALWAYS encrypts and refuses to run without a recipient (the data contains live API keys and the model provider key). The plaintext archive never touches a disk: it streams from
# a read-only, network-less container straight into age or gpg. Each volume is mounted read-only into `docker run --rm --network none --read-only --cap-drop ALL`, as UID 10000.
# Output, next to each other in --out-dir (never overwritten, mode 0600):
#   client-runtime-<UTC stamp>-profiles.tar.age        or .gpg   the profiles volume, tar --numeric-owner
#   client-runtime-<UTC stamp>-profiles.manifest.age   or .gpg   sha256 of every file in it (restore compares this)
#   client-runtime-<UTC stamp>-worker-state.tar.age / .manifest.age    the same for worker_home
#   client-runtime-<UTC stamp>.header.txt                        project, image, ciphertext sha256 and sizes; holds no secret and no profile name
# The header is plain text, so on its own it only catches damage, not tampering by someone who can write to the backup folder. The script therefore prints the header's own sha256 at
# the end: write it down where whoever can write to the backup folder cannot reach it (the runbook, a password manager note, an audit entry). Restore refuses to run without it.
# The worker must be stopped first (a half-written profile has a journal that only the running worker repairs): `docker compose stop hermes-provisioner`; use --allow-running to
# accept a live copy anyway. Keep a copy off this host and keep the decryption key somewhere else: a backup next to its key protects nothing.
# Restore: ops/restore-profiles.sh, only into new empty volumes. Nothing here starts, stops or changes a container, a volume or the Hermes data.

main() {
  set +x
  set -eu -o pipefail
  umask 077
  export LC_ALL=C

  local out="" age_recipient="" gpg_recipient="" project="iacquire-client-hermes" image="${IACQUIRE_HERMES_IMAGE:-iacquire/hermes-client:acceptance}" allow_running=0
  usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2; }
  die() { printf 'backup-profiles: %s\n' "$*" >&2; exit 1; }

  while [ $# -gt 0 ]; do
    case "$1" in
      --out-dir) [ $# -ge 2 ] || { usage; exit 2; }; out=$2; shift 2 ;;
      --age-recipient) [ $# -ge 2 ] || { usage; exit 2; }; age_recipient=$2; shift 2 ;;
      --gpg-recipient) [ $# -ge 2 ] || { usage; exit 2; }; gpg_recipient=$2; shift 2 ;;
      --project) [ $# -ge 2 ] || { usage; exit 2; }; project=$2; shift 2 ;;
      --image) [ $# -ge 2 ] || { usage; exit 2; }; image=$2; shift 2 ;;
      --allow-running) allow_running=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
  done
  [ -n "$out" ] || { usage; exit 2; }

  # No recipient, no backup: there is deliberately no plaintext mode.
  if [ -z "$age_recipient" ] && [ -z "$gpg_recipient" ]; then die "an encryption recipient is required (--age-recipient or --gpg-recipient); this script never writes a plaintext backup"; fi
  if [ -n "$age_recipient" ] && [ -n "$gpg_recipient" ]; then die "give one recipient kind, not both"; fi
  local kind ext
  if [ -n "$age_recipient" ]; then
    kind=age; ext=age
    command -v age >/dev/null 2>&1 || die "age is not installed"
    printf '%s' "$age_recipient" | grep -Eq '^age1[a-z0-9]{20,}$' || die "--age-recipient must be an age public key (age1...)"
  else
    kind=gpg; ext=gpg
    command -v gpg >/dev/null 2>&1 || die "gpg is not installed"
    printf '%s' "$gpg_recipient" | grep -Eq '^[A-Za-z0-9@._+-]{3,128}$' || die "--gpg-recipient must be a key id, fingerprint or email address"
  fi
  printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || die "--project is not a valid Compose project name"
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  if [ -L "$out" ] || [ ! -d "$out" ]; then die "--out-dir must be an existing directory (not a symlink)"; fi

  encrypt() { # reads stdin, writes the encrypted file named by $1
    if [ "$kind" = age ]; then age -r "$age_recipient" -o "$1"; else gpg --batch --yes --trust-model always --encrypt --recipient "$gpg_recipient" --output "$1"; fi
  }

  local profiles_volume="${project}_client_profiles" state_volume="${project}_worker_home"
  docker volume inspect -f '{{.Name}}' "$profiles_volume" >/dev/null 2>&1 || die "the volume $profiles_volume does not exist on this host"
  docker volume inspect -f '{{.Name}}' "$state_volume" >/dev/null 2>&1 || die "the volume $state_volume does not exist on this host"

  if [ "$allow_running" = 0 ]; then
    local running
    running=$(docker inspect -f '{{.State.Running}}' "${project}-hermes-provisioner-1" 2>/dev/null || true)
    if [ "$running" = "true" ]; then die "the provisioner worker is running; stop it first (docker compose stop hermes-provisioner) or pass --allow-running to accept a live copy"; fi
  fi

  local stamp prefix part
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  prefix="$out/client-runtime-$stamp"
  # A failed run leaves no half-written encrypted file that could be mistaken for a backup.
  BACKUP_PREFIX=$prefix
  trap 'rm -f -- "$BACKUP_PREFIX"-*.partial' EXIT
  for part in profiles worker-state; do
    for suffix in "tar.$ext" "manifest.$ext"; do
      if [ -e "$prefix-$part.$suffix" ]; then die "$prefix-$part.$suffix already exists; a backup is never overwritten"; fi
    done
  done
  if [ -e "$prefix.header.txt" ]; then die "$prefix.header.txt already exists; a backup is never overwritten"; fi

  # The one container shape every read uses: no network, read-only root filesystem, no capabilities, the volume read-only, and the unprivileged owner of the data.
  reader() { # $1 volume, then the command and its arguments
    local volume=$1; shift
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10000:10000 \
      -v "$volume:/src:ro" --entrypoint "$1" "$image" "${@:2}"
  }

  local files=()
  backup_part() { # $1 part name, $2 volume
    local name=$1 volume=$2 archive manifest
    archive="$prefix-$name.tar.$ext"
    manifest="$prefix-$name.manifest.$ext"
    reader "$volume" tar --numeric-owner -C /src -cf - . | encrypt "$archive.partial"
    reader "$volume" /bin/sh -c 'cd /src && find . -type f -print0 | sort -z | xargs -0 -r sha256sum' | encrypt "$manifest.partial"
    mv -n -- "$archive.partial" "$archive"
    mv -n -- "$manifest.partial" "$manifest"
    [ -s "$archive" ] && [ -s "$manifest" ] || die "the encrypted files for $name are empty"
    files+=("$archive" "$manifest")
  }
  printf 'Backing up %s and %s read-only, encrypted with %s:\n' "$profiles_volume" "$state_volume" "$kind"
  backup_part profiles "$profiles_volume"
  backup_part worker-state "$state_volume"

  local image_id file
  image_id=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || printf 'unknown')
  {
    printf 'format=iacquire-client-runtime-backup/1\n'
    printf 'created_utc=%s\n' "$stamp"
    printf 'compose_project=%s\n' "$project"
    printf 'image_ref=%s\n' "$image"
    printf 'image_id=%s\n' "$image_id"
    printf 'encryption=%s\n' "$kind"
    for file in "${files[@]}"; do
      printf 'file=%s sha256=%s bytes=%s\n' "$(basename -- "$file")" "$(sha256sum -- "$file" | cut -d' ' -f1)" "$(wc -c <"$file" | tr -d ' ')"
    done
  } >"$prefix.header.txt"

  for file in "${files[@]}" "$prefix.header.txt"; do
    printf '  wrote %s  sha256:%s\n' "$file" "$(sha256sum -- "$file" | cut -c1-8)"
  done
  printf 'Header sha256 (record it away from the backup folder; ops/restore-profiles.sh needs it as --header-sha256): %s\n' "$(sha256sum -- "$prefix.header.txt" | cut -d' ' -f1)"
  printf 'Done. Copy these files off this host, keep the private %s key elsewhere, and test a restore into new empty volumes (ops/restore-profiles.sh) before relying on them.\n' "$kind"
}

main "$@"
