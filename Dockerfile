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

# Copy full source tree
COPY . .

# Build all TypeScript packages (contract is excluded via package.json build script)
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy all files including built dist directories and node_modules
COPY --from=builder /app ./

EXPOSE 3000

CMD ["node", "packages/api/dist/index.js"]