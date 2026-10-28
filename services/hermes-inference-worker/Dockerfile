ARG HERMES_BASE_IMAGE=docker.io/nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d
FROM ${HERMES_BASE_IMAGE}

ARG HERMES_BASE_IMAGE
ARG HERMES_SOURCE_COMMIT=bf0203a794a07aac3ff764972ab9087baa4e4f4e
RUN /opt/hermes/.venv/bin/python -c 'import sys; expected="docker.io/nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d"; sys.exit(0 if sys.argv[1] == expected else "Unexpected Hermes base image pin")' "${HERMES_BASE_IMAGE}" && \
    /opt/hermes/.venv/bin/python -c 'import sys; sys.exit(0 if sys.argv[1] == "bf0203a794a07aac3ff764972ab9087baa4e4f4e" else "Unexpected Hermes source commit")' "${HERMES_SOURCE_COMMIT}"
RUN /opt/hermes/.venv/bin/python -c 'import re,subprocess,sys; h=subprocess.run(["/opt/hermes/bin/hermes","--version"],check=True,capture_output=True,text=True); hv=h.stdout+h.stderr; n=subprocess.run(["/usr/local/bin/node","--version"],check=True,capture_output=True,text=True).stdout.strip(); ok=re.search(r"(?<![0-9.])v?0\.22\.5(?![0-9.])",hv) and n=="v26.12.1"; sys.exit(0 if ok else f"Expected Hermes v0.22.5 / Node v26.12.1, got Hermes {hv.strip()} / Node {n}")'
COPY --chown=0:0 services/hermes-inference-worker/worker.py /opt/iacquire-hermes/inference/worker.py
COPY --chown=0:0 services/hermes-inference-worker/inference_runner.py /opt/iacquire-hermes/inference/inference_runner.py
COPY --chown=0:0 services/hermes-inference-worker/deepseek_egress_proxy.py /opt/iacquire-hermes/inference/deepseek_egress_proxy.py
COPY --chown=0:0 services/hermes-inference-worker/pinned_runtime_smoke.py /opt/iacquire-hermes/inference/pinned_runtime_smoke.py
COPY --chown=0:0 services/hermes-inference-worker/test_worker.py /opt/iacquire-hermes/inference/test_worker.py
COPY --chown=0:0 services/hermes-inference-worker/Dockerfile /opt/iacquire-hermes/inference/Dockerfile
RUN chmod 0444 /opt/iacquire-hermes/inference/*.py && \
    /opt/hermes/.venv/bin/python -m py_compile \
      /opt/iacquire-hermes/inference/worker.py \
      /opt/iacquire-hermes/inference/inference_runner.py \
      /opt/iacquire-hermes/inference/deepseek_egress_proxy.py \
      /opt/iacquire-hermes/inference/pinned_runtime_smoke.py && \
    /opt/hermes/.venv/bin/python -c 'import sys; sys.path.insert(0,"/opt/hermes"); from run_agent import AIAgent; import model_tools; assert callable(AIAgent); assert model_tools.get_tool_definitions(enabled_toolsets=[]) == []'

ENV PYTHONNOUSERSITE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/hermes
USER 10000:10000
LABEL org.opencontainers.image.version="0.22.5-iacquire-inference.v1"
LABEL com.iacquire.hermes.base-source="${HERMES_SOURCE_COMMIT}"
ENTRYPOINT ["/opt/hermes/.venv/bin/python"]
CMD ["/opt/iacquire-hermes/inference/worker.py", "--serve"]
