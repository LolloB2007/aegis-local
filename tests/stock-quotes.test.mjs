import test from 'node:test';
import assert from 'node:assert/strict';
import {stockQuoteIntent,getStockQuote} from '../src/stock-quotes.mjs';

test('stock quote requests route without generating market numbers',()=>{
  assert.equal(stockQuoteIntent("What's Apple's stock price?").symbol,'AAPL');
  assert.equal(stockQuoteIntent('What is the price of NVDA?').symbol,'NVDA');
  assert.equal(stockQuoteIntent('Give me a quote for $MSFT').symbol,'MSFT');
  assert.equal(stockQuoteIntent('How much is UniCredit stock worth?').symbol,'UCG.MI');
  assert.equal(stockQuoteIntent('What is the stock price of Acme Corp?').symbol,null);
  assert.equal(stockQuoteIntent('Search the web for Apple stock price').symbol,'AAPL');
  assert.equal(stockQuoteIntent("What's the stock price of Apple and Tesla?").ambiguous,true);
  for(const s of ['Why is Apple stock price falling?','Explain stock prices',
    'Open AAPL stock page','What is the CAPM?'])
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


test('end-to-end: stock question bypasses BOTH models and returns verified quote',async t=>{
  const fs=await import('node:fs/promises');
  const os=await import('node:os');
  const path=await import('node:path');
  const http=await import('node:http');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-stock-e2e-'));
  const formerHome=process.env.AEGIS_HOME;
  process.env.AEGIS_HOME=home;
  const mockCalls=[];
  const ollama=http.createServer(async(req,res)=>{
    let body='';
    for await(const chunk of req)body+=chunk.toString();
    mockCalls.push(req.url);
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/ps')return res.end('{"models":[]}');
    if(req.url==='/v1/systemone')return res.end(JSON.stringify({
      answers:{intent:{choice:'ask_llm',probabilities:{ask_llm:.95},confidence:.95},
        target_app:{choice:'none'}}
    }));
    if(req.url==='/api/chat')return res.end(JSON.stringify({message:{content:'You can look it up.'}}));
    return res.end('{}');
  });
  await new Promise(resolve=>ollama.listen(0,'127.0.0.1',resolve));
  const oldFetch=globalThis.fetch;
  const now=Math.floor(Date.now()/1000);
  globalThis.fetch=async(input,options)=>{
    if(String(input).startsWith('https://query1.finance.yahoo.com/v8/finance/chart/'))
      return {ok:true,text:async()=>JSON.stringify({chart:{result:[{meta:{
        symbol:'AAPL',shortName:'Apple Inc.',currency:'USD',
        regularMarketPrice:250.25,previousClose:249.75,regularMarketTime:now
      }}]}})};
    return oldFetch(input,options);
  };
  t.after(async()=>{
    globalThis.fetch=oldFetch;
    await new Promise(resolve=>ollama.close(resolve));
    await fs.rm(home,{recursive:true,force:true});
    if(formerHome===undefined)delete process.env.AEGIS_HOME;
    else process.env.AEGIS_HOME=formerHome;
  });
  const {saveSettings}=await import('../src/store.mjs');
  const {runTurn}=await import('../src/agent.mjs');
  await saveSettings({ollamaUrl:'http://127.0.0.1:'+ollama.address().port,autoReloadKev:false});
  const response=await runTurn("What's Apple's stock price?");
  assert.equal(response.action,'stock_quote');
  assert.match(response.response,/250\.25 USD/);
  assert.match(response.response,/Market timestamp/);
  assert.doesNotMatch(response.response,/look it up/i);
  assert.ok(!mockCalls.includes('/v1/systemone'),'Quote reads must not load Kev');
  assert.ok(!mockCalls.includes('/api/chat'),'The 3B must not generate a market quote');
});
