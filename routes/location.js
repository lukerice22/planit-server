// POST /api/location  (Gemini + Places)
import fetch from "node-fetch";

export default async function locationHandler(req, res) {
  try {
    const geminiKey =
      process.env.GOOGLE_GEMINI_API_KEY ||
      process.env.GOOGLE_SERVER_API_KEY;
    const placesKey =
      process.env.GOOGLE_PLACES_API_KEY ||
      process.env.GOOGLE_SERVER_API_KEY ||
      geminiKey;

    const { imageBase64, imageUrl, regionHint } = req.body || {};
    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ error: "imageBase64 or imageUrl is required" });
    }

    // If only URL is provided, fetch and convert to base64
    let imgB64 = imageBase64 || null;
    if (!imgB64 && imageUrl) {
      const r = await fetch(imageUrl);
      if (!r.ok) return res.status(400).json({ error: "failed_to_fetch_image_url" });
      const buf = Buffer.from(await r.arrayBuffer());
      imgB64 = buf.toString("base64");
    }

    // 1) Ask Gemini to identify the place from the photo
    // Model: gemini-1.5-flash (fast, good with images)
    const model = "gemini-1.5-flash";

    const hint = regionHint ? `Region hint: ${regionHint}.` : "";
    const prompt = `
You are a location recognition assistant. 
Given a single photo, identify the MOST LIKELY real-world location.
Return STRICT JSON only with fields:
{
  "placeName": string | null,
  "city": string | null,
  "state": string | null,
  "country": string | null,
  "confidence": number,        // 0..1
  "rationale": string          // short reason referencing visual clues
}
If unsure, set placeName to null and confidence to 0. 
${hint}
JSON only. No prose.`;

    const geminiReq = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg", // fine for png too; Gemini is tolerant
                data: imgB64
              }
            }
          ]
        }
      ]
    };

    const gResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(geminiReq)
      }
    ).then(r => r.json());

    // Pull JSON string from Gemini response (handles plain or fenced JSON)
    const gText =
      gResp?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const jsonMatch = gText.match(/\{[\s\S]*\}$/) || gText.match(/\{[\s\S]*\}/);
    let gObj = null;
    try {
      gObj = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(gText);
    } catch {
      gObj = null;
    }

    const out = { candidates: [] };

    // 2) If Gemini is confident enough, push as candidate directly
    if (gObj && (gObj.placeName || gObj.city) && (gObj.confidence ?? 0) >= 0.55) {
      out.candidates.push({
        placeName: gObj.placeName || [gObj.city, gObj.state, gObj.country].filter(Boolean).join(", "),
        lat: null,
        lng: null,
        confidence: Math.min(0.99, Math.max(0.55, gObj.confidence ?? 0.6)),
        source: "gemini"
      });
    }

    // 3) Places fallback/validation using Gemini hints
    const pieces = [
      gObj?.placeName,
      gObj?.city,
      gObj?.state,
      gObj?.country
    ].filter(Boolean);

    let textQuery = pieces.join(" ");
    if (!textQuery && regionHint) textQuery = regionHint;

    if (textQuery) {
      const q = regionHint ? `${textQuery} ${regionHint}` : textQuery;
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
        q
      )}&type=tourist_attraction&key=${placesKey}`;

      const pr = await fetch(url).then(r => r.json());
      (pr.results || []).slice(0, 3).forEach((p, i) => {
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
          source: out.candidates.length ? "gemini+places" : "places_only"
        });
      });
    }

    // 4) Final selection + shape for client
    if (!out.candidates.length) {
      return res
        .status(200)
        .json({ placeName: null, lat: null, lng: null, confidence: 0, message: "no_idea" });
    }

    // Prefer a candidate with lat/lng; otherwise take the first
    const withGeo = out.candidates.find(c => c.lat != null && c.lng != null);
    const best = withGeo || out.candidates[0];

    return res.status(200).json(best);
  } catch (err) {
    console.error("locationHandler error", err);
    return res.status(500).json({ error: "server_error" });
  }
}