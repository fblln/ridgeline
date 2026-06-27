# From a Space Shuttle to a laser plane: 25 years of (free) elevation data

I rendered a 3D map of a morning hike this week. Halfway through, I swapped the elevation
source — and accidentally took a tour through 25 years of how we measure mountains. Both
sources were **free and public**. That's the part worth talking about.

## 2000: NASA SRTM — the whole planet in 11 days

In February 2000, Space Shuttle *Endeavour* flew with a 60-metre radar mast bolted to its
side and scanned almost the entire land surface of Earth in eleven days. The result —
**SRTM**, a 30-metre elevation model of the world — was released to the public for free.

It was revolutionary. For the first time, anyone could get the shape of the ground anywhere
on Earth without a licence or a fee. A quarter-century later it still quietly powers a huge
slice of the maps, games, and apps you use.

But 30 m is 30 m. From orbit, a gully, a switchback, a stream cut — they all blur into one
smooth slope.

## 2009: Regione Piemonte — a laser over the Alps

Then I switched my render to the **Regione Piemonte LIDAR DTM**: a regional government flew
aircraft firing laser pulses at the ground, building a terrain model at **5 metres, accurate
to ±30 centimetres** vertically. (A 1 m version exists too.)

The difference on screen was immediate. SRTM gave me a soft, blobby mountain. The LIDAR gave
me **individual drainages, ridgelines, the actual texture of the slope** — the terrain you'd
recognise from walking it.

Radar from space → laser from a plane. 30 m → 5 m. One global snapshot → regional precision
you can almost trip over.

## The quietly amazing part: it's just… public

Here's what gets me. A regional administration laser-scanned the Alps at sub-metre vertical
accuracy — an expensive, serious piece of work — and then **gave it away**. Free. Open
licence (CC BY). Served over a standard open protocol (WCS) so a script can pull exactly the
patch it needs.

So on a laptop, with **zero proprietary software and zero cost**, I pulled public laser data,
draped a public topographic map (OpenStreetMap / OpenTopoMap) over it, and rendered a 3D
terrain view that wouldn't look out of place in a paid outdoor app.

No GIS licence. No data vendor. No paywall. Just open data + open tools.

## Open data is infrastructure

We talk a lot about open *source*. Open *data* deserves the same applause. SRTM let a
generation build on a free map of the world. Now regional agencies like Piemonte are putting
out data an order of magnitude finer — and publishing it in open formats anyone can use.

That's not a nice-to-have. That's public money creating a public good that compounds: every
researcher, student, hobbyist, and startup that builds on it gets a head start they didn't
have to pay for.

Huge kudos to NASA, to Regione Piemonte, and to every agency that chooses to open its data
instead of locking it up. You make the fun stuff possible.

*(Render: a GPS hike track on Piemonte 5 m LIDAR + OpenTopoMap, in Python with PyVista. All
open data, all open source.)*
