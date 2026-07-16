FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Dev stage: full deps + tsx, source is bind-mounted at runtime for live reload
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
EXPOSE 8080
ENV NODE_ENV=development
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
COPY providers.json ./
USER app
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
