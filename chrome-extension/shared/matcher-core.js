(function bootstrap(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.SponsorMatcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  const LEGAL_SUFFIXES = new Set([
    "limited",
    "ltd",
    "llp",
    "llc",
    "plc",
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "company",
    "co",
    "holdings",
    "holding"
  ]);

  const DESCRIPTOR_WORDS = new Set([
    "and",
    "academy",
    "asset",
    "advisory",
    "aerospace",
    "care",
    "college",
    "colleges",
    "consulting",
    "digital",
    "defence",
    "defense",
    "education",
    "europe",
    "engineering",
    "financial",
    "group",
    "health",
    "healthcare",
    "helicopters",
    "higher",
    "homes",
    "hospitality",
    "international",
    "ireland",
    "labs",
    "learning",
    "logistics",
    "management",
    "media",
    "operations",
    "partners",
    "partnership",
    "payments",
    "platforms",
    "properties",
    "property",
    "protect",
    "recruitment",
    "resources",
    "retail",
    "school",
    "schools",
    "services",
    "software",
    "solutions",
    "space",
    "staffing",
    "store",
    "stores",
    "support",
    "systems",
    "tech",
    "technologies",
    "technology",
    "transport",
    "transportation",
    "travel",
    "university"
  ]);

  const BRAND_ALIAS_BLOCKLIST = new Set([
    "best",
    "city",
    "global",
    "group",
    "home",
    "international",
    "london",
    "north",
    "one",
    "prime",
    "quality",
    "smart",
    "south",
    "the",
    "uk",
    "united",
    "west"
  ]);

  const DOMAIN_TOKENS = new Set(["com", "co", "io", "net", "org", "uk"]);

  function isDescriptorOrLegal(token) {
    return DESCRIPTOR_WORDS.has(token) || LEGAL_SUFFIXES.has(token);
  }

  function stripDiacritics(value) {
    return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }

  function normalizeName(value) {
    if (!value) {
      return "";
    }

    return stripDiacritics(String(value))
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripParentheticals(value) {
    return value.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  }

  function stripTrailingLegalSuffixes(normalizedName) {
    const tokens = normalizedName.split(" ").filter(Boolean);

    while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
      tokens.pop();
    }

    return tokens.join(" ");
  }

  function shouldAddBrandAlias(normalizedName) {
    const tokens = normalizedName.split(" ").filter(Boolean);

    if (tokens.length < 2 || tokens.length > 4) {
      return false;
    }

    const [firstToken, ...rest] = tokens;

    if (firstToken.length < 4) {
      return false;
    }

    if (BRAND_ALIAS_BLOCKLIST.has(firstToken) || LEGAL_SUFFIXES.has(firstToken) || DESCRIPTOR_WORDS.has(firstToken)) {
      return false;
    }

    if (rest.some((token) => DOMAIN_TOKENS.has(token))) {
      return false;
    }

    return rest.every((token) => isDescriptorOrLegal(token));
  }

  function shouldAddCoordinatedBrandAlias(normalizedName) {
    const tokens = normalizedName.split(" ").filter(Boolean);

    if (tokens.length < 4) {
      return false;
    }

    const [firstToken, conjunction, thirdToken, ...rest] = tokens;

    if (conjunction !== "and" || !rest.length) {
      return false;
    }

    if (DOMAIN_TOKENS.has(firstToken) || DOMAIN_TOKENS.has(thirdToken)) {
      return false;
    }

    if (BRAND_ALIAS_BLOCKLIST.has(firstToken) || LEGAL_SUFFIXES.has(firstToken) || DESCRIPTOR_WORDS.has(firstToken)) {
      return false;
    }

    if (BRAND_ALIAS_BLOCKLIST.has(thirdToken) || LEGAL_SUFFIXES.has(thirdToken) || DESCRIPTOR_WORDS.has(thirdToken)) {
      return false;
    }

    return rest.every((token) => isDescriptorOrLegal(token));
  }

  function addCandidateAlias(aliasSet, alias) {
    if (!alias || alias.length < 2) {
      return;
    }

    if (!/[a-z]/.test(alias)) {
      return;
    }

    aliasSet.add(alias);
  }

  function buildAliases(name) {
    const exactAliases = new Set();
    const brandAliases = new Set();

    if (!name) {
      return { exactAliases, brandAliases };
    }

    const rawVariants = new Set([String(name).trim()]);

    for (const rawVariant of Array.from(rawVariants)) {
      const withoutParens = stripParentheticals(rawVariant);
      rawVariants.add(withoutParens);

      const tradingAsParts = withoutParens.split(/\b(?:t\/a|trading as)\b/i).map((part) => part.trim()).filter(Boolean);
      for (const part of tradingAsParts) {
        rawVariants.add(part);
      }
    }

    for (const rawVariant of rawVariants) {
      const normalized = normalizeName(rawVariant);
      addCandidateAlias(exactAliases, normalized);

      const stripped = stripTrailingLegalSuffixes(normalized);
      addCandidateAlias(exactAliases, stripped);

      if (shouldAddBrandAlias(stripped)) {
        brandAliases.add(stripped.split(" ")[0]);
      }

      if (shouldAddCoordinatedBrandAlias(stripped)) {
        const [firstToken, , thirdToken] = stripped.split(" ");
        addCandidateAlias(brandAliases, `${firstToken} and ${thirdToken}`);
        addCandidateAlias(brandAliases, `${firstToken.charAt(0)} and ${thirdToken.charAt(0)}`);
      }
    }

    return { exactAliases, brandAliases };
  }

  function createIndex(companyNames) {
    const exactAliases = new Set();
    const brandAliases = new Set();
    const uniqueNames = new Set();

    for (const name of companyNames || []) {
      const cleanedName = String(name || "").trim();
      if (!cleanedName) {
        continue;
      }

      uniqueNames.add(cleanedName);

      const aliases = buildAliases(cleanedName);
      for (const alias of aliases.exactAliases) {
        exactAliases.add(alias);
      }
      for (const alias of aliases.brandAliases) {
        brandAliases.add(alias);
      }
    }

    return {
      exactAliases,
      brandAliases,
      stats: {
        organisationCount: uniqueNames.size,
        exactAliasCount: exactAliases.size,
        brandAliasCount: brandAliases.size
      }
    };
  }

  function dedupeAliases(items) {
    const seen = new Set();
    const results = [];

    for (const item of items) {
      if (!item.alias || seen.has(item.alias)) {
        continue;
      }
      seen.add(item.alias);
      results.push(item);
    }

    return results;
  }

  function createCandidateAliases(companyNames) {
    const exact = [];
    const brand = [];

    for (const rawName of companyNames || []) {
      const aliases = buildAliases(rawName);

      for (const alias of aliases.exactAliases) {
        exact.push({ alias, rawName, strength: "exact" });
      }

      for (const alias of aliases.brandAliases) {
        brand.push({ alias, rawName, strength: "brand" });
      }
    }

    return {
      exact: dedupeAliases(exact),
      brand: dedupeAliases(brand)
    };
  }

  function findMatch(candidates, lookupSet, matchType) {
    for (const candidate of candidates) {
      if (lookupSet.has(candidate.alias)) {
        return {
          matched: true,
          matchType,
          alias: candidate.alias,
          sourceName: candidate.rawName
        };
      }
    }

    return null;
  }

  function matchCompanyNames(companyNames, index) {
    if (!index || !index.exactAliases || !index.brandAliases) {
      return {
        matched: false,
        matchType: "none",
        alias: "",
        sourceName: "",
        checkedNames: (companyNames || []).filter(Boolean)
      };
    }

    const checkedNames = (companyNames || []).map((name) => String(name || "").trim()).filter(Boolean);
    const candidates = createCandidateAliases(checkedNames);

    const exactMatch =
      findMatch(candidates.exact, index.exactAliases, "exact") ||
      findMatch(candidates.exact, index.brandAliases, "brand") ||
      findMatch(candidates.brand, index.exactAliases, "brand") ||
      findMatch(candidates.brand, index.brandAliases, "brand");

    if (exactMatch) {
      return {
        ...exactMatch,
        checkedNames
      };
    }

    return {
      matched: false,
      matchType: "none",
      alias: "",
      sourceName: "",
      checkedNames
    };
  }

  return {
    normalizeName,
    buildAliases,
    createIndex,
    matchCompanyNames
  };
});
