FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions
ENV TZ=America/Sao_Paulo

COPY package*.json ./

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm ci

COPY . .

# Build the project
RUN npm run build

# Remove development dependencies
RUN npm prune --omit=dev

RUN mkdir -p /app/sessions

EXPOSE 3000

CMD ["npm", "start"]
