# I threw away 94% of a GPS track — and it got *more* accurate

A morning hike, recorded at 1 Hz: **30,145 points** of (lat, lon, elevation). I simplified
it with Ramer–Douglas–Peucker and learned that the hard part of 3D GPS isn't compression —
it's knowing which 94% is noise.

## The horizontal story: stop fighting the error floor

RDP drops a point unless removing it shifts the line by more than ε. The instinct is to
pick a tiny ε to "stay accurate." But consumer GPS is only good to ~3–5 m. Anything tighter
just preserves jitter the receiver never actually resolved.

So I set **ε = 1 m** — comfortably inside the GPS error bars — and the track went from
**30,145 → 1,895 points. 94% gone.** Visually identical. The remaining 6% *is* the route;
the rest was the sensor twitching in place.

## The vertical story: elevation is where it gets ugly

Horizontal jitter is small. Elevation jitter is brutal — and it **compounds**, because total
ascent is a sum of thousands of tiny ups.

- Recorded climb: **3,004 m**
- Actual climb (Strava): **1,871 m**

That's **over 1,100 m of phantom ascent — 60% more than reality**, built entirely from
noise. The giveaway: at 1 Hz, some samples implied **3 m/s of vertical speed** — 10,000+
m/hour. I was hiking, not launching.

## The trap: naive 3D RDP *protects* the noise

The obvious move is to add elevation to RDP's distance metric. Do that on raw data and every
jitter spike looks like a real cliff — so RDP **keeps more points to preserve it**, and hands
back the same bogus 3,000 m of climb. You pay more to store garbage.

**The fix is order of operations.** The noise is high-frequency; a hiker's real elevation
only moves over tens of seconds. So I low-pass the elevation first (a 60 s average), *then*
run 3D RDP. Recorded climb drops to **1,853 m — within 1% of Strava's 1,871 m** — and the
simplifier keeps *fewer* points, because there are no fake spikes left to defend.

## Three rules I'm keeping

1. **Match ε to the sensor, not your optimism.** ~1 m here dropped 94% of points losslessly.
2. **Treat elevation separately** — it carries most of the noise and it compounds.
3. **Filter before you simplify.** Smooth z to the activity's timescale, *then* run RDP.

94% fewer points, a climb figure that finally matches reality, and a track you can't tell
apart from the original.

---

*And the picture* 👇 — the route draped on real 3D terrain. Huge kudos to the open stack
that made it possible, no proprietary GIS in sight:

- **Regione Piemonte 5 m LIDAR DTM** — the actual mountain, laser-scanned at 5 m and served
  free over WCS (±0.30 m vertical — 6× finer than global SRTM)
- **OpenTopoMap + OpenStreetMap** — the topographic basemap, contours and trails included
- **PyVista / VTK** — real texture-mapped 3D rendering (the thing `matplotlib` quietly
  refuses to do well), with sun-cast hillshade and anti-aliasing

Open data + open tools, start to finish.
