FROM node:20-slim

WORKDIR /app

ENV TZ=America/Sao_Paulo

COPY package*.json ./

RUN npm ci --include=dev

COPY . .

# Build the project
RUN npm run build

# Remove development dependencies
RUN npm prune --production

ENV NODE_ENV=production

CMD ["npm", "start"]
