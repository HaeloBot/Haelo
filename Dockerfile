# syntax=docker/dockerfile:1
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production HAELO_CONFIG=/config/haelo.yaml
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Run as the unprivileged "node" user. State (audit log, tokens, policy lock) lives in a volume.
RUN mkdir -p /state /config && chown -R node:node /state /config
USER node
VOLUME ["/state", "/config"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Inside a container the process must listen on all interfaces; publish the port to loopback only:
#   docker run -p 127.0.0.1:8787:8787 ...
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--http", "--host", "0.0.0.0", "--allow-remote"]
