# Verve Sales – Produktionsabbild (Node 22, Next.js). Keine Geheimnisse im Abbild: alles über Umgebungsvariablen.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Bauzeit braucht keine echte Datenbank; Platzhalter nur für die Konfigurationsprüfung des Builds
ENV NODE_ENV=production DATABASE_URL=postgresql://build:build@localhost:5432/build AUTH_MODE=oidc AI_PROVIDER=disabled SESSION_SECRET=build-only-placeholder-secret-0123456789abcdef
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN groupadd -r verve && useradd -r -g verve -d /app verve
COPY --from=build --chown=verve:verve /app/package.json ./
COPY --from=build --chown=verve:verve /app/node_modules ./node_modules
COPY --from=build --chown=verve:verve /app/.next ./.next
COPY --from=build --chown=verve:verve /app/next.config.ts ./
COPY --from=build --chown=verve:verve /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=verve:verve /app/scripts ./scripts
USER verve
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Start: Migrationen anwenden (mit Prüfung), dann Anwendung. Unsichere Konfiguration bricht ab (S09).
CMD ["sh", "scripts/start.sh"]
