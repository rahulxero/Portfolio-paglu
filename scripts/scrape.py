#!/usr/bin/env python3
"""
Build the dataset for the Top 25 board.

Two sources, because neither one has everything:

  companiesmarketcap.com  -> the ranking, market cap, earnings (TTM), revenue (TTM),
                             country of origin, and the company logo
  Yahoo Finance           -> forward P/E and dividend yield, which companiesmarketcap
                             does not publish at all

Writes alpha.json at the repo root, which the Alpha tab in index.html fetches.
Logos are downloaded into logos/ so the page doesn't hotlink them.

Usage:
    pip install requests beautifulsoup4 yfinance
    python scripts/scrape.py
    git add alpha.json logos && git commit -m "alpha: refresh" && git push
"""

import json
import os
import re
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

BASE = "https://companiesmarketcap.com"
TOP_N = 25
# Repo root — alpha.json is served as a static file by Vercel, and index.html
# fetches it from /alpha.json. Logos go alongside it so /logos/NVDA.png resolves.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = REPO_ROOT
LOGO_DIR = os.path.join(REPO_ROOT, "logos")

# Be a polite scraper: identify yourself, don't hammer the server.
SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "top25-board/1.0 (personal dashboard; contact: you@example.com)",
    "Accept-Language": "en-US,en;q=0.9",
})
DELAY = 2.0  # seconds between requests to companiesmarketcap

PAGES = {
    "market_cap": f"{BASE}/",
    "earnings":   f"{BASE}/most-profitable-companies/",
    "revenue":    f"{BASE}/largest-companies-by-revenue/",
}

# "$5.456 T" / "$965.21 B" / "-$1.2 M"  ->  float dollars
UNITS = {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}
MONEY = re.compile(r"(-?)\$?\s*([\d,]+(?:\.\d+)?)\s*([TBMK])?", re.I)
TICKER_FROM_LOGO = re.compile(r"/company-logos/\d+/(.+?)\.(?:png|webp|jpg)", re.I)


def parse_money(text):
    if not text:
        return None
    m = MONEY.search(text.replace("\u00a0", " "))
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    value = float(m.group(2).replace(",", ""))
    unit = (m.group(3) or "").upper()
    return sign * value * UNITS.get(unit, 1.0)


def clean_country(text):
    """Drop the flag emoji the site prefixes to each country name."""
    return re.sub(r"[\U0001F1E6-\U0001F1FF]", "", text or "").strip()


def fetch(url):
    r = SESSION.get(url, timeout=30)
    r.raise_for_status()
    return BeautifulSoup(r.text, "html.parser")


def parse_ranking(url, value_label):
    """
    Scrape one companiesmarketcap ranking page.

    Column positions shift between pages, so read the header row and look up
    indices by name rather than assuming a fixed layout. The ticker comes out of
    the logo filename, which is the most stable identifier on the page.
    """
    soup = fetch(url)
    table = soup.find("table")
    if table is None:
        raise RuntimeError(f"No table found at {url} — the page layout may have changed.")

    headers = [th.get_text(strip=True).lower() for th in table.select("thead th")]

    def col(*names):
        for name in names:
            for i, h in enumerate(headers):
                if name in h:
                    return i
        return None

    i_value = col(value_label.lower())
    i_country = col("country")
    i_rank = col("rank")

    rows = []
    for tr in table.select("tbody tr"):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue  # ad rows and spacers

        # The ticker lives in the logo filename. Lazy-loaded images keep the real
        # URL in data-src, so check both attributes before giving up on a row.
        src = None
        for img in tr.find_all("img"):
            candidate = img.get("src") or img.get("data-src") or ""
            if TICKER_FROM_LOGO.search(candidate):
                src = candidate
                break
        if not src:
            continue
        ticker = TICKER_FROM_LOGO.search(src).group(1)

        link = tr.find("a", href=True)
        name = ""
        if link:
            # Link text is "Apple AAPL" — strip the trailing ticker.
            name = " ".join(link.get_text(" ", strip=True).split())
            if name.endswith(ticker):
                name = name[: -len(ticker)].strip()

        def cell(idx):
            return tds[idx].get_text(" ", strip=True) if idx is not None and idx < len(tds) else ""

        rows.append({
            "rank": int(parse_money(cell(i_rank)) or len(rows) + 1),
            "ticker": ticker,
            "name": name or ticker,
            "value": parse_money(cell(i_value)),
            "country": clean_country(cell(i_country)),
            "logo_url": src if src.startswith("http") else BASE + src,
        })
    return rows


