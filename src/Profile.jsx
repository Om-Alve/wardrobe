import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { colorProfile } from "../scripts/garment-attributes.mjs";
import { CHOICES, MONK_SCALE, normalizeProfile } from "../scripts/profile.mjs";
import "./stylist.css";
import "./profile.css";

async function request(method = "GET", route = "", body) {
  const response = await fetch(`/api/profile${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result;
}

// What a save would store, ignoring when it was last saved.
const comparable = (profile) => JSON.stringify({ ...normalizeProfile(profile), updatedAt: null });
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

function FieldLabel({ children, fromPhoto }) {
  return <span className="profile-label">{children}{fromPhoto && <small>from photo</small>}</span>;
}

function Choice({ field, title, options, names = {}, draft, set }) {
  const value = draft[field];
  return (
    <label>
      <FieldLabel fromPhoto={draft.source?.[field] === "photo"}>{title}</FieldLabel>
      <select value={value === undefined ? "" : String(value)} onChange={(event) => set(field, options.find((option) => String(option) === event.target.value))}>
        <option value="">—</option>
        {options.map((option) => <option key={String(option)} value={String(option)}>{names[option] || capitalize(String(option))}</option>)}
      </select>
    </label>
  );
}

function ColorList({ title, values = [], onChange }) {
  const [input, setInput] = useState("");
  const add = () => {
    const name = input.trim().toLowerCase();
    if (name && !values.includes(name)) onChange([...values, name]);
    setInput("");
  };
  return (
    <div className="profile-colors">
      <span className="profile-label">{title}</span>
      {values.length > 0 && <div className="editable-tags">
        {values.map((name) => (
          <span className="editable-tag" key={name}>
            {name}
            <button type="button" onClick={() => onChange(values.filter((entry) => entry !== name))} aria-label={`Remove ${name}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>}
      <div className="tag-input-row">
        <input
          value={input}
          list="profile-color-names"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(); }
          }}
          placeholder="Add a color"
          aria-label={`Add to ${title.toLowerCase()}`}
        />
        <button type="button" onClick={add} disabled={!input.trim()} aria-label="Add color">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function Profile({ items }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [setup, setSetup] = useState({ hasReference: false, hasLlm: false });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    request().then((result) => { setSaved(result.profile); setDraft(result.profile); setSetup(result); })
      .catch((failure) => setError(failure.message));
  }, []);

  // Names the scorer gives the wardrobe's own colors, offered while typing.
  const colorNames = useMemo(() => [...new Set(items.flatMap((item) => [item.color, item.secondaryColor])
    .map((hex) => colorProfile(hex)?.name).filter(Boolean))].sort(), [items]);

  if (!draft) {
    return (
      <main className="stylist-page profile-page">
        <header className="stylist-hero"><h1>Profile</h1></header>
        {error ? <p className="stylist-alert error" role="alert">{error}</p> : <div className="profile-sections"><div className="stylist-empty">Loading profile…</div></div>}
      </main>
    );
  }

  const dirty = comparable(draft) !== comparable(saved);
  const set = (field, value) => setDraft((current) => {
    const next = { ...current, [field]: value, source: { ...current.source, [field]: "user" } };
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
      delete next[field];
      delete next.source[field];
    }
    return next;
  });
  const run = async (kind, action) => {
    setBusy(kind); setError(""); setNotice("");
    try { await action(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  };
  const suggest = () => run("suggest", async () => {
    const { suggestion, note: photoNote } = await request("POST", "/suggest");
    setDraft((current) => ({
      ...current, ...suggestion,
      source: { ...current.source, ...Object.fromEntries(Object.keys(suggestion).map((key) => [key, "photo"])) },
    }));
    setNote(photoNote);
  });
  const save = () => run("save", async () => {
    const { profile } = await request("PUT", "", draft);
    setSaved(profile);
    setDraft(profile);
    setNotice("Profile saved.");
  });
  const photoBlocked = !setup.hasLlm
    ? "Set WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env to use this."
    : !setup.hasReference ? "Add data/model-reference.png to use this." : "";
  const choice = { draft, set };

  return (
    <main className="stylist-page profile-page">
      <header className="stylist-hero">
        <h1>Profile</h1>
        <label className="profile-toggle">
          <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
          Use in outfit suggestions
        </label>
      </header>
      {error && <p className="stylist-alert error" role="alert">{error}</p>}
      {notice && <p className="stylist-notice" role="status">{notice}</p>}

      <div className="profile-sections">
        <section className="stylist-panel profile-panel">
          <div className="stylist-section-heading"><h2>Coloring</h2></div>
          <div className="profile-photo-row">
            <button type="button" className="stylist-secondary" disabled={Boolean(busy || photoBlocked)} onClick={suggest}>
              {busy === "suggest" ? "Reading photo…" : "Suggest from my photo"}
            </button>
            <p className="stylist-note">{photoBlocked || "Your reference photo is sent to the configured model when you click this."}</p>
          </div>
          {note && <p className="profile-photo-note" role="status">{note}</p>}
          <div className="profile-field">
            <FieldLabel fromPhoto={draft.source?.skinDepth === "photo"}>Skin depth</FieldLabel>
            <div className="profile-monk" role="radiogroup" aria-label="Skin depth on the Monk scale">
              {MONK_SCALE.map((hex, index) => {
                const level = index + 1;
                const active = draft.skinDepth === level;
                return (
                  <button type="button" role="radio" aria-checked={active} aria-label={`Monk ${level}`} className={active ? "active" : ""} key={hex} onClick={() => set("skinDepth", active ? undefined : level)}>
                    <span style={{ background: hex }} />
                    <small>{level}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="profile-grid">
            <Choice field="hairLightness" title="Hair" options={CHOICES.hairLightness} {...choice} />
            <Choice field="greyHair" title="Grey hair" options={[false, true]} names={{ false: "No", true: "Yes" }} {...choice} />
            <Choice field="contrast" title="Contrast" options={CHOICES.contrast} {...choice} />
            <Choice field="undertone" title="Undertone" options={CHOICES.undertone} {...choice} />
            <Choice field="undertoneConfidence" title="Undertone confidence" options={CHOICES.undertoneConfidence} {...choice} />
          </div>
        </section>

        <section className="stylist-panel profile-panel">
          <div className="stylist-section-heading"><h2>Preferences</h2></div>
          <div className="profile-grid">
            <Choice field="fit" title="Fit" options={CHOICES.fit} {...choice} />
            <label>
              <span className="profile-label">Height (cm)</span>
              <input type="number" min="100" max="250" inputMode="numeric" value={draft.heightCm ?? ""} onChange={(event) => set("heightCm", event.target.value === "" ? undefined : Number(event.target.value))} />
            </label>
          </div>
          <label>
            <span className="profile-label">Goals</span>
            <input value={draft.goals || ""} maxLength={200} onChange={(event) => set("goals", event.target.value)} placeholder="Look taller, balance broad shoulders" />
          </label>
          <div className="profile-two">
            <ColorList title="Colors you love" values={draft.lovedColors} onChange={(value) => set("lovedColors", value)} />
            <div>
              <ColorList title="Colors to avoid" values={draft.avoidedColors} onChange={(value) => set("avoidedColors", value)} />
              <label className="profile-check">
                <input type="checkbox" checked={Boolean(draft.avoidNearFace)} onChange={(event) => set("avoidNearFace", event.target.checked)} />
                Only near the face
              </label>
            </div>
          </div>
          <label>
            <span className="profile-label">Rules</span>
            <input value={draft.rules || ""} maxLength={300} onChange={(event) => set("rules", event.target.value)} placeholder="No black with navy" />
          </label>
          <datalist id="profile-color-names">{colorNames.map((name) => <option key={name} value={name} />)}</datalist>
        </section>
      </div>

      <div className="profile-actions">
        <button type="button" className="stylist-primary" disabled={!dirty || Boolean(busy)} onClick={save}>{busy === "save" ? "Saving…" : "Save"}</button>
        {dirty && <button type="button" className="stylist-secondary" disabled={Boolean(busy)} onClick={() => { setDraft(saved); setNote(""); }}>Discard</button>}
      </div>
    </main>
  );
}
