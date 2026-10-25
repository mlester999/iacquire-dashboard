ARG HERMES_BASE_IMAGE=docker.io/nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d
FROM ${HERMES_BASE_IMAGE} AS hermes-client

ARG HERMES_BASE_IMAGE
RUN /opt/hermes/.venv/bin/python -c 'import re,sys; sys.exit(0 if re.fullmatch(r"(?:docker\.io/)?nousresearch/hermes-agent@sha256:[0-9a-f]{64}", sys.argv[1]) else 1)' "$HERMES_BASE_IMAGE"
ARG HERMES_SOURCE_COMMIT=bf0203a794a07aac3ff764972ab9087baa4e4f4e
ARG HERMES_CATALOG_REVISION=v0225-catalog-v1
RUN /opt/hermes/.venv/bin/python -c 'import re,subprocess,sys; h=subprocess.run(["/opt/hermes/bin/hermes","--version"],check=True,capture_output=True,text=True); hv=h.stdout+h.stderr; n=subprocess.run(["/usr/local/bin/node","--version"],check=True,capture_output=True,text=True).stdout.strip(); ok=re.search(r"(?<![0-9.])v?0\.22\.5(?![0-9.])",hv) and n=="v26.12.1"; sys.exit(0 if ok else f"Expected Hermes v0.22.5 with Node v26.12.1, got Hermes {hv.strip()} and Node {n}")'
USER root
COPY --chown=0:0 services/hermes-provisioner/catalog-overlay-v0225/ /opt/iacquire-hermes/catalog-overlay/
RUN /opt/hermes/.venv/bin/python /opt/iacquire-hermes/catalog-overlay/verify_overlay.py /opt/hermes /opt/iacquire-hermes/catalog-overlay
RUN test -x /opt/hermes/bin/hermes && test -x /opt/hermes/docker/entrypoint-dispatch.sh
RUN set -eu; \
    cp /opt/iacquire-hermes/catalog-overlay/model_tools.py /opt/hermes/model_tools.py; \
    cp /opt/iacquire-hermes/catalog-overlay/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server.py; \
    cp /opt/iacquire-hermes/catalog-overlay/gateway/platforms/api_server_tool_catalog.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py; \
    chmod a+rX,go-w /opt/hermes/model_tools.py /opt/hermes/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py; \
    /opt/hermes/.venv/bin/python -m compileall -q /opt/hermes/model_tools.py /opt/hermes/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py; \
    /opt/hermes/.venv/bin/python -c 'import inspect,sys; sys.path.insert(0,"/opt/hermes"); from gateway.platforms.api_server import APIServerAdapter; from gateway.platforms.api_server_tool_catalog import build_model_tool_catalog; from model_tools import get_tool_definitions; assert hasattr(APIServerAdapter,"_handle_tools"); assert callable(build_model_tool_catalog); assert "update_last_resolved" in inspect.signature(get_tool_definitions).parameters'
COPY --chown=0:0 services/hermes-provisioner/hermes-client-entrypoint.sh /opt/iacquire-hermes/hermes-client-entrypoint.sh
RUN chmod 0555 /opt/iacquire-hermes/hermes-client-entrypoint.sh
ENTRYPOINT ["/opt/iacquire-hermes/hermes-client-entrypoint.sh"]
CMD ["gateway", "run"]
LABEL org.opencontainers.image.version="0.22.5-iacquire-catalog.v0225-catalog-v1"
LABEL com.iacquire.hermes.base-source="${HERMES_SOURCE_COMMIT}"
LABEL com.iacquire.hermes.catalog-revision="${HERMES_CATALOG_REVISION}"

FROM hermes-client AS provisioner
USER root
COPY --chown=0:0 services/hermes-provisioner/requirements.txt /opt/iacquire-hermes/requirements.txt
RUN python3 -c 'import subprocess; from pm import uv_launcher; uv=uv_launcher("uv"); assert uv is not None; subprocess.run([str(uv), "venv", "--python", "/opt/hermes/.venv/bin/python", "/opt/iacquire-hermes/.venv"], check=True); subprocess.run([str(uv), "pip", "install", "--no-cache", "--python", "/opt/iacquire-hermes/.venv/bin/python", "--requirement", "/opt/iacquire-hermes/requirements.txt"], check=True)'
RUN /opt/iacquire-hermes/.venv/bin/python -c 'import yaml'
COPY --chown=0:0 services/hermes-provisioner/worker.py /opt/iacquire-hermes/worker.py
RUN chmod 0444 /opt/iacquire-hermes/worker.py
ENV HERMES_HOME=/opt/data \
    HERMES_CLI=/opt/hermes/bin/hermes \
    HERMES_PROVISIONER_API_BASE=http://127.0.0.1:8642
USER 10000:10000
ENTRYPOINT ["/opt/iacquire-hermes/.venv/bin/python", "/opt/iacquire-hermes/worker.py"]
CMD ["--run"]