def download_logo(url, ticker):
    """Cache the logo locally. Returns a relative path, or None on failure."""
    os.makedirs(LOGO_DIR, exist_ok=True)
    ext = os.path.splitext(url.split("?")[0])[1] or ".png"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", ticker)
    path = os.path.join(LOGO_DIR, safe + ext)
    rel = f"logos/{safe}{ext}"
    if os.path.exists(path):
        return rel
    try:
        r = SESSION.get(url, timeout=30)
        r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)
        return rel
    except Exception as e:
        print(f"  logo failed for {ticker}: {e}")
        return None


# Cache FX lookups so a page full of Korean tickers costs one request, not 25.
_FX_CACHE = {"USD": 1.0}


def fx_to_usd(currency, yf):
    """
    Yahoo reports financials in each company's own reporting currency, while
    companiesmarketcap reports market cap in USD. Mixing the two silently
    inflates any ratio between them — a Korean company's FCF yield came out
    ~1400x too high before this existed. Returns the multiplier that converts
    `currency` into USD, or None if it can't be determined.
    """
    if not currency:
        return None
    currency = currency.upper()
    if currency in _FX_CACHE:
        return _FX_CACHE[currency]
    try:
        # e.g. KRWUSD=X -> how many USD one KRW is worth
        fx = yf.Ticker(f"{currency}USD=X").fast_info
        rate = fx.get("last_price") or fx.get("lastPrice")
        if not rate:
            info = yf.Ticker(f"{currency}USD=X").info or {}
            rate = info.get("regularMarketPrice") or info.get("previousClose")
        rate = float(rate) if rate else None
    except Exception as e:
        print(f"  fx lookup failed for {currency}: {e}")
        rate = None
    _FX_CACHE[currency] = rate
    if rate:
        print(f"  fx {currency} -> USD @ {rate}")
    return rate


def ttm_free_cash_flow(tk, info):
    """
    Yahoo's `freeCashflow` field is inconsistent: for some tickers it's the
    trailing twelve months, for others the most recent quarter. Microsoft came
    back as $19.6B (one quarter) against a true TTM of $67B, understating its
    cash yield by 4x.

    Sum the last four quarters from the cash-flow statement instead, and only
    fall back to the info field when the statement isn't available.
    """
    try:
        q = tk.quarterly_cashflow
        if q is not None and not q.empty:
            def row(*names):
                for n in names:
                    if n in q.index:
                        vals = q.loc[n].dropna()
                        if len(vals) >= 4:
                            return float(vals.iloc[:4].sum())
                return None

            fcf = row("Free Cash Flow")
            if fcf is not None:
                return fcf
            ocf = row("Operating Cash Flow", "Total Cash From Operating Activities")
            capex = row("Capital Expenditure", "Capital Expenditures")
            if ocf is not None and capex is not None:
                return ocf + capex      # capex is reported negative
    except Exception as e:
        print(f"  ttm fcf fallback ({e})")
    return info.get("freeCashflow")


