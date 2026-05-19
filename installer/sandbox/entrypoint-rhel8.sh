#!/bin/bash
# RHEL 8 sandbox entrypoint: bring up dockerd, lock down outbound
# network, then sshd in foreground.
set -e

dockerd >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    echo "[sandbox-rhel8] dockerd ready after ${i}s (pid ${DOCKERD_PID})"
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[sandbox-rhel8] dockerd never came up. Last log:" >&2
    tail -30 /var/log/dockerd.log >&2
    exit 1
  fi
done

# Same air-gap firewall as the Ubuntu sandbox — see entrypoint.sh for
# the rationale. Public internet blocked, RFC1918 + loopback allowed so
# port-forwarded SSH and the inner docker bridge keep working.
echo "[sandbox-rhel8] applying air-gap firewall..."
iptables -P INPUT  ACCEPT
iptables -P OUTPUT ACCEPT
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8     -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12  -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.0/8    -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-net-unreachable
echo "[sandbox-rhel8] firewall up — public internet blocked."

if curl -sS --max-time 3 https://1.1.1.1 >/dev/null 2>&1; then
  echo "[sandbox-rhel8] WARNING: outbound reached internet — firewall not effective" >&2
else
  echo "[sandbox-rhel8] verified: outbound to internet is blocked."
fi

echo "[sandbox-rhel8] starting sshd..."
exec /usr/sbin/sshd -D -e
