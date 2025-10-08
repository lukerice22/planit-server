// inside POST /api/location
const key = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_SERVER_API_KEY;
const placesKey = process.env.GOOGLE_PLACES_API_KEY || key;

const { imageBase64, imageUrl, regionHint } = req.body;
if (!imageBase64 && !imageUrl) {
  return res.status(400).json({ error: "imageBase64 or imageUrl is required" });
}

// 1) Vision: request LANDMARK + WEB_DETECTION
const visionReq = {
  requests: [{
    image: imageBase64 ? { content: imageBase64 } : { source: { imageUri: imageUrl } },
    features: [
      { type: "LANDMARK_DETECTION", maxResults: 10 },
      { type: "WEB_DETECTION", maxResults: 10 },
    ],
    imageContext: {
      // helps disambiguate labels (e.g., English landmark names)
      languageHints: ["en"],
      // ask Vision to try to include geo if it can infer it from the web
      webDetectionParams: { includeGeoResults: true }, // safe to include; ignored if not supported
    }
  }]
};

const v = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(visionReq)
}).then(r => r.json());

const ann = v?.responses?.[0] || {};
const out = { candidates: [] };

// 2) Fast path: use Landmark if confident
if (ann.landmarkAnnotations?.length) {
  const top = ann.landmarkAnnotations[0];
  if (top.score >= 0.60 && top.locations?.[0]?.latLng) {
    out.candidates.push({
      placeName: top.description,
      lat: top.locations[0].latLng.latitude,
      lng: top.locations[0].latLng.longitude,
      confidence: top.score,
      source: "vision_landmark"
    });
  }
}

// 3) Web detection fallback: best guess / entities → query Places
const web = ann.webDetection || {};
const guess = web.bestGuessLabels?.[0]?.label || null;
const entity = (web.webEntities || []).sort((a,b)=> (b.score||0)-(a.score||0))[0];
const textQuery = [guess, entity?.description, "landmark", "viewpoint", "lookout"]
  .filter(Boolean)
  .join(" ");

if (!out.candidates.length && textQuery) {
  const q = regionHint ? `${textQuery} ${regionHint}` : textQuery;
  const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&type=tourist_attraction&key=${placesKey}`;
  const pr = await fetch(placesUrl).then(r => r.json());

  (pr.results || []).slice(0, 3).forEach((p, i) => {
    out.candidates.push({
      placeName: p.name,
      lat: p.geometry?.location?.lat ?? null,
      lng: p.geometry?.location?.lng ?? null,
      confidence: (p.user_ratings_total ? Math.min(0.99, 0.6 + Math.log10(p.user_ratings_total)/10) : 0.6) - i*0.05,
      address: p.formatted_address,
      placeId: p.place_id,
      source: "vision_web+places"
    });
  });
}

// 4) Final selection + shape for client
if (!out.candidates.length) {
  return res.status(200).json({ placeName: null, lat: null, lng: null, confidence: 0, message: "no_idea" });
}

const best = out.candidates[0];
return res.status(200).json(best);