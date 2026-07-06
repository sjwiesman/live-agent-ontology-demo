# Build context is the repo root (see docker-compose.yml) so the shared
# ontology/ontology.yaml can be baked into the image.
FROM python:3.12-slim

WORKDIR /app

# Corporate-proxy friendly: if the build context provides extra CA
# certificates (*.crt at the repo root), trust them for package downloads.
COPY api/requirements.txt *.crt ./
RUN if [ -n "$(find . -maxdepth 1 -name '*.crt' -print -quit)" ]; then \
        cp ./*.crt /usr/local/share/ca-certificates/ && update-ca-certificates; \
    fi
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt

RUN pip install --no-cache-dir -r requirements.txt

COPY api/src/ ./src/
COPY ontology/ontology.yaml ./ontology.yaml

EXPOSE 8080

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
