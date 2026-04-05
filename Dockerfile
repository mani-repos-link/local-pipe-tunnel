FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY data/routes.example.json ./data/routes.example.json

RUN mkdir -p /app/data \
  && cp /app/data/routes.example.json /app/data/routes.json \
  && chmod +x /app/scripts/hash-password.js

ENV NODE_ENV=production
ENV PORT=8080
ENV CONFIG_PATH=/app/data/routes.json
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then((res)=>{if(!res.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
