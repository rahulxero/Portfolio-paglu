"""
api/quotes.py — Vercel Python serverless function
Fetches live stock prices using yfinance.

NSE symbols: append .NS  (e.g. RELIANCE.NS)
BSE symbols: append .BO  (e.g. RELIANCE.BO)
NASDAQ/NYSE: use directly (e.g. AAPL, NVDA)

Requirements (Vercel reads from requirements.txt):
  yfinance>=0.2.40
"""

import json
import http.client
from urllib.parse import urlparse, parse_qs

def handler(request):
    # CORS headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-session-token",
        "Content-Type": "application/json",
    }

    if request.method == "OPTIONS":
        return Response("", 200, headers)

    if request.method != "POST":
        return Response(json.dumps({"error": "POST only"}), 405, headers)

    try:
        import yfinance as yf
        body = json.loads(request.body)
        indian_symbols = body.get("indianSymbols", [])   # NSE/BSE symbols
        intl_symbols   = body.get("intlSymbols", [])     # NASDAQ/NYSE symbols
        exchanges      = body.get("exchanges", {})        # { "RELIANCE": "NSE" }

        if not indian_symbols and not intl_symbols:
            return Response(json.dumps({"error": "No symbols provided"}), 400, headers)

        result = {}

        # Fetch USD/INR rate first
        try:
            fx = yf.Ticker("USDINR=X")
            fx_info = fx.fast_info
            usd_inr = float(fx_info.last_price or 84)
            result["USD_INR"] = round(usd_inr, 2)
        except Exception:
            result["USD_INR"] = 84

        # Indian stocks — try NSE first (.NS), fall back to BSE (.BO)
        for sym in indian_symbols:
            exchange = exchanges.get(sym, "NSE")
            suffix = ".BO" if exchange == "BSE" else ".NS"
            ticker_sym = sym + suffix
            try:
                t = yf.Ticker(ticker_sym)
                info = t.fast_info
                price = float(info.last_price or 0)
                if price > 0:
                    result[sym] = round(price, 2)
                    # Try 24h change
                    try:
                        prev = float(info.previous_close or 0)
                        if prev > 0:
                            result[f"{sym}_ch24"] = round((price - prev) / prev * 100, 2)
                    except Exception:
                        pass
                else:
                    # fallback to BSE if NSE gave zero
                    if suffix == ".NS":
                        t2 = yf.Ticker(sym + ".BO")
                        i2 = t2.fast_info
                        p2 = float(i2.last_price or 0)
                        if p2 > 0:
                            result[sym] = round(p2, 2)
            except Exception as e:
                result[f"{sym}_error"] = str(e)

        # International stocks — NASDAQ/NYSE (prices in USD)
        if intl_symbols:
            try:
                tickers = yf.Tickers(" ".join(intl_symbols))
                for sym in intl_symbols:
                    try:
                        t = tickers.tickers.get(sym)
                        if t:
                            info = t.fast_info
                            price = float(info.last_price or 0)
                            if price > 0:
                                result[sym] = round(price, 2)
                                try:
                                    prev = float(info.previous_close or 0)
                                    if prev > 0:
                                        result[f"{sym}_ch24"] = round((price - prev) / prev * 100, 2)
                                except Exception:
                                    pass
                    except Exception as e:
                        result[f"{sym}_error"] = str(e)
            except Exception as e:
                # fallback: fetch individually
                for sym in intl_symbols:
                    try:
                        t = yf.Ticker(sym)
                        info = t.fast_info
                        price = float(info.last_price or 0)
                        if price > 0:
                            result[sym] = round(price, 2)
                    except Exception:
                        pass

        return Response(json.dumps(result), 200, headers)

    except ImportError:
        return Response(json.dumps({"error": "yfinance not installed. Add yfinance to requirements.txt"}), 500, headers)
    except json.JSONDecodeError:
        return Response(json.dumps({"error": "Invalid JSON body"}), 400, headers)
    except Exception as e:
        return Response(json.dumps({"error": str(e)}), 500, headers)


class Response:
    def __init__(self, body, status=200, headers=None):
        self.body = body
        self.status_code = status
        self.headers = headers or {}
