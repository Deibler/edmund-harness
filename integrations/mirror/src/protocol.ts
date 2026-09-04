import { z } from "zod";

export const MIRROR_PROTOCOL_VERSION = 2 as const;

export const MirrorZoneSchema = z.enum([
  "top_bar",
  "top_left",
  "top_center",
  "top_right",
  "upper_third",
  "middle_center",
  "lower_third",
  "bottom_left",
  "bottom_center",
  "bottom_right",
  "bottom_bar",
  "fullscreen_above",
  "fullscreen_below",
]);

export const MirrorPresentationSchema = z.enum(["widget", "page", "slideshow"]);
export const MirrorLifespanSchema = z.enum(["ephemeral", "session", "persistent"]);

/**
 * Every visible field on a widget is display text, and a model writing a
 * temperature or a score reaches for a number: `temperature: 77`, not `"77"`.
 * Rejecting that cost a whole retry round-trip per widget for something that
 * renders identically either way. Accept the number and stringify it.
 *
 * Booleans and objects are deliberately NOT coerced — those signal the model
 * misunderstood the field, and an error is the right answer.
 *
 * The published JSON Schema still advertises `string` (the converter unwraps
 * ZodEffects to its inner type), so the model is steered toward strings and
 * merely forgiven for numbers.
 */
const numberAsText = (value: unknown): unknown =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : value;

const shortText = z.preprocess(numberAsText, z.string().trim().min(1).max(240));
const bodyText = z.preprocess(numberAsText, z.string().trim().min(1).max(4_000));
const optionalShortText = z.preprocess(
  numberAsText,
  z.string().trim().max(240).optional(),
) as z.ZodType<string | undefined>;
const PageSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/);
const ContentPageSchema = z.union([z.literal("*"), PageSchema]);
const ContentIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/);
const safeAssetUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      value.startsWith("http://127.0.0.1:") ||
      value.startsWith("http://localhost:") ||
      value.startsWith("/asset/") ||
      /^https:\/\/[^\s]+$/i.test(value),
    "URL must be an HTTPS URL or a local mirror asset URL",
  );

const TextPropsSchema = z.object({
  eyebrow: optionalShortText,
  title: optionalShortText,
  text: bodyText,
  tone: z.enum(["default", "muted", "accent", "success", "warning"]).default("default"),
});

/**
 * A list whose items can carry one supporting fact each.
 *
 * `items: string[]` forced everything into the sentence: "Milk — 2 left",
 * "Call the dentist — tomorrow". The renderer then had one blob per row and
 * nowhere to put the second half, so the fact you were scanning for was
 * buried mid-line at body weight, and a list of ten was ten sentences to
 * read rather than a column to glance down.
 *
 * The old shape still parses. A bare string becomes `{ text }`, which is the
 * same forgiveness `numberAsText` gives everywhere else here: every refresh
 * script and cron written against the array of strings keeps working, and
 * nothing has to be migrated to gain the rail.
 */
const ListPropsSchema = z.object({
  title: optionalShortText,
  items: z
    .array(
      z.preprocess(
        (value) =>
          typeof value === "string" || typeof value === "number" ? { text: String(value) } : value,
        z.object({ text: shortText, meta: optionalShortText }),
      ),
    )
    .min(1)
    .max(10),
  numbered: z.boolean().default(false),
});

const ImagePropsSchema = z.object({
  src: safeAssetUrl,
  alt: shortText,
  caption: optionalShortText,
  fit: z.enum(["contain", "cover"]).default("contain"),
  /**
   * Whether this image is a photograph or an artefact drawn on white.
   *
   * Behind two-way glass every lit pixel is haze in the room, so brightness
   * is not a style question. Measured on the glass with a severe-weather
   * radar tile up: the image band averaged **132.7** luminance against
   * **9.5–11.8** for every other band. Eleven to fourteen times the rest of
   * the interface, from one widget, in a dark bedroom.
   *
   * A photograph is mostly midtones and survives a light touch. A map, a
   * chart, a screenshot or a scan is mostly PAPER — a solid white field with
   * a little ink on it — and no amount of tasteful dimming makes a white
   * field anything but a lamp. They need different treatment, and the
   * renderer cannot tell them apart from the pixels it is handed.
   *
   * `chart` is the safe answer whenever you are unsure: a photo shown a
   * little too dark is still a photo.
   */
  treatment: z.enum(["photo", "chart"]).default("photo"),
});

const GalleryPropsSchema = z.object({
  title: optionalShortText,
  intervalSeconds: z.number().int().min(3).max(120).default(10),
  images: z
    .array(
      z.object({
        src: safeAssetUrl,
        alt: shortText,
        caption: optionalShortText,
      }),
    )
    .min(1)
    .max(8),
});

const MediaPropsSchema = z.object({
  src: safeAssetUrl,
  title: shortText,
  caption: optionalShortText,
  autoplay: z.boolean().default(true),
  muted: z.boolean().default(true),
  loop: z.boolean().default(false),
});

