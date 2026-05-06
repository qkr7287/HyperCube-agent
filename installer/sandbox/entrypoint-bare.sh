#!/bin/bash
# Bare sandbox entrypoint: NO dockerd. The installer must bring its own.
# We only set up the air-gap firewall and run sshd.
set -e

echo "[sandbox-bare] applying air-gap firewall..."
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
echo "[sandbox-bare] firewall up — public internet blocked."

echo "[sandbox-bare] starting sshd (no docker — installer must bring it)..."
exec /usr/sbin/sshd -D -e
