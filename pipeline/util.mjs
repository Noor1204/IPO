export const norm = s => String(s || "").toLowerCase().replace(/&amp;|&/g, " and ").replace(/[’']/g, "").replace(/\b(limited|ltd|pvt|private|india|the)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
