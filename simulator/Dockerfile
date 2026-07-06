FROM python:3.12-slim

WORKDIR /app

# Corporate-proxy friendly: if the build context provides extra CA
# certificates (*.crt), trust them for package downloads.
COPY requirements.txt *.crt ./
RUN if [ -n "$(find . -maxdepth 1 -name '*.crt' -print -quit)" ]; then \
        cp ./*.crt /usr/local/share/ca-certificates/ && update-ca-certificates; \
    fi
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt

RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

EXPOSE 8085

CMD ["python", "-m", "src.main"]
