#!/usr/bin/env bash
# Aktualisierung einer bestehenden Installation (siehe docs/installation-ionos.md, Abschnitt „Aktualisieren“).
# Aufruf auf dem Server als root: bash /opt/verve-sales/scripts/update-server.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/verve-sales}"
ENV_FILE="$APP_DIR/.env.production"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/verve-sales}"
cd "$APP_DIR"
[ -f "$ENV_FILE" ] || { echo "Fehlt: $ENV_FILE"; exit 1; }

echo "== 1/4 Sicherung vor dem Update (verschlüsselt)"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
chmod +x "$APP_DIR/scripts/backup-cron.sh"
"$APP_DIR/scripts/backup-cron.sh" "$APP_DIR" "$ENV_FILE" "$BACKUP_DIR" 14 verve-sales-vor-update

echo "== 2/4 Neuen Stand holen"
git pull --ff-only

echo "== 3/4 Neu bauen und starten (Migrationen laufen beim Start)"
docker compose --env-file "$ENV_FILE" up -d --build

echo "== 4/4 Gesundheitsprüfung"
for i in $(seq 1 60); do
  if docker compose --env-file "$ENV_FILE" exec -T app node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then echo "Anwendung läuft."; exit 0; fi
  sleep 3
done
echo "Anwendung meldet sich nicht. Logs: docker compose --env-file $ENV_FILE logs app"
exit 1
