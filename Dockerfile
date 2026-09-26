# WARNING: Railway does NOT use this file. railway/railway.json specifies dockerfile = Dockerfile.api
# for the API service. This root Dockerfile is kept only for local development convenience.
# Always fix PNL-card/canvas issues in docker/Dockerfile.api, NOT here.

# Multi-service build: turbo outputs to packages/<svc>/dist (NOT /app/dist),
# so the previous `COPY --from=builder /app/dist` copied nothing / failed the
# build, and `node dist/index.js` pointed at a file that never existed.
#
# Default CMD is the API service — detector/executor/triggers images should
# override CMD (see docker/Dockerfile.*).

FROM node:20-alpine AS builder
WORKDIR /app

# Copy root and all workspace manifests so npm ci can resolve all workspace dependencies
COPY package.json package-lock.json* ./
COPY packages/api/package.json ./packages/api/
COPY packages/contract/package.json ./packages/contract/
COPY packages/db/package.json ./packages/db/
COPY packages/detector/package.json ./packages/detector/
COPY packages/executor/package.json ./packages/executor/
COPY packages/shared/package.json ./packages/shared/
COPY packages/triggers/package.json ./packages/triggers/

# Install dependencies for all workspaces
RUN npm ci

# Install canvas native build dependencies (required to compile canvas npm package)
RUN apk add --no-cache python3 make g++ pkgconfig pixman-dev cairo-dev pango-dev

# Copy full source tree
COPY . .

# Build all TypeScript packages (contract is excluded via package.json build script)
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install canvas runtime shared libraries (canvas's native addon needs .so files at runtime)
RUN apk add --no-cache cairo pango pixman giflib libjpeg-turbo librsvg

# Copy all files including built dist directories and node_modules
COPY --from=builder /app ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "packages/api/dist/index.js"]