def quality_metrics(tk, info, rate):
    """
    The metrics Buffett actually talks about, which valuation multiples miss.

    ROIC              — return on invested capital. ROE flatters leveraged
                        balance sheets; ROIC doesn't. His stated single metric.
    net_debt_ebitda   — leverage. EV/EBITDA half-accounts for debt but never
                        tells you whether the balance sheet is fragile.
    share_change      — buybacks vs dilution. A company quietly shrinking its
                        share count returns capital; 3%/yr dilution is a hidden
                        tax that appears in no other column here.
    margin_stability  — standard deviation of gross margin. Durable pricing
                        power shows up as margins that hold; it's the closest a
                        screen gets to measuring a moat.

    Everything is ratio-based or percentage-based so currency cancels out.
    Returns a dict of Nones where data is unavailable rather than guessing.
    """
    out = {"roic": None, "net_debt_ebitda": None,
           "share_change": None, "share_change_years": None,
           "margin_stability": None, "gross_margin": None}

    # ── ROIC = NOPAT / invested capital ──
    try:
        inc, bs = tk.income_stmt, tk.balance_sheet
        def pick(df, *names):
            if df is None or df.empty:
                return None
            for n in names:
                if n in df.index:
                    v = df.loc[n].dropna()
                    if len(v):
                        return float(v.iloc[0])
            return None

        ebit = pick(inc, "EBIT", "Operating Income")
        pretax = pick(inc, "Pretax Income")
        taxexp = pick(inc, "Tax Provision")
        equity = pick(bs, "Stockholders Equity", "Total Stockholder Equity")
        debt = info.get("totalDebt") or pick(bs, "Total Debt")
        cash = info.get("totalCash") or pick(bs, "Cash And Cash Equivalents")

        if ebit and equity:
            tax_rate = (taxexp / pretax) if (pretax and taxexp and pretax > 0) else 0.21
            tax_rate = min(max(tax_rate, 0.0), 0.5)
            nopat = ebit * (1 - tax_rate)
            invested = equity + (debt or 0) - (cash or 0)
            if invested and invested > 0:
                out["roic"] = round(nopat / invested * 100, 1)
    except Exception as e:
        print(f"    roic failed: {e}")

    # ── Net debt / EBITDA ──
    try:
        ebitda = info.get("ebitda")
        debt = info.get("totalDebt")
        cash = info.get("totalCash")
        if ebitda and ebitda > 0 and debt is not None:
            out["net_debt_ebitda"] = round((debt - (cash or 0)) / ebitda, 2)
    except Exception:
        pass

    # ── Share count trend ──
    # yfinance's annual statements only reach back ~4 years; get_shares_full
    # goes further when available, so try it first and record the span used
    # rather than claiming 10 years we don't have.
    try:
        import pandas as pd
        sh = None
        try:
            full = tk.get_shares_full(start="2014-01-01")
            if full is not None and len(full) > 1:
                sh = full.dropna()
        except Exception:
            pass
        if sh is not None and len(sh) > 1:
            first, last = float(sh.iloc[0]), float(sh.iloc[-1])
            years = max(1, round((sh.index[-1] - sh.index[0]).days / 365.25))
            if first > 0:
                out["share_change"] = round((last - first) / first * 100, 1)
                out["share_change_years"] = years
        else:
            bs = tk.balance_sheet
            if bs is not None and not bs.empty and "Ordinary Shares Number" in bs.index:
                v = bs.loc["Ordinary Shares Number"].dropna()
                if len(v) > 1:
                    newest, oldest = float(v.iloc[0]), float(v.iloc[-1])
                    if oldest > 0:
                        out["share_change"] = round((newest - oldest) / oldest * 100, 1)
                        out["share_change_years"] = len(v) - 1
    except Exception as e:
        print(f"    share count failed: {e}")

    # ── Gross margin level + stability ──
    try:
        inc = tk.income_stmt
        if inc is not None and not inc.empty:
            gp = inc.loc["Gross Profit"].dropna() if "Gross Profit" in inc.index else None
            rev = inc.loc["Total Revenue"].dropna() if "Total Revenue" in inc.index else None
            if gp is not None and rev is not None:
                margins = [float(g) / float(r) * 100
                           for g, r in zip(gp, rev) if r and float(r) > 0]
                if margins:
                    out["gross_margin"] = round(sum(margins) / len(margins), 1)
                if len(margins) >= 3:
                    mean = sum(margins) / len(margins)
                    var = sum((m - mean) ** 2 for m in margins) / len(margins)
                    out["margin_stability"] = round(var ** 0.5, 2)   # lower = steadier
    except Exception as e:
        print(f"    margin stability failed: {e}")

    return out