const LinkPropsSchema = z.object({
  title: shortText,
  url: safeAssetUrl,
  summary: z.string().trim().max(600).optional(),
  domain: optionalShortText,
});

const FilePropsSchema = z.object({
  name: shortText,
  url: safeAssetUrl,
  mime: z.string().trim().max(120).optional(),
  sizeLabel: z.string().trim().max(40).optional(),
  caption: optionalShortText,
});

const ProgressPropsSchema = z.object({
  label: shortText,
  value: z.number().min(0).max(100),
  detail: optionalShortText,
});

const StatsPropsSchema = z.object({
  title: optionalShortText,
  items: z
    .array(
      z.object({
        label: shortText,
        value: shortText,
        detail: optionalShortText,
      }),
    )
    .min(1)
    .max(6),
});

const TablePropsSchema = z
  .object({
    title: optionalShortText,
    columns: z.array(shortText).min(1).max(6),
    rows: z.array(z.array(z.preprocess(numberAsText, z.string().trim().max(240))).max(6)).max(12),
  })
  .superRefine((value, ctx) => {
    for (const [index, row] of value.rows.entries()) {
      if (row.length !== value.columns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index],
          message: "row length must match columns length",
        });
      }
    }
  });

const AgendaPropsSchema = z.object({
  title: optionalShortText,
  items: z
    .array(
      z.object({
        time: z.preprocess(numberAsText, z.string().trim().max(80)),
        title: shortText,
        detail: optionalShortText,
      }),
    )
    .min(1)
    .max(10),
});

/**
 * A month, as a month — not as a picture of one.
 *
 * Asked to show August, the model had no calendar component. So it wrote an
 * HTML table, rendered it to a PNG, and published that PNG as an `image_card`.
 * The render step failed and produced an image of its own SOURCE TEXT, which
 * sat on the glass as a white rectangle of markup for a day. Nothing in the
 * pipeline could have caught it: a PNG of source is a valid PNG.
 *
 * The lesson is not "validate images". It is that a model with no component
 * for something it has been asked to show will build one out of whatever it
 * does have, and every one of those improvised paths is unreviewable. The
 * component IS the guardrail.
 *
 * So the model supplies the month and which days matter; the GRID is the
 * renderer's job. Handing over a laid-out grid is the same mistake one level
 * up — week boundaries, month length and leap years are arithmetic, and
 * arithmetic is not something to re-derive per turn.
 */
const CalendarPropsSchema = z.object({
  /** ISO year-month. "2026-08". */
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be an ISO year-month like "2026-08"'),
  /** Defaults to the month name; set it for "Trip to Boston" or similar. */
  title: optionalShortText,
  /**
   * Days that have something on them, drawn as a brass dot under the number.
   *
   * This is the only question a calendar on a wall actually answers at a
   * glance — not "what is the date", which the clock already says. Labels are
   * carried for the days worth naming; the renderer decides how many of them
   * it can show without turning the grid into prose.
   */
  marks: z
    .array(
      z.object({
        day: z.number().int().min(1).max(31),
        label: optionalShortText,
      }),
    )
    .max(31)
    .optional(),
  /** Sunday unless asked otherwise; US household. */
  weekStart: z.enum(["sunday", "monday"]).default("sunday"),
});

const TrackerPropsSchema = z.object({
  title: shortText,
  label: shortText,
  status: shortText,
  detail: optionalShortText,
  progress: z.number().min(0).max(100).optional(),
});

const RecipePropsSchema = z.object({
  title: shortText,
  subtitle: optionalShortText,
  ingredients: z.array(shortText).min(1).max(16),
  steps: z.array(bodyText).min(1).max(16),
  currentStep: z.number().int().min(0).max(15).optional(),
});

const ChartPropsSchema = z
  .object({
    title: optionalShortText,
    kind: z.enum(["bar", "line"]).default("bar"),
    labels: z
      .array(z.preprocess(numberAsText, z.string().trim().max(80)))
      .min(2)
      .max(12),
    values: z.array(z.number().finite()).min(2).max(12),
    unit: z.string().trim().max(24).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.labels.length !== value.values.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: "values length must match labels length",
      });
    }
  });

/**
 * The mirror draws seven weather glyphs, but forecasts do not speak in seven
 * words — NWS alone yields "Partly Cloudy", "Chance Showers", "Patchy Fog".
 * A bare enum rejected the whole widget over the icon field, which is the
 * least important thing on it. Map the common vocabulary onto the glyphs we
 * have, and DROP anything still unrecognized rather than failing the call:
 * a weather card with no icon is a far better outcome than no weather card.
 */
