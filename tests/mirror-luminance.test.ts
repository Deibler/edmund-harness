import { describe, expect, test } from "bun:test";
import { luminanceProfile, measuredTreatment } from "../integrations/mirror/src/luminance.ts";

/**
 * `image_card.treatment` picks between two filters nearly three stops apart,
 * and getting it wrong on a mirror means a lit rectangle in a dark bedroom.
 * It used to be DECLARED — the radar cron says "chart", the attachment path
 * said "photo" — and a declaration can be forgotten by a model or by whoever
 * writes the next cron. This measures it.
 */
describe("image luminance", () => {
  const PAPER = "integrations/mirror/models/v1/edmund_det.png";
  const PHOTO = "integrations/mirror/tmp/IMG_4894.JPG";

  test("calls a chart paper", async () => {
    // A real matplotlib detection curve from the wake training run, committed
    // beside the model. White page, thin ink — the exact thing that becomes a
    // lit rectangle if it is treated as a photograph.
    if (!(await Bun.file(PAPER).exists())) return;
    expect(measuredTreatment(PAPER)).toBe("chart");
  });

  test("calls a photograph a photograph", async () => {
    // Deliberately a LOCAL fixture, and skipped where it is absent: the only
    // real photograph to hand is Alex's phone shot of the mirror, which
    // lives in a gitignored scratch directory and is not mine to commit. CI
    // therefore proves the decoder and the paper case; this one runs here.
    if (!(await Bun.file(PHOTO).exists())) return;
    expect(measuredTreatment(PHOTO)).toBe("photo");
  });

  test("decides on white AREA, not on the average", async () => {
    if (!(await Bun.file(PHOTO).exists())) return;
    const photo = luminanceProfile(PHOTO);
    expect(photo).not.toBeNull();
    if (!photo) return;

    // This is the whole reason the classifier is not a brightness threshold.
    // A correctly exposed photograph sits near 18% reflectance — about 118 in
    // sRGB — and this one measures ~145, well ABOVE any cut low enough to
    // catch a pale map. It is still obviously a photograph, because almost
    // none of its area is paper-white.
    expect(photo.mean).toBeGreaterThan(110);
    expect(photo.white).toBeLessThan(0.1);
  });

  test("says nothing rather than guessing when it cannot measure", () => {
    // Null is not "photo". A caller with its own reason to believe one or the
    // other must not have that overwritten by a guess wearing the same type.
    expect(measuredTreatment("/nonexistent/definitely-not-here.png")).toBeNull();
    expect(luminanceProfile("/nonexistent/definitely-not-here.png")).toBeNull();
  });
});
