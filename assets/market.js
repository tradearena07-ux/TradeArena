// TradeArena — mock market data + price simulator
(function (global) {
  const data = [
    // ASX
    { symbol: 'BHP.AX', name: 'BHP Group',          market: 'asx',    price: 43.82,  change: 2.02,  mcap: '$210B',  vol: '8.4M',  high52: 48.90,  low52: 39.20,  tv: 'ASX:BHP' },
    { symbol: 'CBA.AX', name: 'Commonwealth Bank',  market: 'asx',    price: 145.30, change: -0.45, mcap: '$245B',  vol: '2.1M',  high52: 152.10, low52: 122.80, tv: 'ASX:CBA' },
    { symbol: 'RIO.AX', name: 'Rio Tinto',          market: 'asx',    price: 118.90, change: 1.88,  mcap: '$184B',  vol: '3.2M',  high52: 128.50, low52: 101.20, tv: 'ASX:RIO' },
    { symbol: 'CSL.AX', name: 'CSL Limited',        market: 'asx',    price: 312.45, change: 0.92,  mcap: '$150B',  vol: '620K',  high52: 325.40, low52: 268.30, tv: 'ASX:CSL' },
    { symbol: 'WBC.AX', name: 'Westpac Banking',    market: 'asx',    price: 31.20,  change: -1.12, mcap: '$108B',  vol: '5.4M',  high52: 34.10,  low52: 25.80,  tv: 'ASX:WBC' },
    { symbol: 'MQG.AX', name: 'Macquarie Group',    market: 'asx',    price: 212.80, change: 4.12,  mcap: '$80B',   vol: '980K',  high52: 225.60, low52: 170.40, tv: 'ASX:MQG' },
    { symbol: 'WDS.AX', name: 'Woodside Energy',    market: 'asx',    price: 24.15,  change: -1.80, mcap: '$45B',   vol: '4.3M',  high52: 31.20,  low52: 23.10,  tv: 'ASX:WDS' },
    { symbol: 'FMG.AX', name: 'Fortescue Metals',   market: 'asx',    price: 18.45,  change: 3.20,  mcap: '$56B',   vol: '6.1M',  high52: 27.80,  low52: 17.20,  tv: 'ASX:FMG' },
    // US
    { symbol: 'AAPL',   name: 'Apple Inc.',         market: 'us',     price: 228.40, change: 1.34,  mcap: '$3.5T',  vol: '52M',   high52: 237.20, low52: 164.10, tv: 'NASDAQ:AAPL' },
    { symbol: 'NVDA',   name: 'NVIDIA Corp.',       market: 'us',     price: 142.60, change: 3.42,  mcap: '$3.4T',  vol: '120M',  high52: 153.10, low52: 80.20,  tv: 'NASDAQ:NVDA' },
    { symbol: 'TSLA',   name: 'Tesla Inc.',         market: 'us',     price: 248.10, change: -2.10, mcap: '$790B',  vol: '85M',   high52: 298.40, low52: 138.80, tv: 'NASDAQ:TSLA' },
    { symbol: 'MSFT',   name: 'Microsoft Corp.',    market: 'us',     price: 421.50, change: 0.78,  mcap: '$3.1T',  vol: '22M',   high52: 468.20, low52: 380.50, tv: 'NASDAQ:MSFT' },
    // Crypto
    { symbol: 'BTC',    name: 'Bitcoin',            market: 'crypto', price: 64320,  change: 3.81,  mcap: '$1.27T', vol: '$28B',  high52: 73500,  low52: 38500,  tv: 'BINANCE:BTCUSDT' },
    { symbol: 'ETH',    name: 'Ethereum',           market: 'crypto', price: 3245,   change: 2.14,  mcap: '$390B',  vol: '$15B',  high52: 4090,   low52: 2100,   tv: 'BINANCE:ETHUSDT' },
    { symbol: 'SOL',    name: 'Solana',             market: 'crypto', price: 182.40, change: 5.62,  mcap: '$84B',   vol: '$3B',   high52: 208.60, low52: 79.40,  tv: 'BINANCE:SOLUSDT' },
  ];

  function find(symbol) { return data.find(d => d.symbol === symbol); }
  function byMarket(m)  { return m === 'all' ? data.slice() : data.filter(d => d.market === m); }

  function tick() {
    data.forEach(d => {
      const drift = (Math.random() - 0.5) * (d.price * 0.004);
      const newP = Math.max(0.01, d.price + drift);
      d.price = +newP.toFixed(d.price > 1000 ? 0 : 2);
      d.change = +(d.change + (Math.random() - 0.5) * 0.3).toFixed(2);
    });
  }

  // Mock holdings (shared between trade + portfolio)
  const holdings = [
    { symbol: 'BHP.AX', qty: 420,  avgCost: 41.20,  type: 'asx' },
    { symbol: 'CBA.AX', qty: 85,   avgCost: 148.10, type: 'asx' },
    { symbol: 'BTC',    qty: 0.12, avgCost: 52000,  type: 'crypto' },
    { symbol: 'AAPL',   qty: 28,   avgCost: 210,    type: 'us' },
    { symbol: 'RIO.AX', qty: 65,   avgCost: 112,    type: 'asx' },
    { symbol: 'MQG.AX', qty: 22,   avgCost: 198,    type: 'asx' },
    { symbol: 'CSL.AX', qty: 12,   avgCost: 305,    type: 'asx' },
  ];

  function holdingValue(h) {
    const m = find(h.symbol);
    const cur = m ? m.price : h.avgCost;
    const value = h.qty * cur;
    const cost = h.qty * h.avgCost;
    return { current: cur, value, pnl: value - cost, pnlPct: ((value - cost) / cost) * 100, name: m ? m.name : h.symbol };
  }
  function totalValue() { return holdings.reduce((s, h) => s + holdingValue(h).value, 0); }
  function totalCost()  { return holdings.reduce((s, h) => s + h.qty * h.avgCost, 0); }
  function totalPnl()   { return totalValue() - totalCost(); }

  // Default watchlist (persisted to localStorage)
  function getWatchlist() {
    try {
      const stored = JSON.parse(localStorage.getItem('tarena_watchlist') || 'null');
      if (Array.isArray(stored) && stored.length) return stored;
    } catch (e) {}
    return ['BHP.AX', 'CBA.AX', 'MQG.AX', 'WDS.AX', 'BTC', 'ETH'];
  }
  function setWatchlist(arr) { localStorage.setItem('tarena_watchlist', JSON.stringify(arr)); }

  // Orders (simple log)
  function getOrders() {
    try { return JSON.parse(localStorage.getItem('tarena_orders') || '[]'); } catch (e) { return []; }
  }
  function placeOrder(o) {
    const orders = getOrders();
    orders.unshift(Object.assign({ ts: Date.now() }, o));
    localStorage.setItem('tarena_orders', JSON.stringify(orders.slice(0, 50)));
  }

  global.TArenaMarket = {
    data, find, byMarket, tick,
    holdings, holdingValue, totalValue, totalPnl, totalCost,
    getWatchlist, setWatchlist, getOrders, placeOrder,
  };
})(window);
