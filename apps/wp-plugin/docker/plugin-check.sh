#!/bin/sh
# WordPress Plugin Check (S8-F15) against the plugin as it ships: the files `ops:wp-plugin-release` puts in the zip
# (dev files excluded), installed into the WordPress baked into the image. Fails on any error or warning.
# Two WordPress.org-only checks are excluded: the plugin is distributed from the Inmolink update server (signed
# packages, Update URI header), so the updater ban and the readme.txt requirement do not apply.
set -eu
WP="wp --allow-root --path=/opt/wp-check"
HOST="${WP_TESTS_DB_HOST:-127.0.0.1}"

$WP config create --dbname=wp_tests --dbuser=root --dbpass=root --dbhost="$HOST" --dbprefix=chk_ --skip-check --force
$WP core install --url=http://example.org --title=PluginCheck --admin_user=admin --admin_password=admin --admin_email=admin@example.org --skip-email

dest=/opt/wp-check/wp-content/plugins/inmolink
rm -rf "$dest"
mkdir -p "$dest"
tar -C /app \
  --exclude=./vendor --exclude=./tests --exclude=./docker --exclude=./composer.json --exclude=./composer.lock \
  --exclude=./phpunit.xml.dist --exclude=./phpunit.multisite.xml.dist --exclude=./phpcs.xml.dist \
  --exclude=./docker-compose.test.yml --exclude=./.gitignore --exclude=./.dockerignore --exclude=./.phpunit.result.cache \
  -cf - . | tar -C "$dest" -xf -

$WP plugin activate plugin-check
out="$($WP plugin check inmolink --exclude-checks=plugin_updater,plugin_readme --format=json --require=/opt/wp-check/wp-content/plugins/plugin-check/cli.php 2>&1)" || true
printf '%s\n' "$out"
php -r '
$raw = file_get_contents( "php://stdin" );
preg_match_all( "/^FILE: .*$/m", $raw, $m );
$problems = 0;
foreach ( preg_split( "/\n/", $raw ) as $line ) {
	$j = json_decode( $line, true );
	if ( is_array( $j ) ) {
		$problems += count( $j );
	}
}
if ( $problems > 0 || false !== strpos( $raw, "Error:" ) ) {
	fwrite( STDERR, "Plugin Check reported $problems problem(s).\n" );
	exit( 1 );
}
echo "Plugin Check: clean.\n";
' <<EOT
$out
EOT
