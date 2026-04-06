/**
 * POST /api/process-job   [BACKGROUND FUNCTION — runs async, no response timeout]
 *
 * Triggered by upload-pdf.mjs after a job is queued.
 * Reads the PDF from Netlify Blobs → sends to Claude → parses JSON →
 * saves each threat card to Blobs → updates job status to "done" or "error".
 *
 * This runs for as long as needed (up to 15 min on Netlify free tier).
 * The browser polls /api/get-job?id=xxx to check progress.
 */

import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";

// ── Claude extraction prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a Visa PERC threat intelligence analyst who writes for a Card Operations and Management team.
Your job is to extract ALL distinct threat items from a Visa PERC Security Alert or Monthly Gauge PDF
and return them in a structured JSON object.

IMPORTANT RULES:
- Use plain English throughout. No unexplained jargon.
- When you must use a technical term, add a plain explanation in parentheses immediately after.
- Keep summaries to 2–3 sentences max.
- Return ONLY a valid raw JSON object — no markdown fences, no preamble, no commentary.

Return this EXACT schema:
{
  "report_id": "e.g. PERC-26-07 or Monthly Pr3ssure Gauge Mar 2026",
  "report_date": "e.g. March 2026",
  "items": [
    {
      "title":         "Plain-English title, max 12 words",
      "summary":       "2-3 sentence plain-English summary",
      "risk":          "critical | high | medium | low",
      "cat":           "scam | cyber | physical | law | significant",
      "type":          "alert | gauge",
      "medium":        "Where/how the attack happens — e.g. Social Media, POS Terminal, Mobile App",
      "attack_type":   "What kind of attack — plain English",
      "issuer_risk":   "Risk to card-issuing banks — plain English",
      "customer_risk": "Risk to cardholders — plain English",
      "tags":          ["Tag1", "Tag2"],
      "regions":       ["global"],
      "order":         7,
      "hasFlow":       false,
      "flow": [
        { "phase": "bl | am | rd | gn | pu", "label": "Step N · Short Label", "text": "Step description" }
      ],
      "actions": ["Action 1", "Action 2"],
      "iocs": [
        { "label": "Filename or Domain label", "value": "actual IOC value", "warn": true }
      ]
    }
  ]
}

Flow phase colours: bl = blue (setup/entry), am = amber (escalation), rd = red (impact/theft),
gn = green (legitimate step shown for contrast), pu = purple (other/persistence).

Regions: use "global", "apac", "eu", "us", "africa" (lowercase).
Only set hasFlow: true when there is a clear step-by-step attack sequence worth illustrating.
iocs array can be empty [] if no indicators of compromise are mentioned.
`;

export default async (req, context) => {
  let jobId;

  try {
    const body = await req.json();
    jobId = body?.jobId;

    if (!jobId) {
      console.error("process-job: no jobId provided");
      return;
    }

    const jobsStore  = getStore("jobs");
    const cardsStore = getStore("cards");

    // ── Get queued job ──────────────────────────────────────────
    const job = await jobsStore.get(jobId, { type: "json" });
    if (!job) {
      console.error(`process-job: job ${jobId} not found in Blobs`);
      return;
    }

    // ── Mark as processing ──────────────────────────────────────
    await jobsStore.setJSON(jobId, {
      status:      "processing",
      filename:    job.filename,
      startedAt:   new Date().toISOString()
    });

    // ── Validate API key ────────────────────────────────────────
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set in Netlify environment variables");
    }

    // ── Call Claude ─────────────────────────────────────────────
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model:      "claude-opus-4-6",
      max_tokens: 4000,
      system:     SYSTEM_PROMPT,
      messages: [
        {
          role:    "user",
          content: [
            {
              type:   "document",
              source: {
                type:       "base64",
                media_type: "application/pdf",
                data:       job.pdf
              }
            },
            {
              type: "text",
              text: "Extract all threat items from this Visa PERC document and return the JSON object."
            }
          ]
        }
      ]
    });

    // ── Parse response ──────────────────────────────────────────
    const rawText = response.content.find(c => c.type === "text")?.text || "";
    const cleaned = rawText
      .replace(/^```[a-z]*\n?/m, "")
      .replace(/```\s*$/m,       "")
      .trim();

    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new Error(`Claude returned invalid JSON. Raw response snippet: ${rawText.slice(0, 200)}`);
    }

    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new Error("No threat items found in extracted data");
    }

    // ── Save cards to Blobs ─────────────────────────────────────
    const cardIds = [];
    for (const item of data.items) {
      const cardId = `card-${data.report_id.replace(/[^a-zA-Z0-9]/g, "-")}-${item.order || Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      await cardsStore.setJSON(cardId, {
        ...item,
        report_id:   data.report_id,
        report_date: data.report_date || "Unknown Date",
        cardId,
        addedAt: new Date().toISOString()
      });

      cardIds.push(cardId);
    }

    // ── Mark job as done ────────────────────────────────────────
    await jobsStore.setJSON(jobId, {
      status:      "done",
      filename:    job.filename,
      report_id:   data.report_id,
      report_date: data.report_date,
      cardIds,
      count:       data.items.length,
      completedAt: new Date().toISOString()
    });

    console.log(`process-job: ✓ ${jobId} → ${data.items.length} cards from ${data.report_id}`);

  } catch (err) {
    console.error("process-job error:", err.message);

    // ── Mark job as error ───────────────────────────────────────
    if (jobId) {
      try {
        const store = getStore("jobs");
        await store.setJSON(jobId, {
          status:  "error",
          error:   err.message,
          failedAt: new Date().toISOString()
        });
      } catch (blobErr) {
        console.error("Could not update job error status:", blobErr.message);
      }
    }
  }
};

// background: true → Netlify returns 202 immediately and keeps the function running
export const config = {
  path:       "/api/process-job",
  background: true
};
