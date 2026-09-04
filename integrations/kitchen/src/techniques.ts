/**
 * What a technique word actually looks like.
 *
 * A step that says "dice the onion" is doing a lot of unearned work. Dice how
 * small? The difference between a 1/4 inch dice and a rough chop is the
 * difference between onion that melts into a gravy and onion you bite into, and
 * no amount of prose fixes that as fast as one photograph of the finished pile.
 * Same for "sear until fond forms", which is meaningless until you have seen
 * fond, and for a cut of meat, where the name on the package is the whole
 * instruction and a chart is the only way to know where it came from.
 *
 * THE SOURCING RULE, and it is Alex's, from 2026-08-13: reference visuals are
 * real photographs from a real dataset, plus real chefs on video. Not drawings
 * I generated, which he rejected outright, and not an AI image of what a
 * brunoise "looks like", which is a picture of a plausible brunoise rather than
 * a brunoise. Every image below is a Wikimedia Commons file under a free
 * licence, downloaded and served from the artifact directory so the page does
 * not hotlink someone else's bandwidth. Every video id was resolved against
 * YouTube's oembed endpoint rather than recalled, because a plausible-looking
 * dead link is worse than no link.
 *
 * Attribution is rendered on the page, not buried here. That is both the
 * licence terms and the point: the credit is what makes it a real photograph of
 * a real thing rather than a stock image.
 */

export type Technique = {
  id: string;
  /** How the page names it. */
  label: string;
  /** One line on what the technique IS, in a cook's terms. */
  what: string;
  /** The measurable version, where the technique has one. */
  spec?: string;
  /** Wikimedia Commons file, downloaded to img/technique/<id>.<ext>. */
  image?: {
    file: string;
    ext: string;
    credit: string;
    license: string;
    /** The Commons page, so the licence is one tap from the photo. */
    source: string;
  };
  /** A real chef, verified live. */
  video?: { id: string; title: string; by: string };
  /** A written reference for people who would rather read. */
  help?: { url: string; label: string };
};

const commons = (file: string) =>
  `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.replace(/ /g, "_"))}`;

