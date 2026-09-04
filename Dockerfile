# GBX Pipeline: Node server (API + shared SQLite state) serving the built PWA.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data TZ=Australia/Melbourne

# Server dependencies first so they cache independently of app edits.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# App source, then build the static bundle into dist/.
COPY . .
RUN sh build.sh

# SQLite database, VAPID keys and nightly backups live on a mounted volume.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["node", "server/index.js"]
