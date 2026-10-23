# PHPUnit + PHPCS + Plugin Check runner for the WordPress plugin (S8-03, S8-F15). The plugin source is copied in (no bind
# mounts), so the same image runs locally (`pnpm wp:test`) and in CI; the Composer layer is rebuilt only when composer.*
# changes. WP-CLI, a WordPress core and the Plugin Check plugin are pinned and baked in below (dev tooling only).
FROM php:8.3-cli@sha256:60a100afa8efd88c0f556ce60e891c9bb8b1e8bca15721e4db07eca4fa79c07a
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && docker-php-ext-install mysqli \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2.8@sha256:5248900ab8b5f7f880c2d62180e40960cd87f60149ec9a1abfd62ac72a02577c /usr/bin/composer /usr/bin/composer
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_CACHE_DIR=/tmp/composer-cache

# WP-CLI (make-pot / make-json / plugin check), a WordPress core to run it against, and Plugin Check: all pinned by
# version and checksum. Bump them together with composer.json's wordpress version.
ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832
ARG WP_VERSION=6.8.3
ARG PLUGIN_CHECK_VERSION=2.1.0
ARG PLUGIN_CHECK_SHA256=6ff4bd2145f3befcf907df158cc466b1649dafed5686de8369907403c3013fc4
RUN echo "memory_limit=512M" > /usr/local/etc/php/conf.d/zz-memory.ini \
  && curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" \
  && echo "${WP_CLI_SHA512}  /usr/local/bin/wp" | sha512sum -c - \
  && chmod +x /usr/local/bin/wp \
  && wp --allow-root --path=/opt/wp-check core download --version="${WP_VERSION}" \
  && curl -fsSL -o /tmp/plugin-check.zip "https://downloads.wordpress.org/plugin/plugin-check.${PLUGIN_CHECK_VERSION}.zip" \
  && echo "${PLUGIN_CHECK_SHA256}  /tmp/plugin-check.zip" | sha256sum -c - \
  && unzip -q /tmp/plugin-check.zip -d /opt/wp-check/wp-content/plugins \
  && rm /tmp/plugin-check.zip

WORKDIR /app
COPY composer.json composer.lock* ./
RUN --mount=type=cache,target=/tmp/composer-cache composer install --no-interaction --no-progress --prefer-dist
COPY . .
CMD ["sh", "-c", "composer lint && composer test && composer test:multisite && composer plugin-check"]