const WEATHER_ICON_ALIASES: Record<string, string> = {
  clear: "sun",
  sunny: "sun",
  fair: "sun",
  hot: "sun",
  "mostly-sunny": "sun",
  "partly-sunny": "sun",
  clouds: "cloud",
  cloudy: "cloud",
  overcast: "cloud",
  "partly-cloudy": "cloud",
  "mostly-cloudy": "cloud",
  rainy: "rain",
  shower: "rain",
  showers: "rain",
  drizzle: "rain",
  thunderstorm: "storm",
  thunderstorms: "storm",
  tstorms: "storm",
  lightning: "storm",
  severe: "storm",
  snowy: "snow",
  flurries: "snow",
  sleet: "snow",
  ice: "snow",
  icy: "snow",
  blizzard: "snow",
  hail: "snow",
  foggy: "fog",
  mist: "fog",
  misty: "fog",
  haze: "fog",
  hazy: "fog",
  smoke: "fog",
  windy: "wind",
  breezy: "wind",
};

const WEATHER_ICONS = ["sun", "cloud", "rain", "snow", "storm", "fog", "wind"] as const;

const WeatherIconSchema = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  // "Partly Cloudy" / "partly_cloudy" / "PARTLY-CLOUDY" all arrive in the wild.
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if ((WEATHER_ICONS as readonly string[]).includes(key)) return key;
  const alias = WEATHER_ICON_ALIASES[key];
  if (alias) return alias;
  // Last resort: a compound like "chance-of-showers" still names its glyph.
  for (const [needle, icon] of Object.entries(WEATHER_ICON_ALIASES)) {
    if (key.includes(needle)) return icon;
  }
  // …and a compound may name the GLYPH directly rather than a synonym of it.
  // "Light Rain" came off the NWS feed and matched nothing: "light-rain" is
  // not a canonical icon, and no alias key is a substring of it, because the
  // word it contains is "rain" — which is the icon itself. The card then fell
  // back to printing the condition beside the temperature, which is the
  // no-glyph layout, for the most ordinary weather there is.
  for (const icon of WEATHER_ICONS) {
    if (key.includes(icon)) return icon;
  }
  return undefined;
}, z.enum(WEATHER_ICONS).optional()) as z.ZodType<(typeof WEATHER_ICONS)[number] | undefined>;

const WeatherPropsSchema = z.object({
  location: shortText,
  temperature: shortText,
  condition: shortText,
  high: optionalShortText,
  low: optionalShortText,
  /**
   * An active watch or warning, on its own line and in ember.
   *
   * It used to be prepended to `detail`, which made one string carrying three
   * unrelated facts — "Severe Thunderstorm Watch · 77% precip, dewpt 75°F".
   * In a corner column that wrapped to three ragged right-aligned lines with
   * a two-character orphan, and the one fact you would want to see from the
   * hallway had the same weight as the dew point.
   *
   * Separate field because it is a different KIND of thing: a state, not a
   * measurement. State is what colour is for.
   */
  alert: optionalShortText,
  detail: optionalShortText,
  icon: WeatherIconSchema,
});

const ClockPropsSchema = z.object({
  timezone: z.string().trim().max(80).default("local"),
  showSeconds: z.boolean().default(false),
  twelveHour: z.boolean().default(true),
  /**
   * Render the date immediately beneath the time as one unit.
   *
   * The baseline fixture uses this instead of a separate `date` widget in
   * another corner: "what time is it, and which day" is a single glance, and
   * two widgets in one region are separated by the region gap, which reads as
   * two unrelated things. The standalone `date` component still exists for
   * the model to place wherever it likes.
   */
  showDate: z.boolean().default(false),
  /**
   * "number" keeps the digital face. "beer" switches the renderer to an
   * analog face with a beer mug glyph at each hour — hands still track real
   * time, it is not a static image. Extensible for future faces.
   */
  numeralStyle: z.enum(["number", "beer"]).default("number"),
});

const DatePropsSchema = z.object({
  timezone: z.string().trim().max(80).default("local"),
  format: z.enum(["long", "compact"]).default("long"),
});

/**
 * A countdown that counts down by itself.
 *
 * The model supplies when it ends; the glass does the arithmetic every
 * second. Anything else means a model turn per tick, which is not a feature —
 * it is a timer that costs money to watch and stops when the daemon is busy.
 *
 * `endsAtMs` rather than a duration, because a duration has to be paired with
 * a start to mean anything and the pair goes stale the moment a frame is
 * delayed. An absolute instant survives a reconnect, a snapshot replay and a
 * clock the renderer already has.
 */
const TimerPropsSchema = z.object({
  label: shortText,
  endsAtMs: z.number().int().positive(),
  /** Shown under the count while it runs — "then rest 10 minutes". */
  detail: optionalShortText,
});

/**
 * Places, with the distance kept as a number the eye can sort.
 *
 * "Somewhere for dinner" arrived as a `list_card` of strings, so the renderer
 * never saw a distance to put on a rail — and a list of restaurants whose
 * distances are buried mid-sentence is a list you have to READ to rank. The
 * one thing you want from it is which is closest.
 */
