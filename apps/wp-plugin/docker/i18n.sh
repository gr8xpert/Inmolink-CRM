#!/bin/sh
# Regenerates the translation files in languages/ (S8-F15, S8-F22) with WP-CLI: the .pot from the PHP, block.json and
# assets/editor.js; every .po merged with it; the .mo files and the JSON files the block editor loads for editor.js.
# Draft locales (a .po whose Last-Translator says DRAFT: keys present, no translations yet) get no .mo/.json, so
# WordPress falls back to the English source. Run it in the test image with languages/ mounted so the output lands in
# the repo, then commit the result:
#   docker compose -f apps/wp-plugin/docker-compose.test.yml run --rm -v "$PWD/apps/wp-plugin/languages:/app/languages" php sh docker/i18n.sh
# (Git Bash on Windows: use "$(pwd -W)/apps/..." and MSYS_NO_PATHCONV=1.)
set -eu
WP="wp --allow-root --path=/opt/wp-check"
cd /app
$WP i18n make-pot . languages/inmolink.pot --slug=inmolink --domain=inmolink \
  --exclude=vendor,tests,docker,languages --skip-audit \
  --headers='{"Report-Msgid-Bugs-To":"https://inmolink.es"}'
$WP i18n update-po languages/inmolink.pot languages
$WP i18n make-mo languages
$WP i18n make-json languages --no-purge
for po in languages/inmolink-*.po; do
  if grep -q '^"Last-Translator: DRAFT' "$po"; then
    base="${po%.po}"
    rm -f "$base.mo" "$base"-*.json
  fi
done
