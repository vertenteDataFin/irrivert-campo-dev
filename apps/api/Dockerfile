FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace apps/api --workspace packages/core --include-workspace-root
ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
