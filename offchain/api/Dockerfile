FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY offchain/ ./offchain/
RUN npx tsc -p offchain/api/tsconfig.json

FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/offchain/api/dist ./offchain/api/dist

RUN mkdir -p /app/logs

ENV NODE_ENV=production

EXPOSE 7657

CMD ["node", "offchain/api/dist/api/server.js"]
