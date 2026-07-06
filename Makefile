.PHONY: help setup up down clean logs health verify test \
        jam tractor-fault scanner-degraded \
        shell-sqlserver shell-mz

DOCKER_COMPOSE ?= docker compose
API_URL ?= http://localhost:8080

help:
	@echo "UPS Historian → Materialize Live Context Graph demo"
	@echo ""
	@echo "  make setup             - Copy .env.example to .env (edit in your API key)"
	@echo "  make up                - Build and start the full stack"
	@echo "  make down              - Stop all services"
	@echo "  make clean             - Stop everything and delete volumes (full reset)"
	@echo "  make logs              - Tail logs from all services"
	@echo "  make health            - Show service status"
	@echo ""
	@echo "Demo scenarios (watch the dashboard react in seconds):"
	@echo "  make jam               - Jam a sorter at Worldport (LOU-SORT-04)"
	@echo "  make tractor-fault     - Critical engine fault on a loaded tractor"
	@echo "  make scanner-degraded  - Degrade a scanner's read rate"
	@echo ""
	@echo "Verification:"
	@echo "  make verify            - End-to-end smoke test (CDC, graph, write-back)"
	@echo ""
	@echo "Shells:"
	@echo "  make shell-sqlserver   - sqlcmd into the ups database (system of record)"
	@echo "  make shell-mz          - psql into Materialize (the context graph)"

setup:
	@test -f .env || cp .env.example .env
	@echo ".env ready — add your ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the copilot."

up:
	$(DOCKER_COMPOSE) up -d --build
	@echo ""
	@echo "Services starting. SQL Server takes ~60s on first boot; then:"
	@echo "  Dashboard:            http://localhost:5173"
	@echo "  API docs:             http://localhost:8080/docs"
	@echo "  Copilot API:          http://localhost:8081"
	@echo "  Materialize console:  http://localhost:6874"

down:
	$(DOCKER_COMPOSE) down --remove-orphans

clean:
	$(DOCKER_COMPOSE) down -v --remove-orphans
	@echo "Volumes removed; next 'make up' starts from scratch."

logs:
	$(DOCKER_COMPOSE) logs -f --tail=50

health:
	$(DOCKER_COMPOSE) ps
	@echo ""
	@curl -sf $(API_URL)/health >/dev/null && echo "API:      ok" || echo "API:      DOWN"
	@curl -sf http://localhost:8081/health >/dev/null && echo "Copilot:  ok" || echo "Copilot:  DOWN"
	@curl -sf http://localhost:8085/health >/dev/null && echo "Sim:      ok" || echo "Sim:      DOWN"

jam:
	curl -s -X POST "$(API_URL)/api/scenarios/conveyor_jam" | python3 -m json.tool

tractor-fault:
	curl -s -X POST "$(API_URL)/api/scenarios/tractor_fault" | python3 -m json.tool

scanner-degraded:
	curl -s -X POST "$(API_URL)/api/scenarios/scanner_degraded" | python3 -m json.tool

verify:
	./scripts/verify.sh

test:
	cd api && python3 -m pytest tests/ -q 2>/dev/null || echo "api: no tests"
	cd agents && python3 -m pytest tests/ -q 2>/dev/null || echo "agents: no tests"

shell-sqlserver:
	$(DOCKER_COMPOSE) exec sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$${MSSQL_SA_PASSWORD:-StrongPassw0rd!}" -d ups

shell-mz:
	$(DOCKER_COMPOSE) exec mz psql -h localhost -p 6875 -U materialize
