#!/bin/sh
# Sicherung der PostgreSQL-Datenbank (Briefing 17.4). Erzeugt ein komprimiertes Custom-Format-Dump.
# Aufruf: DATABASE_URL=postgresql://… sh scripts/backup.sh [Zielverzeichnis]
set -eu
: "${DATABASE_URL:?DATABASE_URL fehlt}"
DIR="${1:-./backups}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/verve-sales-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL"
sha256sum "$OUT" > "$OUT.sha256"
echo "Sicherung geschrieben: $OUT"
# Hinweis: Sicherungen enthalten personenbezogene Daten. Verschlüsselt ablegen, Zugriff begrenzen,
# Aufbewahrung nach Löschkonzept (offene Entscheidung, siehe docs/entscheidungsprotokoll.md).
