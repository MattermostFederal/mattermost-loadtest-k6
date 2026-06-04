MM_URL    ?= http://localhost:8065
USERS_FILE ?= ./config/users.json

ENV = MM_URL=$(MM_URL) USERS_FILE=$(USERS_FILE)

.PHONY: help preflight smoke load load-readonly load-summary check-users chart-sync chart-lint chart-package

help:
	@echo "Targets:"
	@echo "  preflight       Verify ping, version, and that every user in USERS_FILE has teams + channels"
	@echo "  smoke           One VU for 30s; verifies creds + connectivity"
	@echo "  load            Realistic-user load (writes enabled). Override TARGET_VUS, STEADY_SEC, etc."
	@echo "  load-readonly   Same as 'load' but READ_ONLY=true (safe for prod-clone data)"
	@echo "  load-summary    Same as 'load', writes summary.json"
	@echo ""
	@echo "Required env: MM_URL (e.g. https://mm.example.com), USERS_FILE (default ./config/users.json; .csv or .json)"

check-users:
	@test -f $(USERS_FILE) || { echo "Missing $(USERS_FILE). Copy config/users.example.json or .csv and fill it in."; exit 1; }

preflight: check-users
	$(ENV) k6 run scripts/preflight.js

smoke: check-users
	$(ENV) k6 run scripts/smoke.js

load: check-users
	$(ENV) k6 run scripts/load.js

load-readonly: check-users
	$(ENV) READ_ONLY=true k6 run scripts/load.js

load-summary: check-users
	$(ENV) k6 run --summary-export=summary.json scripts/load.js

# --- Helm chart ---------------------------------------------------------------

chart-sync:  ## Refresh chart/files/scripts/ from the canonical scripts/
	rm -rf chart/files/scripts
	cp -r scripts chart/files/scripts

chart-lint: chart-sync
	helm lint chart

chart-package: chart-sync
	helm package chart -d dist/
