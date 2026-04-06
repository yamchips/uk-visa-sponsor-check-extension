const fs = require("fs");
const path = require("path");

const { createIndex } = require("../chrome-extension/shared/matcher-core.js");

const CSV_PATH = path.resolve(__dirname, "..", "2026-04-02_-_Worker_and_Temporary_Worker.csv");
const OUTPUT_DIR = path.resolve(__dirname, "..", "chrome-extension", "data");
const OUTPUT_PATH = path.resolve(OUTPUT_DIR, "sponsor-index.json");

function parseCsv(text) {
  const rows = [];
  let current = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      current.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      current.push(field);
      field = "";

      if (current.some((value) => value.length > 0)) {
        rows.push(current);
      }

      current = [];
      continue;
    }

    field += char;
  }

  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (current.some((value) => value.length > 0)) {
      rows.push(current);
    }
  }

  return rows;
}

function main() {
  const rawCsv = fs.readFileSync(CSV_PATH, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(rawCsv);

  if (!rows.length) {
    throw new Error("The sponsor CSV is empty.");
  }

  const header = rows[0];
  const orgIndex = header.findIndex((name) => name.trim() === "Organisation Name");

  if (orgIndex === -1) {
    throw new Error('Could not find the "Organisation Name" column in the sponsor CSV.');
  }

  const organisationNames = [];

  for (const row of rows.slice(1)) {
    const name = (row[orgIndex] || "").trim();
    if (name) {
      organisationNames.push(name);
    }
  }

  const index = createIndex(organisationNames);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      sourceCsv: path.basename(CSV_PATH),
      stats: index.stats,
      exactAliases: Array.from(index.exactAliases).sort(),
      brandAliases: Array.from(index.brandAliases).sort()
    })
  );

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Sponsor rows: ${index.stats.organisationCount}`);
  console.log(`Exact aliases: ${index.stats.exactAliasCount}`);
  console.log(`Brand aliases: ${index.stats.brandAliasCount}`);
}

main();
