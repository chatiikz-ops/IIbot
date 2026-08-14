#!/usr/bin/env bash
set -e

echo "=== JETKIZ/ZAPIS PRODUCTION DEPLOY ==="

sudo apt update
sudo apt install -y curl git nginx postgresql postgresql-contrib chromium-browser || \
sudo apt install -y curl git nginx postgresql postgresql-contrib chromium

# SWAP
if [ ! -f /swapfile ]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
fi
sudo swapon /swapfile 2>/dev/null || true
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# NODE 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# SERVICES
sudo systemctl enable --now postgresql nginx

# DATABASE
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='zapis_ai_sales'" | grep -q 1 || \
sudo -u postgres createdb zapis_ai_sales

# BACKEND
cd "$HOME/IIbot"
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build

pm2 delete lidchat-api 2>/dev/null || true
pm2 start dist/main.js --name lidchat-api

# ADMIN
if [ ! -d "$HOME/IIbot-admin" ]; then
  git clone https://github.com/chatiikz-ops/IIbot-admin.git "$HOME/IIbot-admin"
fi

cd "$HOME/IIbot-admin"
npm ci
npm run build

pm2 delete lidchat-admin 2>/dev/null || true
pm2 start npm --name lidchat-admin -- start -- -p 3001

pm2 save

echo "=== DEPLOY COMPLETE ==="
pm2 status