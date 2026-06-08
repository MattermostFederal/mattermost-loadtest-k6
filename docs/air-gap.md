# Running in air-gapped / isolated environments

The script has **no runtime dependencies** other than k6 itself. All imports are either k6 built-ins (`k6/http`, `k6/ws`, `k6/data`, `k6/metrics`, `k6/crypto`, `k6/execution`) or local files in `scripts/lib/`. There is no `npm install`, no Go modules to vendor, no language runtime to bring.

## What you need to copy across the air gap

| Item | How |
|---|---|
| **k6 binary** (~30 MB, single static binary) | Download from [github.com/grafana/k6/releases](https://github.com/grafana/k6/releases) on a connected machine, scp to the target |
| **This repo** | `git clone` on a connected machine, then `tar`/`scp` or use a removable medium |
| **(Kubernetes only) `grafana/k6` Docker image** | `docker pull`, `docker save` to a `.tar`, transfer, `docker load` + push to internal registry |
| **(Kubernetes only) Helm + kubectl binaries** | Both are single static binaries — same drill as k6 |

## Air-gapped Linux (no Kubernetes)

```sh
# On a connected machine — pick a pinned version:
K6_VERSION=2.0.0
curl -L -o k6.tar.gz \
  "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz"
tar -xzf k6.tar.gz   # produces k6-v2.0.0-linux-amd64/k6
git clone <this-repo> mattermost-loadtest-k6
tar -czf bundle.tgz k6-v${K6_VERSION}-linux-amd64 mattermost-loadtest-k6

# Transfer bundle.tgz across the air gap, then on the isolated host:
tar -xzf bundle.tgz
sudo install -m 0755 k6-v2.0.0-linux-amd64/k6 /usr/local/bin/k6
cd mattermost-loadtest-k6
# ...continue with the normal Mode A or Mode B flow.
```

No network access is required during the test — only outbound to your Mattermost URL.

## Air-gapped Kubernetes (Helm chart)

Two extra steps: mirror the `grafana/k6` image to your internal registry, then override `image.repository` in values.

```sh
# On a connected machine:
docker pull grafana/k6:2.0.0
docker save grafana/k6:2.0.0 -o k6-image.tar
helm package chart -d dist/   # produces dist/mattermost-loadtest-k6-1.0.0.tgz

# Transfer k6-image.tar + the chart .tgz, then in the isolated env:
docker load -i k6-image.tar
docker tag grafana/k6:2.0.0 registry.internal/grafana/k6:2.0.0
docker push registry.internal/grafana/k6:2.0.0

helm install lt ./mattermost-loadtest-k6-1.0.0.tgz \
  --set image.repository=registry.internal/grafana/k6 \
  --set image.tag=2.0.0 \
  --set mattermost.url=https://mattermost.internal \
  # ...rest of values
```

**Always pin `image.tag` to a specific version** in air-gapped envs — `latest` will fail with `ErrImagePull` if the image isn't already pulled with that tag.

## Things NOT needed in air-gapped mode

- ❌ Internet access during the test
- ❌ npm / yarn / Node.js
- ❌ A Go toolchain (k6 is a single binary)
- ❌ Any external metrics destination (k6 prints summary to stdout; Prometheus integration is opt-in)
- ❌ A package manager — k6 is just a binary you drop on PATH

## `make airgap-bundle` — one tarball, ready to scp

On a connected build machine, run:

```sh
make airgap-bundle                                  # uses K6_VERSION + K6_ARCH defaults
make airgap-bundle K6_VERSION=2.0.0 K6_ARCH=linux-arm64
```

This produces `dist/mattermost-loadtest-k6-airgap-v<version>-<arch>.tar.gz` containing:

| Inside the bundle | Purpose |
|---|---|
| `k6` (binary) | Pinned, executable on the target Linux box |
| `k6.sha256` | Integrity check for the binary |
| `scripts/`, `config/`, `chart/` | Source tree |
| `Makefile`, `README.md` | Same docs you have here |
| `AIRGAP-README.txt` | Standalone quick-start runbook for whoever opens the bundle |
| `mattermost-loadtest-k6-*.tgz` *(optional)* | `helm package` output, present if helm is installed on the build host |
| `k6-image-<version>.tar` *(optional)* | `docker save` output of `grafana/k6:<version>`, present if docker is installed and can pull |

The optional pieces are skipped automatically (with a clear log line) if `helm`/`docker` aren't installed on the build host — the bundle still works for non-K8s use.

On the air-gapped target:

```sh
tar -xzf mattermost-loadtest-k6-airgap-*.tar.gz
cd airgap
shasum -a 256 -c k6.sha256                           # verify
sudo install -m 0755 ./k6 /usr/local/bin/k6
cat AIRGAP-README.txt                                # follow the runbook
```

## Standalone Linux server (not air-gapped, but bare metal)

If you just want to run from a regular Linux VM with outbound to MM but no Kubernetes:

```sh
# 1. Install k6 (one-time)
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install -y k6
# (Red Hat / Amazon Linux: see https://k6.io/docs/get-started/installation/)

# 2. Get the scripts onto the box
git clone <this-repo> mattermost-loadtest-k6
cd mattermost-loadtest-k6

# 3. Raise the file-descriptor limit if you'll run many VUs
ulimit -n 65536

# 4. Run — Mode A
export MM_URL=https://mattermost.example.com
cp config/users.example.json config/users.json   # fill in real creds
make preflight
make load
```

### Running it long / in the background

For tests longer than a shell session:

```sh
nohup k6 run --summary-export=summary.json scripts/load.js > k6.log 2>&1 &
tail -f k6.log
```

Or via systemd as a one-shot unit. There's no daemon — k6 is a single process that exits when the test ends.

### Sizing

- Outbound HTTPS (and WSS if `MM_URL` is HTTPS) to your Mattermost host
- ~500 MB RAM + 1 CPU per ~500 VUs as a rough rule of thumb
- File descriptors: `ulimit -n` at least `4 × TARGET_VUS` to leave headroom

No Kubernetes, no Helm, no Docker required.
