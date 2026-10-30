FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /var/data /app/data/export

ENV NODE_ENV=production
ENV PORT=10000
ENV DATA_DIR=/var/data

EXPOSE 10000
CMD ["node", "server/boot.js"]
