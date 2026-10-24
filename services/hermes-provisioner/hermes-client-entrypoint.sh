#!/bin/sh
set -eu

secret_file=/run/secrets/hermes_api_key
if [ ! -f "$secret_file" ] || [ -L "$secret_file" ]; then
  echo "Hermes client runtime stopped: api_key_secret_unavailable" >&2
  exit 1
fi
api_key=$(cat "$secret_file")
case "$api_key" in
  *[!0-9a-f]*|'')
    echo "Hermes client runtime stopped: api_key_secret_invalid" >&2
    exit 1
    ;;
esac
if [ "${#api_key}" -ne 64 ]; then
  echo "Hermes client runtime stopped: api_key_secret_invalid" >&2
  exit 1
fi

export API_SERVER_ENABLED=true
export API_SERVER_HOST=0.0.0.0
export API_SERVER_PORT=8642
export API_SERVER_KEY="$api_key"
unset api_key
exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"
