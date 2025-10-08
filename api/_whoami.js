// api/_whoami.js
export default function handler(req, res) {
  res.setHeader("X-App", "planit-backend-serverless");
  res.status(200).json({ ok: true, handler: "serverless", routes: ["/api/location"] });
}
