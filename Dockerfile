FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for build
COPY package*.json ./
RUN npm ci

COPY . .

# Build TypeScript code
RUN npm run build

FROM node:20-alpine

# Use non-root user
USER node

WORKDIR /app

# Ensure we have our persistent directory
ENV SESSIONS_DIR=/app/sessions

# Copy built code and dependencies
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# We do not copy sessions, it will be a mounted volume from Back4App

EXPOSE 3000

# Optional: Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["npm", "start"]
