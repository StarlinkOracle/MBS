FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm install --no-audit --no-fund --offline || npm install --no-audit --no-fund
RUN npm run prisma:generate -w @rcs/db
CMD ["npm", "run", "start", "-w", "@rcs/worker"]
