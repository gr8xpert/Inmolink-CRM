/**
 * A channel's name for the screen (S17-F37): brands keep the catalog name; the one generic channel is a plain phrase, so
 * it comes from the catalog of messages in the member's language.
 */
export function channelLabel(
  channel: { code: string; name: string } | undefined,
  fallback: string,
  genericXml: string,
): string {
  if (!channel) return fallback;
  return channel.code === 'generic-xml' ? genericXml : channel.name;
}
