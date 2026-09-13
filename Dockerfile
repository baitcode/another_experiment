FROM denoland/deno:2.9.6
WORKDIR /app
COPY deno.json deno.lock tsconfig.eslint.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
RUN deno install --allow-scripts
RUN deno cache src/cli.ts
CMD ["deno", "task", "serve"]
