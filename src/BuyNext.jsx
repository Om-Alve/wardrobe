import { useEffect, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { PART_LABELS } from "../scripts/garment-attributes.mjs";
import "./stylist.css";
import "./buy-next.css";

async function request(method = "GET", body) {
  const response = await fetch("/api/stylist/buy-next", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result;
}

const outfits = (count) => `${count} new ${count === 1 ? "outfit" : "outfits"}`;
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

function Purchase({ result, pieces }) {
  const changes = result.breakdown.filter((entry) => entry.after > entry.before);
  const summary = result.step
    ? `Adds ${outfits(result.added)}${result.step > 1 ? " with the pieces above" : ""}`
    : result.similarTo ? `Similar to ${result.similarTo}, which you own`
      : result.alternativeTo ? `Alternative to ${result.alternativeTo}` : "Adds no new outfits for these occasions";
  return (
    <article className="stylist-panel buy-item">
      <span className="buy-swatch" style={{ background: result.item.color }} aria-hidden="true" />
      <div className="buy-copy">
        <div className="buy-heading">
          <h3>{result.step ? `${result.step}. ` : ""}{result.item.name}</h3>
          <span className="stylist-item-count">{capitalize(PART_LABELS[result.item.part] || result.item.part)}</span>
        </div>
        <p className="buy-gain">{summary}</p>
        {changes.length > 0 && <div className="buy-changes">
          {changes.map((entry) => <span key={entry.occasion}>{capitalize(entry.occasion)}: {entry.before || "none"} → {entry.after}</span>)}
        </div>}
        {(result.note || result.why) && <p>{result.note || result.why}</p>}
        {result.examples.length > 0 && <div className="buy-examples">
          {result.examples.map((example) => (
            <div className="buy-example" key={example.occasion}>
              <div className="buy-example-pieces">
                {example.ids.map((id) => {
                  const piece = pieces.get(id);
                  if (!piece) return null;
                  return piece.image
                    ? <img key={id} src={piece.thumbnail || piece.image} alt={piece.name} title={piece.name} loading="lazy" />
                    : <span key={id} className="buy-swatch small" style={{ background: piece.color }} title={piece.name} />;
                })}
              </div>
              <small>{capitalize(example.occasion)}</small>
            </div>
          ))}
        </div>}
      </div>
    </article>
  );
}

export function BuyNext({ items }) {
  const [occasions, setOccasions] = useState(null);
  const [input, setInput] = useState("");
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    request().then((result) => {
      setOccasions(result.last?.occasions.map((occasion) => occasion.name) || result.occasions);
      setReview(result.last);
    }).catch((failure) => setError(failure.message));
  }, []);
  useEffect(() => {
    if (!busy) return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const add = () => {
    const name = input.trim().toLowerCase();
    if (name && !occasions.includes(name) && occasions.length < 8) setOccasions([...occasions, name]);
    setInput("");
  };
  const run = async () => {
    setBusy(true); setSeconds(0); setError("");
    try { setReview(await request("POST", { occasions })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const order = review?.results.filter((result) => result.step) || [];
  // Example outfits can include owned pieces and pieces suggested earlier in the order.
  const pieces = new Map([...items, ...(review?.results.map((result) => result.item) || [])].map((piece) => [piece.id, piece]));
  const others = review?.results.filter((result) => !result.step) || [];

  return (
    <main className="stylist-page buy-page">
      <header className="stylist-hero">
        <h1>What to buy next</h1>
        <p>Pieces ranked by the new complete outfits they would add for your occasions.</p>
      </header>
      {error && <p className="stylist-alert error" role="alert">{error}</p>}
      <section className="stylist-panel buy-occasions">
        <div className="stylist-section-heading"><h2>Occasions</h2></div>
        {occasions && <>
          <div className="editable-tags">
            {occasions.map((name) => (
              <span className="editable-tag" key={name}>
                {name}
                <button type="button" disabled={busy} onClick={() => setOccasions(occasions.filter((entry) => entry !== name))} aria-label={`Remove ${name}`}>
                  <X size={12} weight="regular" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
          <div className="tag-input-row">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(); } }}
              placeholder="Add an occasion, like rainy commute"
              aria-label="Add an occasion"
              disabled={busy || occasions.length >= 8}
            />
            <button type="button" onClick={add} disabled={!input.trim() || busy} aria-label="Add occasion">
              <Plus size={15} weight="regular" aria-hidden="true" />
            </button>
          </div>
        </>}
        <div className="stylist-submit-row">
          <button type="button" className="stylist-primary" disabled={busy || !occasions?.length} onClick={run}>
            {busy ? `Comparing pieces… ${seconds}s` : review ? "Review again" : "Find what to buy"}
          </button>
        </div>
      </section>

      {review && <>
        <div className="buy-coverage">
          {review.coverage.map((entry) => (
            <div key={entry.occasion}>
              <strong>{capitalize(entry.occasion)}</strong> {entry.outfits} complete {entry.outfits === 1 ? "outfit" : "outfits"}
              {(entry.notes || entry.gaps).map((note) => <small key={note}>{note}</small>)}
            </div>
          ))}
        </div>
        <section className="stylist-results">
          {order.length ? order.map((result) => <Purchase key={result.item.id} result={result} pieces={pieces} />)
            : <div className="stylist-empty">None of the suggested pieces would add outfits for these occasions.</div>}
          {others.length > 0 && <>
            <div className="stylist-section-heading"><h2>Alternatives and already covered</h2></div>
            {others.map((result) => <Purchase key={result.item.id} result={result} pieces={pieces} />)}
          </>}
        </section>
      </>}
    </main>
  );
}
