const fetch = require("node-fetch");

// Only ever proxy images from hosts we expect DDB Importer to ask for.
// Add to this list if you hit a legitimate host that gets rejected.
const ALLOWED_HOST_SUFFIXES = [
  "dndbeyond.com",
  "cursecdn.com",
  "cloudfront.net",
];

// Signed adventure book zips use hostnames like
// `<prefix>-dndbeyond-live-restricted.s3.amazonaws.com`.
const ALLOWED_HOST_SUBSTRINGS = [
  "dndbeyond-live-restricted.s3.amazonaws.com",
];

function isAllowedHost(host) {
  const lower = host.toLowerCase();
  if (ALLOWED_HOST_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))) {
    return true;
  }
  return ALLOWED_HOST_SUBSTRINGS.some((fragment) => lower.includes(fragment));
}

/**
 * Reconstructs the target URL from the ddb-importer client's CORS-proxy request.
 *
 * The client builds requests as: <cors-endpoint>ddb/<host>/<path...>
 * (see FileHelper.uploadRemoteImage / cors-strip-protocol + cors-path-prefix settings)
 * So on our side we see the path as /ddb/<host>/<path...>
 */
function buildTargetUrl(hostParam, restParam) {
  if (!hostParam) return null;
  // Client may optionally send the full URL (cors-strip-protocol = false), guard for it.
  if (hostParam.startsWith("http://") || hostParam.startsWith("https://")) {
    return decodeURIComponent(hostParam + (restParam ? `/${restParam}` : ""));
  }
  const rest = restParam ? `/${restParam}` : "";
  return `https://${hostParam}${rest}`;
}

async function imageProxyHandler(req, res) {
  try {
    const hostParam = req.params.host;
    const restParam = req.params[0]; // everything after /ddb/:host/
    const targetUrl = buildTargetUrl(hostParam, restParam);

    if (!targetUrl) {
      return res.status(400).send("Missing target host");
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return res.status(400).send("Invalid target URL");
    }

    if (!isAllowedHost(parsed.hostname)) {
      console.log(`[IMAGE PROXY] Rejected host: ${parsed.hostname}`);
      return res.status(403).send("Host not allowed");
    }

    const upstream = await fetch(parsed.toString(), {
      method: "GET",
      headers: { "x-requested-with": "foundry" },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    upstream.body.pipe(res);
  } catch (error) {
    console.log("[IMAGE PROXY] Error", error);
    return res.status(500).send("Image proxy error");
  }
}

module.exports = { imageProxyHandler, isAllowedHost, buildTargetUrl };
