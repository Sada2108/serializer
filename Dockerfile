FROM oven/bun:1 AS base
WORKDIR /app

# ngspice is required by sim_server.ts (it shells out to the ngspice binary)
RUN apt-get update && apt-get install -y ngspice && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN bun install

COPY . .

EXPOSE 3777
CMD ["bun", "run", "dev-tools/sim_server.ts"]
