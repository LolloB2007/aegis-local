import test from 'node:test';
import assert from 'node:assert/strict';
import {stockQuoteIntent,getStockQuote} from '../src/stock-quotes.mjs';

test('stock quote requests route without generating market numbers',()=>{
  assert.equal(stockQuoteIntent("What's Apple's stock price?").symbol,'AAPL');
  assert.equal(stockQuoteIntent('What is the price of NVDA?').symbol,'NVDA');
  assert.equal(stockQuoteIntent('Give me a quote for $MSFT').symbol,'MSFT');
  assert.equal(stockQuoteIntent('How much is UniCredit stock worth?').symbol,'UCG.MI');
  assert.equal(stockQuoteIntent('What is the stock price of Acme Corp?').symbol,null);
  assert.equal(stockQuoteIntent("What's the stock price of Apple and Tesla?").ambiguous,true);
  for(const s of ['Why is Apple stock price falling?','Explain stock prices',
    'Search the web for Apple stock price','Open AAPL stock page','What is the CAPM?'])
    assert.equal(stockQuoteIntent(s),null,s);
});

test('market quote fetch validates source, currency and timestamp',async()=>{
  const now=Date.parse('2026-11-10T16:00:00Z');
  let called;
  const fetchImpl=async(url,opts)=>{
    called={url,opts};
    return {ok:true,text:async()=>JSON.stringify({chart:{result:[{meta:{
      symbol:'AAPL',currency:'USD',regularMarketPrice:220.5,
      previousClose:219,regularMarketTime:Math.floor(now/1000)-120,
      shortName:'Apple Inc.'
    }}]}})};
  };
  const result=await getStockQuote({symbol:'AAPL'},{fetchImpl,now});
  assert.match(result.text,/220\.50 USD/);
  assert.match(result.text,/Yahoo Finance/);
  assert.equal(result.details.price,220.5);
  assert.equal(result.details.delayed,true);
  assert.match(called.url,/^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL/);
  assert.equal(called.opts.redirect,'error');
});

test('reject mismatched, stale, invalid, and rate-limited quotes',async()=>{
  const now=Date.parse('2026-11-10T16:00:00Z');
  const mock=meta=>async()=>({ok:true,text:async()=>JSON.stringify({chart:{result:[{meta}]}})});
  await assert.rejects(getStockQuote({symbol:'AAPL'},{now,fetchImpl:mock({symbol:'MSFT',regularMarketPrice:1,currency:'USD',regularMarketTime:now/1000})}),/ticker did not match/);
  await assert.rejects(getStockQuote({symbol:'AAPL'},{now,fetchImpl:mock({symbol:'AAPL',regularMarketPrice:1,currency:'USD',regularMarketTime:100})}),/stale/);
  await assert.rejects(getStockQuote({symbol:'AAPL'},{now,fetchImpl:mock({symbol:'AAPL',regularMarketPrice:null,currency:'USD',regularMarketTime:now/1000})}),/Price or currency/);
  await assert.rejects(getStockQuote({symbol:'AAPL'},{now,fetchImpl:async()=>({ok:false,status:429})}),/429/);
});
