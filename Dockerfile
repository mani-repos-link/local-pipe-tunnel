FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY data/routes.example.json ./data/routes.example.json

RUN addgroup -S -g 10001 localpipe \
  && adduser -S -D -H -u 10001 -G localpipe localpipe \
  && mkdir -p /app/data \
  && cp /app/data/routes.example.json /app/data/routes.json \
  && chmod -R a+rX /app/scripts \
  && chown -R 10001:10001 /app

ENV NODE_ENV=production
ENV PORT=8030
ENV CONFIG_PATH=/app/data/routes.json
EXPOSE 8030

USER 10001:10001

CMD ["node", "src/server.js"]
