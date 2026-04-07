const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;

// Cache token in memory for up to 2 hours
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`eBay token error: ${err}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function getEbayBrowseData(itemName) {
  try {
    const token = await getEbayToken();
    const query = encodeURIComponent(itemName);
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${query}&limit=20&filter=conditions%3A%7BUSED%7C%7CVERY_GOOD%7C%7CGOOD%7C%7CACCEPTABLE%7D`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('eBay Browse API error:', response.status);
      return null;
    }

    const data = await response.json();
    const items = data?.itemSummaries;
    if (!items || items.length === 0) return null;

    const prices = items
      .map(item => parseFloat(item?.price?.value))
      .filter(p => !isNaN(p) && p > 0);

    if (prices.length === 0) return null;

    const sorted = [...prices].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * 0.1);
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
    const trimmedAvg = trimmed.length > 0
      ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length
      : prices.reduce((a, b) => a + b, 0) / prices.length;

    const low = trimmed[0] || sorted[0];
    const high = trimmed[trimmed.length - 1] || sorted[sorted.length - 1];

    const watchCounts = items.map(item => item?.watchCount || 0).filter(w => w > 0);
    const avgWatchers = watchCounts.length > 0
      ? watchCounts.reduce((a, b) => a + b, 0) / watchCounts.length
      : 0;

    const demandLevel = avgWatchers > 10 ? 'High' : avgWatchers > 3 ? 'Medium' : 'Low';
    const soldPriceEstimate = trimmedAvg * 0.85;

    return {
      askingAvg: Math.round(trimmedAvg * 100) / 100,
      estimatedSoldAvg: Math.round(soldPriceEstimate * 100) / 100,
      lowPrice: Math.round(low * 0.85 * 100) / 100,
      highPrice: Math.round(high * 0.85 * 100) / 100,
      listingCount: items.length,
      avgWatchers: Math.round(avgWatchers),
      demandLevel,
      source: 'ebay_browse'
    };
  } catch (err) {
    console.error('eBay Browse error:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { image, mediaType, prompt } = req.body;
    if (!image || !prompt) return res.status(400).json({ error: 'Missing image or prompt' });

    // Step 1 — Identify item
    const identifyResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Identify this item in 3-6 words for an eBay search. Brand and model if visible. Just the search term, nothing else. Example: "Nike Air Force 1 white" or "Levi 501 jeans" or "KitchenAid stand mixer"' }
          ]
        }]
      })
    });

    let ebaySearchTerm = null;
    let ebayData = null;

    if (identifyResponse.ok) {
      const identifyData = await identifyResponse.json();
      ebaySearchTerm = identifyData.content[0].text.trim().replace(/['"]/g, '');
      console.log('eBay search term:', ebaySearchTerm);

      if (ebaySearchTerm && EBAY_APP_ID && EBAY_CERT_ID) {
        ebayData = await getEbayBrowseData(ebaySearchTerm);
      }
      console.log('eBay data:', ebayData ? JSON.stringify(ebayData) : 'null - using Claude estimates');
    }

    // Step 2 — Full scan with real data injected
    const ebayContext = ebayData
      ? `\n\nREAL EBAY MARKET DATA (${ebayData.listingCount} current used listings):
- Estimated sold price range: $${ebayData.lowPrice} - $${ebayData.highPrice}
- Estimated average sold price: $${ebayData.estimatedSoldAvg}
- Demand: ${ebayData.demandLevel} (avg ${ebayData.avgWatchers} watchers per listing)

Use $${ebayData.estimatedSoldAvg} as your sell_price_avg. Adjust for condition. Keep range between $${ebayData.lowPrice} and $${ebayData.highPrice}.`
      : '\n\nNo live eBay data available — use your training knowledge for estimates.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: prompt + ebayContext }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();
    return res.status(200).json({
      content: data.content[0].text,
      ebayData,
      ebaySearchTerm
    });

  } catch (err) {
    console.error('Handler error:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
