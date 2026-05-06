# Ubuntu 24.04 sandbox for manually rehearsing the air-gap installer.
# Pre-installs Docker Engine + compose plugin + sshd so you can SSH in
# and run the installer as if you'd just received the .sh on USB.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base tools + sshd. ca-certificates and gnupg are only used to add the
# Docker apt repo at build time; they ship in the final image too because
# rolling them back wouldn't save much.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server sudo curl wget ca-certificates gnupg \
      iproute2 iputils-ping iptables \
    && rm -rf /var/lib/apt/lists/*

# Docker Engine from the official repo. This is what a real Ubuntu 24.04
# operator would do per docs/airgap-install.md (or via the offline .deb
# bundle described there).
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      docker-ce docker-ce-cli containerd.io docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# Allow root password login over ssh. This is a throwaway sandbox; do
# not copy this config to anything real.
RUN mkdir -p /run/sshd && \
    echo 'root:hypercube' | chpasswd && \
    sed -i 's/#*PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#*PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config

EXPOSE 22

COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh
RUN chmod +x /usr/local/bin/sandbox-entrypoint.sh

CMD ["/usr/local/bin/sandbox-entrypoint.sh"]
