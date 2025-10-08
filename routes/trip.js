// routes/trip.js
const express = require("express");
const router = express.Router();

const GOOGLE_KEY = process.env.GOOGLE_SERVER_API_KEY;

/**
 * Body: { city: string, days: number, interests?: string[] }
 * Super simple: uses Places Text Search to grab a few popular spots per interest.
 */
router.post("/", async (req, res) => {
  try {
    const { city, days = 3, interests = ["sights", "food"] } = req.body || {};
    if (!city) return res.status(400).json({ error: "city is required" });

    // Helper: search top 5 places for a query
    const search = async (q) => {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
        q
      )}&key=${GOOGLE_KEY}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      return (j.results || []).slice(0, 5).map((p) => ({
        name: p.name,
        address: p.formatted_address,
        rating: p.rating,
        lat: p.geometry?.location?.lat,
        lng: p.geometry?.location?.lng,
      }));
    };

    // Collect candidates per interest
    const buckets = {};
    for (const i of interests) {
      buckets[i] = await search(`${i} in ${city}`);
    }

    // Build days by rotating through buckets
    const outDays = [];
    for (let d = 0; d < Number(days); d++) {
      const items = [];
      for (const i of interests) {
        const pick = buckets[i][d % (buckets[i].length || 1)];
        if (pick) items.push(`${i.toUpperCase()}: ${pick.name}`);
      }
      // basic filler if empty
      if (!items.length) items.push("Explore the city center");
      outDays.push({ day: d + 1, items });
    }

    res.json({ title: `${city} in ${days} days`, days: outDays });
  } catch (err) {
    console.error("[/api/trip] error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;