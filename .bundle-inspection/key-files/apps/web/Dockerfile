FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm install --no-audit --no-fund --offline || npm install --no-audit --no-fund
EXPOSE 5173
CMD ["npm", "run", "dev", "-w", "@rcs/web", "--", "--host", "0.0.0.0", "--port", "5173"]
