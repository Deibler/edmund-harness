/* Install once per app session, then query with one-liners.
 *
 * The renderer keeps the CURRENT sweep fully decoded in memory as a
 * Float32Array of real physical values — dBZ for HRF/BRF, m/s for HVL/BVL —
 * laid out radial-major: values[radialIndex * gate_depth + gateIndex].
 * -128 means no data. That means every "how strong is it exactly" question is
 * arithmetic, not eyeballing a colour ramp.
 *
 * Paste this whole file as the execute_js expression once. After that:
 *   __rq.info()
 *   __rq.at(LAT, LON)
 *   __rq.max(LAT, LON, 15)
 *   __rq.couplet(40.15, -76.6, 25)     // velocity products only
 */
(() => {
  const R = 6371000, D = Math.PI / 180, NONE = -128;

  const sweep = () => window.__claude_map.radar.radarRenderer.sweep;
  const tower = () => window.__claude_map.radar.radarRenderer.tower;

  function geom(lat, lon) {
    const t = tower(), p1 = t.lat * D, p2 = lat * D, dl = (lon - t.lon) * D;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    let az = Math.atan2(y, x) / D; if (az < 0) az += 360;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return { az, rng: 2 * R * Math.asin(Math.sqrt(a)) };
  }

  function cell(lat, lon) {
    const s = sweep(), g = geom(lat, lon), NR = s.total_radial_gates;
    let ri = Math.round((g.az - s.azimuth_offset) / (360 / NR));
    ri = ((ri % NR) + NR) % NR;
    const gi = Math.round((g.rng - s.meters_to_first_gate) / s.meters_between_gates);
    return { ri, gi, az: g.az, rng: g.rng };
  }

  function latlon(ri, gi) {
    const s = sweep(), t = tower();
    const az = (s.azimuth_offset + ri * 360 / s.total_radial_gates) * D;
    const d = (s.meters_to_first_gate + gi * s.meters_between_gates) / R;
    const p1 = t.lat * D, l1 = t.lon * D;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(az));
    const l2 = l1 + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(p1),
                               Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [+(p2 / D).toFixed(4), +(l2 / D).toFixed(4)];
  }

  /* Missing data is not one sentinel. -128 is "no echo", and a sweep that is
   * still streaming in is padded with -1e8. Both fall outside the product's own
   * declared min/max, so range-check against that instead of matching sentinels
   * — a padded gate read as a real value invents a 194,000 kt couplet. */
  const val = (ri, gi) => {
    const s = sweep();
    if (gi < 0 || gi >= s.gate_depth) return NONE;
    const v = s.values[ri * s.gate_depth + gi];
    return (v >= s.value.min && v <= s.value.max) ? v : NONE;
  };

  /* A box of radial/gate indices covering a radius in miles around a point. */
  function window_(lat, lon, miles) {
    const s = sweep(), c = cell(lat, lon), m = miles * 1609.34;
    const gspan = Math.ceil(m / s.meters_between_gates);
    // Arc length per radial grows with range, so the azimuth span shrinks far out.
    const arc = Math.max(c.rng, 1000) * (360 / s.total_radial_gates) * D;
    const rspan = Math.ceil(m / arc);
    return { c, gspan, rspan, NR: s.total_radial_gates };
  }

  window.__rq = {
    info() {
      const s = sweep(), t = tower();
      return { tower: t.tower_code, lat: t.lat, lon: t.lon, product: s.product,
               unit: s.value.unit, time: s.datetime, elevation_deg: +s.meta.elevation.toFixed(2),
               radials: s.total_radial_gates, gates: s.gate_depth,
               gate_m: s.meters_between_gates, range_km: s.radius / 1000 };
    },

    at(lat, lon) {
      const s = sweep(), c = cell(lat, lon), v = val(c.ri, c.gi);
      return { value: v === NONE ? null : +v.toFixed(1), unit: s.value.unit,
               product: s.product, time: s.datetime,
               range_mi: +(c.rng / 1609.34).toFixed(1), azimuth: +c.az.toFixed(1),
               beam_kft: +((c.rng * Math.tan(s.meta.elevation * D) + c.rng * c.rng / 17000000)
                           * 3.28084 / 1000).toFixed(1) };
    },

    /* Strongest value within a radius, and where it is. */
    max(lat, lon, miles) {
      const s = sweep(), w = window_(lat, lon, miles || 10);
      let best = -1e9, at = null, n = 0;
      for (let dr = -w.rspan; dr <= w.rspan; dr++) {
        const ri = ((w.c.ri + dr) % w.NR + w.NR) % w.NR;
        for (let dg = -w.gspan; dg <= w.gspan; dg++) {
          const v = val(ri, w.c.gi + dg);
          if (v === NONE || isNaN(v)) continue;
          n++;
          if (v > best) { best = v; at = [ri, w.c.gi + dg]; }
        }
      }
      return at ? { max: +best.toFixed(1), unit: s.value.unit, product: s.product,
                    at: latlon(at[0], at[1]), gates_checked: n, time: s.datetime }
                : { max: null, gates_checked: n, time: s.datetime };
    },

    /* Velocity only: the strongest gate-to-gate azimuthal shear in the window.
     * A tight inbound/outbound pair on adjacent radials is rotation; the delta
     * is what warning decisions are actually made on. */
    couplet(lat, lon, miles) {
      const s = sweep();
      if (!/VL|VEL/i.test(s.product)) return { error: "not a velocity product: " + s.product };
      const w = window_(lat, lon, miles || 15);
      let best = 0, at = null, pair = null;
      for (let dr = -w.rspan; dr <= w.rspan; dr++) {
        const ri = ((w.c.ri + dr) % w.NR + w.NR) % w.NR, rj = (ri + 1) % w.NR;
        for (let dg = -w.gspan; dg <= w.gspan; dg++) {
          const gi = w.c.gi + dg, a = val(ri, gi), b = val(rj, gi);
          if (a === NONE || b === NONE || isNaN(a) || isNaN(b)) continue;
          const d = Math.abs(a - b);
          if (d > best) { best = d; at = [ri, gi]; pair = [+a.toFixed(1), +b.toFixed(1)]; }
        }
      }
      const kt = best * 1.94384;
      return { delta_ms: +best.toFixed(1), delta_kt: +kt.toFixed(0), pair_ms: pair,
               at: at ? latlon(at[0], at[1]) : null, time: s.datetime,
               read: kt < 30 ? "no organised rotation" :
                     kt < 50 ? "weak shear, watch it" :
                     kt < 70 ? "notable couplet" : "strong couplet" };
    },
  };

  return JSON.stringify(window.__rq.info());
})()
