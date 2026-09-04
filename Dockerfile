# GBX Pipeline — static preview image.
# Builds dist/ from wireframe.html + manifest + service worker + icons and
# serves it with Caddy on port 80 inside the compose network. The public
# hostname, TLS and auth are handled by the stack's front Caddy (see deploy/).
FROM caddy:2-alpine AS build
WORKDIR /src
COPY . .
RUN sh build.sh

FROM caddy:2-alpine
COPY deploy/Caddyfile.static /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
EXPOSE 80
