FROM node:20

WORKDIR /app

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions

COPY package*.json ./

# Setup cleanly
RUN npm install

COPY . .

# Build the project
RUN npm run build

# Remove development dependencies
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["npm", "start"]
