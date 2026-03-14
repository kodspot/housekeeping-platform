#!/bin/bash
# ═══════════════════════════════════════════════════════════
# VM Setup Script — Run ONCE on a fresh Ubuntu 22.04 GCP VM
# ═══════════════════════════════════════════════════════════
set -euo pipefail

echo "══════════════════════════════════════════"
echo "  Housekeeping Platform — VM Setup"
echo "══════════════════════════════════════════"

# 1. System updates
echo "→ Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# 2. Install Docker
echo "→ Installing Docker..."
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3. Add current user to docker group (so we don't need sudo)
echo "→ Adding $USER to docker group..."
sudo usermod -aG docker "$USER"

# 4. Install Git
echo "→ Installing Git..."
sudo apt-get install -y git

# 5. Configure firewall (allow SSH, HTTP, HTTPS)
echo "→ Configuring firewall..."
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable

# 6. Clone the repository
echo "→ Cloning repository..."
cd ~
if [ -d "housekeeping-platform" ]; then
  echo "  Repository already exists, pulling latest..."
  cd housekeeping-platform
  git pull origin main
else
  git clone https://github.com/kodspot/housekeeping-platform.git
  cd housekeeping-platform
fi

echo ""
echo "══════════════════════════════════════════"
echo "  ✅ VM Setup Complete!"
echo "══════════════════════════════════════════"
echo ""
echo "IMPORTANT: Log out and log back in for docker group to take effect:"
echo "  exit"
echo "  (then SSH back in)"
echo ""
echo "Then verify docker works without sudo:"
echo "  docker ps"
echo ""
