import { useCallback, useEffect, useMemo, useState } from "react";
import "./stylist.css";

const PART_NAMES = {
  upperbody: "Tops", wholebody_up: "Layers", lowerbody: "Bottoms",
  accessories_up: "Accessories", shoes: "Shoes",
};
const PART_ORDER = Object.keys(PART_NAMES);
const EMPTY_STATE = { trips: [], looks: [], setup: { hasLlm: false, hasImageKey: false, hasReference: false } };
const SUGGESTION_STAGES = {
  preparing: "Preparing selected items",
  weather: "Checking destination weather",
  model: "Asking the stylist",
  thinking: "Considering combinations",
  responding: "Receiving outfit ideas",
  checking: "Checking garments and colors",
  retrying: "Refining the suggestions",
  saving: "Saving draft outfits",
};

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

async function requestSuggestions(body, onProgress) {
  const response = await fetch("/api/stylist/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "The suggestion request failed.");
  }
  if (!response.body) throw new Error("The server did not provide suggestion progress.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let looks;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") onProgress(event.stage);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") looks = event.looks;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        handle(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
      if (done) break;
    }
    if (pending.trim()) handle(pending);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!Array.isArray(looks)) throw new Error("The suggestion request ended before outfits were saved.");
  return looks;
}

function ItemThumb({ item }) {
  return <img src={item.thumbnail || item.image} alt="" loading="lazy" />;
}

function TripForm({ onCreate, busy }) {
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  return (
    <form className="stylist-trip-form" onSubmit={async (event) => {
      event.preventDefault();
      if (await onCreate({ name, destination, startDate, endDate })) {
        setName(""); setDestination(""); setStartDate(""); setEndDate("");
      }
    }}>
      <label>Trip name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Kyoto in autumn" /></label>
      <label>Destination<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Kyoto, Japan" /></label>
      <div className="stylist-two-fields">
        <label>From<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>To<input type="date" min={startDate || undefined} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
      </div>
      <button className="stylist-primary" disabled={busy || !name.trim()}>Create trip</button>
    </form>
  );
}

function TripDetails({ trip, items, busy, onSave, onDelete }) {
  const [search, setSearch] = useState("");
  const [details, setDetails] = useState({
    name: trip.name, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate,
  });
  useEffect(() => {
    setDetails({ name: trip.name, destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate });
    setSearch("");
  }, [trip.id]);
  const sorted = [...items].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part) || a.name.localeCompare(b.name));
  const visible = sorted.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()) || item.tags?.some((tag) => tag.includes(search.toLowerCase())));
  const count = (status) => Object.values(trip.items || {}).filter((value) => value === status).length;
  const changeItem = (id, status) => {
    const next = { ...trip.items };
    if (status) next[id] = status;
    else delete next[id];
    onSave({ items: next });
  };
  return (
    <section className="stylist-panel stylist-packing">
      <div className="stylist-section-heading">
        <h2>{trip.name}</h2>
        <button className="stylist-text-button danger" type="button" disabled={busy} onClick={onDelete}>Delete trip</button>
      </div>
      <details className="stylist-trip-settings"><summary>Trip details</summary><form className="stylist-details-form" onSubmit={(event) => { event.preventDefault(); onSave(details); }}>
        <label>Trip name<input value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} /></label>
        <label>Destination<input value={details.destination} onChange={(event) => setDetails({ ...details, destination: event.target.value })} placeholder="City, country" /></label>
        <div className="stylist-two-fields">
          <label>From<input type="date" value={details.startDate} onChange={(event) => setDetails({ ...details, startDate: event.target.value })} /></label>
          <label>To<input type="date" value={details.endDate} onChange={(event) => setDetails({ ...details, endDate: event.target.value })} /></label>
        </div>
        <button type="submit" className="stylist-secondary" disabled={busy || !details.name.trim()}>Save trip details</button>
      </form></details>
      <div className="stylist-pack-summary">
        <span>{count("planned")} planned</span><span>{count("packed")} packed</span><span>{count("worn")} worn or laundry</span>
      </div>
      <p className="stylist-note">Outfits use packed items. Worn items are included with a warning.</p>
      <label className="stylist-search">Find a wardrobe item<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search clothes and accessories" /></label>
      <div className="stylist-pack-list">
        {visible.map((item) => (
          <div className="stylist-pack-row" key={item.id}>
            <ItemThumb item={item} />
            <div className="stylist-pack-name"><span>{item.name}</span><small>{PART_NAMES[item.part] || "Item"}</small></div>
            <select
              aria-label={`Packing status for ${item.name}`}
              value={trip.items?.[item.id] || ""}
              disabled={busy}
              onChange={(event) => changeItem(item.id, event.target.value)}
            >
              <option value="">Not on trip</option>
              <option value="planned">Planned</option>
              <option value="packed">Packed</option>
              <option value="worn">Worn / laundry</option>
            </select>
          </div>
        ))}
      </div>
      {!visible.length && <p className="stylist-note">No matching items.</p>}
    </section>
  );
}