const PlaceListPropsSchema = z.object({
  title: optionalShortText,
  places: z
    .array(
      z.object({
        name: shortText,
        /** Cuisine, category, whatever names the kind of place it is. */
        kind: optionalShortText,
        /** Display text, not a number: "0.4 mi", "12 min walk". */
        distance: optionalShortText,
        /** "$$", "4.6", "closes 9pm" — one supporting fact, not three. */
        detail: optionalShortText,
        /** The one being recommended. Rendered as the only ember row. */
        highlight: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(6),
});

/**
 * What is playing, sized to be ignorable.
 *
 * This sits on the glass for the length of an album, so it is the one
 * component that must survive an hour without dominating. The art stays small
 * deliberately — a large cover is a bright square, and a bright square in a
 * dark room an hour long is a lamp.
 */
const NowPlayingPropsSchema = z.object({
  track: shortText,
  artist: optionalShortText,
  album: optionalShortText,
  /** Where it is playing — "Kitchen". */
  room: optionalShortText,
  art: safeAssetUrl.optional(),
  /** 0-100. Absent for a live stream, which has no position to show. */
  progress: z.number().min(0).max(100).optional(),
});

/**
 * The morning read: a greeting, some dated facts, and a line to end on.
 *
 * Not an agenda. An agenda is a list of appointments and this is a briefing —
 * "bins go out tonight" has no time, "9:40 dentist" does, and both belong in
 * the same read. The gutter holds a time when there is one and stays empty
 * when there is not, which is what keeps the facts on one left margin
 * instead of ragged around whatever prefix each happened to have.
 */
const BriefPropsSchema = z.object({
  greeting: optionalShortText,
  items: z
    .array(
      z.object({
        /** "9:40", "tonight", or nothing at all. */
        time: optionalShortText,
        text: shortText,
      }),
    )
    .min(1)
    .max(8),
  /** One line of prose to close on. Not a fact — the sign-off. */
  closing: optionalShortText,
});

/**
 * A message shown UNSENT, at a size that cannot be skimmed past.
 *
 * This is the one component on the mirror with a real blast radius. Speech
 * recognition is wrong often enough that "text Sam I'll be late" and one
 * mis-heard name is a message to the wrong person, and the mirror has no
 * undo, no outbox and no way to know it happened. So the draft goes on the
 * glass at display size, with the recipient named, and nothing sends until
 * the user says so out loud.
 *
 * The renderer will not draw a send affordance of any kind — there is no
 * pointer on this device, and a button nobody can press is a lie about what
 * is going to happen next.
 */
const MessageDraftPropsSchema = z.object({
  recipient: shortText,
  body: bodyText,
  /** What the user has to say to send it. Shown verbatim, in ember. */
  confirm: optionalShortText,
  /**
   * `sent` exists so the same content id can report the outcome in place. A
   * draft that vanishes and a draft that was sent look identical on a wall,
   * and only one of them means a message went out.
   */
  state: z.enum(["draft", "sent"]).default("draft"),
});

/**
 * A route the mirror DRAWS, rather than a picture of one.
 *
 * The obvious way to put a map on a screen is to screenshot a map. That is
 * exactly what went wrong with the severe-weather radar: a basemap is a white
 * field with a little ink on it, and measured on the glass an untreated one
 * ran 132.7 mean luminance against 9.5–11.8 for every other band — eleven
 * times the whole interface, lit up in a dark bedroom. Dimming it helps and
 * does not fix it, because the paper is still there under the dimming.
 *
 * So there is no basemap. The model sends the geometry and the renderer draws
 * a line on black: no tiles, no labels, no roads, no attribution — none of
 * which anyone reads off a mirror anyway. What a route on a wall is actually
 * for is shape and length, and both survive.
 *
 * Points rather than an encoded polyline: the encoding is bit-packed
 * arithmetic, and a model hand-assembling one is a model producing a route
 * that decodes to somewhere else. 200 is enough to draw a legible county-scale
 * line; a route needing more detail than that needs a phone, not a mirror.
 */
const RouteMapPropsSchema = z.object({
  origin: shortText,
  destination: shortText,
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    )
    .min(2)
    .max(200),
  /** Display text: "12.4 mi". */
  distance: optionalShortText,
  /** Display text: "22 min". */
  duration: optionalShortText,
  /** "via US-30, light traffic" — one line, the thing you would have asked. */
  detail: optionalShortText,
});

/**
 * A receipt, whose whole job is a column of figures you can add up by eye.
 *
 * Amounts are display text rather than numbers because currency formatting is
 * a decision the model has already made ("$34.95", "£12", "MP") and re-deriving
 * it here would be a second opinion nobody asked for. What the renderer owns
 * is the alignment: a monospace column on the right, so the decimal points
 * line up and a wrong total is visible without arithmetic.
 */
const ReceiptPropsSchema = z.object({
  merchant: shortText,
  date: optionalShortText,
  items: z
    .array(
      z.object({
        name: shortText,
        /** "2 ×" — omitted for the singular case rather than written as 1. */
        qty: optionalShortText,
        amount: shortText,
      }),
    )
    .min(1)
    .max(12),
  subtotal: optionalShortText,
  tax: optionalShortText,
  tip: optionalShortText,
  /** The only brass thing on the frame. It is what the glance is for. */
  total: shortText,
});

/**
 * One place, once you have chosen it from the list.
 *
 * Three photographs, hard limit. A contact sheet is something you browse, and
 * browsing is the one thing you cannot do here — there is no pointer, so every
 * extra frame is light spent on something nobody will look at more closely.
 * Past three it stops being a glance and starts being a gallery.
 */
const PlaceDetailPropsSchema = z.object({
  name: shortText,
  /** "Italian · $$" — what kind of place, in one line. */
  kind: optionalShortText,
  /** Display text: "4.6". Brass, because a rating describes the world. */
  rating: optionalShortText,
  ratingCount: optionalShortText,
  address: optionalShortText,
  /** "Open until 10" rather than a week of opening times. */
  hours: optionalShortText,
  phone: optionalShortText,
  photos: z.array(safeAssetUrl).max(3).optional(),
  /** One line: the reason this one and not the others. */
  detail: optionalShortText,
});

/**
 * A hunk and whether the tests passed. Nothing else.
 *
 * A mirror is not a code review — you cannot scroll it, select from it, or
 * follow a symbol out of it. What it is good for is the answer to "did that
 * work", which is a few changed lines and a test result, read while walking
 * past. Twenty-four lines is about a screen at this type size; a diff that
 * needs more than that needs an editor.
 *
 * Line numbers are display text because a removed line has no number in the
 * new file, and inventing one to keep the type uniform would put a lie in the
 * gutter.
 */
const CodeDiffPropsSchema = z.object({
  path: shortText,
  summary: optionalShortText,
  lines: z
    .array(
      z.object({
        number: optionalShortText,
        kind: z.enum(["context", "added", "removed"]).default("context"),
        /** Bounded, and allowed to be empty — blank lines are part of a hunk. */
        text: z.string().max(240),
      }),
    )
    .min(1)
    .max(24),
  /** "18 passed, 0 failed". */
  test: optionalShortText,
  testState: z.enum(["pass", "fail"]).optional(),
});

/**
 * What Edmund is off doing, while he is off doing it.
 *
 * The model does not send this and cannot usefully send it. Sub-agents are
 * spawned inside an MCP subprocess, so the turn that started one ends without
 * ever learning whether it is still running — a roster the model wrote would
 * be a claim about the past. The daemon polls the agents table, which is the
 * only shared truth, and writes this itself.
 *
 * Before it existed a long job showed as a moving presence and an empty
 * thread: something is happening, with no way to tell whether it is the thing
 * you asked for. The roster is the difference between "working" and "working
 * on the eligibility numbers".
 *
 * It is deliberately dull — no dots, no spinners, nothing animated. The
 * presence is already the moving thing on the glass, and two of them competing
 * is how a status display turns into an airport board.
 */
const AgentActivityPropsSchema = z.object({
  jobs: z
    .array(
      z.object({
        task: shortText,
        /** "2 min" — how long it has been going, not when it started. */
        since: optionalShortText,
      }),
    )
    .min(1)
    .max(6),
});

/**
 * The house, readable from the hallway without reading any words.
 *
 * On is an ember dot with a real glow; off is an empty ring. That is the
 * whole component — a list of names and states, where the STATE is carried by
 * a mark rather than by the words "on" and "off", because at four metres you
 * can see a lit dot and you cannot read a two-letter word.
 */
const HomeControlPropsSchema = z.object({
  room: optionalShortText,
  devices: z
    .array(
      z.object({
        name: shortText,
        on: z.boolean(),
        /** "60%", "68°F" — shown only when the device has a level worth saying. */
        detail: optionalShortText,
      }),
    )
    .min(1)
    .max(10),
});

/**
 * A menu is not a list of strings.
 *
 * Asked for one today, the model had to flatten "Filet Mignon 8oz" and
 * "$34.95" into a single `list_card` item before the renderer ever saw them —
 * so there was no name to hang on a left margin and no price to align on a
 * right rail, and it came out as a styled paragraph. Prices are the whole
 * point of a menu: they only work as a column.
 */
const MenuPropsSchema = z.object({
  title: optionalShortText,
  subtitle: optionalShortText,
  sections: z
    .array(
      z.object({
        name: optionalShortText,
        items: z
          .array(
            z.object({
              name: shortText,
              description: optionalShortText,
              // Display text, not a number: "24", "$24", "MP" are all valid.
              price: optionalShortText,
            }),
          )
          .min(1)
          .max(8),
      }),
    )
    .min(1)
    .max(4),
  /** The dish that was actually asked about. Rendered as the only ember thing
   *  on the frame, so it is found without reading. */
  highlight: optionalShortText,
});

/**
 * News is not a list of strings either.
 *
 * Asked for headlines today, the model had to flatten source and headline into
 * one `list_card` item, so the renderer never saw a source to set in brass or a
 * lead to give a photo to — and it landed in a third-width corner, where an
 * 80-character headline wraps at about seven characters a line.
 *
 * The first story is the lead: it gets the photo and twice the type. That is a
 * layout decision the renderer makes, not something the model is asked to rank.
 */
const StoryListPropsSchema = z.object({
  title: optionalShortText,
  stories: z
    .array(
      z.object({
        headline: shortText,
        /** Publication. Rendered as the brass eyebrow above the headline. */
        source: optionalShortText,
        /** Relative age — "2h", "yesterday". Sits beside the source. */
        age: optionalShortText,
        /** Lead art. Only the first story's image is drawn; the rest would
         *  turn a scannable column into a contact sheet. */
        image: safeAssetUrl.optional(),
      }),
    )
    .min(1)
    .max(6),
});

const StatusPropsSchema = z.object({
  label: shortText,
  detail: optionalShortText,
  state: z.enum(["idle", "working", "success", "warning", "error"]).default("idle"),
});

export const MirrorComponentSpecSchema = z.discriminatedUnion("component", [
  z.object({ component: z.literal("text_block"), props: TextPropsSchema }),
  z.object({ component: z.literal("list_card"), props: ListPropsSchema }),
  z.object({ component: z.literal("image_card"), props: ImagePropsSchema }),
  z.object({ component: z.literal("image_gallery"), props: GalleryPropsSchema }),
  z.object({ component: z.literal("video"), props: MediaPropsSchema }),
  z.object({ component: z.literal("audio"), props: MediaPropsSchema }),
  z.object({ component: z.literal("link_card"), props: LinkPropsSchema }),
  z.object({ component: z.literal("file_card"), props: FilePropsSchema }),
  z.object({ component: z.literal("progress"), props: ProgressPropsSchema }),
  z.object({ component: z.literal("stats"), props: StatsPropsSchema }),
  z.object({ component: z.literal("table"), props: TablePropsSchema }),
  z.object({ component: z.literal("agenda"), props: AgendaPropsSchema }),
  z.object({ component: z.literal("calendar"), props: CalendarPropsSchema }),
  z.object({ component: z.literal("tracker"), props: TrackerPropsSchema }),
  z.object({ component: z.literal("recipe"), props: RecipePropsSchema }),
  z.object({ component: z.literal("chart"), props: ChartPropsSchema }),
  z.object({ component: z.literal("menu"), props: MenuPropsSchema }),
  z.object({ component: z.literal("story_list"), props: StoryListPropsSchema }),
  z.object({ component: z.literal("weather"), props: WeatherPropsSchema }),
  z.object({ component: z.literal("clock"), props: ClockPropsSchema }),
  z.object({ component: z.literal("date"), props: DatePropsSchema }),
  z.object({ component: z.literal("status"), props: StatusPropsSchema }),
  z.object({ component: z.literal("timer"), props: TimerPropsSchema }),
  z.object({ component: z.literal("place_list"), props: PlaceListPropsSchema }),
  z.object({ component: z.literal("now_playing"), props: NowPlayingPropsSchema }),
  z.object({ component: z.literal("home_control"), props: HomeControlPropsSchema }),
  z.object({ component: z.literal("brief"), props: BriefPropsSchema }),
  z.object({ component: z.literal("message_draft"), props: MessageDraftPropsSchema }),
  z.object({ component: z.literal("route_map"), props: RouteMapPropsSchema }),
  z.object({ component: z.literal("receipt"), props: ReceiptPropsSchema }),
  z.object({ component: z.literal("agent_activity"), props: AgentActivityPropsSchema }),
  z.object({ component: z.literal("place_detail"), props: PlaceDetailPropsSchema }),
  z.object({ component: z.literal("code_diff"), props: CodeDiffPropsSchema }),
]);

const MirrorContentBaseSchema = z.object({
  id: ContentIdSchema,
  page: ContentPageSchema.default("home"),
  zone: MirrorZoneSchema,
  presentation: MirrorPresentationSchema.default("widget"),
  lifespan: MirrorLifespanSchema,
  priority: z.number().int().min(-100).max(100).default(0),
  expiresAtMs: z.number().int().positive().nullable(),
  protected: z.boolean().default(false),
  revision: z.number().int().nonnegative(),
  createdAtMs: z.number().int().positive(),
  updatedAtMs: z.number().int().positive(),
});

export const MirrorContentSchema = z.intersection(
  MirrorContentBaseSchema,
  MirrorComponentSpecSchema,
);

export type MirrorContent = z.infer<typeof MirrorContentSchema>;
export type MirrorComponentSpec = z.infer<typeof MirrorComponentSpecSchema>;
export type MirrorZone = z.infer<typeof MirrorZoneSchema>;
export type MirrorPresentation = z.infer<typeof MirrorPresentationSchema>;
export type MirrorLifespan = z.infer<typeof MirrorLifespanSchema>;

const MessageIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,95}$/);
const frameBase = {
  v: z.literal(MIRROR_PROTOCOL_VERSION),
  id: MessageIdSchema,
};

