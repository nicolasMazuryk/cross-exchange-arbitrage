

2. Infrastructure provisioning

- Tag everything (labels on Hetzner resources) — they're how the CCM, CSI, and your own automation find things.


3. Deployments
- kamal deploy


5. Container images

- Build with BuildKit / docker buildx, use multi-stage Dockerfiles.

6. Deploying the application

- Kamal 2: kamal deploy builds, pushes, and rolls your containers to the remote server

- Kamal 2 deploys Dockerized apps over SSH, Let's Encrypt TLS.

8. Networking, edge, and TLS

Hetzner Cloud Networks for private VPCs — always put your databases on the private network and firewall the public interfaces.
Hetzner Cloud Firewalls at the resource level; treat them as your first line of defense and don't depend on host firewalls alone.
Hetzner Load Balancers are cheap and integrate with the CCM. For most workloads they're enough; reach for a self-managed Caddy only when you need exotic routing.


3. Kamal 2 configuration

Things worth calling out:
- kamal-proxy does zero-downtime deployments (holding requests while your app restarts). IMPORTANT: we don't want zero-downtime deployments, which are running 2 application instance at the same time, because it may create undesired side effects.
- Healthchecks are non-optional. Without a working /up endpoint, kamal-proxy will not switch traffic during a deploy and you'll think the deploy hung.
- Bind accessory ports to 127.0.0.1. The 127.0.0.1:5432:5432 mapping keeps your database off the public internet — combined with the private network, your DB is reachable only by app containers on the same host.
- Multi-arch builds. If you build on Apple Silicon but deploy to amd64 Hetzner (the CX/CPX line), pin builder.arch: amd64 or use linux/amd64,linux/arm64 for the CAX ARM servers. ARM on Hetzner is genuinely cheaper and most stacks build fine.


11. Security checklist
Walking the perimeter from outside in:

Hetzner Cloud Firewall allowing only 22/80/443.
Private network for all server-to-server traffic; nothing accessory-side on a public IP.
UFW inside the OS as defense in depth.
Fail2ban for SSH brute-force protection.
SSH: key-only, no root password.
Unattended security upgrades enabled.
Non-root container user in your Dockerfile.


12. Things that bite people in production
A short list of footguns:

No /up healthcheck → deploys hang at "Waiting for the first healthy container".
Building on Apple Silicon, deploying to Intel without --platform linux/amd64 → exec-format errors at boot.
Disk fills up from images — schedule prunes, monitor disk.


## IMPORTANT

I deploy the crypto arbitrage trading system that listens to a lot of web sockets events from exchanges which send thousands of events per second. It is super important that there are no two instances of the application is running at the same time. Because we are listening to order book updates and detect arbitrage opportunities, if two applications detect the same opportunity - then we unintentionally enter two trades, which leads to wrong, false decisions, which may cause losing money.
We don't want kamal-proxy to do a zero downtime deployments using Kamal proxy, which for some time is running two application instances. We want to avoid that.

