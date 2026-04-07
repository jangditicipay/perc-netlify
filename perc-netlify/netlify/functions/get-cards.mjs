/**
 * GET /api/get-cards
 *
 * Called on page load to retrieve all cards previously added via PDF upload.
 * Returns an array of card objects sorted by addedAt (oldest first).
 *
 * These cards persist indefinitely in Netlify Blobs — they survive
 * redeployments, browser refreshes, and site updates.
 */

import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  try {
    const store = getStore("cards");

    // List all card keys
    const { blobs } = await store.list();

    if (!blobs || blobs.length === 0) {
      return json({ cards: [], count: 0 });
    }

    // Fetch all card objects in parallel
    const results = await Promise.allSettled(
      blobs.map(blob => store.get(blob.key, { type: "json" }))
    );

    const cards = results
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value)
      .sort((a, b) => {
        // Sort by addedAt ascending (oldest first, preserves display order)
        return new Date(a.addedAt || 0) - new Date(b.addedAt || 0);
      });

    return json({ cards, count: cards.length });

  } catch (err) {
    console.error("get-cards error:", err.message);
    // Return empty array rather than error — page still works with hardcoded cards
    return json({ cards: [], count: 0, warning: "Could not load dynamic cards" });
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
