MM_URL    ?= http://localhost:8065
USERS_FILE ?= ./config/users.json

# Air-gap bundle parameters
# K6_VERSION is the single source of truth; keep chart/values.yaml image.tag in sync.
K6_VERSION ?= 2.0.0
K6_ARCH    ?= linux-amd64
BUNDLE_STAGE = dist/airgap
BUNDLE_NAME  = mattermost-loadtest-k6-airgap-v$(K6_VERSION)-$(K6_ARCH).tar.gz

# Export every Make-known variable to recipe shells so values containing
# shell metacharacters (e.g. ADMIN_PASSWORD='a&b!c$d') pass through cleanly
# without unquoted interpolation in the recipe.
#
# Two equivalent ways to pass credentials:
#   1) export in the calling shell:
#        export ADMIN_EMAIL=sysadmin@example.com
#        export ADMIN_PASSWORD='hunter2!@#'
#        make bootstrap
#   2) pass via make command line:
#        make bootstrap ADMIN_EMAIL=sysadmin@example.com ADMIN_PASSWORD='hunter2!@#'
# Both work because .EXPORT_ALL_VARIABLES re-exports Make variables to the
# recipe shell. Recipes do not interpolate `$(ADMIN_PASSWORD)` into command
# lines — they rely on the shell already having the variable in its env.
#
# Portability:
#   - Tested on macOS (`/usr/bin/make` is GNU Make 3.81) and recent Linux
#     distributions (`make` is GNU Make 4.x).
#   - BSD make (FreeBSD/NetBSD default) does NOT support .EXPORT_ALL_VARIABLES.
#     Install GNU Make (`pkg install gmake`) and invoke as `gmake` there.
#   - Windows: use WSL. Native cmd/PowerShell don't have `make` or the POSIX
#     shell features the recipes need.
.EXPORT_ALL_VARIABLES:

ENV = MM_URL=$(MM_URL) USERS_FILE=$(USERS_FILE)

# --- Prometheus remote-write integration --------------------------------------
# Set K6_PROMETHEUS_RW_SERVER_URL to a remote-write endpoint (Prometheus with
# --web.enable-remote-write-receiver, Mimir, Cortex, or Alloy with a
# prometheus.receive_http component) to stream metrics in real time.
#
#   K6_PROMETHEUS_RW_SERVER_URL=https://prom.internal:9090/api/v1/write make load
#
# Optional auth env vars (passed straight through to k6):
#   K6_PROMETHEUS_RW_USERNAME / K6_PROMETHEUS_RW_PASSWORD   (basic auth)
#   K6_PROMETHEUS_RW_BEARER_TOKEN                           (bearer token)
#   K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY=true          (self-signed TLS)
#   K6_PROMETHEUS_RW_PUSH_INTERVAL=5s                       (flush cadence)
#
# When set, K6_OUT_ARGS becomes the `-o experimental-prometheus-rw` flag plus
# a run_id tag so multiple runs are distinguishable in Grafana. When unset,
# k6 prints to stdout as before.
K6_OUT_ARGS = $(if $(K6_PROMETHEUS_RW_SERVER_URL),-o experimental-prometheus-rw)
K6_RUN_TAGS = $(if $(K6_PROMETHEUS_RW_SERVER_URL),--tag run_id=$${RUN_ID:-default})

.PHONY: help preflight smoke load load-readonly load-summary check-users check-vus \
        breakpoint load-search load-attachments load-realtime \
        bootstrap cleanup teardown-soft teardown-hard check-admin recover-flags \
        chart-sync chart-lint chart-package \
        airgap-bundle airgap-clean

