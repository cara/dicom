# Baut die App und liefert sie über nginx aus (z. B. als Portainer-Stack).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
