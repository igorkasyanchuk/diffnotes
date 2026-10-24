FROM node:24.15.0-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.15.0-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY server ./server
COPY skill ./skill
COPY docker-entrypoint.sh /usr/local/bin/diffnotes-entrypoint
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
# the app runs as `node`: the entrypoint fixes /data's owner, then drops root
ENTRYPOINT ["diffnotes-entrypoint"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "server/index.ts"]
