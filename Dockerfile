FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
# procps provides `ps`, which systeminformation's si.processes() shells out to.
# Without it the call fails silently and processes.{total,running} are stuck at 0.
RUN apk add --no-cache docker-cli docker-cli-compose procps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
