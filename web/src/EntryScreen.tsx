import { Compass, MapPin, Mountain, Search, Upload } from "lucide-react";
import { useState } from "react";

type EntryTab = "search" | "coords" | "gpx";

// ponytail: one mock valley exists, so the inputs are visual — any submit loads it.
export function EntryScreen({ onLoad }: { onLoad: () => void }) {
  const [tab, setTab] = useState<EntryTab>("search");

  return (
    <main className="entry-screen">
      <form
        className="entry-card"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad();
        }}
      >
        <div className="entry-brand">
          <div className="brand-mark">
            <Mountain size={20} />
          </div>
          <div>
            <h1>Ridgeline</h1>
            <p className="entry-tagline">Fly any valley from the sky · 2D / 3D LiDAR terrain</p>
          </div>
        </div>

        <div className="entry-tabs" role="tablist">
          <button type="button" className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
            Search a place
          </button>
          <button type="button" className={tab === "coords" ? "active" : ""} onClick={() => setTab("coords")}>
            Lat, Long
          </button>
          <button type="button" className={tab === "gpx" ? "active" : ""} onClick={() => setTab("gpx")}>
            Import GPX
          </button>
        </div>

        {tab === "search" ? (
          <div className="entry-field">
            <div className="entry-input-wrap">
              <Search size={16} />
              <input className="entry-input has-icon" placeholder="Search a place or peak…" />
            </div>
          </div>
        ) : null}

        {tab === "coords" ? (
          <div className="entry-coords">
            <div className="entry-input-wrap">
              <MapPin size={16} />
              <input className="entry-input has-icon" placeholder="Latitude" defaultValue="45.0703" />
            </div>
            <input className="entry-input" placeholder="Longitude" defaultValue="6.6431" />
          </div>
        ) : null}

        {tab === "gpx" ? (
          <div className="entry-field">
            <div className="entry-input-wrap">
              <Upload size={16} />
              <input className="entry-input has-icon" type="file" accept=".gpx" />
            </div>
          </div>
        ) : null}

        <div className="entry-preview">
          <Compass className="compass" size={18} />
          <span>20 km × 20 km terrain area</span>
        </div>

        <button type="submit" className="text-button primary wide">
          Load area
        </button>
      </form>
    </main>
  );
}