function LookCard({ look, items, trip, setup, busy, revision, setRevision, onRevise, onPhoto, onSave, onDate, onDelete, hideHeading = false }) {
  const garments = look.garmentIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const currentWarnings = trip ? garments.filter((item) => trip.items?.[item.id] === "worn").map((item) => `${item.name} is marked worn or in laundry.`) : [];
  const unavailable = trip ? garments.filter((item) => !["packed", "worn"].includes(trip.items?.[item.id])) : [];
  const warnings = [...new Set([...currentWarnings, ...unavailable.map((item) => `${item.name} is no longer packed.`)])];
  const photoMissing = !setup.hasImageKey ? "Add an image API key to enable modeled photos." : !setup.hasReference ? "Add a model reference photo to enable modeled photos." : "";
  return (
    <article className="stylist-look">
      <div className="stylist-look-main">
        {look.image ? <img className="stylist-look-photo" src={look.image} alt={`Modeled preview for ${look.name}`} loading="lazy" /> : (
          <div className="stylist-look-collage">{garments.map((item) => <ItemThumb key={item.id} item={item} />)}</div>
        )}
        <div className="stylist-look-copy">
          {!hideHeading && <>
            <div className="stylist-look-topline"><span>{look.status === "generating" ? "Making photo" : look.status === "review" ? "Review photo" : look.savedAt ? "Saved" : "Draft"}</span><span>{look.occasion}</span></div>
            <h3>{look.name}</h3>
          </>}
          <p>{look.reason}</p>
          <div className="stylist-garment-list">{garments.map((item) => <span key={item.id}>{item.name}</span>)}</div>
          {look.palette && <div className="stylist-palette">
            <span>Wada #{look.palette.id}</span>
            {look.palette.colors.map((color) => <span className="stylist-swatch" key={color.name} title={`${color.name} ${color.hex}`} style={{ background: color.hex }} />)}
          </div>}
          {look.weather && <p className="stylist-small">Conditions: {look.weather}</p>}
          {warnings.map((warning) => <p className="stylist-warning" key={warning}>{warning}</p>)}
          {look.error && <p className="stylist-warning">{look.error}</p>}
          {look.status === "generating" && <p className="stylist-small" role="status">Generating the modeled photo. This may take a few minutes.</p>}
          {look.status === "review" && <p className="stylist-small">Check the person and every selected garment. Regenerate if anything looks wrong.</p>}
          {look.messages?.length > 0 && <div className="stylist-chat-history">{look.messages.map((entry, index) => <p key={index} className={entry.role}><strong>{entry.role === "user" ? "You" : "Stylist"}</strong> {entry.text}</p>)}</div>}
        </div>
      </div>
      {["idea", "failed"].includes(look.status) && <form className="stylist-revise-form" onSubmit={(event) => { event.preventDefault(); onRevise(look.id); }}>
        <input aria-label={`Revise ${look.name}`} value={revision || ""} onChange={(event) => setRevision(look.id, event.target.value)} placeholder="Ask the stylist to change this look…" />
        <button type="submit" className="stylist-secondary" disabled={busy || !revision?.trim()}>Revise</button>
      </form>}
      <div className="stylist-look-actions">
        {["idea", "failed", "review"].includes(look.status) && <button className="stylist-primary" type="button" disabled={busy || unavailable.length > 0 || Boolean(photoMissing)} title={photoMissing || undefined} onClick={() => onPhoto(look.id)}>{look.status === "review" ? "Regenerate photo" : "See how it looks"}</button>}
        {!look.savedAt && look.status !== "generating" && <button className="stylist-secondary" type="button" disabled={busy || unavailable.length > 0} onClick={() => onSave(look.id)}>Save outfit</button>}
        {look.savedAt && trip && <label className="stylist-day">Wear on<input type="date" value={look.date || ""} min={trip.startDate || undefined} max={trip.endDate || undefined} disabled={busy} onChange={(event) => onDate(look.id, event.target.value)} /></label>}
        <button className="stylist-text-button danger" type="button" disabled={busy} onClick={() => onDelete(look.id)}>Delete look</button>
      </div>
    </article>
  );
}

