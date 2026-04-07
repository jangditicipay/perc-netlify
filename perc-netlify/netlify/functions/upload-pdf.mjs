/**
 * POST /api/upload-pdf
 *
 * Receives a base64-encoded PDF from the browser.
 * Stores it in Netlify Blobs as a "queued" job.
 * Fires a background function to process it with Claude.
 * Returns { jobId } immediately — no waiting.
 *
 * Body: { base64: string, filename: string }
 */

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ── Parse request ───────────────────────────────────────────
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { base64, filename } = body;

  if (!base64 || typeof base64 !== "string") {
    return json({ error: "Missing or invalid base64 PDF data" }, 400);
  }
  if (!filename || typeof filename !== "string") {
    return json({ error: "Missing filename" }, 400);
  }

  // Basic validation — PDFs start with JVBERi (base64 of %PDF)
  if (!base64.startsWith("JVBERi")) {
    return json({ error: "File does not appear to be a valid PDF" }, 400);
  }

  // ── Create job ──────────────────────────────────────────────
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const store = getStore("jobs");

    await store.setJSON(jobId, {
      status:    "queued",
      filename:  sanitizeFilename(filename),
      pdf:       base64,       // stored temporarily; cleared after processing
      createdAt: new Date().toISOString()
    });

    // ── Trigger background processing ──────────────────────────
    // "Fire and forget" — we don't await this.
    // The background function returns 202 immediately; Netlify keeps it running.
    const siteUrl = Netlify.env.get("URL") || new URL(req.url).origin;
    fetch(`${siteUrl}/.netlify/functions/process-job`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jobId })
    }).catch((err) => {
      console.error("Failed to trigger process-job:", err.message);
    });

    return json({ jobId, status: "queued" }, 202);

  } catch (err) {
    console.error("upload-pdf error:", err);
    return json({ error: "Server error — could not queue job" }, 500);
  }
};

// ── Helpers ─────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-\s]/g, "").slice(0, 120);
}
