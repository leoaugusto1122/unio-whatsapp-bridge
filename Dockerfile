FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/sessions

COPY package*.json ./

# Install all dependencies (including dev) to allow build
RUN npm install

COPY . .

# Build step
RUN npm run build

# Prune devDependencies to keep container size small
RUN npm prune --omit=dev

# Create sessions directory and enforce permission specifically for it
RUN mkdir -p /app/sessions && chown node:node /app/sessions

# Back4app might have issues with strict USER directives during volume mounts if not previously created correctly,
# but we'll keep USER node for safety.
USER node

EXPOSE 3000

CMD ["npm", "start"]
