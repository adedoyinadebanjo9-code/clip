// Supabase Edge Function: suggest-clips
// Secrets to set: GEMINI_API_KEY (required), ALLOWED_ORIGIN (your site origin, no path), GEMINI_MODEL (optional)

const KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MAX_CHARS = 60000;
const LIMIT = 6;          // requests per IP per window (best effort, resets when the instance restarts)
const WINDOW_MS = 60_000;

const PROMPT =
 " You choose short-form video clips (TikTok, Reels, Shorts,and those types) from a transcript. Each line starts with its start time in seconds in square brackets. " +
  "Return 3 to 6 clips, each 20 to 45 seconds long, that make sense on their own. " +
  "HOOK RULES: the first 3 seconds decide whether people keep watching. Start the clip on a bold claim, a surprising fact, a question, a conflict, or the start of a story that creates curiosity. Never start on filler (so, um, okay, welcome back, thanks for watching). Prefer to start at the beginning of a sentence. " +
  "WATCH-TIME RULES: no slow lead-in; deliver the payoff or answer inside the clip; cover one complete idea; end right after the payoff. " +
  "Use start and end times in seconds taken from the transcript timestamps. Clips must not overlap. " +
  "hook is the on-screen text for the first seconds: under 8 words, plain and specific, and true to what the clip delivers. " +
  "title is a headline under 60 characters. score is 0 to 100 for how strong the hook is and how well the clip should hold attention. reason is one sentence on why the clip works.";

const SCHEMA = {
  type: "OBJECT",
  properties: { clips: { type: "ARRAY", items: { type: "OBJECT",
    properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, title: { type: "STRING" }, score: { type: "NUMBER" }, reason: { type: "STRING" } },
    required: ["start", "end", "title", "score", "reason"] } } },
  required: ["clips"],
};

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const hits = new Map<string, number[]>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!KEY) return json({ error: "not_configured" }, 500);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return json({ error: "rate_limited" }, 429);
  recent.push(now);
  hits.set(ip, recent);

  let body: { transcript?: unknown; duration?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const transcript = body.transcript;
  const duration = Number(body.duration);
  if (typeof transcript !== "string" || transcript.length < 20 || transcript.length > MAX_CHARS)
    return json({ error: "bad_transcript" }, 400);
  if (!isFinite(duration) || duration <= 0 || duration > 4 * 3600) return json({ error: "bad_duration" }, 400);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${PROMPT}\nVideo length: ${Math.round(duration)} seconds.\n\nTranscript:\n${transcript}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    },
  );
  if (!res.ok) { console.error("gemini", res.status, await res.text()); return json({ error: "upstream" }, res.status === 429 ? 429 : 502); }

  try {
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return json(JSON.parse(text));
  } catch {
    return json({ error: "bad_model_output" }, 502);
  }
});
