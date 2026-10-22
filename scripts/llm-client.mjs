export function llmSettings(setting) {
  const customBase = setting("WARDROBE_LLM_BASE_URL");
  return {
    key: setting("WARDROBE_LLM_API_KEY") || (customBase ? "" : setting("OPENAI_API_KEY")),
    baseUrl: (customBase || setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1")).replace(/\/$/, ""),
    configured: Boolean(setting("WARDROBE_LLM_API_KEY") || customBase || setting("OPENAI_API_KEY")),
  };
}

export function imageSettings(setting) {
  return {
    key: setting("OPENAI_IMAGE_API_KEY") || setting("OPENAI_API_KEY"),
    baseUrl: setting("OPENAI_IMAGE_BASE_URL", setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1")).replace(/\/$/, ""),
  };
}

export async function chatJson({ key, baseUrl, model, prompt, image, mime = "image/png", timeout = 90000 }) {
  const content = image ? [
    { type: "text", text: `${prompt}\nReturn only a valid JSON object, without Markdown fences or commentary.` },
    { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
  ] : `${prompt}\nReturn only a valid JSON object, without Markdown fences or commentary.`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `LLM request failed (${response.status})`);
  const answer = result.choices?.[0]?.message?.content;
  const text = typeof answer === "string" ? answer : Array.isArray(answer) ? answer.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
  if (!text) throw new Error("The LLM returned no answer.");
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); }
  catch { throw new Error("The LLM did not return valid JSON. Try a model that follows JSON instructions."); }
}
