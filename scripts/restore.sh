#!/bin/sh
# Wiederherstellung in eine LEERE Zieldatenbank (Wiederherstellungstest, S12). Entschlüsselt ein mit
# scripts/backup.sh erzeugtes .dump.gpg zuerst in eine temporäre Datei; ein älteres, unverschlüsseltes
# .dump wird unverändert eingespielt (Rückwärtskompatibilität mit Sicherungen von vor der Verschlüsselung).
# Aufruf: TARGET_DATABASE_URL=postgresql://… BACKUP_ENCRYPTION_PASSPHRASE=… sh scripts/restore.sh backups/verve-sales-….dump.gpg
set -eu
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL fehlt}"
DUMP="${1:?Pfad zur Sicherung fehlt}"
if [ -f "$DUMP.sha256" ]; then (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256"); fi

case "$DUMP" in
  *.gpg)
    : "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE fehlt (siehe docs/betrieb.md Abschnitt 5)}"
    PASSFILE="$(mktemp)"
    PLAIN="$(mktemp)"
    chmod 600 "$PASSFILE" "$PLAIN"
    trap 'rm -f "$PASSFILE" "$PLAIN"' EXIT
    printf '%s' "$BACKUP_ENCRYPTION_PASSPHRASE" > "$PASSFILE"
    gpg --batch --yes --passphrase-file "$PASSFILE" --pinentry-mode loopback --decrypt -o "$PLAIN" "$DUMP"
    pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$PLAIN"
    ;;
  *)
    pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" "$DUMP"
    ;;
esac
echo "Wiederherstellung abgeschlossen. Prüfen: Anzahl Objekte, gesperrte/gelöschte Quellen (is_locked, '[Inhalt gelöscht]') und Protokoll müssen dem Sicherungsstand entsprechen."
