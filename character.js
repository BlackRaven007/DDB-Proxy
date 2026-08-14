const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const { fetchJsonWithRetry } = require("./httpClient");

const isValidData = data => {
  return data.success === true;
};


const extractClassOptions = (cobaltId, optionIds=[], campaignId=null) => {
  console.log(optionIds);

  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [character] Requesting class options for ${cobaltId}`);

    const url = CONFIG.urls.classOptionsAPI();
    const body = JSON.stringify({
      "campaignId": campaignId,
      "sharingSetting": 2,
      "ids": optionIds,
    });

    const auth = authentication.CACHE_AUTH.exists(cobaltId);
    const headers = (auth && auth.data) ? {
      "Authorization": `Bearer ${auth.data}`,
      "Content-Type": "application/json",
      "Content-Length": body.length,
    } : {};

    const options = {
      method: "POST",
      headers: headers,
      body: body
    };

    fetchJsonWithRetry(url, options, {
      retries: 2,
      timeoutMs: 15000,
      retryDelayMs: 250,
      requestKey: `class-options:${cobaltId}:${optionIds.join("-")}`,
    })
      .then(({ data: json, ok }) => {
        if (ok && isValidData(json)) {
          const filteredItems = json.data.definitionData.filter(option =>
            option.sources && (option.sources.length === 0 || option.sources.some((source) => source.sourceId != 39))
          );
          resolve(filteredItems);
        } else {
          console.log(`[ddb-proxy] [character] Received no valid class option data: ${json.message}`);
          reject(json.message);
        }
      })
      .catch(error => {
        console.log("[ddb-proxy] [character] Error retrieving class options");
        console.log(error);
        reject(error);
      });
  });
};


const extractRacialTraitsOptions = (cobaltId, optionIds=[], campaignId=null) => {
  console.log(optionIds);

  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [character] Requesting origin options for ${cobaltId}`);

    const url = CONFIG.urls.racialTraitOptionsAPI();
    const body = JSON.stringify({
      "campaignId": campaignId,
      "sharingSetting": 2,
      "ids": optionIds,
    });

    const auth = authentication.CACHE_AUTH.exists(cobaltId);
    const headers = (auth && auth.data) ? {
      "Authorization": `Bearer ${auth.data}`,
      "Content-Type": "application/json",
      "Content-Length": body.length,
    } : {};

    const options = {
      method: "POST",
      headers: headers,
      body: body
    };

    fetchJsonWithRetry(url, options, {
      retries: 2,
      timeoutMs: 15000,
      retryDelayMs: 250,
      requestKey: `origin-options:${cobaltId}:${optionIds.join("-")}`,
    })
      .then(({ data: json, ok }) => {
        if (ok && isValidData(json)) {
          const filteredItems = json.data.definitionData.filter(option =>
            option.sources && (option.sources.length === 0 || option.sources.some((source) => source.sourceId != 39))
          );
          resolve(filteredItems);
        } else {
          console.log(`[ddb-proxy] [character] Received no valid origin option data: ${json.message}`);
          reject(json.message);
        }
      })
      .catch(error => {
        console.log("[ddb-proxy] [character] Error retrieving origin options");
        console.log(error);
        reject(error);
      });
  });
};

const extractCharacterData = (cobaltId, characterId) => {
  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [character] Retrieving character data for characterId=${characterId}`);

    const auth = authentication.CACHE_AUTH.exists(cobaltId);
    const headers = (auth) ? {headers: {"Authorization": `Bearer ${auth.data}`}} : {};
    const characterUrl = CONFIG.urls.characterUrl(characterId);
    fetchJsonWithRetry(characterUrl, headers, {
      retries: 2,
      timeoutMs: 20000,
      retryDelayMs: 300,
      requestKey: `character:${cobaltId}:${characterId}`,
    })
      .then(({ data: json, ok }) => {
        if (ok && isValidData(json)) {
          console.log(`[ddb-proxy] [character] Character data retrieved successfully for characterId=${characterId}`);
          resolve(json.data);
        } else {
          console.log(`[ddb-proxy] [character] Character data request failed for characterId=${characterId}: ${json.message}`);
          reject(json.message);
        }
      })
      .catch(error => {
        console.log(`[ddb-proxy] [character] loadCharacterData(${characterId}) failed: ${error}`);
        reject(error);
      });
  });
};

const getOptionalClassFeatures = (data, optionIds, campaignId, cobaltId) => {
  const cacheId = authentication.CACHE_AUTH.exists(cobaltId);

  return new Promise((resolve) => {
    if (cacheId) {
      console.log(`[ddb-proxy] [character] Processing optional class features for ${cobaltId}`);

      extractClassOptions(cobaltId, optionIds, campaignId)
        .then(options => {
          data.classOptions = options;
          resolve(data);
        });
    } else {
      resolve(data);
    }
  });
};

const getOptionalOrigins = (data, optionIds, campaignId, cobaltId) => {
  const cacheId = authentication.CACHE_AUTH.exists(cobaltId);

  return new Promise((resolve) => {
    if (cacheId) {
      console.log(`[ddb-proxy] [character] Processing optional origin features for ${cobaltId}`);

      extractRacialTraitsOptions(cobaltId, optionIds, campaignId)
        .then(options => {
          data.originOptions = options;
          resolve(data);
        });
    } else {
      resolve(data);
    }
  });
};


exports.extractClassOptions = extractClassOptions;
exports.extractCharacterData = extractCharacterData;
exports.getOptionalClassFeatures = getOptionalClassFeatures;
exports.getOptionalOrigins = getOptionalOrigins;
