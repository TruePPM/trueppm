# Dev stage — Vite dev server with HMR.
# Source is bind-mounted from the host; no COPY of src needed here.
FROM node:22-alpine AS dev

WORKDIR /app
COPY package.json ./
RUN npm install

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build stage — compiles the production bundle.
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# Serve stage (default) — nginx serves the pre-built bundle.
# Used by docker-compose.prod.yml via the web-build init pattern.
#
# nginx-unprivileged runs as a non-root user (uid 101) and listens on an
# unprivileged port (8080) — see nginx.conf. The reverse proxy in
# docker-compose.prod.yml maps host 80 -> container 8080.
FROM nginxinc/nginx-unprivileged:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Explicit non-root user (the base image already sets this; declared here so the
# container's effective user is unambiguous and never root).
USER 101

EXPOSE 8080
