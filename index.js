const express = require("express");
const http = require("node:http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");

const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const { fetchJsonWithRetry, getHttpQueueStats, runWithCorrelationId } = require("./httpClient");

const filterModifiers = require("./filterModifiers.js");
const lookup = require("./lookup.js");

const spells = require("./spells.js");
const character = require("./character.js");
const items = require("./items.js");
const monsters = require("./monsters.js");
const campaign = require("./campaign.js");
const { imageProxyHandler } = require("./image.js");

const app = express();
const port = process.env.PORT || 3000;
const DDB_AVAILABLE_USER_CONTENT_URL = "https://www.dndbeyond.com/mobile/api/v6/available-user-content";
const DDB_BOOK_CODES_URL = "https://www.dndbeyond.com/mobile/api/v6/book-codes";
const DDB_GET_BOOK_URL_BASE = "https://www.dndbeyond.com/mobile/api/v6/get-book-url";
const BOOK_ENTITY_TYPE_ID = "496802664";

function isTruthyFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((v) => Number.isFinite(v)))];
}

function extractLicenses(payload) {
  const root = payload?.data ?? payload ?? {};
  const licenses = root.Licenses ?? root.licenses ?? [];
  return Array.isArray(licenses) ? licenses : [];
}

function licenseEntities(license) {
  const entities = license?.Entities ?? license?.entities ?? [];
  return Array.isArray(entities) ? entities : [];
}

function isBookLicense(license) {
  const typeId = String(license?.EntityTypeID ?? license?.entityTypeId ?? license?.entityTypeID ?? "");
  return typeId === BOOK_ENTITY_TYPE_ID;
}

function isOwnedEntity(entity) {
  const value = entity?.isOwned ?? entity?.IsOwned ?? entity?.owned;
  return isTruthyFlag(value);
}

function isReleasedEntity(entity) {
  const value = entity?.isReleased ?? entity?.IsReleased;
  if (value === undefined || value === null) return true;
  return isTruthyFlag(value);
}

function hasEnhancementEntity(entity) {
  const value = entity?.hasEnhancement
    ?? entity?.HasEnhancement
    ?? entity?.hasEnhancedContent
    ?? entity?.HasEnhancedContent;
  return isTruthyFlag(value);
}

function mapOwnedBooksFromContent(payload) {
  const books = extractLicenses(payload)
    .filter(isBookLicense)
    .flatMap((license) => licenseEntities(license))
    .filter((entity) => isReleasedEntity(entity) && isOwnedEntity(entity));

  const bookIds = uniqueNumbers(books.map((entity) => asNumber(entity?.id ?? entity?.ID ?? entity?.entityId ?? entity?.EntityID)));
  const enhancementBookIds = uniqueNumbers(
    books
      .filter((entity) => hasEnhancementEntity(entity))
      .map((entity) => asNumber(entity?.id ?? entity?.ID ?? entity?.entityId ?? entity?.EntityID)),
  );

  return { bookIds, enhancementBookIds };
}

function mapLibraryFromContent(payload, ownedOnly = false) {
  const books = extractLicenses(payload)
    .filter(isBookLicense)
    .flatMap((license) => licenseEntities(license))
    .filter((entity) => isReleasedEntity(entity));

  const mapped = books
    .map((entity) => {
      const id = asNumber(entity?.id ?? entity?.ID ?? entity?.entityId ?? entity?.EntityID);
      if (id === null) return null;
      return {
        id,
        name: entity?.name ?? entity?.Name ?? `${id}`,
        isOwned: isOwnedEntity(entity),
        isReleased: isReleasedEntity(entity),
        relativePath: entity?.relativePath ?? entity?.RelativePath ?? "",
        hasEnhancement: hasEnhancementEntity(entity),
      };
    })
    .filter((entry) => entry !== null);

  return ownedOnly ? mapped.filter((entry) => entry.isOwned) : mapped;
}

