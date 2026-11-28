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

# Public front-end build settings (NOT secrets: Vite inlines them into the
# client bundle, and both are meant to be readable in the browser).
#
#   * VITE_TURNSTILE_SITE_KEY — the Turnstile site key (public by design). With
#     no value the client loads no widget and tells the visitor that CAPTCHA is
#     not configured; it never pretends the check is live.
#   * VITE_AUTH_ALLOWED_ORIGINS — comma-separated extra origins allowed to
#     receive the OAuth return (the published origin is already allowed in
#     src/lib/oauthRedirect.ts).
#
# Render passes a service's environment variables as Docker build args of the
# same name, but only when the Dockerfile declares them. Without these two ARGs
# the values never reach the Vite build, so the published site would silently
# ship with no CAPTCHA and no extra allowed origin.
ARG VITE_TURNSTILE_SITE_KEY=
ARG VITE_AUTH_ALLOWED_ORIGINS=

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_IMAGEKIT_SIGNED_URLS=$VITE_IMAGEKIT_SIGNED_URLS \
    VITE_IMAGEKIT_PRIVATE_UPLOADS=$VITE_IMAGEKIT_PRIVATE_UPLOADS \
    VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY \
    VITE_AUTH_ALLOWED_ORIGINS=$VITE_AUTH_ALLOWED_ORIGINS \
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
