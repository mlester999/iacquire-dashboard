ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE} AS hermes-client

ARG HERMES_BASE_IMAGE
RUN /opt/hermes/.venv/bin/python -c 'import re,sys; sys.exit(0 if re.fullmatch(r"(?:docker\.io/)?nousresearch/hermes-agent@sha256:[0-9a-f]{64}", sys.argv[1]) else 1)' "$HERMES_BASE_IMAGE"
RUN /opt/hermes/.venv/bin/python -c 'import yaml'

USER root
COPY --chown=0:0 hermes-client-entrypoint.sh /opt/iacquire-hermes/hermes-client-entrypoint.sh
RUN chmod 0555 /opt/iacquire-hermes/hermes-client-entrypoint.sh
ENTRYPOINT ["/opt/iacquire-hermes/hermes-client-entrypoint.sh"]
CMD ["gateway", "run"]

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