export function Stylist({ items, view, onNavigate }) {
  const [state, setState] = useState(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState("all");
  const [savedScope, setSavedScope] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevisionState] = useState({});
  const [count, setCount] = useState(3);
  const [occasion, setOccasion] = useState("");
  const [conditions, setConditions] = useState("");
  const [brief, setBrief] = useState("");
  const [anchorId, setAnchorId] = useState("");
  const [chosenIds, setChosenIds] = useState(null);
  const [weather, setWeather] = useState(null);
  const [suggestionProgress, setSuggestionProgress] = useState(null);
  const [suggestionSeconds, setSuggestionSeconds] = useState(0);

  const refresh = useCallback(async () => setState(await request("/state")), []);
  useEffect(() => { refresh().catch((failure) => setError(failure.message)).finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    if (savedScope !== "all" && savedScope !== "wardrobe" && !state.looks.some((look) => look.savedAt && look.tripId === savedScope)) setSavedScope("all");
    if (savedScope === "wardrobe" && !state.looks.some((look) => look.savedAt && !look.tripId)) setSavedScope("all");
  }, [savedScope, state.looks]);
  useEffect(() => {
    if (!state.looks.some((look) => look.status === "generating")) return undefined;
    const timer = window.setInterval(() => refresh().catch(() => {}), 2500);
    return () => window.clearInterval(timer);
  }, [state.looks, refresh]);
  useEffect(() => {
    if (!suggestionProgress) return undefined;
    const timer = window.setInterval(() => setSuggestionSeconds(Math.floor((Date.now() - suggestionProgress.startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [suggestionProgress?.startedAt]);

  const act = async (action, success) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); if (success) setNotice(success); return true; }
    catch (failure) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  const trip = state.trips.find((entry) => entry.id === scope) || null;
  const savedView = view === "outfits";
  const available = useMemo(() => trip
    ? items.filter((item) => ["packed", "worn"].includes(trip.items?.[item.id]))
    : items, [items, trip]);
  const requestItems = chosenIds ? available.filter((item) => chosenIds.includes(item.id)) : available;
  const draftLooks = state.looks.filter((look) => !look.savedAt && look.tripId === (trip?.id || null)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const allSavedLooks = state.looks.filter((look) => Boolean(look.savedAt));
  const wardrobeSavedCount = allSavedLooks.filter((look) => !look.tripId).length;
  const savedTripCollections = state.trips.filter((entry) => allSavedLooks.some((look) => look.tripId === entry.id));
  const showSavedFilters = Number(wardrobeSavedCount > 0) + savedTripCollections.length > 1;
  const savedLooks = allSavedLooks.filter((look) => savedScope === "all" || (savedScope === "wardrobe" ? !look.tripId : look.tripId === savedScope))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const setRevision = (id, value) => setRevisionState((current) => ({ ...current, [id]: value }));
  const createTrip = async (details) => act(async () => {
    const created = await request("/trips", "POST", details);
    setScope(created.id);
  }, "Trip created. Mark the items you have packed.");
  const deleteTrip = () => {
    if (!window.confirm(`Delete ${trip.name} and its outfits?`)) return;
    act(async () => { await request(`/trips/${trip.id}`, "DELETE"); setScope("all"); }, "Trip deleted.");
  };
  const deleteLook = (id) => {
    if (!window.confirm("Delete this look and its photo?")) return;
    act(() => request(`/looks/${id}`, "DELETE"), "Look deleted.");
  };
  const lookupWeather = () => act(async () => {
    if (!trip?.destination) throw new Error("Add a trip destination first.");
    const query = new URLSearchParams({ destination: trip.destination, startDate: trip.startDate || "", endDate: trip.endDate || "" });
    const result = await request(`/weather?${query}`);
    setWeather(result);
  });

  useEffect(() => { setAnchorId(""); setChosenIds(null); setWeather(null); setConditions(""); }, [scope]);

  const renderLook = (look) => {
    const lookTrip = state.trips.find((entry) => entry.id === look.tripId) || null;
    const card = <LookCard
      key={look.id} look={look} items={items} trip={lookTrip} hideHeading={savedView}
      setup={state.setup} busy={busy}
      revision={revision[look.id]} setRevision={setRevision}
      onRevise={(id) => act(async () => { await request(`/looks/${id}/revise`, "POST", { message: revision[id] }); setRevision(id, ""); }, "Look revised.")}
      onPhoto={(id) => act(() => request(`/looks/${id}/photo`, "POST"), "Photo generation started.")}
      onSave={async (id) => {
        if (await act(() => request(`/looks/${id}/save`, "POST"), "Outfit saved.")) {
          setSavedScope(look.tripId || "all");
          onNavigate("outfits");
        }
      }}
      onDate={(id, date) => act(() => request(`/looks/${id}`, "PATCH", { date }))}
      onDelete={deleteLook}
    />;
    if (!savedView) return card;
    const garments = look.garmentIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
    const previewItems = ["upperbody", "lowerbody"].map((part) => garments.find((item) => item.part === part)).filter(Boolean);
    const detail = look.status === "generating" ? "Making photo" : look.status === "review" ? "Review photo" : look.status === "failed" ? "Photo failed" : look.date || `${garments.length} pieces`;
    return <details className="stylist-saved-row" key={look.id}>
      <summary>
        <span className={`stylist-saved-thumb${look.image ? " has-photo" : ""}`}>
          {look.image ? <img src={look.image} alt="" loading="lazy" /> : previewItems.map((item) => <ItemThumb key={item.id} item={item} />)}
        </span>
        <span className="stylist-saved-copy"><strong>{look.name}</strong><small>{[lookTrip?.name || "Whole wardrobe", look.occasion].filter(Boolean).join(" · ")}</small></span>
        <span className="stylist-saved-detail">{detail}</span>
      </summary>
      {card}
    </details>;
  };

  return (
    <main className={`stylist-page${savedView ? " saved-outfits-page" : ""}`}>
      <header className="stylist-hero"><h1>{savedView ? "Saved outfits" : "Outfit planner"}</h1>{!savedView && <p>Build looks from your wardrobe or a trip packing list.</p>}</header>
      {!savedView && !state.setup.hasLlm && <p className="stylist-alert">Set <code>WARDROBE_LLM_API_KEY</code> or <code>WARDROBE_LLM_BASE_URL</code> in <code>.env</code> and restart the app to ask for outfits.</p>}
      {!savedView && !state.setup.hasImageKey && <p className="stylist-alert">Add <code>OPENAI_IMAGE_API_KEY</code> to <code>.env</code> to create modeled photos.</p>}
      {!savedView && !state.setup.hasReference && <p className="stylist-alert">Add <code>data/model-reference.png</code> to create modeled photos.</p>}
      {error && <p className="stylist-alert error" role="alert">{error}</p>}
      {notice && <p className="stylist-notice" role="status">{notice}</p>}

      {savedView ? <div className="stylist-saved-page">
        {showSavedFilters && <nav className="stylist-saved-filters" aria-label="Saved outfit collections">
          <button type="button" className={savedScope === "all" ? "active" : ""} onClick={() => setSavedScope("all")}>All</button>
          {wardrobeSavedCount > 0 && <button type="button" className={savedScope === "wardrobe" ? "active" : ""} onClick={() => setSavedScope("wardrobe")}>Whole wardrobe</button>}
          {savedTripCollections.map((entry) => <button type="button" className={savedScope === entry.id ? "active" : ""} key={entry.id} onClick={() => setSavedScope(entry.id)}>{entry.name}</button>)}
        </nav>}
        <section className="stylist-results">
          {loading && <div className="stylist-empty">Loading outfits…</div>}
          {!loading && !error && !savedLooks.length && <div className="stylist-empty">No saved outfits here. Save a draft from the planner to add one.</div>}
          {savedLooks.map(renderLook)}
        </section>
      </div> :
      <div className="stylist-layout">
        <aside className="stylist-sidebar">
          <section className="stylist-panel">
            <div className="stylist-section-heading"><h2>Lists</h2></div>
            <div className="stylist-trip-nav">
              <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>Whole wardrobe <span>{items.length}</span></button>
              {state.trips.map((entry) => <button type="button" className={scope === entry.id ? "active" : ""} key={entry.id} onClick={() => setScope(entry.id)}>{entry.name} <span>{Object.keys(entry.items || {}).length}</span></button>)}
            </div>
          </section>
          <details className="stylist-panel stylist-new-trip" key={state.trips.length}><summary>New trip</summary><TripForm onCreate={createTrip} busy={busy} /></details>
        </aside>

        <div className="stylist-content">
          {trip && <TripDetails key={trip.id} trip={trip} items={items} busy={busy} onSave={(changes) => act(() => request(`/trips/${trip.id}`, "PATCH", changes))} onDelete={deleteTrip} />}
          <section className="stylist-panel stylist-ask">
            <div className="stylist-section-heading"><h2>Outfit ideas</h2><span className="stylist-item-count">{requestItems.length} items available</span></div>
            {trip && <p className="stylist-note">Only packed and worn items are available.</p>}
            <form className="stylist-ask-form" onSubmit={async (event) => {
              event.preventDefault();
              setSuggestionSeconds(0);
              setSuggestionProgress({ startedAt: Date.now(), stages: [] });
              await act(() => requestSuggestions({ tripId: trip?.id || null, selectedItemIds: requestItems.map((item) => item.id), count: Number(count), occasion, conditions, brief, anchorId: requestItems.some((item) => item.id === anchorId) ? anchorId : "" }, (stage) => {
                setSuggestionProgress((current) => current && current.stages.at(-1) !== stage
                  ? { ...current, stages: [...current.stages, stage] } : current);
              }), "Draft looks saved. Revise one or make its photo.");
              setSuggestionProgress(null);
            }}>
              <details className="stylist-item-picker"><summary>Choose items for this request <span>{requestItems.length} of {available.length} selected</span></summary>
                <div className="stylist-picker-actions"><button type="button" className="stylist-text-button" onClick={() => setChosenIds(null)}>Select all available</button></div>
                <div className="stylist-picker-list">{available.map((item) => <label key={item.id} className="stylist-picker-item"><input type="checkbox" checked={requestItems.some((chosen) => chosen.id === item.id)} onChange={() => {
                  const current = chosenIds || available.map((entry) => entry.id);
                  setChosenIds(current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id]);
                  if (anchorId === item.id) setAnchorId("");
                }} /><ItemThumb item={item} /><span>{item.name}</span></label>)}</div>
              </details>
              <div className="stylist-form-grid">
                <label>Number of looks<select value={count} onChange={(event) => setCount(event.target.value)}>{[1, 2, 3, 4, 5, 6].map((value) => <option key={value}>{value}</option>)}</select></label>
                <label>Occasion<input value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="Dinner, sightseeing, office…" /></label>
                <label>Anchor piece<select value={requestItems.some((item) => item.id === anchorId) ? anchorId : ""} onChange={(event) => setAnchorId(event.target.value)}><option value="">Let the stylist choose</option>{requestItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              </div>
              {trip?.destination && <div className="stylist-weather-row"><button type="button" className="stylist-secondary" disabled={busy} onClick={lookupWeather}>Check destination weather</button>{weather && <span>{weather.unavailable ? "Forecast is outside the available range. Enter conditions below." : weather.summary}</span>}</div>}
              <label>Weather or conditions override<input value={conditions} onChange={(event) => setConditions(event.target.value)} placeholder="Warm days, cool evenings, possible rain…" /></label>
              <label>What would you like to wear?<textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} placeholder="I want relaxed looks that work for walking all day and one nicer dinner." /></label>
              <div className="stylist-submit-row"><button className="stylist-primary" disabled={busy || !state.setup.hasLlm || !requestItems.some((item) => item.part === "upperbody") || !requestItems.some((item) => item.part === "lowerbody")}>{suggestionProgress ? "Suggesting…" : "Suggest outfits"}</button></div>
              {suggestionProgress && <div className="stylist-suggest-progress">
                <div className="stylist-progress-heading"><span className="stylist-progress-spinner" aria-hidden="true" /><strong role="status" aria-live="polite">{SUGGESTION_STAGES[suggestionProgress.stages.at(-1)] || "Starting the stylist"}</strong><span className="stylist-progress-time" aria-hidden="true">{Math.floor(suggestionSeconds / 60)}:{String(suggestionSeconds % 60).padStart(2, "0")}</span></div>
                <div className="stylist-progress-track" aria-hidden="true"><span /></div>
                <ol className="stylist-progress-steps">{suggestionProgress.stages.slice(-4).map((stage, index, recent) => <li key={`${stage}-${index}`} className={index === recent.length - 1 ? "current" : "complete"}>{SUGGESTION_STAGES[stage]}</li>)}</ol>
              </div>}
            </form>
          </section>
          <section className="stylist-results">
            <div className="stylist-section-heading"><h2>Drafts</h2><span className="stylist-item-count">{draftLooks.length} {draftLooks.length === 1 ? "look" : "looks"}</span></div>
            {!draftLooks.length && <div className="stylist-empty">No drafts yet.</div>}
            {draftLooks.map(renderLook)}
          </section>
          <p className="stylist-credit">Color references: <a href="https://github.com/mattdesl/dictionary-of-colour-combinations" target="_blank" rel="noreferrer">Sanzo Wada dictionary dataset</a>. Forecast: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>.</p>
        </div>
      </div>}
    </main>
  );
}
