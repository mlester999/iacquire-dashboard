#!/usr/bin/env bash
# Restores a backup made by ops/backup-profiles.sh into NEW, EMPTY volumes, then verifies every file against the backup's sha256 manifest.
#
#   ops/restore-profiles.sh --backup <path prefix, e.g. /backups/client-runtime-20261101T120000Z> \
#        --header-sha256 <the 64 hex digits backup-profiles.sh printed> \
#        (--age-identity <identity file> | --gpg) --target-project <new compose project name> [--image <image ref>]
#
# The header that lists the ciphertext hashes sits unsigned next to the backup, so anyone who can write to the backup folder and knows the public key could forge a whole backup and
# a matching header. --header-sha256 is the digest recorded when the backup was made, kept away from that folder: the header is checked against it before anything else is trusted.
#
# It never restores over live data: a target volume that does not exist yet is created (with the labels Compose expects); one that exists must be empty and attached to no container,
# otherwise the script stops before anything is written. Both volumes are checked before the first one is touched. Containers that read or write a volume run with
# `--network none --read-only`, no capabilities beyond the few tar needs to restore owners, and nothing else mounted. The archive is decrypted into a pipe, never onto a disk.
# Afterwards the files are hashed in a read-only container and compared with the decrypted manifest; any difference stops the script with a failure, and the restored volume must not
# be used. Then: start the runtime under the new project name, run `worker.py --verify-home`, run the portal health check, and only then enable anything.
# Nothing here starts a container that serves the data, edits a portal row or touches the Hermes home of another project.

