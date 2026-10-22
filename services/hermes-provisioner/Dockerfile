ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE} AS hermes-client

ARG HERMES_BASE_IMAGE
RUN /opt/hermes/.venv/bin/python -c 'import re,sys; sys.exit(0 if re.fullmatch(r"(?:docker\.io/)?nousresearch/hermes-agent@sha256:[0-9a-f]{64}", sys.argv[1]) else 1)' "$HERMES_BASE_IMAGE"
ARG HERMES_SOURCE_COMMIT=f97608f178d1ffeca59860195ab7da295f7c8e5f
ARG HERMES_CATALOG_REVISION=f6a6230
RUN /opt/hermes/.venv/bin/python -c 'import pathlib,sys,tomllib; version=tomllib.loads(pathlib.Path("/opt/hermes/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]; sys.exit(0 if version == "0.21.5" else f"Expected Hermes 0.21.5 for the reviewed catalog backport, got {version}")'
RUN /opt/hermes/.venv/bin/python -c 'import yaml'

USER root
COPY --chown=0:0 services/hermes-provisioner/catalog-overlay/ /opt/iacquire-hermes/catalog-overlay/
RUN /opt/hermes/.venv/bin/python -c 'import hashlib,pathlib,sys; root=pathlib.Path("/opt/iacquire-hermes/catalog-overlay"); bad=[]; [(bad.append(str(name)) if hashlib.sha256((root/name).read_bytes()).hexdigest() != expected else None) for expected,name in (line.split(None,1) for line in (root/"SHA256SUMS").read_text(encoding="utf-8").splitlines() if line.strip())]; sys.exit(f"Catalog overlay checksum mismatch: {bad}" if bad else 0)'
RUN test -x /opt/hermes/bin/hermes && test -x /opt/hermes/docker/entrypoint-dispatch.sh
RUN set -eu; \
    cp /opt/iacquire-hermes/catalog-overlay/model_tools.py /opt/hermes/model_tools.py; \
    cp /opt/iacquire-hermes/catalog-overlay/agent/memory_provider.py /opt/hermes/agent/memory_provider.py; \
    cp /opt/iacquire-hermes/catalog-overlay/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server.py; \
    cp /opt/iacquire-hermes/catalog-overlay/gateway/platforms/api_server_tool_catalog.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py; \
    cp /opt/iacquire-hermes/catalog-overlay/plugins/memory/honcho/__init__.py /opt/hermes/plugins/memory/honcho/__init__.py; \
    cp /opt/iacquire-hermes/catalog-overlay/plugins/memory/supermemory/__init__.py /opt/hermes/plugins/memory/supermemory/__init__.py; \
    cp /opt/iacquire-hermes/catalog-overlay/tools/mcp_tool.py /opt/hermes/tools/mcp_tool.py; \
    cp /opt/iacquire-hermes/catalog-overlay/tools/mcp_tool_registration.py /opt/hermes/tools/mcp_tool_registration.py; \
    chmod a+rX,go-w /opt/hermes/model_tools.py /opt/hermes/agent/memory_provider.py /opt/hermes/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py /opt/hermes/plugins/memory/honcho/__init__.py /opt/hermes/plugins/memory/supermemory/__init__.py /opt/hermes/tools/mcp_tool.py /opt/hermes/tools/mcp_tool_registration.py; \
    /opt/hermes/.venv/bin/python -m compileall -q /opt/hermes/model_tools.py /opt/hermes/agent/memory_provider.py /opt/hermes/gateway/platforms/api_server.py /opt/hermes/gateway/platforms/api_server_tool_catalog.py /opt/hermes/plugins/memory/honcho/__init__.py /opt/hermes/plugins/memory/supermemory/__init__.py /opt/hermes/tools/mcp_tool.py /opt/hermes/tools/mcp_tool_registration.py; \
    /opt/hermes/.venv/bin/python -c 'import inspect,sys; sys.path.insert(0,"/opt/hermes"); from gateway.platforms.api_server import APIServerAdapter; from gateway.platforms.api_server_tool_catalog import build_model_tool_catalog; from model_tools import get_tool_definitions; assert hasattr(APIServerAdapter,"_handle_tools"); assert callable(build_model_tool_catalog); assert "update_last_resolved" in inspect.signature(get_tool_definitions).parameters'
COPY --chown=0:0 hermes-client-entrypoint.sh /opt/iacquire-hermes/hermes-client-entrypoint.sh
RUN chmod 0555 /opt/iacquire-hermes/hermes-client-entrypoint.sh
ENTRYPOINT ["/opt/iacquire-hermes/hermes-client-entrypoint.sh"]
CMD ["gateway", "run"]
LABEL org.opencontainers.image.version="0.21.5-iacquire-catalog.f6a6230"
LABEL com.iacquire.hermes.base-source="${HERMES_SOURCE_COMMIT}"
LABEL com.iacquire.hermes.catalog-revision="${HERMES_CATALOG_REVISION}"

FROM hermes-client AS provisioner
USER root
COPY --chown=0:0 worker.py /opt/iacquire-hermes/worker.py
RUN chmod 0444 /opt/iacquire-hermes/worker.py
ENV HERMES_HOME=/opt/data \
    HERMES_CLI=/opt/hermes/bin/hermes \
    HERMES_PROVISIONER_API_BASE=http://127.0.0.1:8642
USER 10000:10000
ENTRYPOINT ["/opt/hermes/.venv/bin/python", "/opt/iacquire-hermes/worker.py"]
CMD ["--run"]
