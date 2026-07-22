const { request } = require('../utils/providerHttp');

class MalSyncProvider {
  async resolveGogoSlug({ malId }) {
    if (!malId || !process.env.MALSYNC_BASE_URL) return null;
    const base = process.env.MALSYNC_BASE_URL.replace(/\/$/, '');
    const response = await request({ method: 'GET', url: `${base}/mal/anime/${encodeURIComponent(malId)}` });
    const sites = response.data?.Sites || response.data?.sites || {};
    for (const site of Object.values(sites)) {
      for (const entry of Object.values(site || {})) {
        if (entry?.identifier && /gogo/i.test(entry?.site || entry?.url || JSON.stringify(entry))) return entry.identifier;
      }
    }
    return null;
  }
}

module.exports = { MalSyncProvider };