const MirrorConversationMessageSchema = z.object({
  id: MessageIdSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(4_000),
  final: z.boolean(),
});
export type MirrorConversationMessage = z.infer<typeof MirrorConversationMessageSchema>;

const OverlayPayloadSchema = z.object({
  phase: z.enum(["idle", "listening", "thinking", "working", "responding", "speaking", "showing"]),
  messages: z.array(MirrorConversationMessageSchema).max(12).optional(),
  /** What the model is doing right now ("searching the web"), shown under the
   *  status while a long turn runs. Optional: older screens ignore it. */
  detail: z.string().max(120).optional(),
  /**
   * Sub-agents still in flight for this session.
   *
   * Above zero the screen draws the delegating presence instead of the plain
   * working knot — the "present but subtle" signal for a job that outlives the
   * conversation that started it. Clamped low deliberately: this is a visual
   * roster, not a counter, and past a handful the field stops being readable.
   */
  agents: z.number().int().min(0).max(8).optional(),
  // Rolling compatibility with pre-conversation V2 screens.
  userText: z.string().max(2_000).optional(),
  userFinal: z.boolean().optional(),
  botText: z.string().max(4_000).optional(),
});

export const AgentFrameSchema = z.discriminatedUnion("type", [
  z.object({
    ...frameBase,
    type: z.literal("snapshot"),
    revision: z.number().int().nonnegative(),
    page: PageSchema,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    contents: z.array(MirrorContentSchema).max(64),
  }),
  z.object({
    ...frameBase,
    type: z.literal("content_upsert"),
    revision: z.number().int().positive(),
    content: MirrorContentSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("content_remove"),
    revision: z.number().int().positive(),
    contentId: ContentIdSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("page_set"),
    revision: z.number().int().positive(),
    page: PageSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("overlay_set"),
    overlay: OverlayPayloadSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("audio_play"),
    format: z.enum(["mp3", "wav", "aac", "ogg"]),
    data: z.string().max(12_000_000),
    text: z.string().max(4_000).optional(),
    messageId: MessageIdSchema.optional(),
  }),
  z.object({
    ...frameBase,
    type: z.literal("followup_listen"),
  }),
  z.object({
    ...frameBase,
    // Restore playback after a wake turned out to be Edmund hearing himself.
    // Pairs with the Pi ducking rather than stopping audio on wake, so a false
    // trigger costs a moment of quiet instead of the rest of the sentence.
    type: z.literal("audio_resume"),
  }),
  z.object({
    ...frameBase,
    // A genuine interruption: drop the current utterance and everything queued.
    type: z.literal("audio_stop"),
    reason: z.string().max(120).optional(),
  }),
  z.object({
    ...frameBase,
    type: z.literal("ping"),
    at: z.number().int(),
  }),
]);

