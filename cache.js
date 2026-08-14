/**
 * Simple in-memory cache
 */
class Cache {
  constructor(name, expiration=24) {
    this.items = [];
    this.name = name;
    this.expiration = expiration; // expiration in hours
    this.inFlight = new Map();
  }

  exists(id) {
    const result = this.items.find(cache => cache.id === id && !this.isExpired(cache.lastUpdate));
    if (result) {
      console.log(`[ddb-proxy] [cache:${this.name}] Cache hit for ${id}`);
    } else {
      console.log(`[ddb-proxy] [cache:${this.name}] Cache miss for ${id}`);
    }
    return result;
  }

  isExpired(timestamp) {
    return (new Date().valueOf() - timestamp) / (1000 * 60 * 60 * this.expiration) >= 1;
  }

  add(id, data) {
    const isArray = Array.isArray(data);
    const isString = typeof data === "string" || data instanceof String;
    const isObject = typeof data === "object";
    if (!data || ((isArray || isString) && !data.length) || (!isArray && !isString && !isObject)) return null;
    console.log(`[ddb-proxy] [cache:${this.name}] Adding to the cache (ID: ${id}): ${Array.isArray(data) ? data.length : 1} item(s).`);

    const index = this.items.find(cache => cache.id === id);
    if (index) {
      console.log(`[ddb-proxy] [cache:${this.name}] Removing expired entry from cache`);
      this.items = this.items.filter(cache => cache.id !== id);
    }

    this.items.push({
      id: id,
      lastUpdate: new Date().valueOf(),
      data: data,
    });
  }

  async getOrCreate(id, producer) {
    const existing = this.exists(id);
    if (existing !== undefined) return existing.data;

    if (this.inFlight.has(id)) {
      return this.inFlight.get(id);
    }

    const promise = Promise.resolve()
      .then(() => producer())
      .then((data) => {
        this.add(id, data);
        return data;
      })
      .finally(() => {
        this.inFlight.delete(id);
      });

    this.inFlight.set(id, promise);
    return promise;
  }
}

module.exports = Cache;
