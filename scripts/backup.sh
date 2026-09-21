#!/bin/sh
# Sicherung der PostgreSQL-Datenbank (Briefing 17.4). Erzeugt ein komprimiertes Custom-Format-Dump und
# verschlüsselt es anschließend symmetrisch mit GPG (AES-256) – Sicherungen enthalten personenbezogene
# Daten (docs/pilotfreigabe-vorschlag.md Abschnitt 9). Bewusst KEINE Pipe "pg_dump | gpg": /bin/sh (dash
# auf Debian/Ubuntu) kennt kein "pipefail", ein fehlgeschlagener pg_dump würde in einer Pipe verschluckt
# und gpg würde aus leerer Eingabe klaglos eine gültige, aber leere "Sicherung" schreiben. Deshalb erst in
# eine Datei mit eingeschränkten Rechten dumpen (Fehler bricht hier sofort ab), dann verschlüsseln, dann
# die Klartextdatei entfernen.
# Aufruf: DATABASE_URL=postgresql://… BACKUP_ENCRYPTION_PASSPHRASE=… sh scripts/backup.sh [Zielverzeichnis]
set -eu
: "${DATABASE_URL:?DATABASE_URL fehlt}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE fehlt (siehe docs/betrieb.md Abschnitt 5)}"
DIR="${1:-./backups}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/verve-sales-$STAMP.dump.gpg"
PASSFILE="$(mktemp)"
PLAIN="$(mktemp)"
chmod 600 "$PASSFILE" "$PLAIN"
trap 'rm -f "$PASSFILE" "$PLAIN"' EXIT
printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" > "$PASSFILE"
pg_dump --format=custom --no-owner --no-privileges --file="$PLAIN" "$DATABASE_URL"
gpg --batch --yes --passphrase-file "$PASSFILE" --pinentry-mode loopback --symmetric --cipher-algo AES256 -o "$OUT" "$PLAIN"
sha256sum "$OUT" > "$OUT.sha256"
echo "Sicherung geschrieben (verschlüsselt): $OUT"
