const express = require("express");
const http = require("node:http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");

const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const { getHttpQueueStats, runWithCorrelationId } = require("./httpClient");

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

      socket.on("auth", (payload, callback) => {
        const message = `Streaming socket namespace ${namespace} is not implemented on this ddb-proxy instance; HTTP fallback is required.`;
        console.warn(`[ddb-proxy] [socket.io:${label}] auth rejected: ${message}`);
        if (typeof callback === "function") {
          callback({ ok: false, message });
        } else {
          socket.emit("event", { kind: "error", payload: { message, fatal: true } });
        }
      });

      socket.on("start", (_payload, callback) => {
        const message = `Stream jobs are not available on ${namespace}; use the HTTP endpoint instead.`;
        console.warn(`[ddb-proxy] [socket.io:${label}] start rejected: ${message}`);
        if (typeof callback === "function") {
          callback({ ok: false, message });
        }
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
