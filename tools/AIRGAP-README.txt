mattermost-loadtest-k6 — air-gapped bundle
==========================================

This tarball is everything you need to run the load test in an environment
without internet access. It contains:

  k6                                # pinned k6 binary (Linux)
  scripts/                          # the test scripts
  config/                           # users.example.{json,csv} templates
  chart/                            # Helm chart source (for K8s installs)
  mattermost-loadtest-k6-*.tgz      # packaged Helm chart (if helm was available
                                    # on the build host)
  k6-image-*.tar                    # grafana/k6 Docker image (if docker was
                                    # available on the build host)
  README.md, Makefile               # full documentation + convenience targets


Quick start: bare Linux (no K8s)
---------------------------------

  1. Place the bundled k6 binary on PATH:

       sudo install -m 0755 ./k6 /usr/local/bin/k6
       k6 version    # confirm it works

  2. Set the Mattermost target:

       export MM_URL=https://mattermost.internal.example.com

  3a. Mode A (bring your own users):

       cp config/users.example.json config/users.json
       # ...fill in real credentials...
       make preflight
       make load

  3b. Mode B (chart-style bootstrap, no users file needed):

       export RUN_ID=$(hostname)-$(date +%s)
       export ADMIN_EMAIL=sysadmin@example.com
       export ADMIN_PASSWORD='YourAdminPassword!'
       export BOOTSTRAP_NUM_USERS=100
       export BOOTSTRAP_NUM_CHANNELS=10
       k6 run scripts/bootstrap.js   # create team + channels + users
       k6 run scripts/load.js        # run the load test
       k6 run scripts/cleanup.js     # delete posts marked [lt-$RUN_ID]
       k6 run scripts/teardown.js    # delete bootstrap users/channels/team

See README.md for full documentation of all environment variables and modes.


Quick start: air-gapped Kubernetes
-----------------------------------

  1. Load the bundled image into Docker (if your registry uses Docker):

       docker load -i k6-image-*.tar
       # output shows: Loaded image: grafana/k6:<VERSION>

  2. Re-tag and push to your internal registry:

       docker tag grafana/k6:<VERSION> registry.internal/grafana/k6:<VERSION>
       docker push registry.internal/grafana/k6:<VERSION>

     (For containerd / k3s / etc. use the equivalent `ctr images import` etc.)

  3. Install the chart, pointing image.repository at your registry:

       helm install lt ./mattermost-loadtest-k6-*.tgz \
         --set image.repository=registry.internal/grafana/k6 \
         --set image.tag=<VERSION> \
         --set mattermost.url=https://mattermost.internal \
         --set bootstrap.enabled=true \
         --set bootstrap.numUsers=100 \
         --set admin.email=sysadmin@example.com \
         --set admin.password='...'

  4. Watch progress:

       kubectl get jobs -l app.kubernetes.io/instance=lt -w
       kubectl logs -f job/lt-mattermost-loadtest-k6 -c k6

  5. Tear everything down (triggers MM-side cleanup automatically):

       helm uninstall lt

See chart/README.md for chart-specific documentation.


Verification before transferring
---------------------------------

It's good practice to verify the bundle's k6 binary before you ship it:

       sha256sum k6
       ./k6 version

The k6 version reported should match the K6_VERSION the bundle was built for.


Networking required on the target side
---------------------------------------

  - Outbound HTTPS (and WSS if MM_URL is HTTPS) to your Mattermost host
  - For K8s mode: cluster nodes must be able to pull from your internal
    registry; no internet egress otherwise

That's all. The test does not phone home or fetch anything during execution.