export const TECHNIQUES: Technique[] = [
  {
    id: "dice",
    label: "Dice",
    what: "Even cubes, cut by slicing one way, then the other, then across.",
    spec: "Large 3/4 in, medium 1/2 in, small 1/4 in. Recipes that just say diced mean medium.",
    image: {
      file: "File:Chopped onion.jpg",
      ext: "jpg",
      credit: "Rainer Zenz",
      license: "CC BY-SA 3.0",
      source: commons("File:Chopped onion.jpg"),
    },
    video: { id: "dCGS067s0zo", title: "Dicing An Onion", by: "Gordon Ramsay" },
    help: {
      url: "https://www.seriouseats.com/knife-skills-how-to-dice-an-onion",
      label: "Serious Eats: how to dice an onion",
    },
  },
  {
    id: "mince",
    label: "Mince",
    what: "Cut finer than dice, then rock the knife over the pile until it is almost a paste.",
    spec: "Under 1/8 in. Fine enough to disappear into a sauce.",
    image: {
      file: "File:Garlic bulbs and cloves.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 4.0",
      source: commons("File:Garlic bulbs and cloves.jpg"),
    },
    video: { id: "1y5h1pDHhzs", title: "How to Chop Garlic", by: "Jacques Pepin" },
    help: {
      url: "https://www.seriouseats.com/knife-skills-how-to-mince-garlic",
      label: "Serious Eats: mincing garlic",
    },
  },
  {
    id: "slice",
    label: "Slice",
    what: "Flat pieces of even thickness, cut straight down across the ingredient.",
    spec: "Thin 1/8 in, standard 1/4 in. Even matters more than thin: uneven slices cook unevenly.",
    video: { id: "n6H2B6-di-o", title: "Knife Skills Basics", by: "Knifewear" },
    help: {
      url: "https://www.seriouseats.com/knife-skills-basic-knife-cuts",
      label: "Serious Eats: the basic cuts",
    },
  },
  {
    id: "julienne",
    label: "Julienne",
    what: "Matchsticks. Square the ingredient off, slice it into planks, stack and cut into sticks.",
    spec: "1/8 in square, about 2 in long.",
    image: {
      file: "File:Celery julienne.JPG",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 3.0",
      source: commons("File:Celery julienne.JPG"),
    },
    video: { id: "n6H2B6-di-o", title: "Knife Skills Basics", by: "Knifewear" },
  },
  {
    id: "brunoise",
    label: "Brunoise",
    what: "Julienne turned ninety degrees and cut across, giving tiny even cubes.",
    spec: "1/8 in cubes.",
    image: {
      file: "File:Karotten brunoise.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC0",
      source: commons("File:Karotten brunoise.jpg"),
    },
    video: { id: "n6H2B6-di-o", title: "Knife Skills Basics", by: "Knifewear" },
  },
  {
    id: "chiffonade",
    label: "Chiffonade",
    what: "Stack the leaves, roll them into a cigar, slice across into ribbons.",
    spec: "Ribbons about 1/8 in wide. For basil and other soft herbs.",
    image: {
      file: "File:BasilChiffonade.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 4.0",
      source: commons("File:BasilChiffonade.jpg"),
    },
    video: { id: "n6H2B6-di-o", title: "Knife Skills Basics", by: "Knifewear" },
  },
  {
    id: "beef-cuts",
    label: "Where the beef came from",
    what: "Which part of the animal a cut is from, which is what decides how to cook it.",
    spec: "Rib and loin are tender and want fast heat. Chuck, round and brisket want low and slow.",
    image: {
      file: "File:US Beef cuts.svg",
      ext: "png",
      credit: "US Department of Agriculture",
      license: "Public domain",
      source: commons("File:US Beef cuts.svg"),
    },
    help: { url: "https://en.wikipedia.org/wiki/Cut_of_beef", label: "Every cut of beef, mapped" },
  },
  {
    id: "pork-cuts",
    label: "Where the pork came from",
    what: "Which part of the animal a cut is from, which is what decides how to cook it.",
    spec: "Loin is lean and overcooks fast. Shoulder and belly are fatty and forgiving.",
    image: {
      file: "File:American Pork Cuts.svg",
      ext: "png",
      credit: "US Department of Agriculture",
      license: "Public domain",
      source: commons("File:American Pork Cuts.svg"),
    },
    help: { url: "https://en.wikipedia.org/wiki/Pork#Cuts", label: "Every cut of pork, mapped" },
  },
  {
    id: "salmon",
    label: "Handling a salmon fillet",
    what: "Skin on one side, a line of pin bones down the thick half.",
    spec: "Run a finger along the thick edge to find pin bones, pull them with pliers in the direction they lean.",
    image: {
      file: "File:Raw salmon fillets.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC0",
      source: commons("File:Raw salmon fillets.jpg"),
    },
    help: {
      url: "https://www.seriouseats.com/how-to-buy-store-cook-salmon",
      label: "Serious Eats: buying and cooking salmon",
    },
  },
  {
    id: "brown",
    label: "Brown the meat",
    what: "Dry heat until the surface goes deep brown, which is flavour rather than doneness.",
    spec: "Medium-high, do not crowd the pan, and leave it alone until it releases on its own.",
    image: {
      file: "File:Fondwhite.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 2.0",
      source: commons("File:Fondwhite.jpg"),
    },
    video: { id: "OPEzpj3z8vY", title: "How to Brown Ground Beef", by: "Certified Angus Beef" },
    help: {
      url: "https://www.seriouseats.com/the-maillard-reaction",
      label: "What browning actually is",
    },
  },
  {
    id: "sear",
    label: "Sear",
    what: "Hard contact with a hot dry pan to build a crust before anything else happens.",
    spec: "Pat dry first. Water on the surface steams instead of browning and no crust forms.",
    video: { id: "QFuqHa7adT0", title: "The Juiciest Pan-Seared Chicken", by: "Home Cook Basics" },
  },
  {
    id: "deglaze",
    label: "Deglaze",
    what: "Pour liquid into the hot pan and scrape the stuck brown bits loose into it.",
    spec: "Those bits are called fond and they are most of the flavour of a pan sauce.",
    image: {
      file: "File:Deglaze-01.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 2.0",
      source: commons("File:Deglaze-01.jpg"),
    },
    video: { id: "Iz5J0-zMnkA", title: "How To Deglaze A Pan", by: "Chowhound" },
    help: {
      url: "https://www.seriouseats.com/just-add-water-how-to-make-a-pan-sauce-and-how-to-fix-a-broken-one",
      label: "Serious Eats: making a pan sauce",
    },
  },
  {
    id: "roux",
    label: "Roux",
    what: "Equal fat and flour cooked together, the thickener under most gravies.",
    spec: "Cook at least a minute or the sauce tastes of raw flour. Blonde thickens most, dark thickens least.",
    image: {
      file: "File:Roux bianco.JPG",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 3.0",
      source: commons("File:Roux bianco.JPG"),
    },
    video: { id: "MLP6lgbvpAw", title: "How To Make A Roux", by: "Food Wishes" },
  },
  {
    id: "saute",
    label: "Saute",
    what: "Moderate fat, moderately high heat, food kept moving so it colours without steaming.",
    image: {
      file: "File:Saute and sauce pan.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY-SA 4.0",
      source: commons("File:Saute and sauce pan.jpg"),
    },
  },
  {
    id: "boil",
    label: "Boil",
    what: "Full rolling boil: large bubbles breaking the whole surface, not just a few at the edge.",
    spec: "A simmer is the gentler one, small bubbles rising steadily, around 190F.",
    image: {
      file: "File:Boiling water.jpg",
      ext: "jpg",
      credit: "Wikimedia Commons",
      license: "CC BY 3.0",
      source: commons("File:Boiling water.jpg"),
    },
  },
  {
    id: "al-dente",
    label: "Al dente",
    what: "Pasta cooked through but still with a slight bite at the centre.",
    spec: "Start tasting two minutes before the box says. It carries on cooking in the sauce.",
    video: { id: "1SZhlEwgSXs", title: "How to Cook Pasta", by: "Laura Fuentes" },
  },
  {
    id: "rest",
    label: "Rest the meat",
    what: "Off the heat, loosely covered, before cutting.",
    spec: "Five minutes for chops, ten to fifteen for a roast. Cutting early loses the juice to the board.",
    help: {
      url: "https://www.seriouseats.com/the-food-lab-the-importance-of-resting-meat",
      label: "Serious Eats: why resting works",
    },
  },
];

