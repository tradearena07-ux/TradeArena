/* TradeArena · School content
 *
 * Single source of truth for the 6 lesson-based modules. Both schools.html
 * and lesson.html read from window.TArenaSchool. Admin overrides from the
 * `school_module_overrides` Supabase table are merged in at runtime and
 * win on a per-field basis (title, summary, reward, lessons[]).
 */
(function (global) {
  'use strict';

  const MODULES = [
    {
      key:    'm1',
      title:  'Stock Market Basics',
      summary:'Learn what stocks are, how exchanges match buyers and sellers, and the order types every new trader must know.',
      icon:   'fa-chart-simple',
      accent: '#e8c060',
      reward: 500,
      lessons: [
        { key:'m1l1', title:'What is a stock?', minutes:4, content:
`A stock (or share) is a small slice of ownership in a company. When Commonwealth Bank issues 1.7 billion shares and you own 100 of them, you own roughly one fifty-millionth of the bank — including your share of its future profits.

**Why companies issue stock.** Selling shares lets a company raise money without taking on debt. The buyers (you, super funds, institutions) become part-owners and the company gets cash to grow.

**How you make money from stocks.**
1. **Capital gains** — the share price rises and you sell for more than you paid.
2. **Dividends** — the company pays you a slice of profits each quarter or half-year.

**Why prices move.** A stock's price reflects the market's collective bet on what the company will be worth in the future. Earnings beats, new products, regulation, interest rate decisions, even rumours — all of it gets priced in within seconds.

**Common shares vs preferred shares.** Most stocks you trade on the ASX and US markets are *common* shares: one vote per share, last in line if the company goes bankrupt. *Preferred* shares trade more like bonds — fixed dividend, no vote, paid out before common holders in liquidation.

**Key takeaway.** A stock is not a lottery ticket — it is a fractional claim on a real business. Treat every ticker as if you were buying the company itself, because legally that is exactly what you are doing.` },
        { key:'m1l2', title:'How exchanges work', minutes:4, content:
`An exchange is a regulated marketplace where buyers and sellers meet. The two you'll touch most: the **ASX** (Australian Securities Exchange) and the **NYSE/NASDAQ** in the United States.

**The order book.** At every moment the exchange holds two stacks of orders for each stock:
- **Bids** — people willing to buy, sorted highest price first.
- **Asks (offers)** — people willing to sell, sorted lowest price first.

The highest bid and lowest ask are the *top of book*. The gap between them is the **spread** — wide spreads = illiquid stock = expensive to trade.

**Matching engine.** When a new order arrives, the exchange's matching engine pairs it against the opposite side of the book in **price-time priority**: best price wins, ties go to whoever queued first. If no match exists, the order rests in the book.

**Settlement.** When you buy a share on the ASX today (T), the actual ownership transfer happens on **T+2** — two business days later. US markets also operate on T+1 since 2024. TradeArena simulates instant settlement for learning purposes.

**Brokers.** You don't talk to the exchange directly — your broker (CommSec, Stake, Interactive Brokers, etc.) routes your order. They charge a fee per trade (or zero if they make money selling order flow).

**Key takeaway.** Every trade you place is matched against another human or algorithm willing to take the other side. Liquidity (how thick that book is) determines how easily you can get in and out.` },
        { key:'m1l3', title:'Reading a stock chart', minutes:5, content:
`A chart compresses thousands of trades into a picture. The most common view is a **candlestick chart**.

**Anatomy of a candle.** Each candle covers one time period — could be 1 minute, 1 hour, 1 day. It shows four prices:
- **Open** — first trade of the period.
- **Close** — last trade of the period.
- **High** — highest trade during the period.
- **Low** — lowest trade during the period.

If close > open, the candle body is **green** (or hollow). If close < open, the body is **red**. The thin lines above and below are the **wicks** — they mark the high and low.

**Volume bars.** Underneath the chart you'll usually see vertical bars showing how many shares traded each period. **Big volume = conviction.** A breakout on huge volume is meaningful; the same move on thin volume is suspect.

**Time frames.** Day traders watch 1 to 15 minute charts. Swing traders use 1 hour to daily. Long-term investors look at weekly or monthly. Always know which time frame you're on — patterns mean different things at different scales.

**Things to look for first.**
1. **Trend** — is the chart making higher highs and higher lows (uptrend), lower highs and lower lows (downtrend), or chopping sideways?
2. **Support/resistance** — flat horizontal levels where price has bounced or stalled multiple times.
3. **Volume** — is it rising into the move or fading?

**Key takeaway.** A chart is a record of every decision the market has already made. You're reading collective psychology in candle form.` },
        { key:'m1l4', title:'Market hours', minutes:3, content:
`Different exchanges open and close at different times. Knowing the schedule prevents you from placing orders into a closed market or missing the volatility window.

**ASX (Sydney).**
- **Pre-open**: 7:00–10:00 Sydney time. Orders queue but don't execute.
- **Opening auction**: 10:00–10:10 (staggered by ticker first letter).
- **Continuous trading**: 10:00 — 16:00.
- **Closing auction**: 16:10.

**NYSE & NASDAQ (New York).**
- **Pre-market**: 04:00–09:30 ET.
- **Regular session**: 09:30–16:00 ET.
- **After-hours**: 16:00–20:00 ET.
- In Sydney that's roughly **00:30–07:00 the next day** (varies with daylight saving on both sides).

**Crypto** trades 24/7/365. No opens, no closes, no holiday breaks.

**Forex** trades 24 hours, Monday morning Sydney to Friday evening New York. Liquidity peaks during the London/New York overlap (roughly 22:00–02:00 Sydney).

**Why timing matters.**
- The **first 30 minutes** and **last 30 minutes** of any session carry the most volume and the widest moves.
- News released **after the close** can gap the price violently when the market re-opens — your stop-loss won't save you from a gap.
- Daylight saving changes (Australia and US shift on different dates) move the US open in your local time twice a year.

**Key takeaway.** Trade the hours your strategy needs. Don't fight thin overnight liquidity unless you're hedging a real position.` },
        { key:'m1l5', title:'Order types', minutes:5, content:
`Choosing the right order type is half of execution. Here are the ones every trader uses.

**Market order.** "Buy/sell now at whatever price." Fills instantly but you accept whatever the order book offers — dangerous on illiquid stocks where the spread is wide.

**Limit order.** "Buy at $50 or lower" / "Sell at $52 or higher." You set the worst price you'll accept. Won't execute until someone hits your price. Trade-off: you may never fill.

**Stop-loss order.** Sits dormant until the price crosses a trigger, then fires as a market order. Used to cap losses: "If TSLA drops to $200, sell me out." Crucial: a stop fires at the trigger and then takes the next available bid — in a fast-moving stock that can be much worse than your trigger price.

**Stop-limit order.** Like stop-loss, but converts to a *limit* order instead of a market order at trigger. Safer (you control the exit price) but riskier (it might not fill at all if price gaps through).

**Trailing stop.** A stop that automatically moves up as the price rises (for longs). Locks in gains while letting winners run. Example: "trail by $2" — if price hits $50 then $55 then $60, the stop ratchets from $48 → $53 → $58.

**Good-Till-Cancelled (GTC) vs Day order.**
- **Day** — order dies at market close if unfilled.
- **GTC** — order persists until you cancel it (or your broker's max GTC window expires, usually 30–90 days).

**On TradeArena (paper).** All trades execute at the live mid-price the moment you confirm. Use this risk-free environment to drill the muscle memory: limit orders for entries, stop-losses on every position, no exceptions.

**Key takeaway.** Market orders for emergencies. Limit orders for everything else. Stops on every trade.` },
      ],
    },
    {
      key:    'm2',
      title:  'Crypto Fundamentals',
      summary:'Bitcoin, blockchain, and how trading crypto differs from trading equities. Built for the 24/7 market.',
      icon:   'fa-coins',
      accent: '#f7931a',
      reward: 500,
      lessons: [
        { key:'m2l1', title:'What is Bitcoin?', minutes:4, content:
`Bitcoin (BTC) is a digital currency invented in 2008 by an anonymous developer using the name **Satoshi Nakamoto**. It runs on a public, decentralised network — no bank, no government, no CEO controls it.

**The supply is fixed.** Only 21 million bitcoins will ever exist. New coins are issued to "miners" who maintain the network, and that issuance halves every four years (the **halving**). As of 2026 we're past the fourth halving and around 19.7 million BTC are in circulation.

**Why it has value.** Like gold, Bitcoin's value comes from scarcity, durability, divisibility, and the fact that enough people agree it's worth something. Unlike gold, you can send a billion dollars across the planet in 10 minutes for a few dollars in fees.

**How you actually own it.** Bitcoin lives on the blockchain, not in any company. Your *wallet* is just a pair of cryptographic keys: the public key receives funds, the private key signs transactions. **Lose the private key, lose the bitcoin — forever.** Exchanges (Coinbase, CoinSpot, Kraken) hold the keys for you, which is convenient but reintroduces counterparty risk.

**Why traders care.** BTC moves 3–5× more violently than equities. A 10% intra-day move is normal; 30% in a day has happened. That volatility is a magnet for traders and a wealth-destroyer for the unprepared.

**Key takeaway.** Bitcoin is a scarce, borderless, censorship-resistant digital asset. Treat it as a high-volatility commodity that trades 24/7, not as a "stock that goes up."` },
        { key:'m2l2', title:'Blockchain basics', minutes:4, content:
`A blockchain is a public ledger that is **append-only**, **distributed**, and **secured by cryptography**. Every Bitcoin or Ethereum transaction is permanently recorded on it.

**The structure.** Transactions are bundled into **blocks**. Each block contains a cryptographic hash of the previous block's contents, chaining them together. Change a single transaction in block 100 and every block after it becomes invalid — that's the tamper-evidence.

**Consensus.** Thousands of computers (nodes) keep their own copy of the chain. They agree on which version is "real" via a consensus rule:
- **Proof of Work** (Bitcoin) — miners burn electricity solving a puzzle. The first to solve it adds the next block and earns the block reward.
- **Proof of Stake** (Ethereum since 2022) — validators lock up capital ("stake"). Misbehave and you lose it.

**Public addresses.** A wallet address looks like \`bc1q...\` (Bitcoin) or \`0x...\` (Ethereum). Anyone can see the balance and full history of any address — blockchains are pseudonymous, not anonymous.

**Smart contracts.** Ethereum and similar chains let you deploy code that runs on the blockchain. This enables tokens (USDC, UNI), decentralised exchanges (Uniswap), lending protocols (Aave) — collectively called **DeFi**.

**Layer 2s.** Base chains are slow and expensive when busy. Layer 2s (Arbitrum, Optimism, Lightning Network) batch transactions off-chain and post a compact proof back to the base chain — much cheaper, much faster.

**Key takeaway.** A blockchain is a database that no single party owns. That property — and only that property — is what makes crypto different from a regular fintech app.` },
        { key:'m2l3', title:'Crypto vs stocks', minutes:4, content:
`Trading crypto looks similar to trading stocks — same charts, same order types — but the underlying asset behaves differently.

**Hours.** Crypto trades 24/7/365. Stocks trade 6.5 hours a day, 5 days a week. That means:
- News breaks any time. There's no "wait for the open."
- Weekend moves are real and you can't hedge them on the equity side.
- Liquidity dries up on Sunday afternoons (US time) — be careful with stops.

**Volatility.** A 5% daily move is normal in crypto, rare in blue-chip stocks. Position sizing must shrink accordingly: if you'd risk 2% of your account on Apple, risk 0.5% on Bitcoin.

**No earnings, no dividends.** Stocks have quarterly cash flows that anchor valuation. Crypto has nothing equivalent — the price is purely supply, demand, and narrative.

**Custody.** A stock lives at your broker who lives at the central depository. Crypto can live entirely under your control (self-custody) — that's powerful but means **you are the bank**, with no recourse if you mess up.

**Regulation.** Equities are heavily regulated by ASIC (AU) and the SEC (US). Crypto regulation is patchy and evolving — exchanges go bankrupt (FTX, Celsius), tokens get delisted, tax rules change. Treat regulatory risk as a permanent variable.

**Tax (Australia).** The ATO treats crypto as a CGT asset, just like shares. Every disposal — selling, swapping one coin for another, even paying for coffee in BTC — is a taxable event. Hold for 12+ months for the 50% CGT discount.

**Key takeaway.** Same tools, different beast. The market never sleeps, the swings are larger, and the responsibility for custody and tax compliance lands harder on you.` },
        { key:'m2l4', title:'Reading crypto charts', minutes:4, content:
`The candlestick mechanics from Module 1 carry over — but crypto charts have their own quirks.

**Common time frames.** Because crypto is 24/7, daily candles use UTC midnight as the boundary. Some traders prefer 4-hour or 1-hour candles which respect the round-the-clock flow better than daily.

**Volume profile.** Crypto volume is fragmented across dozens of exchanges. The volume bar on Binance won't match Coinbase. **Aggregated views** (CoinGecko, TradingView's "all exchanges") give a truer picture.

**Funding rates (perpetuals).** Perpetual futures dominate crypto trading. The **funding rate** is a periodic payment between longs and shorts that keeps the perpetual price tethered to spot. Persistently positive funding = crowded longs, mean-reversion risk; deeply negative funding = crowded shorts, often a bottom signal.

**Open interest.** The total dollar value of outstanding futures contracts. Rising OI + rising price = new longs being added (healthy uptrend). Rising OI + falling price = new shorts piling in (bearish). OI dropping while price moves = traders closing positions, momentum fading.

**Wicks matter more.** Crypto sees brutal **liquidation cascades**: a 5% move triggers leveraged stops, which cause more selling, which triggers more stops. Long lower wicks on big-volume candles often mark short-term capitulation lows.

**Cross-asset confirmation.** BTC dominance (BTC market cap / total crypto market cap) tells you regime: rising = "flight to safety inside crypto" (alts bleeding); falling = "alt season" (smaller coins outperforming).

**Key takeaway.** Read the same candles you learned in Module 1, but always check funding, OI and BTC dominance before sizing a crypto trade.` },
        { key:'m2l5', title:'Risk management', minutes:5, content:
`Crypto's volatility means risk management isn't optional — it's the entire game.

**Position sizing.** Decide what % of your account you're willing to lose on a single trade. **1% per trade is the industry standard for stocks; cut that to 0.25–0.5% for crypto.** Then work backwards:

> If your account is $100,000 and you're risking 0.5% ($500), and your stop is $2 below entry on an asset, you can buy 250 units.

**Stop losses are non-negotiable.** Set the stop *before* you enter, based on the chart (below structure, not at a round number). Move it to break-even once the trade is in profit. Never widen a stop in a losing trade — that's how 1% becomes 10%.

**Leverage is a doubled-edged razor.** Most crypto exchanges offer 10× to 100× leverage. At 50× a 2% adverse move wipes your collateral. **Beginners should trade spot (no leverage) for the first 6 months.** Later, never use more than 3×.

**Self-custody risk.** If you're holding crypto outside an exchange, your seed phrase is your account. Lose it = total loss, no support team. Store it offline, write it on metal if it's a meaningful amount.

**Counterparty risk.** Exchanges fail. FTX held billions of dollars of customer crypto and went to zero in 48 hours. **Don't keep more on any single exchange than you can afford to lose.** Withdraw long-term holdings to a hardware wallet (Ledger, Trezor).

**Tax risk.** Track every trade. Tools like Koinly or CoinTracker hook into Aussie exchanges and produce ATO-ready reports. Surprise tax bills are how good years turn bad.

**Key takeaway.** Win rate matters less than the size of your wins vs your losses, and your ability to keep showing up next month. Survive first, thrive second.` },
      ],
    },
    {
      key:    'm3',
      title:  'Technical Analysis',
      summary:'Candlesticks, support and resistance, moving averages, RSI and MACD — the core toolkit chart-based traders use.',
      icon:   'fa-chart-line',
      accent: '#60a5fa',
      reward: 1000,
      lessons: [
        { key:'m3l1', title:'Candlestick patterns', minutes:5, content:
`A single candle tells a story. Multi-candle patterns tell better ones. Here are the high-signal ones to memorise.

**Doji.** Open and close are nearly identical — the body is a thin line with wicks above and below. Indicates indecision. A doji at the top of an uptrend or bottom of a downtrend is a heads-up that the trend is losing steam.

**Hammer / hanging man.** Small body at the top, long lower wick (at least 2× body length). Buyers rejected lower prices.
- At the bottom of a downtrend = **hammer** (bullish reversal).
- At the top of an uptrend = **hanging man** (bearish warning, needs confirmation).

**Shooting star.** Inverse hammer — small body at the bottom, long upper wick. At a top, signals sellers rejected higher prices. Bearish.

**Bullish engulfing.** A red candle followed by a larger green candle that completely engulfs the red body. After a downtrend, this is a powerful reversal signal. **Bearish engulfing** is the mirror image at tops.

**Morning star.** Three-candle bottom: big red, small indecision candle (any colour), big green. Marks a clear capitulation and reversal. **Evening star** is the bearish version at tops.

**Three white soldiers / three black crows.** Three consecutive strong-bodied candles in the same direction with little wick. Continuation/momentum signal.

**Pattern hygiene.**
1. Patterns work best at significant levels (support, resistance, moving averages).
2. Volume should expand on the signal candle.
3. Wait for the *next* candle to confirm before entering.

**Key takeaway.** Candle patterns aren't magic — they're shorthand for the supply/demand fight that just played out. Use them to time entries near levels you'd already trade.` },
        { key:'m3l2', title:'Support & Resistance', minutes:5, content:
`Support and resistance are price levels where supply and demand have historically been imbalanced enough to stop a move.

**Support** is a price floor — buyers consistently step in and stop the decline. **Resistance** is a price ceiling — sellers consistently step in and stop the rally. These are not exact prices; treat them as zones (e.g. \`$182.40 ± $0.80\`).

**How to find them.**
1. Pull up the daily chart.
2. Look for prices where the chart has reversed *more than once*. Two touches = potential level. Three+ touches = strong level.
3. Mark **swing highs** (peaks) and **swing lows** (troughs). The clearer the previous reaction, the more important the level.

**Role reversal.** Once a resistance level breaks, it often becomes future support (and vice versa). The crowd that wanted to sell at $50 has now changed their mind — they'll buy any retest of $50 because they "missed it" the first time.

**Round numbers.** $100, $50, 1000 sats, 1.0000 in forex — humans cluster orders at psychological round numbers. They act as soft support/resistance whether or not the chart agrees.

**Volume profile.** Some platforms (TradingView Pro) show how much volume traded at each price. **High-volume nodes** are sticky levels (price tends to grind there). **Low-volume nodes** are vacuums (price flies through).

**Higher time frame wins.** A daily resistance is more important than a 15-minute resistance. When they overlap, the level is stronger.

**Trading the level.**
- **Bounce** play: enter near the level, stop just beyond it, target the next level.
- **Breakout** play: enter on confirmed close beyond the level with volume, stop just back inside it.

**Key takeaway.** Levels are where decisions get made. Always know which levels matter on the chart in front of you before you place a trade.` },
        { key:'m3l3', title:'Moving averages', minutes:4, content:
`A moving average smooths price into a single line so you can see the trend without the noise.

**Simple Moving Average (SMA).** Average of the last N closes. The 200-day SMA is the most-watched line in markets — institutions use it as the long-term trend filter.

**Exponential Moving Average (EMA).** Weighted to recent prices, so it reacts faster than the SMA. Day traders prefer the 9 and 21 EMA on intraday charts.

**The classic trio.**
- **20 EMA** — short-term trend.
- **50 SMA** — intermediate trend.
- **200 SMA** — long-term trend.

When price is **above all three and they're stacked in order (20 > 50 > 200)**, you're in a clean uptrend. Below all three and stacked the other way = downtrend. Tangled = chop.

**Crosses.**
- **Golden cross** — 50-day crosses above 200-day. Famous bullish long-term signal.
- **Death cross** — 50-day crosses below 200-day. Bearish.

These are slow, lagging signals — useful for regime context, useless for tactical entries.

**Dynamic support/resistance.** In a strong uptrend, price often pulls back to the 20 or 50 EMA and bounces. In a strong downtrend, the same MAs act as resistance on bounces. Mark the MA touch + a bullish candlestick pattern as a high-probability entry.

**MA slope matters more than MA value.** A flat 200 SMA = no trend, MAs won't help. A steeply rising 200 SMA = strong trend, MAs are reliable supports.

**Caution.** MAs are lagging by definition. They tell you what *was* happening. Don't expect predictive magic — pair MAs with structure (support/resistance) and momentum (RSI/MACD).

**Key takeaway.** MAs are your trend filter. Trade in the direction of the higher-time-frame MAs, look for entries on lower-time-frame MA touches.` },
        { key:'m3l4', title:'RSI indicator', minutes:4, content:
`The **Relative Strength Index** measures the speed and magnitude of recent price moves. It outputs a value from 0 to 100.

**Default settings.** 14 periods. Most platforms ship with this — leave it.

**Classic interpretation.**
- **Above 70** = overbought (price has rallied hard, due for a pause).
- **Below 30** = oversold (price has dumped hard, due for a bounce).
- **Around 50** = neutral.

**Why "overbought" doesn't mean "sell short".** A strong trend can keep RSI pinned above 70 for weeks. Selling every overbought print in a bull market is a fast way to bleed out. Treat 70/30 as **conditions**, not signals.

**Better uses.**

1. **Divergence.** Price makes a higher high, but RSI makes a *lower* high → bearish divergence (momentum is fading, the move is weakening). Mirror image for bullish divergence at lows. Divergences at major support/resistance are some of the highest-conviction reversal signals available.

2. **Range breaks.** In an uptrend, RSI usually oscillates between 40 and 80. In a downtrend, between 20 and 60. The first time RSI breaks the *opposite* range (e.g. drops to 30 in an uptrend), the trend is changing.

3. **Hidden divergence.** Price makes a higher *low*, RSI makes a lower low → continuation signal in an uptrend (the dip was bought aggressively).

**Time frame matters.** RSI on a 5-minute chart fires constantly and is mostly noise. RSI on the daily and weekly carries real signal.

**Combining.** RSI is most useful as confirmation — never as a standalone signal.
- Bullish setup: price at support + bullish candle + RSI bullish divergence.
- Bearish setup: price at resistance + bearish candle + RSI bearish divergence.

**Key takeaway.** RSI tells you whether momentum is accelerating, decelerating, or reversing. Use it for divergence and regime, not for "70 = sell."` },
        { key:'m3l5', title:'MACD indicator', minutes:5, content:
`The **Moving Average Convergence Divergence** is the de-facto trend-following momentum indicator. It has three components:

1. **MACD line** — the difference between the 12 EMA and 26 EMA.
2. **Signal line** — 9 EMA of the MACD line.
3. **Histogram** — MACD line minus signal line, displayed as bars above/below zero.

**Reading it.**

- **MACD above zero** = the 12 EMA is above the 26 EMA → short-term momentum is positive.
- **MACD below zero** = the inverse → short-term momentum is negative.
- **MACD crosses above signal line** = bullish momentum trigger.
- **MACD crosses below signal line** = bearish momentum trigger.
- **Histogram expanding** = momentum accelerating.
- **Histogram contracting** = momentum decelerating.

**The four high-quality setups.**

1. **Bullish cross above zero** — MACD crosses above the signal line while *both are above zero*. Strong continuation signal in an uptrend.
2. **Bearish cross below zero** — mirror image in a downtrend.
3. **Zero-line cross** — MACD line crosses zero. Slower than the signal-line cross but a clearer regime change.
4. **MACD divergence** — same logic as RSI divergence. Higher highs in price + lower highs in MACD = waning momentum, reversal warning.

**Common mistakes.**
- Trading every signal-line cross. Most of them are noise, especially in choppy markets where MACD whipsaws around zero.
- Using MACD on tiny time frames. Like RSI, the indicator is far more reliable on 4-hour, daily and weekly charts.
- Treating MACD as a system. It's a confirmation tool. Pair it with structure (S/R, MAs) and price action (candles).

**MACD vs RSI.** RSI measures *velocity* (how fast). MACD measures *trend* (which way and how strong). They complement each other — many traders show both on the same chart.

**Key takeaway.** MACD is your momentum + trend gauge. Trade in the direction of the histogram, weight setups higher when crosses happen on the same side of zero as your trend.` },
      ],
    },
    {
      key:    'm4',
      title:  'ASX Deep Dive',
      summary:'How the Australian Securities Exchange works, the heavyweight stocks that move it, and franking credits.',
      icon:   'fa-building-columns',
      accent: '#00a651',
      reward: 500,
      lessons: [
        { key:'m4l1', title:'How the ASX works', minutes:4, content:
`The **Australian Securities Exchange** is the primary stock exchange in Australia, headquartered in Sydney. Around 2,200 companies are listed with a combined market cap of roughly **A$2.6 trillion** (2026).

**Tickers.** ASX uses 3-letter codes: \`CBA\` (Commonwealth Bank), \`BHP\` (BHP Group), \`CSL\` (CSL Limited). Some have a 4th letter for warrants or preference shares.

**Indices.**
- **S&P/ASX 200** — the headline benchmark, top 200 companies by free-float market cap. About 80% of total market value.
- **S&P/ASX 300** — adds 100 smaller names.
- **All Ordinaries** — top 500, the legacy index that pre-dates the ASX 200.

**Market structure.** ASX runs continuous matching from 10:00 to 16:00 Sydney time, plus opening and closing auctions. Settlement is **T+2** through CHESS (Clearing House Electronic Subregister System) — though ASX is mid-way through replacing CHESS with a new platform.

**ASX vs Cboe Australia.** Since 2011 there's a second exchange (originally Chi-X, now Cboe Australia) where the same ASX-listed shares can also trade. Most retail brokers route to whichever venue has the best price. Combined volumes count.

**Sector mix.** The ASX is heavily concentrated in **financials** (~28%) and **materials/mining** (~22%). That makes the index extremely sensitive to commodity prices (iron ore, copper, lithium) and to credit conditions for the big four banks.

**Trading costs.** Brokerage on ASX is typically $5–$10 flat per trade at low-cost brokers (Stake, Pearler, CommSec Pocket), or 0.10%–0.50% at full-service brokers. Stamp duty was abolished decades ago.

**Key takeaway.** ASX is your home market: smaller and more concentrated than the US, but the rules are tight, settlement is reliable, and you trade in your own time zone.` },
        { key:'m4l2', title:'Top ASX stocks', minutes:4, content:
`The ASX 200 is dominated by a small handful of names. Knowing them is mandatory.

**The big four banks.**
- **CBA** (Commonwealth Bank) — largest stock in the index by some margin.
- **WBC** (Westpac), **NAB** (National Australia Bank), **ANZ** (ANZ Group).

Banks together are roughly 25% of the ASX 200. They pay reliable, fully-franked dividends. Their share prices are driven by the RBA cash rate, mortgage growth, and bad-debt cycles.

**The miners.**
- **BHP** — diversified mega-miner: iron ore, copper, coal. The single biggest stock outside CBA.
- **RIO** (Rio Tinto) — iron ore and copper.
- **FMG** (Fortescue) — pure-play iron ore.
- **NCM/NEM** (Newcrest, since merged with Newmont) — gold.

Miners swing on commodity prices. Iron ore especially is the swing factor — China's steel demand drives BHP, RIO, FMG simultaneously.

**Healthcare giants.**
- **CSL** — global blood plasma and vaccines. Often described as the ASX's best long-term compounder.
- **RMD** (ResMed) — sleep apnea devices.
- **COL/WOW** are not healthcare, those are…

**Supermarkets.**
- **WOW** (Woolworths), **COL** (Coles). Defensive, slow-growing, dividend-paying.

**Telcos & energy.**
- **TLS** (Telstra) — telecom.
- **WDS** (Woodside Energy), **STO** (Santos) — oil and gas.

**Tech (small but growing).**
- **WTC** (WiseTech), **XRO** (Xero), **NXT** (NextDC).

**The "Big 4 banks + BHP + CSL"** rule of thumb: those 6 stocks alone are roughly 40% of the ASX 200. When they move, the index moves.

**Key takeaway.** The ASX is concentrated. If you trade the index, you're really trading banks, miners, and CSL. Understand those three engines and you understand the market.` },
        { key:'m4l3', title:'Australian market hours', minutes:3, content:
`The ASX trading day is shorter than US markets. Knowing the schedule prevents missed fills and stale stops.

**Pre-open: 7:00 – 10:00 Sydney.**
Orders can be entered, modified, cancelled. Nothing trades. The opening auction will use these orders to set the open price.

**Opening auction: ~10:00 – 10:10.**
ASX staggers opens by ticker first letter to spread system load:
- 10:00:00 — A and B
- 10:02:15 — C
- 10:04:30 — D, E, F, G, H, I
- 10:06:45 — J, K, L, M, N, O, P, Q, R
- 10:09:00 — S, T, U, V, W, X, Y, Z

**Continuous trading: 10:10 – 16:00.**
The bulk of volume happens here. The first 30 minutes after the open and the last 30 minutes before the close are the most volatile and liquid.

**Pre-close auction: 16:00 – 16:10.**
Orders queue. The closing match runs at a randomised time within \~16:10:00 – 16:10:15 to prevent gaming. The closing auction sets the official close price used by index funds and ETFs.

**After-hours: 16:10 – 17:00 (limited).**
Some brokers offer after-hours dealing on a "last traded" basis. Volume is thin and spreads are wide.

**Holidays.** ASX closes on NSW public holidays: New Year's Day, Australia Day, Good Friday, Easter Monday, Anzac Day, Queen's/King's Birthday, Christmas Day, Boxing Day. Half-day closes on Christmas Eve and New Year's Eve.

**Daylight saving.** Sydney shifts in October and April. The opening time stays at 10:00 *Sydney local*, but the equivalent time in Perth, Brisbane, and overseas markets shifts.

**Key takeaway.** Plan around the staggered open if you trade letter A–F vs S–Z. Lean into the open and close for liquidity. Don't bother with after-hours unless you know exactly why.` },
        { key:'m4l4', title:'Franking credits', minutes:5, content:
`Franking credits are a uniquely Australian feature that materially boost the after-tax return of holding ASX dividend stocks. Every Aussie trader needs to understand them.

**The problem they solve.** A company earns profit, pays 30% corporate tax, then distributes the after-tax profit to shareholders as dividends. Without franking, that dividend would be taxed *again* in the shareholder's hands — double tax on the same dollar.

**The solution.** When an Aussie company has already paid corporate tax, the dividend is **fully franked**. Each dollar of fully franked dividend comes with a franking credit equal to ~42.86 cents (the tax already paid by the company on that dollar of earnings).

**Worked example.**
- CBA pays you a $1.00 fully franked dividend.
- You also receive a franking credit of $0.4286.
- Your **grossed-up income** is $1.4286.
- You pay tax on $1.4286 at your marginal rate, then *subtract* the $0.4286 credit from your tax bill.

If your marginal tax rate is **30%**, the franking credit exactly offsets the tax — net cost is zero.
If your marginal tax rate is **45%**, you owe an extra ~21 cents.
If your marginal tax rate is **0%** (super in pension phase), the ATO **refunds** you the $0.4286 in cash.

**Partially franked / unfranked.** Dividends from companies with overseas earnings (BHP, CSL, Macquarie) are often only partially franked — only the Australian-tax-paid portion carries credits. International stocks pay zero franking.

**Why it matters for trading.**
- The **45-day rule**: you must hold the shares "at risk" for at least 45 days around the ex-dividend date to claim the franking credits.
- The dividend yield quoted on ASX websites is the **cash yield**. The **grossed-up yield** (cash + franking) is the real after-tax comparison metric — usually 1.4× the headline figure for fully franked stocks.

**Why it matters for SMSFs and retirees.** A super fund in pension phase pays 0% tax. Franking credits are paid out as cash refunds — historically worth tens of billions a year nationally.

**Key takeaway.** Two stocks with the same dividend yield are not equal. A 5% fully franked yield is worth ~7.1% grossed up — far more attractive than a 5% unfranked international payer for an Aussie investor.` },
      ],
    },
    {
      key:    'm5',
      title:  'Trading Psychology',
      summary:'The four ways your own brain blows up trades — and the simple habits that keep emotion off the keyboard.',
      icon:   'fa-brain',
      accent: '#a855f7',
      reward: 500,
      lessons: [
        { key:'m5l1', title:'FOMO vs strategy', minutes:4, content:
`**Fear Of Missing Out** is the single biggest destroyer of new traders' accounts. It feels like opportunity. It is almost always a trap.

**The pattern.** A stock or coin runs 30% in a day. Twitter and Discord are screaming about it. You don't have a position. You feel stupid for missing it. You buy at the top because "it's going higher." It rolls over. You hold because you "believe in it." You sell two weeks later 40% down.

**Why it happens.** The brain interprets price going up without you as *loss*. Loss aversion (next lesson) kicks in. The trade you're chasing isn't a setup — it's a salve for an emotion.

**The cost.** A FOMO entry has terrible asymmetry: you're buying at the top of a momentum move with no clear stop and no clear target. Your maximum upside is small (the move is mostly done). Your downside is unlimited (the unwind can be brutal).

**The fix.**

1. **Have a written plan.** Define your edge — the specific setup you trade. If a move doesn't match the setup, you don't trade it. Period.
2. **Pre-define entries.** Use limit orders at the levels *you* identified, not market orders at whatever price you panic-clicked.
3. **Wait for the next setup.** Markets serve up dozens of opportunities every week. Missing one is irrelevant; chasing one can end your account.
4. **Use a "missed it" rule.** If you weren't in the trade by the time you noticed it on Twitter, it's no longer a trade — it's news. Move on.

**The mindset shift.** Successful traders are *bored* most of the time. They wait for high-probability setups, execute mechanically, and ignore everything else. Boredom is not failure — it's discipline.

**Key takeaway.** The trade you didn't take cannot lose you money. The trade you chased can lose you everything. Stay in your lane.` },
        { key:'m5l2', title:'Loss aversion', minutes:4, content:
`Daniel Kahneman won the Nobel Prize for showing that humans feel a $100 loss roughly **2× more painfully** than a $100 gain. This asymmetry destroys traders.

**How it shows up.**

1. **Cutting winners early.** A trade goes 1% in your favour and you immediately want to lock it in — because losing the unrealised gain feels like a loss. You sell. The trade goes 5% further without you.

2. **Letting losers run.** A trade goes 1% against you. Selling means *realising* the loss, which feels final. You hold. It goes 5% against you. You can't sell now — you'd be locking in a "big loss." You hold. It bottoms 30% down.

3. **Doubling down on losers.** Adding to a losing position feels like you're "averaging in." It is actually the opposite of what works — you're throwing capital at a thesis the market is rejecting.

4. **Revenge trading.** You take a loss, feel furious, want to "get it back." You enter the next trade with double size and zero plan. Disaster.

**The fix.**

1. **Decide the exit before you enter.** Both the stop and the target. Write them down. The trade has *one* outcome — hit the stop or hit the target. Either is a successful execution.

2. **Risk fixed, not size.** Always risk the same dollar amount per trade (e.g. 1% of account). When the chart says the stop is far, your size shrinks. When the stop is tight, your size grows. The pain of any single loss is the same — your brain learns to tolerate it.

3. **Move stops only one direction.** Up for longs, down for shorts. Never widen a stop. If the chart invalidates your thesis, *that* is information — accept it.

4. **Take a forced break after a loss.** 10 minutes minimum. Long enough to break the revenge-trade reflex.

**Key takeaway.** Your brain is wired to do the wrong thing under stress. The job of a trading process is to make decisions *for* you when you can't trust yourself to make them.` },
        { key:'m5l3', title:'Setting stop losses', minutes:5, content:
`A stop loss is a pre-decided exit price that caps your downside. Trading without one is gambling.

**Why every trade needs one.**

- It enforces position sizing. Without a stop you don't know how much you're risking.
- It removes the "should I sell?" decision under stress — the decision was already made.
- It survives bad news. A 30% gap-down on earnings can't ask you "are you sure?"

**Where to place it.**

The wrong way: round numbers, percentage of price, or "however much I can stomach." All of these have nothing to do with what the market is actually doing.

The right way: **at a level that invalidates your trade thesis.** Examples:

- You bought because price held the 50-day MA. Stop = a daily close below the 50-day MA.
- You bought because price broke resistance at $50 with volume. Stop = a close back below $50.
- You bought a bullish engulfing candle. Stop = below the low of that candle.

The stop should answer: "If price gets here, I was *wrong* about the setup." Not "if price gets here, I'm uncomfortable."

**Position size from the stop.**

1. Decide your dollar risk per trade (e.g. 1% of account = $1,000).
2. Find the stop level on the chart based on your thesis.
3. Calculate the per-share risk (entry price − stop price).
4. Position size = $1,000 ÷ per-share risk.

**Stop varieties.**

- **Hard stop** (resting order in the market) — protects you from being away from the screen, but visible to the market in some venues.
- **Mental stop** — you watch and execute manually. Only works if you're disciplined and at the screen. Most traders fail this.
- **Trailing stop** — moves up with price to lock in gains.

**Common mistakes.**
- Placing stops at obvious round numbers (everyone else's stops are there too — that's where price gets "hunted").
- Moving stops further away to avoid being hit.
- Cancelling the stop because you "feel" the trade will come back.

**Key takeaway.** A stop loss is the price the market would have to print to prove you wrong. Place it there, size accordingly, and *do not move it*.` },
        { key:'m5l4', title:'Trading journal', minutes:4, content:
`Top traders all keep a journal. The goal isn't to write a diary — it's to build a feedback loop your gut alone cannot give you.

**What to log per trade.**

1. **Date / time** — entry and exit.
2. **Ticker** + **direction** (long/short).
3. **Setup** — the named pattern from your playbook (e.g. "MA pullback," "breakout retest," "RSI divergence").
4. **Entry price**, **stop**, **target**.
5. **Position size** (dollar risk, not just share count).
6. **Outcome** — exit price, P&L in $ and R-multiples (R = risk you took).
7. **Screenshot** — the chart at entry and at exit.
8. **One sentence on emotional state** at entry — "calm and waiting" vs "anxious, chasing."

**What to review weekly.**

- **Win rate** by setup. Which setups actually make you money? Cut the others.
- **Average winner vs average loser** in R-multiples. A 2R average winner with a 1R average loser at 40% win rate is profitable.
- **Time-of-day** P&L. Many traders make money in the first hour and give it back after lunch. Find your edge window.
- **Mistake count.** Did you take trades not on your playbook? Move stops? Skip stops? Tag and total them.

**What to review monthly.**

- The single biggest winner: was it luck or process?
- The single biggest loser: was it a known mistake or a black swan?
- The trades you *didn't* take but should have: pattern out the hesitation.

**Tools.** Notion, Excel, Google Sheets, or a dedicated app like Edgewonk or Tradervue. The tool doesn't matter — the consistency does.

**Why it works.** Memory is selective: you remember the wins, you forget the losses, you misremember why you took a trade. A journal is the receipts. Six months in you'll spot patterns about your own behaviour you'd never see otherwise.

**Key takeaway.** The traders who survive 5+ years all journal. It's not optional — it's the cheapest edge available.` },
        ],
    },
    {
      key:    'm6',
      title:  'Portfolio Strategy',
      summary:'Diversification, dollar-cost averaging, rebalancing, and choosing between long-term and short-term horizons.',
      icon:   'fa-briefcase',
      accent: '#10b981',
      reward: 1000,
      lessons: [
        { key:'m6l1', title:'Diversification', minutes:4, content:
`Diversification is the only free lunch in finance. Spreading capital across uncorrelated assets reduces total portfolio risk without proportionally reducing return.

**Why it works.** If two assets each have 20% volatility but their returns are uncorrelated, a 50/50 portfolio has roughly 14% volatility — the same expected return for less drawdown. Combine 10+ uncorrelated assets and the volatility math gets even better.

**What "uncorrelated" actually means.** During the 2008 GFC, most equities crashed together. During COVID 2020, equities AND bonds AND gold sold off in the same week. Correlation is not constant — it spikes to 1.0 in panics, exactly when you need diversification most. Building a "diversified" portfolio of 10 ASX bank stocks isn't diversified — they all move together.

**Layers of diversification.**

1. **Across stocks** — at minimum 15–25 individual names if you're picking, otherwise an ETF.
2. **Across sectors** — banks, miners, healthcare, tech, consumer staples.
3. **Across geographies** — ASX, US, emerging markets. Different rate cycles, different currencies.
4. **Across asset classes** — equities, bonds, gold, real estate (REITs), crypto, cash.

**The simplest diversified portfolio.** Three ETFs:
- 50% global equities (e.g. \`VGS\` for developed markets ex-Aus, \`VAS\` for ASX 300).
- 30% bonds (\`VGB\` Aussie government, \`VIF\` international).
- 20% defensive — gold, REITs, cash.

That's it. Most retail "stock pickers" underperform this for decades.

**When NOT to diversify.** If you have a genuine edge (a defined trading strategy with positive expected value), concentrate capital where the edge is. Diversification reduces noise but it also caps upside. Pick one approach per bucket of capital.

**Key takeaway.** For long-term wealth: diversify aggressively. For active trading: concentrate around your edge. Never confuse the two buckets.` },
        { key:'m6l2', title:'Dollar Cost Averaging', minutes:4, content:
`**Dollar Cost Averaging** is the practice of investing a fixed dollar amount on a fixed schedule, regardless of price. Boring. Effective.

**How it works.** $1,000 a month into VAS:
- Month 1: VAS at $90 → 11.11 units.
- Month 2: VAS at $85 → 11.76 units.
- Month 3: VAS at $95 → 10.53 units.
- Month 4: VAS at $80 → 12.50 units.

You bought *more* units when price was low and *fewer* when price was high. Over time your average cost is below the simple average price.

**Why it beats lump-sum (sometimes).** Mathematically, lump-sum investing wins about two-thirds of the time over long periods because markets trend up. But DCA wins on the metric that actually matters for most humans: **psychological survival**. You don't dump $50,000 into the market the day before a 30% crash and quit forever.

**Why it works for accumulation.**

- **Removes timing decisions.** No "should I wait for a dip?" — you buy on the schedule.
- **Smooths volatility.** The same $1,000 in a 20%-down market buys 20% more units.
- **Compounds with salary.** It maps naturally to monthly pay cycles.
- **Eliminates regret.** You bought at the top? You'll buy more next month at the bottom.

**Where it fails.**

- **In a sustained downtrend.** DCA-ing into a stock that goes from $100 to $10 over five years is a slow bleed. DCA only works on assets you genuinely believe will be higher in 10 years (broad index ETFs typically qualify; individual stocks often don't).
- **Vs lump sum in clear bull market.** If you have $50,000 today and the market is in a confirmed uptrend, drip-feeding it over a year mathematically loses to investing it now.

**The hybrid.** Many traders do both: lump-sum the bulk into a diversified core, DCA the rest as monthly contributions, and keep a separate trading account for active strategies.

**Key takeaway.** DCA is the simplest, most reliable wealth-building strategy ever discovered. Set it up once with auto-debit, review annually, otherwise leave it alone.` },
        { key:'m6l3', title:'Rebalancing', minutes:4, content:
`Rebalancing is selling a slice of what's gone up and buying a slice of what's gone down to bring your portfolio back to your target weights.

**Why it matters.** Suppose you set a 60% stocks / 40% bonds target. Stocks rip 30% over a year, bonds are flat. Now your portfolio is 68% stocks / 32% bonds — you're taking more risk than you signed up for. A bear market here hurts twice as much.

**How to do it.**

**Calendar-based:** Pick a date (1 January, end of financial year, etc.) and rebalance to target weights. Simple, predictable, tax-aware.

**Threshold-based:** Rebalance whenever any asset class drifts more than X% from target (typically 5%). Triggers more often in volatile markets, less often in calm ones — captures more of the rebalancing premium.

**Mechanics.**

1. Calculate current weights.
2. Identify which asset is overweight (sell some) and which is underweight (buy more).
3. Place the trades. Use limit orders to control execution.

**Tax-efficient rebalancing.** Selling crystallises capital gains. Strategies to minimise tax drag:

- **Use new contributions.** Direct your monthly DCA into the underweight asset instead of selling the overweight one.
- **Rebalance inside super.** Internal switches don't trigger CGT.
- **Hold > 12 months.** The 50% CGT discount applies to assets held more than a year — wait if you're close.
- **Tax-loss harvesting.** If something is at a loss, selling locks in the loss to offset other gains. Then buy back a *similar but not identical* asset to preserve exposure (don't trigger the wash sale rule).

**Why people don't do it.** Selling winners feels wrong. Buying laggards feels worse. Behavioural friction is the #1 reason real investors underperform their own strategy.

**Automation.** Most retail platforms now offer auto-rebalancing on diversified portfolios. Use it. Removes the emotion.

**Key takeaway.** Rebalancing is mechanical "buy low, sell high" — done quarterly or annually it's worth ~0.5%/year over 30 years vs never rebalancing. Not glamorous; meaningful.` },
        { key:'m6l4', title:'Long vs short term', minutes:5, content:
`Every dollar in your portfolio should have a defined time horizon. Mixing horizons is the #1 way investors lose money — they treat long-term capital as trading capital and trading capital as long-term capital.

**The three buckets.**

**1. Cash bucket (0–6 months).**
- Emergency fund.
- Money you'll need for rent, tuition, holidays.
- Held in a high-interest savings account (\~4–5% in 2026).
- **Never invest this in stocks.** A 30% drawdown the week before you need it = disaster.

**2. Long-term bucket (5+ years).**
- Wealth-building. Retirement. House deposit if 5+ years out.
- Diversified ETFs, DCA monthly, rebalance annually.
- **Don't check it more than quarterly.** The volatility is meaningless on this time scale.
- Tax structure matters: super, joint accounts, family trusts.

**3. Trading bucket (0–6 months horizon, "play money").**
- Active trading, individual stocks, crypto, options.
- **Cap it at 5–10% of total investable wealth.** A 100% loss must be survivable.
- Treat it as a separate business with its own P&L, journal, and rules.

**Why mixing buckets blows up.**

- "I'll invest the house deposit in the index for a year" — a 2022-style 25% drawdown wipes 18 months of saving.
- "This trade is going against me, I'll just hold it long term" — turning a 5% trading loss into a 50% bag-hold.
- "I'll borrow against my long-term portfolio to buy crypto" — leverage on top of leverage at the worst possible time.

**Tax matters by horizon.**

- **Short-term trades** (held < 12 months) are taxed at your full marginal rate.
- **Long-term holds** (held ≥ 12 months) get the 50% CGT discount in Australia.
- The tax difference alone can be \~10–15% of the gain — it pays to know which bucket you're in *before* you sell.

**The progression.**

- Year 1: Cash bucket fully funded (3–6 months expenses) before anything else.
- Year 2: Long-term bucket DCA started (\$X every payday).
- Year 3+: Optional trading bucket once the first two are stable.

**Key takeaway.** Define the horizon for every dollar. Match the strategy to the horizon. Never let one bucket spill into another in either direction.` },
      ],
    },
  ];

  // ----- Public API -------------------------------------------------------
  function lessonOf(moduleKey, lessonKey) {
    const m = MODULES.find(x => x.key === moduleKey);
    if (!m) return null;
    return m.lessons.find(l => l.key === lessonKey) || null;
  }
  function moduleOf(moduleKey) {
    return MODULES.find(x => x.key === moduleKey) || null;
  }
  function applyOverrides(overrides) {
    // overrides: array of {module_key, title, summary, reward_amount, lessons}
    if (!Array.isArray(overrides) || !overrides.length) return MODULES;
    const map = Object.fromEntries(overrides.map(o => [o.module_key, o]));
    return MODULES.map(m => {
      const o = map[m.key];
      if (!o) return m;
      return {
        ...m,
        title:   o.title    || m.title,
        summary: o.summary  || m.summary,
        reward:  Number.isFinite(o.reward_amount) ? o.reward_amount : m.reward,
        lessons: Array.isArray(o.lessons) && o.lessons.length
                  ? o.lessons.map((l, i) => ({
                      key:     l.key || `${m.key}l${i+1}`,
                      title:   l.title || `Lesson ${i+1}`,
                      content: l.content || '',
                      minutes: Number.isFinite(l.minutes) ? l.minutes : 4,
                    }))
                  : m.lessons,
      };
    });
  }

  global.TArenaSchool = {
    MODULES,
    moduleOf,
    lessonOf,
    applyOverrides,
  };
})(window);