main() {
  set +x
  set -eu -o pipefail
  umask 077
  export LC_ALL=C

  local prefix="" identity="" use_gpg=0 header_sha="" target="" image="${IACQUIRE_HERMES_IMAGE:-iacquire/hermes-client:acceptance}"
  usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" >&2; }
  die() { printf 'restore-profiles: %s\n' "$*" >&2; exit 1; }

  while [ $# -gt 0 ]; do
    case "$1" in
      --backup) [ $# -ge 2 ] || { usage; exit 2; }; prefix=$2; shift 2 ;;
      --age-identity) [ $# -ge 2 ] || { usage; exit 2; }; identity=$2; shift 2 ;;
      --gpg) use_gpg=1; shift ;;
      --header-sha256) [ $# -ge 2 ] || { usage; exit 2; }; header_sha=$2; shift 2 ;;
      --target-project) [ $# -ge 2 ] || { usage; exit 2; }; target=$2; shift 2 ;;
      --image) [ $# -ge 2 ] || { usage; exit 2; }; image=$2; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
  done
  [ -n "$prefix" ] && [ -n "$target" ] || { usage; exit 2; }
  if [ -z "$identity" ] && [ "$use_gpg" = 0 ]; then die "give --age-identity <file> or --gpg to decrypt the backup"; fi
  if [ -n "$identity" ] && [ "$use_gpg" = 1 ]; then die "give one of --age-identity and --gpg"; fi
  printf '%s' "$header_sha" | grep -Eq '^[0-9a-f]{64}$' || die "give --header-sha256 <the 64 hex digits recorded when the backup was made>; without it nothing proves who wrote the header"
  printf '%s' "$target" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || die "--target-project is not a valid Compose project name"
  command -v docker >/dev/null 2>&1 || die "docker is not installed"

  local header="$prefix.header.txt"
  [ -f "$header" ] || die "$header was not found; --backup takes the path prefix shared by the backup files"
  [ "$(sha256sum -- "$header" | cut -d' ' -f1)" = "$header_sha" ] || die "$header does not match --header-sha256; it is not the header recorded for this backup, so the backup is not trusted"
  grep -q '^format=iacquire-client-runtime-backup/1$' "$header" || die "$header is not a header this tool wrote"
  local kind ext source_project
  kind=$(sed -n 's/^encryption=//p' "$header" | head -n 1)
  case "$kind" in age) ext=age ;; gpg) ext=gpg ;; *) die "the header names an unknown encryption" ;; esac
  source_project=$(sed -n 's/^compose_project=//p' "$header" | head -n 1)
  if [ "$kind" = age ]; then
    [ -n "$identity" ] || die "the backup is age-encrypted: give --age-identity <file>"
    [ -f "$identity" ] && [ ! -L "$identity" ] || die "the age identity file was not found"
    command -v age >/dev/null 2>&1 || die "age is not installed"
  else
    [ "$use_gpg" = 1 ] || die "the backup is gpg-encrypted: give --gpg"
    command -v gpg >/dev/null 2>&1 || die "gpg is not installed"
  fi

  decrypt() { # decrypts the file named by $1 to stdout
    if [ "$kind" = age ]; then age -d -i "$identity" "$1"; else gpg --batch --decrypt -- "$1"; fi
  }

  # The ciphertext must be exactly what the backup wrote: compare sizes and hashes with the header (itself pinned by --header-sha256) before decrypting anything.
  local part suffix file want_sha want_bytes
  for part in profiles worker-state; do
    for suffix in "tar.$ext" "manifest.$ext"; do
      file="$prefix-$part.$suffix"
      [ -f "$file" ] || die "$(basename -- "$file") is missing"
      want_sha=$(sed -n "s/^file=$(basename -- "$file") sha256=\\([0-9a-f]*\\) bytes=.*/\\1/p" "$header" | head -n 1)
      want_bytes=$(sed -n "s/^file=$(basename -- "$file") sha256=[0-9a-f]* bytes=\\([0-9]*\\)\$/\\1/p" "$header" | head -n 1)
      [ -n "$want_sha" ] && [ -n "$want_bytes" ] || die "the header does not list $(basename -- "$file")"
      [ "$(sha256sum -- "$file" | cut -d' ' -f1)" = "$want_sha" ] || die "$(basename -- "$file") does not match the sha256 in the header; the backup is damaged or was changed"
      [ "$(wc -c <"$file" | tr -d ' ')" = "$want_bytes" ] || die "$(basename -- "$file") has a different size than the header says"
    done
  done

  local profiles_volume="${target}_client_profiles" state_volume="${target}_worker_home"

  # Every target is checked before any is written: it must be new, or exist, be attached to nothing and hold nothing.
  check_target() { # $1 volume
    local volume=$1 attached
    if docker volume inspect -f '{{.Name}}' "$volume" >/dev/null 2>&1; then
      attached=$(docker ps -a --filter "volume=$volume" --format '{{.Names}}' 2>/dev/null || true)
      if [ -n "$attached" ]; then die "the volume $volume is attached to a container; restore only into a new volume"; fi
      if ! docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true --user 0:0 \
        -v "$volume:/t:ro" --entrypoint /bin/sh "$image" -c 'test -z "$(ls -A /t)"' >/dev/null 2>&1; then
        die "the volume $volume is not empty, or could not be read; restore only into a new, empty volume"
      fi
    fi
  }
  check_target "$profiles_volume"
  check_target "$state_volume"

  ensure_target() { # $1 volume, $2 compose volume name
    if ! docker volume inspect -f '{{.Name}}' "$1" >/dev/null 2>&1; then
      docker volume create --label "com.docker.compose.project=$target" --label "com.docker.compose.volume=$2" "$1" >/dev/null
    fi
  }

  restore_part() { # $1 part, $2 volume, $3 compose volume name
    local name=$1 volume=$2
    ensure_target "$volume" "$3"
    decrypt "$prefix-$name.tar.$ext" | docker run --rm -i --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
      --security-opt no-new-privileges:true --user 0:0 -v "$volume:/dst" --entrypoint tar "$image" -xpf - --numeric-owner -C /dst
    local actual expected
    actual=$(docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true --user 0:0 \
      -v "$volume:/src:ro" --entrypoint /bin/sh "$image" -c 'cd /src && find . -type f -print0 | sort -z | xargs -0 -r sha256sum')
    expected=$(decrypt "$prefix-$name.manifest.$ext")
    if [ "$actual" != "$expected" ]; then
      die "verification FAILED for $volume: its files do not match the backup manifest. Do not use this volume; remove it and investigate."
    fi
    printf '  restored and verified %s (%s files)\n' "$volume" "$(printf '%s\n' "$actual" | grep -c . || true)"
  }

  printf 'Restoring backup %s (made from project %s) into new volumes of project %s:\n' "$(basename -- "$prefix")" "${source_project:-unknown}" "$target"
  restore_part profiles "$profiles_volume" client_profiles
  restore_part worker-state "$state_volume" worker_home
  printf 'Done. Next: start the runtime under the project name %s, run worker.py --verify-home and the portal health check, and only then enable the worker.\n' "$target"
}

main "$@"
