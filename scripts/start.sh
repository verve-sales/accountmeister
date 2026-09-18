#!/bin/sh
# Startablauf Produktion: Konfigurationsprüfung → Migration → Anwendung.
set -eu
if [ "${AUTH_MODE:-development}" = "development" ]; then echo "Start verweigert: AUTH_MODE=development ist in Produktion nicht zulässig (S09)." >&2; exit 1; fi
if [ "${AI_PROVIDER:-disabled}" = "test" ]; then echo "Start verweigert: AI_PROVIDER=test ist in Produktion nicht zulässig (S09)." >&2; exit 1; fi
case "${SESSION_SECRET:-}" in entwicklung-*|build-only-*|"") echo "Start verweigert: SESSION_SECRET fehlt oder ist ein Beispielwert." >&2; exit 1;; esac
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Migrationen anwenden …"
  node scripts/migrate.mjs
fi
exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}"
