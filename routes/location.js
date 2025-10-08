// routes/location.js
const express = require("express");
const router = express.Router();

// Node 18+ has global fetch
const KEY = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_SERVER_API_KEY;
if (!KEY) {
  console.error("[/api/location] No Google API key found in env");
}
const VISION_URL = `https://vision.googleapis.com/v1/images:annotate?key=${KEY}`;


/**
 * Body: { imageUrl?: string, imageBase64?: string }
 * Prefers imageUrl to avoid large request bodies.
 */
router.post("/", async (req, res) => {
  try {
    const { imageUrl, imageBase64 } = req.body || {};
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({ error: "imageUrl or imageBase64 is required" });
    }

    const image = imageUrl
      ? { source: { imageUri: imageUrl } }
      : { content: imageBase64 };

    const body = {
      requests: [
        {
          image,
          features: [{ type: "LANDMARK_DETECTION", maxResults: 3 }],
        },
      ],
    };

    const r = await fetch(VISION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(502).json({ error: "Vision API failed", details: txt });
    }
    const data = await r.json();
    const ann = data?.responses?.[0]?.landmarkAnnotations?.[0];

    if (!ann) {
      return res.status(200).json({
        placeName: null,
        lat: null,
        lng: null,
        confidence: 0,
        note: "No landmark detected",
      });
    }

    const loc = ann.locations?.[0]?.latLng || {};
    res.json({
      placeName: ann.description || null,
      lat: loc.latitude ?? null,
      lng: loc.longitude ?? null,
      confidence: ann.score ?? 0,
    });
  } catch (err) {
    console.error("[/api/location] error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;