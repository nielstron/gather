FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG GATHER_BASE_PATH=
ENV GATHER_BASE_PATH=$GATHER_BASE_PATH
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV UV_THREADPOOL_SIZE=16 NODE_ENV=production HOST=0.0.0.0 PORT=3000 PHOTO_ROOT=/photos DATA_ROOT=/data
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY LICENSE ./LICENSE
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src/lib ./src/lib
ARG GATHER_BASE_PATH=
ENV GATHER_BASE_PATH=$GATHER_BASE_PATH
USER node
EXPOSE 3000
CMD ["node", "build"]
