# Client-only runtime on the existing VPS: the host check and the stages after it (2026-11-02)

**Status: the founder chose the existing VPS on 2026-11-02 (a separate client-only gateway next to the internal one). Nothing is installed or changed there. This file holds the one read-only check to run first and the stages that follow, each of which needs its own approval.**

## 1. The decision and what it costs

- **What was chosen:** the pilot's client-only runtime runs on the VPS that already hosts the internal Hermes runtime, as its own Compose project (`iacquire-client-hermes`) with its own volumes. It never mounts the agency data directory or any internal profile (`services/hermes-provisioner/DEPLOYMENT.md`, "Layout and trust boundaries").
- **Fixed caps in the compose files:** gateway 2 GiB, 1 CPU, 256 processes; worker 512 MiB, 0.5 CPU, 128 processes; one concurrent run. The worst case reserves 2.5 GiB of the host's memory.
- **What the choice costs:** no new bill, but the client runtime shares the host, its firewall and its SSH posture with the internal runtime, and the neighbours are not capped (the deployment guide measured the internal Hermes container uncapped on 2026-10-22; six inference workers have been added since). Production capacity is **not established** until the host is measured and a load test shows the reserve. If the reserve cannot be shown without changing the internal runtime, the answer is a separate VPS after approval.
- **Capacity number for the pilot:** `IACQUIRE_PROVISIONER_MAX_PROFILES` and `HERMES_PROVISIONER_MAX_PROFILES` set to **6**: one client's team is admitted all or nothing, so 6 holds exactly one client. Raise it (to 12, the number the isolated acceptance measured) only after a second client is approved and the host has been measured under load.

## 2. Stage 0: the read-only host check (run at the VPS console; changes nothing)

Run each line as it is, as root, in the console you already use for the other read-only checks. Every line only reads: no secret, key, token or environment value is printed, and nothing is created, started, stopped, pulled or deleted. Paste the whole output back in the chat only, never into a repository file: sections 9 and 10 can show addresses and ports. If a line fails with "command not found", leave it and say so.

```bash
echo "== 1 host =="; date -u +%FT%TZ; uptime -s; uptime; echo "cpus: $(nproc)"; grep PRETTY_NAME /etc/os-release; uname -r
echo "== 2 memory and swap =="; free -m; swapon --show; echo "(nothing listed above for swap means none)"
echo "== 3 disk =="; df -h /; df -h /var/lib/docker 2>/dev/null; docker system df
echo "== 4 docker engine =="; docker version --format 'server {{.Server.Version}}'; docker compose version --short; docker info --format 'cgroup {{.CgroupVersion}}, storage {{.Driver}}, security {{json .SecurityOptions}}'; docker info --format 'warnings {{json .Warnings}}'
echo "== 5 containers =="; docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}}'
echo "== 6 use right now (one sample) =="; docker stats --no-stream --format '{{.Name}} | cpu {{.CPUPerc}} | mem {{.MemUsage}} | pids {{.PIDs}}'
echo "== 7 limits per container (0 means none) =="; for c in $(docker ps -aq); do docker inspect -f '{{.Name}} | mem {{.HostConfig.Memory}} | nanocpus {{.HostConfig.NanoCpus}} | pids {{.HostConfig.PidsLimit}} | restart {{.HostConfig.RestartPolicy.Name}} | readonly {{.HostConfig.ReadonlyRootfs}} | privileged {{.HostConfig.Privileged}} | network {{.HostConfig.NetworkMode}}' "$c"; done
echo "== 8 networks and volumes =="; docker network ls --format '{{.Name}} | {{.Driver}}'; docker volume ls --format '{{.Name}}'
echo "== 9 what listens and on which address =="; ss -tlnp | tail -n +2 | awk '{print $4, $6}' | sort -u
echo "== 10 firewall =="; ufw status verbose 2>&1 | head -30; nft list ruleset 2>/dev/null | head -60
echo "== 11 ssh and guards =="; sshd -T 2>/dev/null | grep -E '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) '; for s in fail2ban unattended-upgrades; do echo "$s: $(systemctl is-active $s 2>&1)"; done
echo "== 12 clock =="; timedatectl 2>/dev/null | grep -E 'Time zone|synchronized|NTP'
echo "== 13 tunnel connector and the places the client runtime would use =="; docker ps --format '{{.Names}} {{.Image}}' | grep -i cloudflared || echo "no cloudflared container running"; ls -ld /srv /srv/iacquire-client-hermes 2>&1 | head -3
echo "== end =="
```

## 3. How the output will be read

| Measure | Good | Not good, and what follows |
| --- | --- | --- |
| Memory available (section 2) | 4 GiB or more | Under 2.5 GiB (the caps): not enough. Between: barely; cap the neighbours first or use another host |
| CPU load (section 1) | 15-minute load under 1.0 on 2 cores | Sustained above 1.0: the client gateway's 1 CPU would compete with the internal runtime |
| Swap (section 2) | Some swap | None: a memory spike kills a container instead of slowing it. Adding swap is a change and needs its own approval |
| Disk (section 3) | 15 GiB or more free under Docker | Less: clean up or enlarge before building images |
| Docker (section 4) | Engine 24 or newer, `compose` v2 present, no cgroup warnings, no user-namespace remapping | A missing compose plugin or remapping breaks the reviewed layout and the secret-file ownership checks |
| Limits (section 7) | Every neighbour has a memory limit | A neighbour with `mem 0` can starve the client gateway: cap it (a change to the internal runtime, needs approval) |
| Networks (section 8) | The private network named in the env example already exists and is internal | Missing: it is created in stage 3. Not internal: a finding |
| Listening ports (section 9) | Nothing the client runtime needs is published; no listener on `0.0.0.0` that is not expected; **8642 not published** | Any unexpected public listener (including an internal gateway's own raw port) is a finding to close before client data lands on the host |
| Firewall and SSH (sections 10 and 11) | A firewall is active; root and password logins off; a brute-force guard running | If these are still as in the earlier security review, apply that review's hardening **before the first client profile is created**: client data raises its priority |
| Tunnel (section 13) | A connector exists for the internal route | None: the client route needs its own approved hostname and Access token (stage 4) |

## 4. The stages after the check (none is approved; each stops at its first failed gate)

1. **Decisions.** Capacity (6, above); where the client profile backups go and who holds their encryption key (`ops/backup-profiles.sh`, `ops/restore-profiles.sh`); which model provider's key the profiles use and its spending ceiling; the exact HTTPS hostname for the client route.
2. **Private files and an offline check.** The three secret files and the Compose env file under `/srv/iacquire-client-hermes` with the owners and modes the deployment guide states; `scripts/hermes-client-preflight.sh --offline-config` must pass; the Compose files interpolate without starting anything.
3. **Build and start only the client gateway** in its own project, without the worker and without the tunnel: the volume is separate and empty, no host port is published, an outside probe cannot reach the API. A change on the VPS: its own approval.
4. **The route and the portal side.** A Cloudflare Tunnel route and Access service token for the client hostname; the gateway registered and attested in the portal (`scripts/hermes-client-gateway-attest.ts`); the provisioner token and gateway pin set as portal switches (each reversible).
5. **The worker on one canary.** One synthetic tenant through the real worker on the production image, then the pinned-runtime proof repeated on it.
6. **The business-tool tier** for the pilot workspace with the supervised gateway restart (runbook section 7).
7. **The supervised pilot** (`docs/client-pilot-package-2026-11-01.md`).

The portal side of the release is already in production and dormant (`docs/client-production-release-runbook-2026-11-03.md`, section 13), so nothing in these stages waits on a deployment.
