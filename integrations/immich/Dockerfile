FROM node:22-bookworm-slim AS compiler
RUN apt-get update -qq && apt-get install -y --no-install-recommends patch ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /compiler --no-package-lock --ignore-scripts typescript@npm:@typescript/typescript6@6.0.2
WORKDIR /upstream
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/controllers/library.controller.ts server/src/controllers/library.controller.ts
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/dtos/library.dto.ts server/src/dtos/library.dto.ts
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/repositories/library.repository.ts server/src/repositories/library.repository.ts
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/services/library.service.ts server/src/services/library.service.ts
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/types.ts server/src/types.ts
ADD https://raw.githubusercontent.com/immich-app/immich/60b51cb3bc909e72fe963f4dfb1947515cb9ab3b/server/src/repositories/storage.repository.ts server/src/repositories/storage.repository.ts
COPY scan-path.patch build.cjs ./
RUN patch --batch -p1 < scan-path.patch && node build.cjs

FROM ghcr.io/immich-app/immich-server:v3.2.2@sha256:79cc1623323d5894922686d8743b4780181428f98eecbfb58ce12c41ef02d1ea
COPY --from=compiler /output/ /usr/src/app/server/dist/
COPY scan-path.patch /usr/src/app/gather-scan-path.patch
LABEL org.opencontainers.image.description="Immich v3.2.2 with scoped external-library scanning"