export type AgentFrame = z.infer<typeof AgentFrameSchema>;

export const PiEventSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("hello"),
    node: z.string().max(80),
    revision: z.number().int().nonnegative(),
    protocol: z.literal(MIRROR_PROTOCOL_VERSION),
    /** Fingerprint of the wire vocabulary the screen validates against. See
     *  contract.ts. Optional so an older screen still connects. */
    contract: z.string().max(64).optional(),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("ack"),
    replyTo: MessageIdSchema,
    status: z.enum(["accepted", "duplicate", "rejected"]),
    revision: z.number().int().nonnegative().optional(),
    error: z.string().max(240).optional(),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("wake"),
    id: MessageIdSchema,
    /**
     * How sure the wake detector was, 0-1.
     *
     * Optional, and its ABSENCE carries meaning: the Vosk grammar fallback is
     * a starved ASR decoder that emits a text hypothesis and no confidence at
     * all, so there is nothing it could honestly put here. A missing score
     * means "verify this some other way", which is why it must not default to
     * 1 — that would read identically to a detector that was certain.
     */
    score: z.number().min(0).max(1).optional(),
    /** Which wake phrase matched, e.g. "edmund" or "hey_edmund". */
    label: z.string().max(80).optional(),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("utterance"),
    id: MessageIdSchema,
    format: z.literal("wav"),
    data: z.string().max(12_000_000),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.enum(["wake_timeout", "followup_timeout"]),
    id: MessageIdSchema,
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("screen_status"),
    connected: z.boolean(),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("audio_done"),
    replyTo: MessageIdSchema,
    status: z.enum(["ok", "error"]),
    error: z.string().max(240).optional(),
  }),
  z.object({
    v: z.literal(MIRROR_PROTOCOL_VERSION),
    type: z.literal("pong"),
    replyTo: MessageIdSchema,
    at: z.number().int(),
  }),
]);