async function fetchAvailableUserContent(cobalt) {
  const form = new URLSearchParams();
  form.append("token", `${cobalt}`);
  const requestKey = `available-user-content:${authentication.getCacheId(cobalt)}`;
  const result = await fetchJsonWithRetry(
    DDB_AVAILABLE_USER_CONTENT_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
    {
      retries: 2,
      timeoutMs: 20000,
      retryDelayMs: 300,
      requestKey,
    },
  );

  if (!result.ok) {
    throw new Error(`available-user-content upstream failed with HTTP ${result.status}`);
  }

  const status = String(result?.data?.status ?? result?.data?.Status ?? "success").toLowerCase();
  if (status !== "success") {
    throw new Error(`available-user-content upstream returned status=${status}`);
  }

  return result.data;
}

async function fetchMobileApi(cobalt, url, extra = {}, requestKeySuffix = "") {
  const form = new URLSearchParams();
  form.append("token", `${cobalt}`);
  Object.entries(extra).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") form.append(key, value);
    else form.append(key, JSON.stringify(value));
  });

  const result = await fetchJsonWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
    {
      retries: 2,
      timeoutMs: 20000,
      retryDelayMs: 300,
      requestKey: `${requestKeySuffix}:${authentication.getCacheId(cobalt)}`,
    },
  );

  if (!result.ok) {
    throw new Error(`upstream failed with HTTP ${result.status}`);
  }

  const status = String(result?.data?.status ?? result?.data?.Status ?? "success").toLowerCase();
  if (status !== "success") {
    throw new Error(`upstream returned status=${status}`);
  }

  return result.data;
}

app.use((req, res, next) => {
  const incoming = req.headers["x-correlation-id"];
  const correlationId = typeof incoming === "string" && incoming.trim() !== ""
    ? incoming
    : `proxy-${crypto.randomUUID()}`;
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  runWithCorrelationId(correlationId, () => next());
});

/**
 * A simple ping to tell if the proxy is running
 */
app.get("/ping", cors(), (req, res) => res.send("pong"));

/**
 * Image / CORS proxy.
 * ddb-importer requests images as: <endpoint>/ddb/<host>/<path...>
 * (see cors-path-prefix + cors-strip-protocol settings client-side)
 */
app.options("/ddb/:host/*", cors(), (req, res) => res.status(200).send());
app.get("/ddb/:host/*", cors(), imageProxyHandler);

app.get("/healthz", cors(), (req, res) => {
  return res.status(200).json({
    success: true,
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    queue: getHttpQueueStats(),
  });
});

app.get("/readyz", cors(), async (_req, res) => {
  try {
    await lookup.getConfig();
    return res.status(200).json({
      success: true,
      status: "ready",
      queue: getHttpQueueStats(),
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      status: "not-ready",
      message: String(error),
      queue: getHttpQueueStats(),
    });
  }
});

const authPath = ["/proxy/auth"];
app.options(authPath, cors(), (req, res) => res.status(200).send());
app.post(authPath, cors(), express.json(), (req, res) => {
  if (!req.body.cobalt || req.body.cobalt == "") return res.json({ success: false, message: "No cobalt token" });
  const cacheId = authentication.getCacheId(req.body.cobalt);

  authentication.getBearerToken(cacheId, req.body.cobalt).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });
    return res.status(200).json({ success: true, message: "Authenticated.", token: token });
  });
});

const configLookupCall = "/proxy/api/config/json";
app.options(configLookupCall, cors(), (req, res) => res.status(200).send());
app.get(configLookupCall, cors(), express.json(), (req, res) => {

  lookup
    .getConfig()
    .then((data) => {
      return res
        .status(200)
        .json({ success: true, message: "Config retrieved.", data: data });
    })
    .catch((error) => {
      console.log(error);
      if (error === "Forbidden") {
        return res.json({ success: false, message: "Forbidden." });
      }
      return res.json({ success: false, message: "Unknown error during config loading: " + error });
    });

});

