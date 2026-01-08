FROM node:18-alpine AS build

RUN apk --no-cache add git

WORKDIR /smartbed-mqtt

# Copy dependency manifests first
COPY package.json ./
COPY yarn.lock ./
COPY patches ./patches

# Install deps (deterministic if yarn.lock exists)
RUN yarn install

# Copy build sources
COPY src ./src
COPY tsconfig.build.json ./
COPY tsconfig.json ./

# Build
RUN yarn build:ci


# =========================
# Runtime stage
# =========================
FROM node:18-alpine

# Add env
ENV LANG=C.UTF-8

RUN apk add --no-cache bash curl jq && \
    curl -J -L -o /tmp/bashio.tar.gz "https://github.com/hassio-addons/bashio/archive/v0.13.1.tar.gz" && \
    mkdir /tmp/bashio && \
    tar zxvf /tmp/bashio.tar.gz --strip 1 -C /tmp/bashio && \
    mv /tmp/bashio/lib /usr/lib/bashio && \
    ln -s /usr/lib/bashio/bashio /usr/bin/bashio

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /smartbed-mqtt

COPY run.sh /smartbed-mqtt/
RUN chmod a+x /smartbed-mqtt/run.sh

# Copy build outputs from build stage
COPY --from=build /smartbed-mqtt/node_modules /smartbed-mqtt/node_modules
COPY --from=build /smartbed-mqtt/dist/tsc/ /smartbed-mqtt/

ENTRYPOINT ["/smartbed-mqtt/run.sh"]

LABEL \
  io.hass.name="Smartbed Integration via MQTT" \
  io.hass.description="Home Assistant Community Add-on for Smartbeds" \
  io.hass.type="addon" \
  io.hass.version="1.1.22" \
  maintainer="Richard Hopton <richard@thehoptons.com>"