export type PiEvent = z.infer<typeof PiEventSchema>;

/**
 * Components that read fine in a third-width corner.
 *
 * The three top and three bottom regions share a row, so each is ~360px of a
 * 1080px panel. At the body size that is roughly sixteen characters a line —
 * enough for a temperature or a time, and nothing else.
 */
const AMBIENT_COMPONENTS = new Set([
  "clock",
  "date",
  "weather",
  "status",
  "progress",
  "tracker",
  // These three carry a mark or a figure rather than sentences, which is the
  // whole test for a third-width column: a lit dot, a countdown and a track
  // name all survive sixteen characters a line. `place_list` deliberately
  // does not — its rows are prose with a rail beside them.
  "timer",
  "now_playing",
  "home_control",
]);

/*
 * `image_card` was on that list and should never have been.
 *
 * The reasoning was that a picture has no line length, so a narrow column
 * cannot break it. True, and beside the point: a corner is a third of the
 * glass, so an image sent there is rendered at ~360 px on a 1080 px panel and
 * reads as a stamp in the margin rather than as the answer. The August
 * calendar the model produced landed exactly there — 460x260 of content shown
 * at a size where nothing in it was legible, in the one region reserved for
 * things you are not meant to look at.
 *
 * An image is what the model chose to show you. It goes in a band.
 */

