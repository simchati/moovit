FROM node:22-alpine

# unzip : extraction de stops.txt depuis le GTFS du ministère
RUN apk add --no-cache unzip

WORKDIR /app
COPY package.json server.js stops.js ./
COPY public ./public
COPY views ./views
RUN mkdir -p data && chown node:node data

USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1

# Les variables (MOT_KEY, MOT_BASE_URL, APP_PASSWORD) sont injectées par Coolify
CMD ["node", "server.js"]
