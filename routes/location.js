// routes/location.js
const express = require("express");
const router = express.Router();

// ---- Sanity route to confirm you're hitting THIS file
router.get("/_whoami", (req, res) => {
  res.setHeader("X-Handler", "gemini");
  return res.status(200).json({ ok: true, handler: "gemini-router" });
});

router.post("/", async (req, res) => {
  res.setHeader("X-Handler", "gemini");
  console.log("[/api/location] Gemini route live");

  try {
    const geminiKey =
      process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_SERVER_API_KEY;
    const placesKey =
      process.env.GOOGLE_PLACES_API_KEY ||
      process.env.GOOGLE_SERVER_API_KEY ||
      geminiKey;

    const { imageBase64, imageUrl, regionHint } = req.body || {};
    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ error: "imageBase64 or imageUrl is required" });
    }

    // --- Base64 normalization ---
    let imgB64 = imageBase64 || null;
    if (imgB64 && imgB64.startsWith("data:")) {
      const comma = imgB64.indexOf(",");
      imgB64 = comma >= 0 ? imgB64.slice(comma + 1) : imgB64;
    }

    // --- Fetch image URL if needed ---
    if (!imgB64 && imageUrl) {
      const r = await fetch(imageUrl);
      if (!r.ok) return res.status(400).json({ error: "failed_to_fetch_image_url" });
      const buf = Buffer.from(await r.arrayBuffer());
      imgB64 = buf.toString("base64");
    }

    // --- Gemini (1.5-flash) request ---
    const model = "gemini-1.5-flash";
    const prompt = `
You are a location recognition assistant.
Identify the MOST LIKELY real-world location in this single photo.
Return STRICT JSON only:
{
  "placeName": string | null,
  "city": string | null,
  "state": string | null,
  "country": string | null,
  "confidence": number,
  "rationale": string
}
If unsure, use null and confidence 0.
${regionHint ? `Region hint: ${regionHint}.` : ""}`.trim();

    const gReq = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "image/jpeg", data: imgB64 } }
          ]
        }
      ]
    };

    const gResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(gReq) }
    ).then(r => r.json());

    const gText = gResp?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = gText.match(/\{[\s\S]*\}$/) || gText.match(/\{[\s\S]*\}/);
    let g = null;
    try { g = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(gText); } catch {}

    const out = { candidates: [] };

    if (g && (g.placeName || g.city)) {
      out.candidates.push({
        placeName: g.placeName || [g.city, g.state, g.country].filter(Boolean).join(", "),
        lat: null,
        lng: null,
        confidence: Math.min(0.99, Math.max(0.55, g.confidence ?? 0.6)),
        source: "gemini"
      });
    }

    // --- Places fallback to get lat/lng ---
    const pieces = [g?.placeName, g?.city, g?.state, g?.country].filter(Boolean);
    let textQuery = pieces.join(" ");
    if (!textQuery && regionHint) textQuery = regionHint;

    if (textQuery) {
      const q = regionHint ? `${textQuery} ${regionHint}` : textQuery;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&type=tourist_attraction&key=${placesKey}`;
      const pr = await fetch(url).then(r => r.json());
      (pr.results || []).slice(0, 3).forEach((p, i) => {
        out.candidates.push({
          placeName: p.name,
          lat: p.geometry?.location?.lat ?? null,
          lng: p.geometry?.location?.lng ?? null,
          confidence: (p.user_ratings_total ? Math.min(0.98, 0.62 + Math.log10(p.user_ratings_total)/10) : 0.6) - i*0.05,
          address: p.formatted_address,
          placeId: p.place_id,
          source: out.candidates.length ? "gemini+places" : "places_only"
        });
      });
    }

    // --- Final response ---
    if (!out.candidates.length) {
      return res.status(200).json({ placeName: null, lat: null, lng: null, confidence: 0, message: "no_idea" });
    }

    const withGeo = out.candidates.find(c => c.lat != null && c.lng != null);
    const best = withGeo || out.candidates[0];
    return res.status(200).json(best);
  } catch (e) {
    console.error("[/api/location] error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;