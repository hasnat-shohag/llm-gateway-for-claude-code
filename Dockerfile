FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

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
