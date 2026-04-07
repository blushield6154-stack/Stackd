const EBAY_APP_ID = process.env.EBAY_APP_ID;

async function getEbaySoldData(itemName) {
  try {
    const query = encodeURIComponent(itemName);
    const url = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.3&SECURITY-APPNAME=${EBAY_APP_ID}&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD&keywords=${query}&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&itemFilter(1).name=ListingType&itemFilter(1).value=FixedPrice&sortOrder=EndTimeSoonest&paginationInput.entriesPerPage=20`;

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item;

    if (!items || items.length === 0) return null;

    const prices = items
      .map(item => parseFloat(item?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__))
      .filter(p => !isNaN(p) && p > 0);

    if (prices.length === 0) return null;

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const sorted = [...prices].sort((a, b) => a - b);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];

    // Calculate avg days to sell from listing end dates
    const endDates = items
      .map(item => item?.listingInfo?.[0]?.endTime?.[0])
      .filter(Boolean)
      .map(d => new Date(d));

    const startDates = items
      .map(item => item?.listingInfo?.[0]?.startTime?.[0])
      .filter(Boolean)
      .map(d => new Date(d));

    let avgDays = null;
    if (endDates.length > 0 && startDates.length > 0) {
      const diffs = endDates.map((end, i) => {
        if (!startDates[i]) return null;
        return (end - startDates[i]) / (1000 * 60 * 60 * 24);
      }).filter(d => d !== null && d >= 0 && d <= 90);

      if (diffs.length > 0) {
        avgDays = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
      }
    }

    return {
      avgPrice: Math.round(avg * 100) / 100,
      lowPrice: Math.round(low * 100) / 100,
      highPrice: Math.round(high * 100) / 100,
      soldCount: prices.length,
      avgDaysToSell: avgDays,
      source: 'ebay_live'
    };

  } catch (err) {
    console.error('eBay API error:', err.message);
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

    // Step 1 — Ask Claude to identify the item only first
    const identifyResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Identify this item in 3-6 words for an eBay search. Brand and model if visible. Just the search term, nothing else. Example: "Nike Air Force 1 white" or "Levi 501 jeans vintage" or "KitchenAid stand mixer red"' }
          ]
        }]
      })
    });

    let ebaySearchTerm = null;
    let ebayData = null;

    if (identifyResponse.ok) {
      const identifyData = await identifyResponse.json();
      ebaySearchTerm = identifyData.content[0].text.trim().replace(/['"]/g, '');

      // Step 2 — Pull real eBay sold data using that search term
      if (ebaySearchTerm && EBAY_APP_ID) {
        ebayData = await getEbaySoldData(ebaySearchTerm);
      }
      console.log('eBay search term:', ebaySearchTerm);
      console.log('eBay App ID present:', !!EBAY_APP_ID);
      console.log('eBay data result:', ebayData ? JSON.stringify(ebayData) : 'null - falling back to Claude estimates');
    }

    // Step 3 — Send Claude the full prompt with real eBay data if we got it
    const ebayContext = ebayData
      ? `\n\nREAL EBAY SOLD DATA (last 90 days, ${ebayData.soldCount} sales):
- Average sold price: $${ebayData.avgPrice}
- Price range: $${ebayData.lowPrice} - $${ebayData.highPrice}
- Average days to sell: ${ebayData.avgDaysToSell !== null ? ebayData.avgDaysToSell + ' days' : 'unknown'}
- Sales volume: ${ebayData.soldCount} units sold recently

Use this real data for your price estimates. Do not override it with estimates unless the data seems clearly wrong for the item shown.`
      : '\n\nNo live eBay data available — use your training knowledge for price estimates.';

    const fullPrompt = prompt + ebayContext;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: fullPrompt }
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
      ebayData: ebayData,
      ebaySearchTerm: ebaySearchTerm
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