def enrich_from_yahoo(companies):
    """
    Forward P/E and dividend yield aren't on companiesmarketcap, so pull them
    from Yahoo. Tickers mostly match already (2222.SR, 005930.KS, BRK-B).
    Anything Yahoo doesn't recognise just stays None.

    Ratios (FCF yield, P/E, margin) are computed from Yahoo's own fields so the
    currency cancels out. Absolute figures backfilled into the table are
    converted to USD first, since everything else in the table is USD.
    """
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance not installed — skipping forward P/E and dividend yield.")
        return

    for c in companies:
        try:
            tk = yf.Ticker(c["ticker"])
            info = tk.info or {}
        except Exception as e:
            print(f"  yahoo failed for {c['ticker']}: {e}")
            continue

        # Guard against a ticker that resolved to the wrong security. SpaceX is
        # private but appears in the market-cap ranking, and "SPCX" on Yahoo is a
        # closed-end fund — it was filling the row with nonsense (681x EBITDA).
        # quoteType is the reliable signal here; name matching produced false
        # positives on abbreviations (TSMC vs "Taiwan Semiconductor Manufacturing").
        qt = (info.get("quoteType") or "").upper()
        if qt and qt != "EQUITY":
            print(f"  {c['ticker']:<12} SKIPPED — Yahoo quoteType is {qt}, not a listed equity")
            continue

        # Reporting currency drives every cross-source conversion below.
        fin_cur = info.get("financialCurrency") or info.get("currency")
        rate = fx_to_usd(fin_cur, yf)

        c["forward_pe"] = info.get("forwardPE")
        if c.get("pe") is None:
            c["pe"] = info.get("trailingPE")

        c["sector"] = info.get("sector")
        # EV/EBITDA straight from Yahoo is unreliable across listings (TSM came
        # back at 4.9 against a true ~18). Rebuild it from components in one
        # currency, and fall back to Yahoo's figure only if that isn't possible.
        # Build EV in USD from the market cap we trust (companiesmarketcap) plus
        # net debt converted from the reporting currency, then divide by EBITDA
        # also converted. Yahoo's own enterpriseValue/ebitda pair is not reliably
        # in one currency for ADRs — TSM kept coming back at 4.9 against ~18.6.
        ebitda = info.get("ebitda")
        ev_ratio = None
        if ebitda and ebitda > 0 and rate and c.get("market_cap"):
            net_debt_usd = ((info.get("totalDebt") or 0) - (info.get("totalCash") or 0)) * rate
            ev_usd = c["market_cap"] + net_debt_usd
            ebitda_usd = ebitda * rate
            if ebitda_usd > 0:
                ev_ratio = ev_usd / ebitda_usd
        if ev_ratio is None and info.get("enterpriseToEbitda"):
            ev_ratio = info.get("enterpriseToEbitda")
        # A negative multiple means net cash exceeds EV or EBITDA is negative —
        # not "cheap", just not meaningful. Berkshire was showing -1.8 in green.
        # Anything past ~150x isn't a valuation signal, it's a broken input —
        # a near-zero EBITDA denominator or a mismatched security.
        if ev_ratio and 0 < ev_ratio <= 150:
            c["ev_ebitda"] = round(ev_ratio, 2)
        else:
            c["ev_ebitda"] = None
        c["ps"] = info.get("priceToSalesTrailing12Months")
        c["roe"] = round(info["returnOnEquity"] * 100, 1) if info.get("returnOnEquity") else None

        # FCF yield: free cash flow over market cap.
        # Yahoo reports financials in `financialCurrency`, which for an ADR is the
        # company's home currency (TWD for TSM) while `marketCap` is in the trading
        # currency (USD). Using either side raw produced TSMC at 32% and Samsung at
        # 5800%. Convert FCF to USD explicitly, then divide by the USD market cap.
        fcf = ttm_free_cash_flow(tk, info)
        mc_usd = c.get("market_cap")
        if fcf and mc_usd and mc_usd > 0 and rate:
            c["fcf_yield"] = round(fcf * rate / mc_usd * 100, 2)
        else:
            c["fcf_yield"] = None

        # dividendYield has changed units between yfinance releases, so derive it
        # from the rate and price when both are present and only fall back otherwise.
        rate = info.get("dividendRate")
        price = info.get("currentPrice") or info.get("regularMarketPrice")
        if rate and price:
            c["dividend_yield"] = round(rate / price * 100, 2)
        else:
            dy = info.get("dividendYield")
            if dy is not None:
                c["dividend_yield"] = round(dy * 100 if dy < 1 else dy, 2)

        # Backfill anything the ranking pages didn't cover (companies outside their
        # top 100). These arrive in the company's reporting currency, so convert
        # before they sit next to USD figures from companiesmarketcap.
        rate = fx_to_usd(info.get("financialCurrency") or info.get("currency"), yf)
        if c.get("revenue") is None and info.get("totalRevenue"):
            c["revenue"] = info["totalRevenue"] * rate if rate else None
        if c.get("earnings") is None and info.get("netIncomeToCommon"):
            c["earnings"] = info["netIncomeToCommon"] * rate if rate else None

        c.update(quality_metrics(tk, info, rate))

        print(f"  {c['ticker']:<12} fwd P/E {c.get('forward_pe')}  div {c.get('dividend_yield')}  "
              f"ROIC {c.get('roic')}  nd/ebitda {c.get('net_debt_ebitda')}  "
              f"shares {c.get('share_change')}%")


