/**
 * GET /api/get-job?id=job-xxx
 *
 * Called by the browser every 2 seconds to check processing progress.
 *
 * Returns:
 *   { status: "queued" | "processing" | "done" | "error", ... }
 *
 * When status = "done", also returns:
 *   { cards: [ ...card objects ] }
 */

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url   = new URL(req.url);
  const jobId = url.searchParams.get("id");

  if (!jobId) {
    return json({ error: "Missing ?id= parameter" }, 400);
  }

  try {
    const jobsStore  = getStore("jobs");
    const cardsStore = getStore("cards");

    const job = await jobsStore.get(jobId, { type: "json" });

    if (!job) {
      return json({ status: "not_found" }, 404);
    }

    // If done, fetch the card objects
    let cards = [];
    if (job.status === "done" && Array.isArray(job.cardIds) && job.cardIds.length > 0) {
      const fetched = await Promise.allSettled(
        job.cardIds.map(id => cardsStore.get(id, { type: "json" }))
      );
      cards = fetched
        .filter(r => r.status === "fulfilled" && r.value !== null)
        .map(r => r.value);
    }

    return json({
      status:      job.status,
      filename:    job.filename,
      report_id:   job.report_id,
      report_date: job.report_date,
      count:       job.count,
      error:       job.error || null,
      cards
    });

  } catch (err) {
    console.error("get-job error:", err.message);
    return json({ error: "Server error — could not retrieve job" }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":                "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control":               "no-store"
    }
  });
}
