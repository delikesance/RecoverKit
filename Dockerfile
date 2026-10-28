# Image tout-en-un : PostgreSQL 16 + site (Next.js) + worker, supervisés par docker/entrypoint.sh.
# Un seul port : 3000/tcp (HTTP). Le HTTPS est géré en amont. PostgreSQL n'écoute que sur 127.0.0.1.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Aucune variable d'environnement n'est nécessaire au build : la configuration est lue au démarrage.
RUN npm run build --workspace @recoverkit/web

FROM node:22-bookworm-slim AS run
# PostgreSQL 16 depuis le dépôt officiel PGDG. On part de l'image Node et non de postgres:16, car cette
# dernière déclare EXPOSE 5432, impossible à retirer : l'image ne doit exposer que 3000/tcp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common tini \
 && sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-16 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/16/bin:$PATH

WORKDIR /app
# node_modules reste nécessaire : le worker et les migrations tournent via tsx.
COPY --from=build --chown=postgres:postgres /app ./
COPY --chown=postgres:postgres docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod 0755 /app/docker/entrypoint.sh \
 && mkdir -p /var/lib/postgresql/data \
 && chown postgres:postgres /var/lib/postgresql/data \
 && chmod 0700 /var/lib/postgresql/data

ENV NODE_ENV=production \
    PORT=3000 \
    PGDATA=/var/lib/postgresql/data

# Les données (base, mot de passe interne, TOKEN_SECRET généré) vivent dans ce volume.
VOLUME /var/lib/postgresql/data
EXPOSE 3000
USER postgres
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]
