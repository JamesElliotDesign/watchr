import fs from "fs";
import path from "path";

const file = path.resolve("signals.json");

try {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0) {
    console.log("No qualified signals yet.");
    process.exit(0);
  }

  console.log(`Qualified signals (${data.length}):\n`);
  for (const s of data) {
    const t = new Date(s.ts).toISOString();
    console.log(
      `• ${t} | wallet=${s.wallet} | mint=${s.mint} | amount=${s.amount} | status=${s.status} | source=${s.source}`
    );
  }
} catch (e: any) {
  if (e.code === "ENOENT") {
    console.log("signals.json not found (no qualified signals yet).");
  } else {
    console.error("Error reading signals.json:", e.message || e);
  }
}
