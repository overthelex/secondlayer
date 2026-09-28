# teamarea-api: node runs server.ts directly; apache2-utils brings htpasswd
# for bcrypt. Runs as node (uid 1000 = ubuntu on the box, owner of the
# htpasswd dir it rewrites).
FROM node:24-alpine
RUN apk add --no-cache apache2-utils && mkdir -p /data && chown node:node /data
COPY server.ts /app/server.ts
USER node
CMD ["node", "/app/server.ts"]