def main():
    os.makedirs(LOGO_DIR, exist_ok=True)   # so `git add logos` never fails in CI
    print("Fetching rankings from companiesmarketcap.com")

    caps = parse_ranking(PAGES["market_cap"], "market cap")[:TOP_N]
    print(f"  market cap: {len(caps)} companies")
    time.sleep(DELAY)

    earnings = {r["ticker"]: r["value"] for r in parse_ranking(PAGES["earnings"], "earnings")}
    print(f"  earnings: {len(earnings)} companies")
    time.sleep(DELAY)

    revenue = {r["ticker"]: r["value"] for r in parse_ranking(PAGES["revenue"], "revenue")}
    print(f"  revenue: {len(revenue)} companies")

    companies = []
    for r in caps:
        t = r["ticker"]
        e = earnings.get(t)
        mc = r["value"]
        companies.append({
            "rank": r["rank"],
            "ticker": t,
            "name": r["name"],
            "country": r["country"],
            "market_cap": mc,
            "earnings": e,
            "revenue": revenue.get(t),
            # companiesmarketcap computes P/E the same way: price / EPS == mcap / net income.
            "pe": round(mc / e, 2) if mc and e and e > 0 else None,
            "forward_pe": None,
            "dividend_yield": None,
            "sector": None,
            "fcf_yield": None,
            "ev_ebitda": None,
            "ps": None,
            "roe": None,
            "net_margin": None,
            "roic": None,
            "net_debt_ebitda": None,
            "share_change": None,
            "share_change_years": None,
            "margin_stability": None,
            "gross_margin": None,
            "logo": None,
            "logo_url": r["logo_url"],
        })

    print("Downloading logos")
    for c in companies:
        c["logo"] = download_logo(c.pop("logo_url"), c["ticker"])

    print("Enriching from Yahoo Finance")
    enrich_from_yahoo(companies)

    # Recompute trailing P/E for anyone whose earnings were backfilled by Yahoo.
    for c in companies:
        if c["pe"] is None and c["market_cap"] and c["earnings"] and c["earnings"] > 0:
            c["pe"] = round(c["market_cap"] / c["earnings"], 2)
        # Net margin needs no extra source — it's profit over revenue.
        if c.get("revenue") and c.get("earnings") is not None and c["revenue"] > 0:
            c["net_margin"] = round(c["earnings"] / c["revenue"] * 100, 1)

    companies.sort(key=lambda c: c["market_cap"] or 0, reverse=True)

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "companies": companies,
    }

    out = os.path.join(OUT_DIR, "alpha.json")
    with open(out, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote {out} — {len(companies)} companies.")
    print("Commit alpha.json and logos/ to publish the update.")


if __name__ == "__main__":
    main()
