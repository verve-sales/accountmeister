#!/bin/bash
# Einmalige Einrichtung auf einem frischen Ubuntu-/Debian-Server (z. B. IONOS Cloud Server).
# Ausführen als root:  bash install-server.sh
# Das Skript installiert Docker, holt den Quellcode, fragt die Konfiguration ab, startet die Anwendung
# und richtet eine tägliche Sicherung ein. Es kann gefahrlos erneut ausgeführt werden.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/verve-sales/accountmeister.git}"
APP_DIR="${APP_DIR:-/opt/verve-sales}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/verve-sales}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local var="$1" prompt="$2" default="${3:-}" val; if [ -n "$default" ]; then read -r -p "$prompt [$default]: " val; val="${val:-$default}"; else while [ -z "${val:-}" ]; do read -r -p "$prompt: " val; done; fi; printf -v "$var" '%s' "$val"; }

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen (sudo -i)."; exit 1; }

say "1/6 Systempakete und Docker"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw openssl >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || { echo "Docker Compose fehlt – bitte Docker-Installation prüfen."; exit 1; }

say "2/6 Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

say "3/6 Quellcode"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  echo "Das Repository ist privat. Beim Klonen nach Benutzername (GitHub-Name) und Passwort fragen:"
  echo "als Passwort ein GitHub Personal Access Token einfügen (Anleitung in docs/installation-ionos.md, Schritt 3)."
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

say "4/6 Konfiguration"
ENV_FILE="$APP_DIR/.env.production"
if [ -f "$ENV_FILE" ]; then
  echo "Vorhandene Konfiguration wird verwendet: $ENV_FILE"
else
  ask DOMAIN "Domain der Anwendung (z. B. accountmeister.verveconsulting.ai)"
  ask ADMIN_EMAILS "E-Mail-Adresse(n) der Betriebsverwaltung, kommagetrennt" "ivo.seifert@verveconsulting.de"
  ask TENANT_ID "Microsoft Entra: Verzeichnis-ID (Mandant)"
  ask OIDC_CLIENT_ID "Microsoft Entra: Anwendungs-ID (Client)"
  ask OIDC_CLIENT_SECRET "Microsoft Entra: Geheimer Clientschlüssel (Wert)"
  cat > "$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
AUTH_MODE=oidc
OIDC_ISSUER=https://login.microsoftonline.com/$TENANT_ID/v2.0
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET=$OIDC_CLIENT_SECRET
ADMIN_EMAILS=$ADMIN_EMAILS
OIDC_AUTO_CREATE_USERS=false
WORKSPACE_NAME=Verve Consulting
AI_PROVIDER=disabled
AI_DAILY_JOB_LIMIT=200
LANGDOCK_API_KEY=
LANGDOCK_BASE_URL=https://api.langdock.com/openai/eu/v1
LANGDOCK_DEFAULT_MODEL=gpt-4o-mini
MAX_UPLOAD_MB=25
SESSION_MAX_AGE_SECONDS=43200
SESSION_IDLE_SECONDS=7200
RATE_LIMIT_LOGIN_PER_15MIN=20
RATE_LIMIT_WRITES_PER_MIN=120
ENV
  chmod 600 "$ENV_FILE"
  echo "Konfiguration geschrieben: $ENV_FILE (nur root lesbar)"
fi

say "5/6 Anwendung bauen und starten (dauert beim ersten Mal einige Minuten)"
docker compose --env-file "$ENV_FILE" up -d --build
echo "Warte auf Gesundheitsprüfung …"
for i in $(seq 1 60); do
  if docker compose --env-file "$ENV_FILE" exec -T app node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then echo "Anwendung läuft."; break; fi
  sleep 3
  [ "$i" -eq 60 ] && { echo "Anwendung meldet sich nicht. Logs: docker compose --env-file $ENV_FILE logs app"; exit 1; }
done

say "6/6 Tägliche Sicherung (03:15 Uhr) und Aufbewahrung 14 Tage"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
cat > /etc/cron.d/verve-sales-backup <<CRON
15 3 * * * root cd $APP_DIR && docker compose --env-file $ENV_FILE exec -T db pg_dump -U verve -Fc verve_sales > $BACKUP_DIR/verve-sales-\$(date +\%Y\%m\%d).dump && docker compose --env-file $ENV_FILE exec -T app tar -C /data -czf - uploads > $BACKUP_DIR/verve-sales-uploads-\$(date +\%Y\%m\%d).tar.gz && find $BACKUP_DIR \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +14 -delete
CRON
chmod 644 /etc/cron.d/verve-sales-backup

DOMAIN_SHOW=$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)
say "Fertig."
echo "Aufrufen: https://$DOMAIN_SHOW  (das TLS-Zertifikat holt Caddy beim ersten Aufruf automatisch; DNS muss auf diesen Server zeigen)"
echo "Logs:      cd $APP_DIR && docker compose --env-file .env.production logs -f"
echo "Update:    cd $APP_DIR && git pull && docker compose --env-file .env.production up -d --build"
echo "Sicherung: $BACKUP_DIR (täglich 03:15 Uhr). Bitte zusätzlich regelmäßig an einen zweiten Ort kopieren."
