#!/bin/sh
# Wiederherstellung in eine LEERE Zieldatenbank (Wiederherstellungstest, S12).
# Aufruf: TARGET_DATABASE_URL=postgresql://… sh scripts/restore.sh backups/verve-sales-….dump
set -eu
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL fehlt}"
DUMP="${1:?Pfad zur Sicherung fehlt}"
if [ -f "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256"); fi
pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$DUMP"
echo "Wiederherstellung abgeschlossen. Prüfen: Anzahl Objekte, gesperrte/gelöschte Quellen (is_locked, '[Inhalt gelöscht]') und Protokoll müssen dem Sicherungsstand entsprechen."