help:
	@echo "Local test targets (Mode A — bring your own users; requires USERS_FILE):"
	@echo "  preflight        Verify ping, version, and that every user in USERS_FILE has teams + channels"
	@echo "  smoke            One VU for 30s; verifies creds + connectivity"
	@echo "  load             Realistic-user load (writes enabled). Override TARGET_VUS, STEADY_SEC, etc."
	@echo "  load-readonly    Same as 'load' but READ_ONLY=true"
	@echo "  load-summary     Same as 'load', writes summary.json"
	@echo "  load-realistic   Production-shaped sessions (SESSION_SEC=3600, RAMP_UP_SEC=240)."
	@echo "                   Use this for capacity sizing; 'load' is an auth-stress profile."
	@echo ""
	@echo "Capacity / bottleneck testing:"
	@echo "  breakpoint       Ramp VU count until write p95 crosses BREAKPOINT_WRITE_P95_MS (default 1000ms)."
	@echo "                   k6 aborts at the breaking point and the summary tells you the VU count."
	@echo "                   Tune via BREAKPOINT_MAX_VUS (default 1000), BREAKPOINT_DURATION (default 30m)."
	@echo "  load-search      Search-heavy mix (SearchPosts/Users/Channels ~50x weight). Stresses Elasticsearch."
	@echo "  load-attachments File-upload-heavy mix. Stresses S3 / MinIO / local disk file store."
	@echo "  load-realtime    WebSocket-fanout-heavy mix (short idles, post-heavy). Stresses Go app server."
	@echo ""
	@echo "Real-time metrics → Grafana:"
	@echo "  Set K6_PROMETHEUS_RW_SERVER_URL=<remote-write URL> on any of the above targets"
	@echo "  to stream metrics into Prometheus/Alloy in real time. Auth knobs:"
	@echo "  K6_PROMETHEUS_RW_USERNAME/PASSWORD, K6_PROMETHEUS_RW_BEARER_TOKEN,"
	@echo "  K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY. Import Grafana dashboard ID 19665."
	@echo ""
	@echo "Cleanup (works in both modes):"
	@echo "  cleanup          Delete posts marked [lt-\$$RUN_ID]."
	@echo "                   Mode A: requires USERS_FILE (uses each user's session)."
	@echo "                   Mode B: requires ADMIN_EMAIL+ADMIN_PASSWORD+RUN_ID; uses admin path,"
	@echo "                           no users file or BOOTSTRAP_NUM_USERS needed."
	@echo ""
	@echo "Mode B — chart-managed bootstrap (requires ADMIN_EMAIL + ADMIN_PASSWORD + RUN_ID):"
	@echo "  bootstrap       Create team + N channels + N users (BOOTSTRAP_NUM_USERS, BOOTSTRAP_NUM_CHANNELS)"
	@echo "  teardown-soft   Archive channels/team, deactivate users (sets delete_at; reversible from System Console)"
	@echo "  teardown-hard   Permanent delete — toggles ServiceSettings.EnableAPI*Deletion=true,"
	@echo "                  sweeps users/channels/team, then restores the flags to their snapshotted values."
	@echo "                  NOT REVERSIBLE. Validate against a non-prod instance first."
	@echo ""
	@echo "Recovery (when teardown died mid-run with flags left enabled):"
	@echo "  recover-flags   Set ServiceSettings.EnableAPI*Deletion flags back to safe defaults"
	@echo "                  (all false) or to a specific state via RECOVER_SNAPSHOT_JSON."
	@echo "                  RECOVER_DRY_RUN=true to print the delta without writing."
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

# Softer precondition for breakpoint / capacity tests that work in either
# mode: accept Mode A (USERS_FILE exists) OR Mode B (BOOTSTRAP_NUM_USERS>0
# with bootstrap-derived creds). Without one, lib/users.js fails at k6
# init with a cryptic message; this gives operators a clear instruction.
check-vus:
	@if [ -n "$(BOOTSTRAP_NUM_USERS)" ] && [ "$(BOOTSTRAP_NUM_USERS)" -gt 0 ] 2>/dev/null; then \
	  exit 0; \
	fi; \
	if [ ! -f "$(USERS_FILE)" ]; then \
	  echo "No VU source available:"; \
	  echo "  Mode A: set USERS_FILE to a users.json/.csv file (currently '$(USERS_FILE)' does not exist)"; \
	  echo "  Mode B: set BOOTSTRAP_NUM_USERS=N (and matching RUN_ID) to derive users from RUN_ID"; \
	  exit 1; \
	fi

# Bootstrap / teardown targets require an admin session AND a run id so resource
# names line up across bootstrap → load → cleanup → teardown.
#
# Checks use $$VAR (shell expansion at recipe time) instead of $(VAR) (Make
# interpolation at parse time). This makes the check honest about what k6
# will actually see: the recipe shell's env vars, including ones EXPORTed
# in the caller's shell. Avoids the trap where `make ADMIN_PASSWORD=x` (Make-
# only) passes the check but k6 then doesn't see the value.
check-admin:
	@test -n "$${ADMIN_EMAIL}"    || { echo "ADMIN_EMAIL is not set (export it in your shell)";    exit 1; }
	@test -n "$${ADMIN_PASSWORD}" || { echo "ADMIN_PASSWORD is not set (export it in your shell)"; exit 1; }
	@test -n "$${RUN_ID}"         || { echo "RUN_ID is not set (export the same value used for bootstrap)"; exit 1; }

preflight: check-users
	$(ENV) k6 run scripts/preflight.js

smoke: check-users
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/smoke.js

load: check-users
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load.js

load-readonly: check-users
	$(ENV) READ_ONLY=true k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load.js

