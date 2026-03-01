# Estágio de build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Estágio de produção
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions
RUN mkdir -p /app/sessions && chown node:node /app/sessions
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["npm", "start"]
