/**
 * Apple Maps links, in the form Messages renders as a tappable place card.
 *
 * The alternative Edmund had was pasting a plain URL — or worse, typing an
 * address as prose that the recipient has to select, copy and paste into Maps.
 * A recommendation someone has to retype is a recommendation with friction on
 * it, and he gives a lot of them: "Sabrina's in Fairmount, big portions" is
 * the useful half of an answer whose other half is getting there.
 *
 * Parameter semantics are Apple's (Map Links, iPhone URL Scheme Reference):
 *   `address`  shows exactly this location, WITHOUT running a search
 *   `ll`       pins exact coordinates
 *   `q`        a search query on its own, but a LABEL when address or ll is
 *              also present — which is why a name plus an address gives a card
 *              titled with the place rather than the street
 *
 * Coordinates win when present: an address string is geocoded on the
 * recipient's device and can land on the wrong "Main St", while a lat/long
 * cannot. The name is still passed as the label so the card reads as a place.
 */

export type MapPlace = {
  /** Display name — "Sabrina's Cafe". Becomes the card's title. */
  name?: string;
  /** Street address. Shown as-is, not searched. */
  address?: string;
  latitude?: number;
  longitude?: number;
};

export class MapLinkError extends Error {}

/** Build a maps.apple.com URL for a place. Throws if it names nothing. */
export function appleMapsLink(place: MapPlace): string {
  const params = new URLSearchParams();
  const hasCoords =
    typeof place.latitude === "number" &&
    typeof place.longitude === "number" &&
    Number.isFinite(place.latitude) &&
    Number.isFinite(place.longitude);

  if (hasCoords) {
    if (Math.abs(place.latitude!) > 90 || Math.abs(place.longitude!) > 180) {
      throw new MapLinkError(
        `latitude/longitude out of range (${place.latitude}, ${place.longitude})`,
      );
    }
    params.set("ll", `${place.latitude},${place.longitude}`);
  } else if (place.address?.trim()) {
    params.set("address", place.address.trim());
  }

  const name = place.name?.trim();
  if (name) params.set("q", name);

  // Nothing to point at. A bare maps.apple.com opens the app on the user's own
  // location, which is a worse outcome than telling the caller it failed.
  if (!params.has("ll") && !params.has("address")) {
    if (!name) throw new MapLinkError("need at least a name, an address, or coordinates");
    // Name only: `q` alone is a search, which is the correct fallback — Maps
    // will find "Sabrina's Cafe Philadelphia" the way a person would.
  }

  // URLSearchParams encodes spaces as "+", which Maps accepts, but %20 is what
  // Apple's own share sheet emits and it survives more link parsers intact.
  return `https://maps.apple.com/?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Whether Messages will render a link as a preview card.
 *
 * It only does so when the message body is the URL and nothing else. A single
 * trailing word turns the card into plain blue text, which is exactly the
 * outcome this feature exists to avoid — so callers send commentary as its own
 * message rather than appending it.
 */
export function isBareLink(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

/**
 * Does this text contain a street address written out as prose?
 *
 * Pure telemetry, deliberately not a gate. The rule that addresses go out as
 * Maps cards lives in the prompt, and a prompt rule is a hope until something
 * counts it — this is what lets "does he actually do it" be answered from the
 * log rather than from impressions. It does not rewrite or block anything:
 * a false positive would otherwise cost a real message.
 *
 * Matches a house number followed by a street word, which is the shape that
 * benefits from a card. Deliberately misses bare place names ("meet at
 * Cosmic") — those are not addresses and a card is optional there.
 */
const STREET_RE = new RegExp(
  [
    "\\b\\d{1,5}\\s+", // house number
    "(?:[NSEW]\\.?\\s+)?", // optional direction: N, S.E, etc
    // Street name: capitalised words OR a numbered street ("27th", "5th") —
    // the numbered form is why "910 N 27th St" was missed by a pattern that
    // required the name to begin with a capital letter.
    "(?:\\d{1,3}(?:st|nd|rd|th)|[A-Z][A-Za-z.'-]*)",
    "(?:\\s+(?:\\d{1,3}(?:st|nd|rd|th)|[A-Z][A-Za-z.'-]*)){0,3}\\s+",
    "(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court",
    "|Pl|Place|Pike|Hwy|Highway|Terr|Terrace|Cir|Circle|Sq|Square)\\b\\.?",
  ].join(""),
);

export function looksLikeStreetAddress(text: string): boolean {
  return STREET_RE.test(text);
}

/** Whether a message already carries a Maps link. */
export function hasMapsLink(text: string): boolean {
  return /https?:\/\/maps\.apple\.com\//i.test(text);
}
