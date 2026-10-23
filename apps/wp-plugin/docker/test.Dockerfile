# PHPUnit + PHPCS runner for the WordPress plugin (S8-03). The plugin source is copied in (no bind mounts), so the
# same image runs locally (`pnpm wp:test`) and in CI; the Composer layer is rebuilt only when composer.* changes.
FROM php:8.3-cli@sha256:60a100afa8efd88c0f556ce60e891c9bb8b1e8bca15721e4db07eca4fa79c07a
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && docker-php-ext-install mysqli \
  && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2.8@sha256:5248900ab8b5f7f880c2d62180e40960cd87f60149ec9a1abfd62ac72a02577c /usr/bin/composer /usr/bin/composer
ENV COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_CACHE_DIR=/tmp/composer-cache
WORKDIR /app
COPY composer.json composer.lock* ./
RUN --mount=type=cache,target=/tmp/composer-cache composer install --no-interaction --no-progress --prefer-dist
COPY . .
CMD ["sh", "-c", "composer lint && composer test"]