const NARROW_ZONES: Record<string, MirrorZone> = {
  top_left: "upper_third",
  top_center: "upper_third",
  top_right: "upper_third",
  bottom_left: "lower_third",
  bottom_center: "lower_third",
  bottom_right: "lower_third",
};

/**
 * Keep prose out of the corner columns.
 *
 * A model asked for news picked `bottom_left` + `list_card`, and five
 * eighty-character headlines wrapped at about seven characters a line. That is
 * not a prompting failure to be argued with every turn — a corner is a third of
 * the glass wide, so anything with sentences in it belongs in a full-width band
 * and the device is the thing that knows it.
 *
 * The model still chooses top vs bottom, which is the part it actually has an
 * opinion about; only the width is taken out of its hands. Ambient fixtures and
 * explicitly full-width zones pass through untouched.
 */
export function placementZone(zone: MirrorZone, component: string): MirrorZone {
  if (AMBIENT_COMPONENTS.has(component)) return zone;
  return NARROW_ZONES[zone] ?? zone;
}

/**
 * What the content is FOR. The device works out where it goes.
 *
 * Rendering one thing used to take four layout decisions — a zone out of
 * thirteen, a presentation, a lifespan and a priority — none of which the
 * model can judge, because all four depend on the panel, on what else is
 * already up, and on where the conversation dock is about to open. Asked for
 * news it picked `bottom_left`, which is a third of the glass wide, and five
 * headlines wrapped at about seven characters a line.
 *
 * Three intents, and they are questions about meaning rather than geometry:
 *
 *   ambient  something you glance at, unrelated to any conversation. The
 *            time, the weather, a countdown to a trip. It lives at an edge
 *            and it outlives the exchange.
 *   answer   the response to what was just asked. A full-width band, and it
 *            leaves on its own.
 *   focus    the one thing to look at right now, that you are USING. A recipe
 *            mid-cook, a running timer, a draft waiting to be confirmed. It
 *            takes the glass.
 *
 * This is the APL responsive-template lesson: the model chooses meaning, the
 * device chooses layout. `zone` and the rest survive as overrides, because
 * "usually the device knows better" is not "the device always knows better".
 */
export const MIRROR_INTENTS = ["ambient", "answer", "focus"] as const;
export type MirrorIntent = (typeof MIRROR_INTENTS)[number];

/**
 * Where an ambient component belongs when nothing says otherwise.
 *
 * Only the fixtures with a conventional home are named. Anything else lands
 * in a field zone — the renderer folds all six content zones into one
 * composed band, and ambient content without an expiry parks on its FLOOR,
 * the strip above the waterline. "bottom_left" here is wire vocabulary, not
 * geometry; the device decides width and neighbours from what else is up.
 */
const AMBIENT_HOME: Record<string, MirrorZone> = {
  clock: "top_left",
  date: "top_left",
  weather: "top_right",
};

export type ResolvedPlacement = {
  zone: MirrorZone;
  presentation: MirrorPresentation;
  lifespan: MirrorLifespan;
  priority: number;
};

export function placementForIntent(intent: MirrorIntent, component: string): ResolvedPlacement {
  if (intent === "ambient") {
    return {
      zone: AMBIENT_HOME[component] ?? "bottom_left",
      presentation: "widget",
      // Session, not persistent. Persistent content outlives everything and
      // has to be deliberately removed, so it is what the user ASKS for, not
      // what a model infers from "this is ambient" — the failure mode is a
      // glass that slowly fills with widgets nobody chose and nobody clears.
      lifespan: "session",
      priority: -10,
    };
  }
  if (intent === "focus") {
    // Zone is inert for page presentation — Region only renders `widget`, and
    // #page-surface picks the highest-priority page item — but the field is
    // not optional, and middle_center is the honest answer to "where is it".
    return { zone: "middle_center", presentation: "page", lifespan: "session", priority: 50 };
  }
  // An answer goes UP, not down. The dock opens across the bottom while the
  // conversation that produced the answer is still live, reserving 11rem; an
  // answer placed low is one the waterline is about to slide under.
  return { zone: "upper_third", presentation: "widget", lifespan: "ephemeral", priority: 0 };
}

export function mirrorFrameId(prefix = "mirror"): string {
  return `${prefix}:${Date.now().toString(36)}:${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function summarizeContent(content: MirrorContent): string {
  return `${content.id} [${content.component} ${content.presentation} ${content.page}/${content.zone} ${content.lifespan} p=${content.priority} r=${content.revision}]`;
}
