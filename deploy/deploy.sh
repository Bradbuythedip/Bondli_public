#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════
# BONDLI v3.0 — Production Deploy Script
# ═══════════════════════════════════════
# Usage: ./deploy/deploy.sh [fresh|update|ssl|status]

DOMAIN="${DOMAIN:-bondli.fun}"
EMAIL="${EMAIL:-admin@bondli.fun}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
NC="\033[0m"

log() { echo -e "${GREEN}[BONDLI]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── FRESH INSTALL ────────────────────
fresh_install() {
  log "Starting fresh deployment of bondli.fun..."

  # 1. System deps
  log "Installing system dependencies..."
  sudo apt update && sudo apt upgrade -y
  sudo apt install -y curl git ufw fail2ban docker.io docker-compose-plugin

  # 2. Firewall
  log "Configuring firewall..."
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow ssh
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw --force enable
  log "Firewall: SSH + HTTP + HTTPS only"

  # 3. Fail2ban
  log "Configuring fail2ban..."
  sudo systemctl enable fail2ban
  sudo systemctl start fail2ban

  # 4. Non-root docker
  sudo usermod -aG docker $USER
  log "Added $USER to docker group (re-login may be needed)"

  # 5. Check env
  if [ ! -f "$PROJECT_DIR/.env.production" ]; then
    err ".env.production not found! Copy .env.example and fill in your secrets."
  fi

  # 6. Build frontend
  log "Building frontend..."
  cd "$PROJECT_DIR/app"
  npm ci
  npm run build
  cd "$PROJECT_DIR"

  # 7. SSL cert (initial)
  setup_ssl

  # 8. Launch containers
  log "Starting Docker containers..."
  cd "$PROJECT_DIR/deploy"
  docker compose up -d --build
  
  log "Waiting for services..."
  sleep 5

  # 9. Health check
  if curl -sf http://localhost:3001/api/health > /dev/null; then
    log "${GREEN}API is healthy!${NC}"
  else
    warn "API health check failed. Check logs: docker compose logs bondli"
  fi

  log ""
  log "==========================================="
  log "  BONDLI.FUN DEPLOYED SUCCESSFULLY"
  log "==========================================="
  log "  Domain: https://${DOMAIN}"
  log "  API:    https://${DOMAIN}/api/health"
  log "  Logs:   cd deploy && docker compose logs -f"
  log "==========================================="
}

# ── UPDATE (rebuild + restart) ───────
update() {
  log "Updating bondli.fun..."
  
  cd "$PROJECT_DIR/app"
  npm ci
  npm run build

  cd "$PROJECT_DIR/deploy"
  docker compose up -d --build
  
  sleep 3
  if curl -sf http://localhost:3001/api/health > /dev/null; then
    log "Update successful! API is healthy."
  else
    warn "Health check failed after update."
  fi
}

# ── SSL SETUP ────────────────────────
setup_ssl() {
  log "Setting up SSL for ${DOMAIN}..."
  
  mkdir -p "$PROJECT_DIR/deploy/certbot/conf"
  mkdir -p "$PROJECT_DIR/deploy/certbot/www"
  
  # Get cert via standalone (nginx not running yet for fresh install)
  docker run -it --rm -p 80:80 \
    -v "$PROJECT_DIR/deploy/certbot/conf:/etc/letsencrypt" \
    -v "$PROJECT_DIR/deploy/certbot/www:/var/www/certbot" \
    certbot/certbot certonly \
    --standalone \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --email "$EMAIL" \
    --agree-tos \
    --no-eff-email

  log "SSL certificate obtained!"
}

# ── STATUS ───────────────────────────
status() {
  log "bondli.fun Status:"
  echo ""
  cd "$PROJECT_DIR/deploy"
  docker compose ps
  echo ""
  
  if curl -sf http://localhost:3001/api/health > /dev/null; then
    echo -e "API: ${GREEN}HEALTHY${NC}"
  else
    echo -e "API: ${RED}DOWN${NC}"
  fi
  
  echo ""
  docker compose logs --tail=20 bondli 2>/dev/null || true
}

# ── LOGS ─────────────────────────────
logs() {
  cd "$PROJECT_DIR/deploy"
  docker compose logs -f --tail=100 bondli
}

# ── MAIN ─────────────────────────────
case "${1:-help}" in
  fresh)   fresh_install ;;
  update)  update ;;
  ssl)     setup_ssl ;;
  status)  status ;;
  logs)    logs ;;
  *)
    echo "Usage: $0 {fresh|update|ssl|status|logs}"
    echo ""
    echo "  fresh   - Full first-time deployment"
    echo "  update  - Rebuild and restart"
    echo "  ssl     - Setup/renew SSL certificate"
    echo "  status  - Show service status"
    echo "  logs    - Tail API logs"
    ;;
esac
