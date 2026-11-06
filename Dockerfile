# syntax=docker/dockerfile:1

############################
# Build stage — pnpm monorepo
############################
FROM node:22-slim AS build
WORKDIR /app

# pnpm is required: the workspace uses pnpm catalogs (catalog:) and a
# postinstall guard that rejects npm/yarn installs.
RUN npm install -g pnpm@10.33.3

COPY . .

# Build-time Supabase configuration. Vite inlines VITE_* values into the
# client bundle. Values are also committed in artifacts/aani-social/.env, so
# the build works even when these args are not provided; when they are
# provided they take precedence over the .env file.
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG VITE_SUPABASE_PUBLISHABLE_KEY=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    NODE_ENV=production \
    CI=true

RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
RUN pnpm --filter @workspace/aani-social run build

############################
# Runtime stage — static SPA
############################
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=80 \
    STATIC_DIR=/app/public

COPY --from=build /app/artifacts/aani-social/dist/public ./public
COPY --from=build /app/scripts/serve-static.mjs ./serve-static.mjs

EXPOSE 80

# Serves ./public on 0.0.0.0:$PORT with SPA fallback for client-side routes.
CMD ["node", "serve-static.mjs", "./public"]
