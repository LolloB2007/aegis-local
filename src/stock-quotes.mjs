// Read-only stock quotes. Kev may classify the user's request, but quote
// numbers only come from validated HTTPS market-data metadata, never the LLM.
const NAMES=Object.freeze([
  ['berkshire hathaway','BRK-B'],['jpmorgan chase','JPM'],['goldman sachs','GS'],
  ['intesa sanpaolo','ISP.MI'],['novo nordisk','NVO'],['alphabet','GOOGL'],
  ['google','GOOGL'],['microsoft','MSFT'],['nvidia','NVDA'],['tesla','TSLA'],
  ['apple','AAPL'],['amazon','AMZN'],['meta','META'],['facebook','META'],
  ['netflix','NFLX'],['broadcom','AVGO'],['palantir','PLTR'],
  ['advanced micro devices','AMD'],['amd','AMD'],['intel','INTC'],
  ['salesforce','CRM'],['oracle','ORCL'],['walmart','WMT'],['disney','DIS'],
  ['coinbase','COIN'],['shopify','SHOP'],['visa','V'],['mastercard','MA'],
  ['ferrari','RACE'],['enel','ENEL.MI'],['eni','ENI.MI'],
  ['unicredit','UCG.MI'],['generali','G.MI'],['stellantis','STLAM.MI'],
  ['leonardo','LDO.MI'],['asml','ASML'],['lvmh','MC.PA']
]);
const SYMBOL=/^[A-Z0-9^][A-Z0-9.^-]{0,14}$/;
const BAD_SYMBOLS=new Set(['THE','FOR','OF','IS','AT','NOW','TODAY','STOCK','SHARE','PRICE','QUOTE','WHAT','HOW','MY','A','ON']);

export function stockQuoteIntent(message) {
  const text=String(message||'').trim();
  if(/^(?:open|launch|visit|browse)\b/i.test(text))return null;
  if(/\b(?:why|forecast|prediction|predict|target price|price target|historical|history|chart|trend|analysis|valuation|dividend|should i buy|how to)\b/i.test(text))return null;
  if(!/\b(?:price|quote|trading at|how much|worth|stock at)\b/i.test(text))return null;
  const isStock=/\b(?:stock|shares?|ticker|quote|trading at)\b/i.test(text);
  const explicit=/\$[A-Z]{1,7}\b|\b(?:NASDAQ|NYSE|NYSEARCA|BIT):[A-Z0-9.-]+\b/.test(text);
  const capitalSymbol=/\b[A-Z]{1,7}(?:\.[A-Z]{1,3})?\b/.test(text);
  // Known listed-company names plus a clear price request should be answered
  // as quotes even when the user omits the word "stock" (e.g. "look up
  // Apple's price"), rather than triggering a browser-only search.
  const knownCompany=NAMES.some(([name])=>
    new RegExp('(?:^|[^a-z])'+name+'(?:$|[^a-z])','i').test(text));
  if(!isStock && !(explicit||capitalSymbol||knownCompany))return null;
  if(!/\b(?:what|how much|latest|current|today|now|give|show|check|tell|quote|price)\b/i.test(text))return null;
  const candidates=new Set();
  for(const match of text.matchAll(/(?:\$|\b(?:NASDAQ|NYSE|NYSEARCA|BIT):)([A-Z][A-Z0-9.-]{0,14})\b/g))candidates.add(match[1]);
  // Safe to interpolate: all fixed lookup names contain only ASCII letters and spaces.
  for(const [name,ticker] of NAMES) {
    if(new RegExp('(?:^|[^a-z])'+name+'(?:$|[^a-z])','i').test(text))candidates.add(ticker);
  }
  for(const match of [
    ...text.matchAll(/\b([A-Z]{1,7}(?:\.[A-Z]{1,3})?)\s+(?:stock|shares?|quote|price)\b/g),
    ...text.matchAll(/\b(?:price|quote|stock|shares?)\s+(?:of|for|in)?\s*([A-Z]{1,7}(?:\.[A-Z]{1,3})?)\b/g)
  ])if(!BAD_SYMBOLS.has(match[1]))candidates.add(match[1]);
  const valid=[...candidates].filter(symbol=>SYMBOL.test(symbol));
  return {symbol:valid.length===1?valid[0]:null,ambiguous:valid.length>1,candidates:valid.slice(0,6)};
}

const validPrice=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<1e10;
export async function getStockQuote(request,{fetchImpl=fetch,now=Date.now(),signal=null}={}){
  const symbol=request?.symbol;
  if(!symbol||!SYMBOL.test(symbol))throw new Error('Specify a valid stock ticker.');
  const url='https://query1.finance.yahoo.com/v8/finance/chart/'+
    encodeURIComponent(symbol)+'?interval=1d&range=5d';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),9000);
  const cancel=()=>controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(signal?.aborted)throw new Error('Request cancelled.');
    const response=await fetchImpl(url,{
      method:'GET',redirect:'error',signal:controller.signal,
      headers:{accept:'application/json','user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'}
    });
    if(!response.ok)throw new Error('Market data provider HTTP '+response.status+'.');
    const raw=await response.text();
    if(raw.length>160000)throw new Error('Market data response exceeded size limit.');
    const meta=JSON.parse(raw)?.chart?.result?.[0]?.meta;
    if(!meta||typeof meta!=='object')throw new Error('No valid quote returned for '+symbol+'.');
    if(String(meta.symbol||'').toUpperCase()!==symbol)throw new Error('Quote ticker did not match requested ticker.');
    const price=meta.regularMarketPrice;
    const epoch=Number(meta.regularMarketTime);
    const currency=String(meta.currency||'');
    if(!validPrice(price)||!/^[A-Z]{3}$/.test(currency))throw new Error('Price or currency missing from market data.');
    if(!Number.isSafeInteger(epoch)||epoch*1000>now+600000||now-epoch*1000>7*86400000)
      throw new Error('Quote timestamp is missing or stale.');
    const prior=validPrice(meta.previousClose)?meta.previousClose:
      validPrice(meta.chartPreviousClose)?meta.chartPreviousClose:null;
    const change=prior?(price-prior)/prior*100:null;
    const company=String(meta.shortName||meta.longName||symbol).replace(/[\r\n<>]/g,' ').slice(0,100);
    const shown=price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
    const timestamp=new Date(epoch*1000).toISOString().replace('T',' ').replace('.000Z',' UTC');
    const changeText=change===null?'':'\nChange vs previous close: '+(change>=0?'+':'')+change.toFixed(2)+'%.';
    return {
      text:'**'+company+' ('+symbol+'): '+shown+' '+currency+'**'+changeText+
        '\nMarket timestamp: '+timestamp+
        '\nSource: Yahoo Finance chart quote. Quotes may be delayed; this is not a live execution price.',
      details:{symbol,company,price,currency,previousClose:prior,marketTime:new Date(epoch*1000).toISOString(),
        source:'Yahoo Finance',url,delayed:true}
    };
  }catch(error){
    if(controller.signal.aborted)throw new Error(signal?.aborted?'Request cancelled.':'Market data request timed out.');
    if(error instanceof SyntaxError)throw new Error('Market provider returned invalid JSON.');
    throw error;
  }finally{
    clearTimeout(timer);
    signal?.removeEventListener('abort',cancel);
  }
}
