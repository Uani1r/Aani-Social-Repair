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

# ImageKit signed-URL switches (booleans, not secrets: Vite inlines them into
# the client bundle). Default false, so a build without these args keeps the
# current public-URL behaviour. Render has to pass "true" explicitly for the
# front end to start requesting signatures.
ARG VITE_IMAGEKIT_SIGNED_URLS=false
ARG VITE_IMAGEKIT_PRIVATE_UPLOADS=false

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_IMAGEKIT_SIGNED_URLS=$VITE_IMAGEKIT_SIGNED_URLS \
    VITE_IMAGEKIT_PRIVATE_UPLOADS=$VITE_IMAGEKIT_PRIVATE_UPLOADS \
    NODE_ENV=production \
    CI=true

RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false
RUN pnpm --filter @workspace/aani-social run build
RUN pnpm --filter @workspace/api-server run build

############################
# Runtime stage — API, FFmpeg and static SPA
############################
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

COPY --from=build /app/artifacts/api-server/dist ./dist
COPY --from=build /app/artifacts/aani-social/dist/public ./dist/public

EXPOSE 8080

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
