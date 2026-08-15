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


def enrich_from_yahoo(companies):
    """
    Forward P/E and dividend yield aren't on companiesmarketcap, so pull them
    from Yahoo. Tickers mostly match already (2222.SR, 005930.KS, BRK-B).
    Anything Yahoo doesn't recognise just stays None.
    """
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance not installed — skipping forward P/E and dividend yield.")
        return

    for c in companies:
        try:
            info = yf.Ticker(c["ticker"]).info or {}
        except Exception as e:
            print(f"  yahoo failed for {c['ticker']}: {e}")
            continue

        c["forward_pe"] = info.get("forwardPE")
        if c.get("pe") is None:
            c["pe"] = info.get("trailingPE")

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

        # Backfill anything the ranking pages didn't cover (companies outside their top 100).
        if c.get("revenue") is None:
            c["revenue"] = info.get("totalRevenue")
        if c.get("earnings") is None:
            c["earnings"] = info.get("netIncomeToCommon")

        print(f"  {c['ticker']:<12} fwd P/E {c.get('forward_pe')}  div {c.get('dividend_yield')}")


def main():
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
