FROM node:22-alpine AS build
WORKDIR /app
# python3 + build tools are required to compile better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Dev stage: full deps + tsx, source is bind-mounted at runtime for live reload
FROM node:22-alpine AS dev
WORKDIR /app
# python3 + build tools are required to compile better-sqlite3 (native module)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
EXPOSE 8080
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
# python3 + build tools required for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
COPY providers.json ./
# /app/data is the persistent volume mount point for usage.db
RUN mkdir -p /app/data && chown app:app /app/data
USER app
EXPOSE 8080
ENV NODE_ENV=production
ENV USAGE_DB_PATH=/app/data/usage.db
CMD ["node", "dist/index.js"]