export const BY_ID = new Map(TECHNIQUES.map((t) => [t.id, t]));

/**
 * Techniques a step is talking about, inferred from its own words.
 *
 * Inference rather than a field the recipe writer has to fill in, because every
 * recipe already written would otherwise have none, and a feature that only
 * works on recipes written after it shipped is a feature nobody sees. The
 * recipe writer can still name them explicitly; this is the floor, not the
 * ceiling.
 *
 * Deliberately conservative. A false positive puts a picture of a brunoise next
 * to a step that never mentioned one, which makes the whole panel look
 * automated and ignorable.
 */
const CUES: Array<[string, RegExp]> = [
  ["dice", /\bdic(e|ed|ing)\b|\bcut .{0,24}\b(cubes?|1\/[24] ?(inch|in)\b)/i],
  ["mince", /\bminc(e|ed|ing)\b/i],
  ["julienne", /\bjulienne/i],
  ["brunoise", /\bbrunoise/i],
  ["chiffonade", /\bchiffonade/i],
  ["slice", /\bslic(e|ed|ing)\b/i],
  ["beef-cuts", /\bground beef\b|\bbeef (chuck|round|roast|steak)\b/i],
  ["pork-cuts", /\bpork (loin|chop|shoulder|tenderloin)\b/i],
  ["salmon", /\bsalmon\b/i],
  ["brown", /\bbrown(ing|ed)?\b(?!ing sugar)|\bno longer pink\b/i],
  ["sear", /\bsear(ing|ed)?\b|\bcrust\b/i],
  ["deglaze", /\bdeglaz(e|ing)\b|\bfond\b|\bscrape up the brown/i],
  ["roux", /\broux\b|\bflour .{0,20}butter\b|\bslurry\b/i],
  ["saute", /\bsaut[eé]/i],
  ["boil", /\brolling boil\b|\bbring .{0,24} to a boil\b/i],
  ["al-dente", /\bal dente\b/i],
  ["rest", /\brest (the|for|it)\b|\blet .{0,16} rest\b/i],
];

export function techniquesFor(step: { title: string; body: string }): Technique[] {
  const text = `${step.title}. ${step.body}`;
  const out: Technique[] = [];
  for (const [id, re] of CUES) {
    if (re.test(text)) {
      const t = BY_ID.get(id);
      // Two panels is the most a step can carry before the instruction is
      // buried under its own references.
      if (t && !out.some((x) => x.id === id) && out.length < 2) out.push(t);
    }
  }
  return out;
}
