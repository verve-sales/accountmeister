#!/bin/sh
# Täglicher Sicherungslauf für eine laufende Installation (eingerichtet von scripts/install-server.sh als
# Cron-Job; wird auch von scripts/update-server.sh vor jedem Update aufgerufen). Sichert Datenbank und
# Dokumentenvolume aus den laufenden Containern und legt beide GPG-verschlüsselt ab (AES-256, symmetrisch,
# Passphrase aus BACKUP_ENCRYPTION_PASSPHRASE in der Konfigurationsdatei) – siehe docs/betrieb.md Abschnitt 5.
# Aufruf: sh backup-cron.sh <APP_DIR> <ENV_FILE> <BACKUP_DIR> [KEEP_DAYS] [DATEINAME_PRAEFIX]
set -eu
APP_DIR="${1:?APP_DIR fehlt}"
ENV_FILE="${2:?ENV_FILE fehlt}"
BACKUP_DIR="${3:?BACKUP_DIR fehlt}"
KEEP_DAYS="${4:-14}"
PREFIX="${5:-verve-sales}"

[ -f "$ENV_FILE" ] || { echo "Fehlt: $ENV_FILE" >&2; exit 1; }
PASSPHRASE="$(grep '^BACKUP_ENCRYPTION_PASSPHRASE=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$PASSPHRASE" ]; then
  echo "BACKUP_ENCRYPTION_PASSPHRASE fehlt in $ENV_FILE – Sicherung abgebrochen (siehe docs/betrieb.md Abschnitt 5)." >&2
  exit 1
fi
PASSFILE="$(mktemp)"
PLAIN_DB="$(mktemp)"
PLAIN_UP="$(mktemp)"
chmod 600 "$PASSFILE" "$PLAIN_DB" "$PLAIN_UP"
trap 'rm -f "$PASSFILE" "$PLAIN_DB" "$PLAIN_UP"' EXIT
printf '%s' "$PASSPHRASE" > "$PASSFILE"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Bewusst KEINE Pipe "docker compose exec ... | gpg": /bin/sh kennt kein "pipefail", ein fehlgeschlagener
# pg_dump/tar im Container würde sonst verschluckt und gpg würde aus leerer Eingabe eine gültige, aber
# leere "Sicherung" schreiben. Deshalb erst mit ">" in eine Datei mit eingeschränkten Rechten leiten
# (ein Fehler bricht hier dank "set -e" sofort ab), dann verschlüsseln.
docker compose --env-file "$ENV_FILE" exec -T db pg_dump -U verve -Fc verve_sales > "$PLAIN_DB"
gpg --batch --yes --passphrase-file "$PASSFILE" --pinentry-mode loopback --symmetric --cipher-algo AES256 \
    -o "$BACKUP_DIR/$PREFIX-$STAMP.dump.gpg" "$PLAIN_DB"

if docker compose --env-file "$ENV_FILE" exec -T app sh -c 'test -d /data/uploads' 2>/dev/null; then
  docker compose --env-file "$ENV_FILE" exec -T app tar -C /data -czf - uploads > "$PLAIN_UP"
  gpg --batch --yes --passphrase-file "$PASSFILE" --pinentry-mode loopback --symmetric --cipher-algo AES256 \
      -o "$BACKUP_DIR/$PREFIX-uploads-$STAMP.tar.gz.gpg" "$PLAIN_UP"
fi

find "$BACKUP_DIR" \( -name '*.dump.gpg' -o -name '*.tar.gz.gpg' \) -mtime "+$KEEP_DAYS" -delete

echo "Sicherung geschrieben: $BACKUP_DIR/$PREFIX-$STAMP.dump.gpg"
