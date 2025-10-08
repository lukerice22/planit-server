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
    if (!placesKey) {
      // not fatal, but warn and we’ll just return Gemini’s guess
      console.warn("[location] GOOGLE_PLACES_API_KEY missing — skipping geo resolve");
    }

    const { imageBase64, imageUrl, regionHint } = req.body || {};
    if (!imageBase64 && !imageUrl) {
      return res
        .status(400)
        .json({ error: "imageBase64 or imageUrl is required" });
    }

    // ---------- Normalize Image → base64 + mime ----------
    let imgB64 = imageBase64 || null;
    let mime = "image/jpeg"; // client now always sends JPEG; keep as default

    if (imgB64 && imgB64.startsWith("data:")) {
      const m = imgB64.match(/^data:(.+?);base64,(.*)$/s);
      if (m) {
        mime = (m[1] || "image/jpeg").split(";")[0];
        imgB64 = m[2];
      } else {
        // generic strip if data URL not matched perfectly
        const comma = imgB64.indexOf(",");
        if (comma >= 0) imgB64 = imgB64.slice(comma + 1);
      }
    }

    // If only URL provided, fetch and convert to base64; try to honor content-type
    if (!imgB64 && imageUrl) {
      // HEAD for content-type (best effort)
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

    // Reject formats Gemini can stumble on if they sneak in
    if (/image\/(heic|heif|avif)/i.test(mime)) {
      return res
        .status(415)
        .json({ error: "unsupported_image_format", details: "Please send JPEG or PNG" });
    }

    // ---------- Gemini Call ----------
    const prompt = `
You are a location recognition assistant.
Identify the MOST LIKELY real-world location shown in this single photo.
Return STRICT JSON only:
{
  "placeName": string | null,
  "city": string | null,
  "state": string | null,
  "country": string | null,
  "confidence": number,       // 0.0–1.0
  "rationale": string
}
If unsure, use null fields and confidence 0.
${regionHint ? `Region hint: ${regionHint}.` : ""}`.trim();

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
    };

    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`;
    const gResp = await fetch(gUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gReq),
    }).then((r) => r.json());

    const finish = gResp?.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      console.warn("[location] Gemini finishReason:", finish);
    }

    const gText = gResp?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let g = null;
    try {
      // Allow for markdown fencing; extract the first JSON object
      const jsonMatch = gText.match(/\{[\s\S]*?\}/);
      g = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(gText);
    } catch {
      // leave g as null
    }

    const out = { candidates: [] };

    if (g && (g.placeName || g.city || g.country)) {
      out.candidates.push({
        placeName:
          g.placeName || [g.city, g.state, g.country].filter(Boolean).join(", "),
        lat: null,
        lng: null,
        confidence: Math.min(0.99, Math.max(0.55, g.confidence ?? 0.6)),
        source: "gemini",
      });
    }

    // ---------- Resolve to lat/lng via Places (if we have a text to search) ----------
    let textQuery = "";
    const pieces = [
      g?.placeName,
      g?.city,
      g?.state,
      g?.country,
      regionHint,
    ].filter(Boolean);
    textQuery = pieces.join(" ").trim();

    if (placesKey && textQuery) {
      // try a couple of types to improve hit rate
      const types = ["point_of_interest", "tourist_attraction", "establishment"];
      let usedResults = false;

      for (const t of types) {
        const q = textQuery;
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
          q
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
          break; // good enough
        }
      }
      if (!usedResults) {
        console.warn("[location] Places found no results for:", textQuery);
      }
    }

    // ---------- Final selection ----------
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