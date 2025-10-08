// routes/location.js
const express = require("express");
const router = express.Router();

// Use global fetch if available (Node 18+/Vercel), else fallback to node-fetch v2
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = require("node-fetch");
}
const fetch = _fetch;

// CONFIG
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  process.env.GOOGLE_GEMINI_MODEL ||
  "gemini-1.5-pro"; // stronger than flash for landmarks

// POST /location (also at /api/location via dual mounts in server.js)
router.post("/", async (req, res) => {
  res.setHeader("X-Handler", "gemini-express");
  try {
    const geminiKey =
      process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_SERVER_API_KEY;
    const placesKey =
      process.env.GOOGLE_PLACES_API_KEY ||
      process.env.GOOGLE_SERVER_API_KEY ||
      geminiKey;

    if (!geminiKey) {
      return res.status(500).json({ error: "missing_gemini_key" });
    }

    const { imageBase64, imageUrl, regionHint } = req.body || {};
    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ error: "imageBase64 or imageUrl is required" });
    }

    // ---------- Normalize Image → base64 + mime ----------
    let imgB64 = imageBase64 || null;
    let mime = "image/jpeg"; // client now sends JPEG base64; default to jpeg

    if (imgB64 && imgB64.startsWith("data:")) {
      const m = imgB64.match(/^data:(.+?);base64,(.*)$/s);
      if (m) {
        mime = (m[1] || "image/jpeg").split(";")[0];
        imgB64 = m[2];
      } else {
        const comma = imgB64.indexOf(",");
        if (comma >= 0) imgB64 = imgB64.slice(comma + 1);
      }
    }

    // If only URL provided, fetch → base64 (best-effort content-type)
    if (!imgB64 && imageUrl) {
      try {
        const head = await fetch(imageUrl, { method: "HEAD" });
        const ct = head.headers.get("content-type");
        if (ct) mime = ct.split(";")[0];
      } catch {}
      const r = await fetch(imageUrl);
      if (!r.ok) return res.status(400).json({ error: "failed_to_fetch_image_url" });
      const buf = Buffer.from(await r.arrayBuffer());
      imgB64 = buf.toString("base64");
    }

    // Guard on tricky formats if a URL sneaks in
    if (/image\/(heic|heif|avif)/i.test(mime)) {
      return res
        .status(415)
        .json({ error: "unsupported_image_format", details: "Please send JPEG or PNG" });
    }

    // ---------- Gemini Call ----------
    const prompt = `
You are a location recognition assistant.
Identify the MOST LIKELY real-world location in this SINGLE photo.

Return STRICT JSON only (no prose), using this exact schema:
{
  "placeName": string | null,   // e.g. "Santa Monica Pier"
  "city": string | null,        // e.g. "Santa Monica"
  "state": string | null,       // e.g. "California"
  "country": string | null,     // e.g. "United States"
  "bestGuess": string | null,   // free-text guess if unsure (e.g., "a pier with ferris wheel on a beach")
  "confidence": number,         // 0.0–1.0
  "rationale": string           // short reason (<= 200 chars)
}

If unsure, set placeName/city/state/country to null, confidence 0, and still provide a short bestGuess.
${regionHint ? `Region hint: ${regionHint}.` : ""}`.trim();

    const generationConfig = { temperature: 0.2 }; // keep it factual
    const gReq = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mime || "image/jpeg", data: imgB64 } },
          ],
        },
      ],
      generationConfig,
    };

    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const gResp = await fetch(gUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gReq),
    }).then((r) => r.json());

    const finish = gResp?.candidates?.[0]?.finishReason;
    const gText = gResp?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Debug (non-sensitive, short)
    console.log("[location] finishReason:", finish);
    if (gText) console.log("[location] gText sample:", gText.slice(0, 200));

    let g = null;
    try {
      const jsonMatch = gText.match(/\{[\s\S]*?\}/);
      g = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(gText);
    } catch {
      // leave null
    }

    const out = { candidates: [] };

    // prefer structured fields, but allow bestGuess to drive Places
    let bestGuess = g?.bestGuess || null;

    if (g && (g.placeName || g.city || g.country || bestGuess)) {
      out.candidates.push({
        placeName:
          g.placeName || [g.city, g.state, g.country].filter(Boolean).join(", "),
        lat: null,
        lng: null,
        confidence: Math.min(0.99, Math.max(0.5, g.confidence ?? 0.6)),
        source: "gemini",
      });
    }

    // ---------- Resolve to lat/lng via Places ----------
    let textQuery = "";
    const pieces = [
      g?.placeName,
      g?.city,
      g?.state,
      g?.country,
      regionHint,
      bestGuess,
      // sprinkle in landmark-y terms to bias search meaningfully
      "landmark",
      "viewpoint",
      "tourist attraction",
    ].filter(Boolean);

    textQuery = pieces.join(" ").trim();

    if (placesKey && textQuery) {
      const types = ["point_of_interest", "tourist_attraction", "establishment"];
      let usedResults = false;

      for (const t of types) {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
          textQuery
        )}&type=${t}&key=${placesKey}`;
        const pr = await fetch(url).then((r) => r.json());

        if (Array.isArray(pr.results) && pr.results.length) {
          pr.results.slice(0, 3).forEach((p, i) => {
            out.candidates.push({
              placeName: p.name,
              lat: p.geometry?.location?.lat ?? null,
              lng: p.geometry?.location?.lng ?? null,
              confidence:
                (p.user_ratings_total
                  ? Math.min(0.98, 0.62 + Math.log10(p.user_ratings_total) / 10)
                  : 0.6) - i * 0.05,
              address: p.formatted_address,
              placeId: p.place_id,
              source: out.candidates.length ? "gemini+places" : "places_only",
            });
          });
          usedResults = true;
          break; // first good hit is fine
        }
      }

      if (!usedResults) {
        console.warn("[location] Places found no results for:", textQuery);
      }
    }

    if (!out.candidates.length) {
      return res
        .status(200)
        .json({ placeName: null, lat: null, lng: null, confidence: 0, message: "no_idea" });
    }

    const withGeo = out.candidates.find((c) => c.lat != null && c.lng != null);
    const best = withGeo || out.candidates[0];
    return res.status(200).json(best);
  } catch (e) {
    console.error("[routes/location] error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
