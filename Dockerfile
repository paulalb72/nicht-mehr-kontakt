FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node app.js smtp.js ./
RUN mkdir -p /app/data && chown node:node /app/data

USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_FILE=/app/data/optouts.json
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "if(process.env.HOST!=='0.0.0.0')process.exit(1);require('node:http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "app.js", "serve"]
