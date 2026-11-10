# Сборка: ставим devDependencies (typescript) и компилируем в dist/
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Финальный образ: скомпилированный JS + resvg (рисует карточки) + шрифты.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# su-exec — чтобы после chown тома переключиться с root на node.
RUN apk add --no-cache su-exec

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY assets ./assets
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh \
	&& mkdir -p /app/data \
	&& chown -R node:node /app

# Стартуем от root только чтобы починить права на смонтированный ./data,
# дальше entrypoint сразу делает su-exec на node.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
