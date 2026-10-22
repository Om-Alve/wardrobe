import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, BookmarkSimple, Check, EyeSlash } from "@phosphor-icons/react";
import "./lookbook.css";

async function request(path, method = "GET", body) {
  const response = await fetch(`/api/stylist${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result;
}

const key = (ids) => [...ids].sort().join("|");

function Tile({ outfit, items, saved, wornToday, busy, onSave, onWear, onHide }) {
  const pieces = outfit.ids.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  return (
    <article className="lookbook-tile">
      <div className="lookbook-collage">
        {pieces.map((piece) => <img key={piece.id} src={piece.thumbnail || piece.image} alt={piece.name} title={piece.name} loading="lazy" />)}
      </div>
      <div className="lookbook-copy">
        <strong>{outfit.name}</strong>
        {outfit.why && <p>{outfit.why}</p>}
        {outfit.note && <small>{outfit.note}</small>}
        {outfit.palette && <span className="lookbook-palette" title={`Follows combination ${outfit.palette.id} in Sanzo Wada's Dictionary of Colour Combinations`}>
          {outfit.palette.colors.map((color) => <i key={color.hex} style={{ background: color.hex }} title={color.name} />)}
          <small>Wada {outfit.palette.id}</small>
        </span>}
      </div>
      <div className="lookbook-actions">
        <button type="button" aria-label={saved ? "Saved" : "Save outfit"} title={saved ? "Saved" : "Save outfit"} aria-pressed={saved} disabled={busy || saved} onClick={onSave}>
          <BookmarkSimple size={17} weight={saved ? "fill" : "regular"} aria-hidden="true" />
        </button>
        <button type="button" aria-label={wornToday ? "Worn today" : "Wore it"} title={wornToday ? "Worn today" : "Wore it"} aria-pressed={Boolean(wornToday)} disabled={busy} onClick={onWear}>
          <Check size={17} weight={wornToday ? "bold" : "regular"} aria-hidden="true" />
        </button>
        {onHide && <button type="button" aria-label="Hide outfit" title="Hide outfit" disabled={busy} onClick={onHide}>
          <EyeSlash size={17} aria-hidden="true" />
        </button>}
      </div>
    </article>
  );
}

export function Lookbook({ items, looks, wears, hasLlm, busy, act }) {
  const [lookbook, setLookbook] = useState(null);
  const [stale, setStale] = useState(false);
  const [building, setBuilding] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [genre, setGenre] = useState("all");

  const build = useCallback(async () => {
    setBuilding(true); setError("");
    try { setLookbook((await request("/lookbook", "POST")).lookbook); setStale(false); }
    catch (failure) { setError(failure.message); }
    finally { setBuilding(false); }
  }, []);
  const reload = useCallback(async () => {
    const result = await request("/lookbook");
    setLookbook(result.lookbook);
    setStale(result.stale);
    return result;
  }, []);
  // Built once and kept; it rebuilds on its own when the wardrobe has changed since.
  useEffect(() => {
    reload().then((result) => { if ((!result.lookbook || result.stale) && hasLlm) build(); })
      .catch((failure) => setError(failure.message));
  }, [reload, build, hasLlm]);
  useEffect(() => {
    if (!building) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => { window.clearInterval(timer); setSeconds(0); };
  }, [building]);

  const parts = useMemo(() => new Map(items.map((item) => [item.id, item.part])), [items]);
  const core = useCallback((ids) => key(ids.filter((id) => parts.get(id) !== "accessories_up")), [parts]);
  const savedKeys = useMemo(() => new Set(looks.filter((look) => look.savedAt).map((look) => core(look.garmentIds))), [looks, core]);
  const today = new Date().toLocaleDateString("en-CA");
  const wornToday = useMemo(() => new Map(wears.filter((wear) => wear.date === today).map((wear) => [core(wear.garmentIds), wear])), [wears, today, core]);

  const genres = lookbook?.genres || [];
  const outfits = lookbook?.outfits || [];
  const sections = genres.map((entry) => ({ ...entry, outfits: outfits.filter((outfit) => outfit.genre === entry.name) }));
  const shown = genre === "all" ? sections : sections.filter((entry) => entry.name === genre);

  const tile = (outfit, entry) => {
    const id = key(outfit.ids);
    const worn = wornToday.get(id);
    return (
      <Tile
        key={id} outfit={outfit} items={items} busy={busy || building}
        saved={savedKeys.has(id)} wornToday={worn}
        onSave={() => act(() => request("/outfits/save", "POST", { garmentIds: outfit.ids, name: outfit.name, genre: entry?.name || "", reason: entry?.description || "" }), "Saved to your outfits.")}
        onWear={() => act(() => worn ? request(`/wears/${worn.id}`, "DELETE") : request("/wears", "POST", { garmentIds: outfit.ids }), worn ? "" : "Logged as worn today.")}
        onHide={async () => { if (await act(() => request("/outfits/hide", "POST", { garmentIds: outfit.ids }), "Hidden. The stylist will avoid this outfit.")) reload().catch(() => {}); }}
      />
    );
  };

  if (!lookbook) {
    return (
      <div className="lookbook">
        {error && <p className="stylist-alert error" role="alert">{error}</p>}
        <div className="stylist-empty">
          {!hasLlm ? "Set WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env to build outfits from your wardrobe."
            : building ? `Picking the best outfits from your wardrobe… ${seconds}s` : error ? "" : "Loading outfits…"}
        </div>
        {hasLlm && !building && error && <div><button type="button" className="stylist-secondary" onClick={build}>Try again</button></div>}
      </div>
    );
  }

  return (
    <div className={`lookbook${building ? " is-building" : ""}`}>
      {error && <p className="stylist-alert error" role="alert">{error}</p>}
      <div className="lookbook-bar">
        <span className="stylist-item-count">
          {building ? `${stale ? "Your wardrobe changed. " : ""}Rebuilding… ${seconds}s` : `${outfits.length} outfits picked from ${lookbook.considered || outfits.length} combinations`}
        </span>
        <button type="button" className="stylist-text-button lookbook-rebuild" disabled={building || !hasLlm} onClick={build}>
          <ArrowClockwise size={13} aria-hidden="true" /> Rebuild
        </button>
      </div>
      <nav className="lookbook-genres" aria-label="Filter outfits by genre">
        <button type="button" className={genre === "all" ? "active" : ""} onClick={() => setGenre("all")}>All<span>{outfits.length}</span></button>
        {sections.map((entry) => (
          <button type="button" key={entry.name} className={genre === entry.name ? "active" : ""} onClick={() => setGenre(entry.name)}>
            {entry.name}<span>{entry.outfits.length}</span>
          </button>
        ))}
      </nav>
      {shown.map((entry) => (
        <section className="lookbook-section" key={entry.name}>
          <h2>{entry.name}</h2>
          {entry.description && <p>{entry.description}</p>}
          <div className="lookbook-grid">{entry.outfits.map((outfit) => tile(outfit, entry))}</div>
        </section>
      ))}
    </div>
  );
}
