/** One place level as the read models and website DTOs carry it. */
type PlaceLevel = { name: string } | null | undefined;

export interface PlaceParts {
  area?: PlaceLevel;
  city?: PlaceLevel;
  region?: PlaceLevel;
  country?: PlaceLevel;
}

const DEFAULT_LEVELS = ['area', 'city', 'region'] as const;

/** A place as one line of text, smallest level first: "Marbella, Málaga". `levels` picks and orders the parts. */
export function placeText(place: PlaceParts, levels: readonly (keyof PlaceParts)[] = DEFAULT_LEVELS): string {
  return levels
    .map((level) => place[level]?.name)
    .filter((name): name is string => !!name)
    .join(', ');
}
