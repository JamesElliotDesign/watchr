import fetch from "node-fetch";
import { HELIUS_API_KEY, WEBHOOK_URL } from "./src/config.js";

async function main() {
  // Use any known wallet address for testing
  const testWallet = "As7HjL7dzzvbRbaD3WCun47robib2kmAKRXMvjHkSMB5";

  try {
    const listUrl = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;

    // Step 1: List current webhooks
    const listRes = await fetch(listUrl);
    console.log("=== Current Webhooks ===");
    console.log("Status:", listRes.status, listRes.statusText);
    const listBody = await listRes.text();
    console.log("Body:", listBody);

    // Step 2: Create a new webhook
    console.log("\n=== Creating Test Webhook ===");
    const createRes = await fetch(listUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountAddresses: [testWallet],
        webhookURL: WEBHOOK_URL,
        transactionTypes: ["SWAP"],
        authHeader: "my-secret",
      }),
    });

    console.log("Status:", createRes.status, createRes.statusText);
    const createBody = await createRes.text();
    console.log("Body:", createBody);

    // Parse to see if we got a webhookID back
    let webhookID: string | null = null;
    try {
      const parsed = JSON.parse(createBody);
      webhookID = parsed.webhookID;
    } catch {
      // ignore parse errors
    }

    // Step 3: Delete the webhook we just created
    if (webhookID) {
      console.log("\n=== Deleting Test Webhook ===");
      const deleteRes = await fetch(`${listUrl}/${webhookID}`, {
        method: "DELETE",
      });
      console.log("Status:", deleteRes.status, deleteRes.statusText);
      console.log("Body:", await deleteRes.text());
    } else {
      console.log("\n(No webhookID returned — skipping delete)");
    }
  } catch (err) {
    console.error("Error in debug-helius:", err);
  }
}

main();