# Production-shaped session behaviour rather than auth stress.
#
# The default profile re-authenticates every VU every SESSION_SEC (180s). Real
# deployments run session lifetimes measured in days -- Mattermost's own default
# is 30 days -- so the default profile spends far more CPU on password hashing
# than any production instance would. Mattermost v11 hashes with PBKDF2-SHA256
# at 600k iterations (~0.4 CPU-seconds per login, not configurable), so login
# rate dominates the CPU profile and the default reads as a capacity number when
# it is really an auth-stress number.
#
# This target holds each session for SESSION_SEC=3600 and ramps arrivals over
# RAMP_UP_SEC=240 instead of 60. Both are overridable.
load-realistic: check-users
	$(ENV) SESSION_SEC=$${SESSION_SEC:-3600} \
	       RAMP_UP_SEC=$${RAMP_UP_SEC:-240} \
	       STEADY_SEC=$${STEADY_SEC:-600} \
	       k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load.js

load-summary: check-users
	$(ENV) k6 run --summary-export=summary.json $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load.js

# --- Capacity / bottleneck testing --------------------------------------------

# breakpoint requires users via either Mode A (USERS_FILE) or Mode B
# (BOOTSTRAP_NUM_USERS pointing at bootstrap-derived creds). check-vus
# validates one or the other is present so the failure surfaces cleanly.
breakpoint: check-vus
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/breakpoint.js

# Targeted stressors use check-vus (not check-users) so Mode B (bootstrap-
# derived users via BOOTSTRAP_NUM_USERS) works locally without a USERS_FILE.
load-search: check-vus
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load-search.js

load-attachments: check-vus
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load-attachments.js

load-realtime: check-vus
	$(ENV) k6 run $(K6_OUT_ARGS) $(K6_RUN_TAGS) scripts/load-realtime.js

# --- Mode B lifecycle ---------------------------------------------------------

# With .EXPORT_ALL_VARIABLES set above, ADMIN_EMAIL / ADMIN_PASSWORD / RUN_ID
# / MM_URL / BOOTSTRAP_* are inherited by k6 directly from the shell — no
# `VAR=$(VAR)` interpolation in command lines. This is the only safe pattern
# for credentials with shell metacharacters.
#
# Default values use inline env-prefix syntax (`VAR=$${VAR:-default} k6 ...`).
# We can't use shell `: $${VAR:=default}` because that sets the shell-internal
# variable WITHOUT exporting it — k6 (a child process) wouldn't see the
# default. Inline env-prefix makes the value available for the child.

bootstrap: check-admin
	BOOTSTRAP_NUM_USERS=$${BOOTSTRAP_NUM_USERS:-50} \
	BOOTSTRAP_NUM_CHANNELS=$${BOOTSTRAP_NUM_CHANNELS:-5} \
	k6 run scripts/bootstrap.js

# cleanup works in BOTH modes — uses the RUN_ID marker.
#   Mode A: requires USERS_FILE (the same creds file used by `make load`).
#   Mode B: requires ADMIN_EMAIL + ADMIN_PASSWORD + RUN_ID exported. The script
#           auto-detects the bootstrap team `lt-<RUN_ID>` and runs an admin-
#           driven sweep — no user file or BOOTSTRAP_NUM_USERS needed.
cleanup:
	RUN_ID=$${RUN_ID:-default} \
	CLEANUP_PASSES=$${CLEANUP_PASSES:-1} \
	CLEANUP_PASS_DELAY_SEC=$${CLEANUP_PASS_DELAY_SEC:-30} \
	k6 run scripts/cleanup.js

teardown-soft: check-admin
	TEARDOWN_MODE=soft k6 run scripts/teardown.js

# teardown-hard toggles ServiceSettings.EnableAPI{User,Channel,Team}Deletion=true
# for the duration of the sweep, then restores the originals (even on partial
# failure). PERMANENT — data is removed at the DB row level. Validate on a
# non-prod instance before running against shared environments.
teardown-hard: check-admin
	TEARDOWN_MODE=hard k6 run scripts/teardown.js

# --- Recovery -----------------------------------------------------------------

# recover-flags restores ServiceSettings.EnableAPI*Deletion flags to a known-
# good state. Use when a prior teardown died (pod OOM, eviction, deadline,
# network blip) AFTER enabling the flags but BEFORE restoring them.
#
# Default: sets all four deletion flags to false (safest).
# Restore-to-snapshot: export RECOVER_SNAPSHOT_JSON with the exact desired state.
# Dry run: export RECOVER_DRY_RUN=true to print the delta without writing.
#
# Requires: ADMIN_EMAIL, ADMIN_PASSWORD, MM_URL exported in the shell.
recover-flags:
	@test -n "$${ADMIN_EMAIL}"    || { echo "ADMIN_EMAIL is not set";    exit 1; }
	@test -n "$${ADMIN_PASSWORD}" || { echo "ADMIN_PASSWORD is not set"; exit 1; }
	k6 run scripts/recover-flags.js

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
