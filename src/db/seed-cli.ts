import "dotenv/config";
import { db } from "./client";
import { seed } from "./seed";

seed(db)
  .then((r) => {
    console.log("Seed angewendet (fiktive Demo-Daten). Setup:", r.setupId);
    process.exit(0);
  })
  .catch((e) => {
    console.error("Seed fehlgeschlagen:", e);
    process.exit(1);
  });
