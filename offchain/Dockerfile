# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY offchain/ ./offchain/
RUN npm run build

# Stage 2: run
FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p logs

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/api/server.js"]
