FROM denoland/deno:2.9.6
WORKDIR /app
RUN chown deno:deno /app
COPY --chown=deno:deno deno.json deno.lock tsconfig.eslint.json drizzle.config.ts ./
COPY --chown=deno:deno drizzle ./drizzle
COPY --chown=deno:deno src ./src
USER deno
RUN deno install --allow-scripts
RUN deno cache src/cli.ts
CMD ["deno", "task", "serve"]
