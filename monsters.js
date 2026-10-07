const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const { fetchJsonWithRetry } = require("./httpClient");

function getAuthHeaders(cacheId) {
  const cacheEntry = authentication.CACHE_AUTH.exists(cacheId);
  const token = cacheEntry?.data;
  return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
}

function getMonsterCount(cobaltId, searchTerm="", homebrew, homebrewOnly, sources, campaignId=null) {
  return new Promise((resolve, reject) => {
    const headers = getAuthHeaders(cobaltId);
    const url = CONFIG.urls.monstersAPI(0,1, searchTerm, homebrew, homebrewOnly, sources, campaignId);
    fetchJsonWithRetry(url, headers, {
      retries: 2,
      timeoutMs: 20000,
      retryDelayMs: 300,
      requestKey: `monster-count:${cobaltId}:${searchTerm}:${homebrew}:${homebrewOnly}:${sources.join("-")}`,
    })
      .then(({ data: json, ok }) => {
        if (!ok) {
          reject(`Monster count lookup failed`);
          return;
        }
        resolve(json.pagination.total);
      })
      .catch(error => {
        console.log("Error retrieving monsters");
        console.log(error);
        reject(error);
      });
  });

}

function imageFiddleMonsters(monsters) {
  const imageFiddledMonsters = monsters.map((monster) => {
    const imageResizeRegEx = /\/thumbnails\/(\d*)\/(\d*)\/(\d*)\/(\d*)\/(\d*)\.(jpg|png|jpeg|webp|gif)/;
    if (monster.largeAvatarUrl) {
      const original = monster.largeAvatarUrl.replace(".com.com/", ".com/");
      monster.largeAvatarUrl = original.replace(imageResizeRegEx, "/thumbnails/$1/$2/1000/1000/$5.$6");
    }
    if (monster.basicAvatarUrl) {
      const original = monster.basicAvatarUrl.replace(".com.com/", ".com/");
      monster.basicAvatarUrl = original.replace(imageResizeRegEx, "/thumbnails/$1/$2/1000/1000/$5.$6");
    }
    return monster;
  });
  return imageFiddledMonsters;
}

const extractMonsters = (cobaltId, searchTerm="", homebrew, homebrewOnly, sources, campaignId=null) => {
  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [monsters] Retrieving monsters for ${cobaltId}`);

    let monsters = [];
    const headers = getAuthHeaders(cobaltId);
    let count = 0;
    // fetch 100 monsters at a time - api limit
    let take = 100;
    getMonsterCount(cobaltId, searchTerm, homebrew, homebrewOnly, sources, campaignId).then(async (total) => {
      console.log(`[ddb-proxy] [monsters] Total monsters reported: ${total}`);
      const hardTotal = total;
      while (total >= count && hardTotal >= count) {
        console.log(`[ddb-proxy] [monsters] Fetching monster page starting at ${count}`);
        const url = CONFIG.urls.monstersAPI(count,take,searchTerm, homebrew, homebrewOnly, sources, campaignId);
        await fetchJsonWithRetry(url, headers, {
          retries: 2,
          timeoutMs: 20000,
          retryDelayMs: 300,
          requestKey: `monsters:${cobaltId}:${count}:${take}:${searchTerm}:${homebrew}:${homebrewOnly}:${sources.join("-")}`,
        })
          .then(({ data: json, ok }) => {
            if (!ok) throw new Error(`Monster page fetch failed at offset ${count}`);
            const imageFiddledMonsters = imageFiddleMonsters(json.data || []);
            monsters.push(...imageFiddledMonsters);
          })
          .catch(error => {
            console.log(`[ddb-proxy] [monsters] Error retrieving monsters at offset ${count}`);
            console.log(error);
            reject(error);
          });
        count += take;
      }
      return monsters;
    }).then((data) => {
      console.log(`Monster count: ${data.length}.`);
      resolve(data);
    }).catch(error => {
      console.log("Error retrieving monsters");
      console.log(error);
      reject(error);
    });
  });
};


async function getIdCount(ids) {
  return new Promise((resolve) => {
    resolve(ids.length);
  });
}

function extractMonstersById (cobaltId, ids, campaignId=null) {
  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [monsters] Retrieving monsters by id for ${cobaltId} (${ids.length} ids)`);

    let monsters = [];
    let count = 0;
    let take = 100;

    getIdCount(ids).then(async (total) => {
      const hardTotal = total;
      while (total >= count && hardTotal >= count) {
        const idSelection = ids.slice(count, count + take);
        const headers = getAuthHeaders(cobaltId);
        const url = CONFIG.urls.monsterIdsAPI(idSelection, campaignId);
        await fetchJsonWithRetry(url, headers, {
          retries: 2,
          timeoutMs: 20000,
          retryDelayMs: 300,
          requestKey: `monsters-by-id:${cobaltId}:${idSelection.join("-")}`,
        })
          .then(({ data: json, ok }) => {
            if (!ok) throw new Error("Monster by-id fetch failed");
            const imageFiddledMonsters = imageFiddleMonsters(json.data || []);
            monsters.push(...imageFiddledMonsters);
          })
          .catch((error) => {
            console.log("[ddb-proxy] [monsters] Error retrieving monsters by id");
            console.log(error);
            reject(error);
          });
        count += take;
      }
      return monsters;
    }).then((data) => {
      console.log(`Monster count: ${data.length}.`);
      resolve(data);
    });

  });
}

exports.extractMonsters = extractMonsters;
exports.extractMonstersById = extractMonstersById;
