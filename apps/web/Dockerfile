FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/web ./apps/web
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --workspace apps/web --workspace packages/core --include-workspace-root
RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
