#!/usr/bin/env bash
# One-time VPS hardening for the shared GBX stack (Ubuntu). Review before running:
#   sudo bash /root/crm/deploy/harden.sh
# Idempotent: safe to re-run. Does not touch Docker networking or the Caddy config.
set -euo pipefail

echo "== unattended security updates"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades fail2ban ufw >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CFG

echo "== firewall: SSH, HTTP, HTTPS only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/   /'

echo "== fail2ban on SSH (5 failures → 1 h ban)"
cat > /etc/fail2ban/jail.d/sshd.local <<'CFG'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
CFG
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

echo "== SSH: keys only, no root password login"
if [ -s /root/.ssh/authorized_keys ]; then
  mkdir -p /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/90-gbx.conf <<'CFG'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 4
X11Forwarding no
CFG
  sshd -t && systemctl reload ssh
else
  echo "   skipped: no /root/.ssh/authorized_keys yet — add your key first, then re-run"
fi

echo "== Docker log rotation"
mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  echo '{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "== permissions on secrets and data"
[ -f /root/crm/.env.production ] && chmod 600 /root/crm/.env.production
[ -d /root/crm-data ] && chmod 700 /root/crm-data
chmod 700 /root

echo "== done. Reboot at a quiet time so the new kernel (if any) is in use: sudo reboot"
