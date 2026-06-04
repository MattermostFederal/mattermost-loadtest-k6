MM_URL    ?= http://localhost:8065
USERS_FILE ?= ./config/users.json

# Air-gap bundle parameters
K6_VERSION ?= 0.51.0
K6_ARCH    ?= linux-amd64
BUNDLE_STAGE = dist/airgap
BUNDLE_NAME  = mattermost-loadtest-k6-airgap-v$(K6_VERSION)-$(K6_ARCH).tar.gz

ENV = MM_URL=$(MM_URL) USERS_FILE=$(USERS_FILE)

.PHONY: help preflight smoke load load-readonly load-summary check-users \
        chart-sync chart-lint chart-package \
        airgap-bundle airgap-clean

help:
	@echo "Local test targets:"
	@echo "  preflight       Verify ping, version, and that every user in USERS_FILE has teams + channels"
	@echo "  smoke           One VU for 30s; verifies creds + connectivity"
	@echo "  load            Realistic-user load (writes enabled). Override TARGET_VUS, STEADY_SEC, etc."
	@echo "  load-readonly   Same as 'load' but READ_ONLY=true"
	@echo "  load-summary    Same as 'load', writes summary.json"
	@echo ""
	@echo "Helm chart:"
	@echo "  chart-sync      Refresh chart/files/scripts/ from scripts/"
	@echo "  chart-lint      helm lint"
	@echo "  chart-package   helm package -> dist/"
	@echo ""
	@echo "Air-gap bundle:"
	@echo "  airgap-bundle   Build a single tar.gz with the k6 binary + scripts + chart"
	@echo "                  Pinned by K6_VERSION (default $(K6_VERSION)), K6_ARCH (default $(K6_ARCH))"
	@echo "  airgap-clean    Remove dist/airgap and dist/$(BUNDLE_NAME)"
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

# --- Air-gap bundle -----------------------------------------------------------

airgap-clean:
	rm -rf $(BUNDLE_STAGE) dist/$(BUNDLE_NAME)

airgap-bundle: chart-sync airgap-clean
	@mkdir -p $(BUNDLE_STAGE)
	@echo ""
	@echo "==> [1/4] Downloading pinned k6 v$(K6_VERSION) ($(K6_ARCH))"
	@curl -fSL --progress-bar -o $(BUNDLE_STAGE)/k6.tar.gz \
	  "https://github.com/grafana/k6/releases/download/v$(K6_VERSION)/k6-v$(K6_VERSION)-$(K6_ARCH).tar.gz"
	@tar -xzf $(BUNDLE_STAGE)/k6.tar.gz -C $(BUNDLE_STAGE)
	@rm $(BUNDLE_STAGE)/k6.tar.gz
	@mv $(BUNDLE_STAGE)/k6-v$(K6_VERSION)-$(K6_ARCH)/k6 $(BUNDLE_STAGE)/k6
	@rm -rf $(BUNDLE_STAGE)/k6-v$(K6_VERSION)-$(K6_ARCH)
	@chmod +x $(BUNDLE_STAGE)/k6
	@(cd $(BUNDLE_STAGE) && shasum -a 256 k6 > k6.sha256)

	@echo "==> [2/4] Copying source tree (scripts, config, chart, docs, Makefile)"
	@cp -r scripts $(BUNDLE_STAGE)/scripts
	@cp -r config $(BUNDLE_STAGE)/config
	@cp -r chart $(BUNDLE_STAGE)/chart
	@cp README.md Makefile $(BUNDLE_STAGE)/
	@cp tools/AIRGAP-README.txt $(BUNDLE_STAGE)/

	@echo "==> [3/4] Optional: helm package (skipped if helm not installed)"
	@if command -v helm >/dev/null 2>&1; then \
	  helm package chart -d $(BUNDLE_STAGE)/ && echo "  -> Helm chart packaged"; \
	else \
	  echo "  -> helm not found; chart/ directory is still included as source"; \
	fi

	@echo "==> [4/4] Optional: docker save grafana/k6:$(K6_VERSION) (skipped if docker not installed or pull fails)"
	@if command -v docker >/dev/null 2>&1 && docker pull grafana/k6:$(K6_VERSION) >/dev/null 2>&1; then \
	  docker save grafana/k6:$(K6_VERSION) -o $(BUNDLE_STAGE)/k6-image-$(K6_VERSION).tar && \
	  echo "  -> Docker image saved ($$(du -h $(BUNDLE_STAGE)/k6-image-$(K6_VERSION).tar | cut -f1))"; \
	else \
	  echo "  -> docker missing or pull failed; K8s users will need to mirror the image separately"; \
	fi

	@echo "==> Creating tarball"
	@mkdir -p dist
	@(cd dist && tar -czf $(BUNDLE_NAME) airgap)
	@echo ""
	@echo "Bundle ready:"
	@du -h dist/$(BUNDLE_NAME) | awk '{print "  dist/$(BUNDLE_NAME)  (" $$1 ")"}'
	@echo ""
	@echo "Contents:"
	@(cd $(BUNDLE_STAGE) && find . -maxdepth 2 -type f -o -type d | sort | sed 's|^|  |')
