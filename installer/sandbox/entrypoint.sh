#!/bin/bash
# Sandbox entrypoint: bring up dockerd, lock down outbound network to
# simulate an air-gapped host, then run sshd in the foreground.
set -e

# --storage-driver=vfs avoids overlay-on-overlay collisions when this
# sandbox runs nested inside Docker Desktop / WSL2. On real bare-metal
# Ubuntu the daemon would use overlay2 by default — vfs is purely a
# Windows-host compatibility shim.
dockerd --storage-driver=vfs >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    echo "[sandbox] dockerd ready after ${i}s (pid ${DOCKERD_PID})"
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[sandbox] dockerd never came up. Last log:" >&2
    tail -30 /var/log/dockerd.log >&2
    exit 1
  fi
done

# Block egress to the public internet while keeping inbound SSH alive.
#
# The host->container path uses connection tracking (port forwarding via
# the docker bridge), so allowing ESTABLISHED on INPUT keeps SSH replies
# flowing. We only drop *new* outbound connections — existing ones (the
# host's incoming ssh) remain symmetric and thus live.
#
# Loopback is fully open so dockerd, the agent's compose stack, and any
# inner container-to-container traffic on the local docker bridge stay
# functional.
echo "[sandbox] applying air-gap firewall..."
iptables -P INPUT  ACCEPT
iptables -P OUTPUT ACCEPT
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Allow outbound to RFC1918 ranges so dockerd can reach its own bridge
# networks (172.17.0.0/16 by default) when launching child containers.
iptables -A OUTPUT -d 10.0.0.0/8     -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12  -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.0/8    -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-net-unreachable
echo "[sandbox] firewall up — public internet blocked, SSH still alive."

# Quick sanity probe (non-fatal): expect this to fail.
if curl -sS --max-time 3 https://1.1.1.1 >/dev/null 2>&1; then
  echo "[sandbox] WARNING: outbound reached internet — firewall not effective" >&2
else
  echo "[sandbox] verified: outbound to internet is blocked."
fi

echo "[sandbox] starting sshd..."
exec /usr/sbin/sshd -D -e
