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

async function streamedAnswer(response, onProgress) {
  if (!response.body) throw new Error("The LLM returned no response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let answer = "";
  let thinking = false;
  let responding = false;
  const readEvent = (event) => {
    const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || "The LLM stream failed.");
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content && !thinking) { thinking = true; onProgress("thinking"); }
    if (typeof delta?.content === "string" && delta.content) {
      if (!responding) { responding = true; onProgress("responding"); }
      answer += delta.content;
      if (answer.length > 1024 * 1024) throw new Error("The LLM answer is too large.");
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        readEvent(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
      if (done) break;
    }
    if (pending.trim()) readEvent(pending);
    return answer;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function chatJson({ key, baseUrl, model, prompt, image, mime = "image/png", timeout = 90000, onProgress, signal }) {
  const content = image ? [
    { type: "text", text: `${prompt}\nReturn only a valid JSON object, without Markdown fences or commentary.` },
    { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
  ] : `${prompt}\nReturn only a valid JSON object, without Markdown fences or commentary.`;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], ...(onProgress ? { stream: true } : {}) }),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
  });
  const result = response.ok && onProgress ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `LLM request failed (${response.status})`);
  const answer = onProgress ? await streamedAnswer(response, onProgress) : result.choices?.[0]?.message?.content;
  const text = typeof answer === "string" ? answer : Array.isArray(answer) ? answer.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
  if (!text) throw new Error("The LLM returned no answer.");
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); }
  catch { throw new Error("The LLM did not return valid JSON. Try a model that follows JSON instructions."); }
}