const emptyAdventureSummary = {
  version: null,
  builtAt: null,
  books: {},
};

app.options("/proxy/maps/metadata/summary", cors(), (req, res) => res.status(200).send());
app.get("/proxy/maps/metadata/summary", cors(), (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "Adventure metadata summary unavailable on this proxy instance; returning an empty summary.",
    data: emptyAdventureSummary,
  });
});

const adventureBookRoutes = [
  "/proxy/adventure/book-codes",
  "/proxy/adventure/enhancement",
  "/proxy/adventure/table-info",
];
app.options(adventureBookRoutes, cors(), (req, res) => res.status(200).send());

app.post("/proxy/adventure/book-codes", cors(), express.json(), async (req, res) => {
  const cobalt = req.body?.cobalt;
  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
  const sourceId = Number(sources[0]?.sourceID ?? sources[0]?.sourceId ?? NaN);

  if (!cobalt || cobalt === "") return res.status(200).json({ success: false, message: "No cobalt token" });
  if (!Number.isFinite(sourceId)) return res.status(200).json({ success: false, message: "Invalid sources payload" });

  try {
    const payload = await fetchMobileApi(cobalt, DDB_BOOK_CODES_URL, { sources }, "adventure:book-codes");
    const entries = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    const source = entries.find((entry) => Number(entry?.sourceID ?? entry?.sourceId) === sourceId) ?? entries[0];
    const keyBase64 = source?.data ?? null;
    if (!keyBase64) {
      return res.status(200).json({ success: false, message: `No book-code key found for source ${sourceId}` });
    }
    return res.status(200).json({ success: true, message: "Book code key retrieved.", data: keyBase64 });
  } catch (error) {
    console.log(`[ddb-proxy] [adventure] book-codes failed: ${error}`);
    return res.status(200).json({
      success: false,
      message: `book-codes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

app.options("/proxy/adventure/book-url/:bookId", cors(), (req, res) => res.status(200).send());
app.post("/proxy/adventure/book-url/:bookId", cors(), express.json(), async (req, res) => {
  const cobalt = req.body?.cobalt;
  const bookId = Number(req.params?.bookId ?? req.body?.bookId ?? NaN);
  if (!cobalt || cobalt === "") return res.status(200).json({ success: false, message: "No cobalt token" });
  if (!Number.isFinite(bookId)) return res.status(200).json({ success: false, message: "Invalid book id" });

  try {
    const payload = await fetchMobileApi(cobalt, `${DDB_GET_BOOK_URL_BASE}/${bookId}`, {}, "adventure:book-url");
    const url = payload?.data?.url ?? payload?.url ?? payload?.data ?? payload;
    if (typeof url !== "string" || url.trim() === "") {
      return res.status(200).json({ success: false, message: `No download url returned for book ${bookId}` });
    }

    let bookCode = String(bookId);
    try {
      const cfg = await lookup.getConfig();
      const source = cfg?.sources?.find((s) => Number(s.id) === bookId);
      if (source?.name) bookCode = String(source.name).toLowerCase();
    } catch (_error) {
      // keep fallback bookCode when config lookup is unavailable
    }

    return res.status(200).json({ success: true, message: "Book url retrieved.", data: { url, bookCode } });
  } catch (error) {
    console.log(`[ddb-proxy] [adventure] book-url failed: ${error}`);
    return res.status(200).json({
      success: false,
      message: `book-url lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

// Optional adventure enrichers. The importer degrades cleanly when these are
// empty; providing routes here avoids browser-level CORS failures.
app.post("/proxy/adventure/enhancement", cors(), express.json(), (_req, res) => {
  return res.status(200).json({ success: true, message: "No enhancement data available.", data: [] });
});

app.post("/proxy/adventure/table-info", cors(), express.json(), (_req, res) => {
  return res.status(200).json({ success: true, message: "No table hints available.", data: [] });
});

const adventureOwnershipRoutes = ["/proxy/adventure/available-user-content", "/proxy/library"];
app.options(adventureOwnershipRoutes, cors(), (req, res) => res.status(200).send());
app.post(adventureOwnershipRoutes, cors(), express.json(), async (req, res) => {
  const cobalt = req.body?.cobalt;
  if (!cobalt || cobalt === "") {
    return res.status(200).json({ success: false, message: "No cobalt token" });
  }

  try {
    const payload = await fetchAvailableUserContent(cobalt);
    const isLibraryRoute = req.path === "/proxy/library";
    if (isLibraryRoute) {
      const ownedOnly = !!req.body?.ownedOnly;
      const data = mapLibraryFromContent(payload, ownedOnly);
      return res.status(200).json({
        success: true,
        message: "Adventure library retrieved.",
        data,
      });
    }

    const data = mapOwnedBooksFromContent(payload);
    return res.status(200).json({
      success: true,
      message: "Adventure ownership retrieved.",
      data,
    });
  } catch (error) {
    console.log(`[ddb-proxy] [adventures] Ownership lookup failed: ${error}`);
    return res.status(200).json({
      success: false,
      message: `Adventure ownership lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

/**
 * Returns raw json from DDB
 */
app.options("/proxy/items", cors(), (req, res) => res.status(200).send());
app.post("/proxy/items", cors(), express.json(), (req, res) => {
  if (!req.body.cobalt || req.body.cobalt == "") return res.json({ success: false, message: "No cobalt token" });

  const cacheId = authentication.getCacheId(req.body.cobalt);
  const campaignId = req.body.campaignId;

  authentication.getBearerToken(cacheId, req.body.cobalt).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });
    items
      .extractItems(cacheId, campaignId)
      .then((data) => {
        return res
          .status(200)
          .json({ success: true, message: "All available items successfully received.", data: data });
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "You must supply a valid bearer token." });
        }
        return res.json({ success: false, message: "Unknown error during item loading: " + error });
      });
  });
});

/**
 * Get Class Spells RAW
 */
app.options("/proxy/class/spells", cors(), (req, res) => res.status(200).send());
app.post("/proxy/class/spells", cors(), express.json(), (req, res) => {
  const className = req.body.className ? req.body.className : req.params.className;
  const campaignId = req.body.campaignId;

  const klass = CONFIG.classMap.find((cls) => cls.name == className);
  if (!klass) return res.json({ success: false, message: "Invalid query" });
  if (!req.body.cobalt || req.body.cobalt == "") return res.json({ success: false, message: "No cobalt token" });
  const cobaltToken = req.body.cobalt;

  const cacheId = authentication.getCacheId(cobaltToken);

  const mockClass = [
    {
      characterClassId: cacheId,
      name: klass.name,
      id: klass.id,
      level: 20,
      spellLevelAccess: 20,
      spells: [],
      classId: klass.id,
      subclassId: klass.id,
      characterClass: klass.name,
      characterSubclass: klass.name,
      characterId: cacheId,
      spellType: klass.spells,
      campaignId: campaignId,
    },
  ];

  authentication.getBearerToken(cacheId, cobaltToken).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });
    spells
      .loadSpells(mockClass, cacheId, true)
      .then((data) => {
        // console.log(data);
        const rawSpells = data.map((d) => d.spells).flat();
        // const parsedSpells = getSpells(rawSpells);
        // return parsedSpells;
        return rawSpells;
      })
      .then((data) => {
        return res
          .status(200)
          .json({ success: true, message: "All available spells successfully received.", data: data });
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "You must supply a valid cobalt value." });
        }
        return res.json({ success: false, message: "Unknown error during spell loading: " + error });
      });
  });
});

// Compatibility endpoints expected by the importer's mule list UI. This local
// proxy does not implement mule catalog APIs, so return a structured response
// (with CORS) instead of a browser-level preflight failure.
const muleCatalogRoutes = [
  "/proxy/classes",
  "/proxy/feats",
  "/proxy/backgrounds",
  "/proxy/races",
  "/proxy/subclass",
];
app.options(muleCatalogRoutes, cors(), (req, res) => res.status(200).send());
app.post(muleCatalogRoutes, cors(), express.json(), (req, res) => {
  return res.status(200).json({
    success: false,
    message: `Endpoint ${req.path} is not implemented on this proxy instance.`,
    data: [],
  });
});

/**
 * Attempt to parse the character remotely
 */
app.options(["/proxy/character", "/proxy/v5/character"], cors(), (req, res) => res.status(200).send());
app.post(["/proxy/character", "/proxy/v5/character"], cors(), express.json(), (req, res) => {
  // check for cobalt token
  const cobalt = req.body.cobalt;

  let characterId = 0;
  try {
    const characterIdString = req.body.characterId ? req.body.characterId : req.params.characterId;
    characterId = parseInt(characterIdString);
  } catch (exception) {
    return res.json({ message: "Invalid query" });
  }

  const updateId = req.body.updateId ? req.body.updateId : 0;
  const cobaltId = `${characterId}${cobalt}`;
  let campaignId = null;

  authentication.getBearerToken(cobaltId, cobalt).then(() => {
    character
      .extractCharacterData(cobaltId, characterId, updateId) // this caches
      .then((data) => {
        console.log(`Name: ${data.name}, URL: ${CONFIG.urls.baseUrl}/character/${data.id}`);
        return Promise.resolve(data);
      })
      .then((data) => {
        if (data.campaign && data.campaign.id && data.campaign.id !== "") campaignId = data.campaign.id;
        const result = {
          character: data,
          name: data.name,
          decorations: data.decorations,
          classOptions: [],
          originOptions: [],
        };
        return result;
      })
      .then((result) => {
        if (cobalt) {
          const optionIds = result.character.optionalClassFeatures.map((opt) => opt.classFeatureId);
          return character.getOptionalClassFeatures(result, optionIds, campaignId, cobaltId);
        } else {
          console.warn("No cobalt token provided, not fetching optional class features");
          return result;
        }
      })
      .then((result) => {
        if (cobalt) {
          const optionIds = result.character.optionalOrigins.map((opt) => opt.racialTraitId);
          return character.getOptionalOrigins(result, optionIds, campaignId, cobaltId);
        }else {
          console.warn("No cobalt token provided, not fetching optional origins");
          return result;
        }
      })
      .then((result) => {
        return spells.getSpellAdditions(result, cobaltId);
      })
      .then((result) => {
        const includeHomebrew = result.character.preferences.useHomebrewContent;
        return spells.filterHomebrew(result, includeHomebrew);
      })
      .then((data) => {
        data = filterModifiers(data);
        return { success: true, messages: ["Character successfully received."], ddb: data };
      })
      .then((data) => {
        return res.status(200).json(data);
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "Character must be set to public in order to be accessible." });
        }
        return res.json({ success: false, message: "Unknown error during character parsing: " + error });
      });
  });
});

/**
 * Return RAW monster data from DDB
 */
const getMonsterProxyRoutes = ["/proxy/monster", "/proxy/monsters"];
app.options(getMonsterProxyRoutes, cors(), (req, res) => res.status(200).send());
app.post(getMonsterProxyRoutes, cors(), express.json(), (req, res) => {
  // check for cobalt token
  const cobalt = req.body.cobalt;
  if (!cobalt || cobalt == "") return res.json({ success: false, message: "No cobalt token" });

  const search = req.body.search ? req.body.search : req.params.search;
  const searchTerm = req.body.searchTerm ? req.body.searchTerm : req.params.searchTerm;

  const homebrew = req.body.homebrew ? req.body.homebrew : false;
  const homebrewOnly = req.body.homebrewOnly ? req.body.homebrewOnly : false;
  const excludeLegacy = req.body.excludeLegacy ? req.body.excludeLegacy : false;

  const exactNameMatch = req.body.exactMatch || false;
  const performExactMatch = exactNameMatch && searchTerm && searchTerm !== "";

  const sources = req.body.sources || [];

  const hash = crypto.createHash("sha256");
  hash.update(cobalt + searchTerm);
  const cacheId = hash.digest("hex");

  authentication.getBearerToken(cacheId, cobalt).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });

    monsters
      .extractMonsters(cacheId, searchTerm, homebrew, homebrewOnly, sources)
      .then((data) => {
        if (excludeLegacy) {
          const filteredMonsters = data.filter((monster) => !monster.isLegacy);
          return filteredMonsters;
        } else {
          return data;
        }
      })
      .then((data) => {
        if (performExactMatch) {
          const filteredMonsters = data.filter((monster) => monster.name.toLowerCase() === search.toLowerCase());
          return filteredMonsters;
        } else {
          return data;
        }
      })
      .then((data) => {
        return res
          .status(200)
          .json({ success: true, message: "All available monsters successfully received.", data: data });
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "You must supply a valid cobalt value." });
        }
        return res.json({ success: false, message: "Unknown error during monster loading: " + error });
      });
  });
});

/**
 * Return RAW monster data from DDB
 */
const getMonsterIdsProxyRoutes = ["/proxy/monstersById", "/proxy/monsters/ids"];
app.options(getMonsterIdsProxyRoutes, cors(), (req, res) => res.status(200).send());
app.post(getMonsterIdsProxyRoutes, cors(), express.json(), (req, res) => {
  // check for cobalt token
  const cobalt = req.body.cobalt;
  if (!cobalt || cobalt == "") return res.json({ success: false, message: "No cobalt token" });

  const ids = req.body.ids;
  if (!ids) {
    return res.json({
      success: false,
      message: "Please supply required monster ids.",
    });
  }

  const hash = crypto.createHash("sha256");
  hash.update(cobalt + ids.join("-"));
  const cacheId = hash.digest("hex");

  authentication.getBearerToken(cacheId, cobalt).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });

    monsters
      .extractMonstersById(cacheId, ids)
      .then((data) => {
        return res
          .status(200)
          .json({ success: true, message: "All available monsters successfully received.", data: data });
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "You must supply a valid cobalt value." });
        }
        return res.json({ success: false, message: "Unknown error during monster loading: " + error });
      });
  });
});

app.options("/proxy/campaigns", cors(), (req, res) => res.status(200).send());
app.post("/proxy/campaigns", cors(), express.json(), (req, res) => {
  if (!req.body.cobalt || req.body.cobalt == "") return res.json({ success: false, message: "No cobalt token" });

  const cacheId = authentication.getCacheId(req.body.cobalt);

  authentication.getBearerToken(cacheId, req.body.cobalt).then((token) => {
    if (!token) return res.json({ success: false, message: "You must supply a valid cobalt value." });
    campaign
      .getCampaigns(req.body.cobalt, cacheId)
      .then((data) => {
        return res
          .status(200)
          .json({ success: true, message: "All available campaigns successfully received.", data: data });
      })
      .catch((error) => {
        console.log(error);
        if (error === "Forbidden") {
          return res.json({ success: false, message: "You must supply a valid bearer token." });
        }
        return res.json({ success: false, message: "Unknown error during campaign get: " + error });
      });
  });
});

function createServer(options = {}) {
  const listenPort = options.port ?? port;
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  const registerStreamNamespace = (namespace, label) => {
    const nsp = io.of(namespace);
    nsp.on("connection", (socket) => {
      console.log(`[ddb-proxy] [socket.io:${label}] Client connected: ${socket.id}`);

      socket.on("disconnect", (reason) => {
        console.log(`[ddb-proxy] [socket.io:${label}] Client disconnected: ${socket.id} (${reason})`);
      });

      socket.on("auth", async (payload, callback) => {
        const supportedNamespaces = ["/monsters", "/spells", "/items"];
        if (!supportedNamespaces.includes(namespace)) {
          const message = `Streaming socket namespace ${namespace} is not implemented on this ddb-proxy instance; HTTP fallback is required.`;
          console.warn(`[ddb-proxy] [socket.io:${label}] auth rejected: ${message}`);
          if (typeof callback === "function") {
            callback({ ok: false, message });
          } else {
            socket.emit("event", { kind: "error", payload: { message, fatal: true } });
          }
          return;
        }

        const cobalt = payload?.cobalt;
        if (!cobalt || cobalt === "") {
          if (typeof callback === "function") callback({ ok: false, message: "No cobalt token" });
          return;
        }

        const cacheId = authentication.getCacheId(cobalt);
        const token = await authentication.getBearerToken(cacheId, cobalt);
        if (!token) {
          if (typeof callback === "function") callback({ ok: false, message: "You must supply a valid cobalt value." });
          return;
        }

        socket.data.ddbAuth = {
          cobalt,
          betaKey: payload?.betaKey,
          campaignId: payload?.campaignId ?? null,
          characterId: payload?.characterId ?? null,
        };
        if (typeof callback === "function") {
          const authMessage = namespace === "/spells"
            ? "Spell streaming auth ok"
            : namespace === "/items"
              ? "Item streaming auth ok"
              : "Monster streaming auth ok";
          callback({ ok: true, message: authMessage });
        }
      });

      socket.on("start", (payload, callback) => {
        const supportedForNamespace = {
          "/monsters": ["all-monsters", "monsters-by-id"],
          "/spells": ["class-spells"],
          "/items": ["all-items"],
        };
        const supported = supportedForNamespace[namespace] ?? [];
        if (!supported.includes(payload?.element)) {
          const message = namespace === "/spells"
            ? `Stream jobs are not available on ${namespace}; use the HTTP endpoint instead.`
            : namespace === "/items"
              ? `Stream jobs are not available on ${namespace}; use the HTTP endpoint instead.`
              : `Unsupported monsters stream element: ${payload?.element}`;
          console.warn(`[ddb-proxy] [socket.io:${label}] start rejected: ${message}`);
          if (typeof callback === "function") callback({ ok: false, message });
          return;
        }

        const element = payload?.element;
        const params = payload?.params ?? {};
        const cobalt = params?.cobalt ?? socket.data.ddbAuth?.cobalt;
        if (!cobalt || cobalt === "") {
          if (typeof callback === "function") callback({ ok: false, message: "No cobalt token" });
          return;
        }

        const jobId = crypto.randomUUID();
        const jobToken = crypto.randomUUID();
        if (typeof callback === "function") {
          callback({ ok: true, jobId, jobToken, replayed: 0 });
        }

        const emitFailure = (error) => {
          const message = error instanceof Error ? error.message : String(error);
          socket.emit("event", { seq: 1, kind: "error", payload: { message, fatal: true } });
        };

        (async () => {
          try {
            if (namespace === "/spells") {
              const className = params?.className ?? "";
              const rulesVersion = params?.rulesVersion ?? "2014";
              const campaignId = params?.campaignId ?? socket.data.ddbAuth?.campaignId ?? null;
              const klass = CONFIG.classMap.find((cls) => cls.name == className);
              if (!klass) throw new Error(`Unsupported class for spell stream: ${className}`);

              const mockClass = [
                {
                  characterClassId: authentication.getCacheId(cobalt),
                  name: klass.name,
                  id: klass.id,
                  level: 20,
                  spellLevelAccess: 20,
                  spells: [],
                  classId: klass.id,
                  subclassId: klass.id,
                  characterClass: klass.name,
                  characterSubclass: klass.name,
                  characterId: authentication.getCacheId(cobalt),
                  spellType: klass.spells,
                  campaignId,
                },
              ];

              const data = await spells.loadSpells(mockClass, cobalt, true);
              const rawSpells = data.map((entry) => entry.spells).flat();
              socket.emit("event", { seq: 1, kind: "classSpells", payload: { spells: rawSpells } });
              socket.emit("event", { seq: 2, kind: "done", payload: { count: rawSpells.length, className, rulesVersion } });
              return;
            }

            if (namespace === "/items") {
              const campaignId = params?.campaignId ?? socket.data.ddbAuth?.campaignId ?? null;
              const data = await items.extractItems(authentication.getCacheId(cobalt), campaignId);
              socket.emit("event", { seq: 1, kind: "items", payload: { items: data, spells: [], extra: [] } });
              socket.emit("event", { seq: 2, kind: "done", payload: { count: data.length } });
              return;
            }

            if (element === "monsters-by-id") {
              const ids = Array.isArray(params?.ids) ? params.ids : [];
              if (ids.length === 0) throw new Error("Please supply required monster ids.");

              // Reuse the auth cache key established during socket auth.
              const authCacheId = authentication.getCacheId(cobalt);
              const data = await monsters.extractMonstersById(authCacheId, ids);
              socket.emit("event", { seq: 1, kind: "monsters", payload: data });
              socket.emit("event", { seq: 2, kind: "done", payload: { count: data.length } });
              return;
            }

            const search = params?.search ?? "";
            const searchTerm = params?.searchTerm ?? "";
            const homebrew = !!params?.homebrew;
            const homebrewOnly = !!params?.homebrewOnly;
            const excludeLegacy = !!params?.excludeLegacy;
            const exactNameMatch = !!params?.exactMatch;
            const performExactMatch = exactNameMatch && searchTerm && searchTerm !== "";
            const sources = Array.isArray(params?.sources) ? params.sources : [];

            const hash = crypto.createHash("sha256");
            hash.update(cobalt + searchTerm);
            const cacheId = hash.digest("hex");

            const baseData = await monsters.extractMonsters(cacheId, searchTerm, homebrew, homebrewOnly, sources);
            const legacyFiltered = excludeLegacy
              ? baseData.filter((monster) => !monster.isLegacy)
              : baseData;
            const finalData = performExactMatch
              ? legacyFiltered.filter((monster) => monster.name.toLowerCase() === search.toLowerCase())
              : legacyFiltered;

            socket.emit("event", { seq: 1, kind: "monsters", payload: finalData });
            socket.emit("event", { seq: 2, kind: "done", payload: { count: finalData.length } });
          } catch (error) {
            emitFailure(error);
          }
        })();
      });

      socket.on("resume", (_payload, callback) => {
        if (typeof callback === "function") callback({ ok: false, message: "resume not supported" });
      });

      socket.on("cancel", (_payload, callback) => {
        if (typeof callback === "function") callback({ ok: false, message: "cancel not supported" });
      });
    });
  };

  [
    ["/monsters", "monsters"],
    ["/items", "items"],
    ["/spells", "spells"],
    ["/mule", "mule"],
  ].forEach(([namespace, label]) => registerStreamNamespace(namespace, label));

  io.on("connection", (socket) => {
    console.log(`[ddb-proxy] [socket.io] Client connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[ddb-proxy] [socket.io] Client disconnected: ${socket.id} (${reason})`);
    });

    socket.on("auth", (payload, callback) => {
      const message = "DDB proxy socket.io ready";
      if (typeof callback === "function") {
        callback({ ok: true, message, payload });
      } else {
        socket.emit("auth", { ok: true, message, payload });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : listenPort;
      resolve({
        app,
        server,
        io,
        url: `http://127.0.0.1:${actualPort}`,
      });
    });
  });
}

if (require.main === module) {
  createServer({ port }).then(({ server }) => {
    console.log(`DDB Proxy started on :${server.address().port}`);
  }).catch((error) => {
    console.error("Failed to start DDB Proxy:", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  createServer,
};
