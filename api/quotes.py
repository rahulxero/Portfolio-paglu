from http.server import BaseHTTPRequestHandler
import json

# Common NSE ticker aliases — maps what users type to actual yfinance ticker
NSE_ALIASES = {
    'SBI':        'SBIN',
    'M&M':        'M%26M',   # URL-encode the &
    'L&T':        'LT',
    'BAJAJ':      'BAJAJFINSV',
    'ZYDUS':      'ZYDUSLIFE',
    'CADILA':     'ZYDUSLIFE',
    'WIPRO':      'WIPRO',
    'HDFCBANK':   'HDFCBANK',
    'ICICIBANK':  'ICICIBANK',
    'KOTAKBANK':  'KOTAKBANK',
    'RELIANCE':   'RELIANCE',
    'TCS':        'TCS',
    'INFY':       'INFY',
    'BHARTIARTL': 'BHARTIARTL',
    'AIRTEL':     'BHARTIARTL',
    'TATAMOTORS': 'TATAMOTORS',
    'TATASTEEL':  'TATASTEEL',
    'AXISBANK':   'AXISBANK',
    'SUNPHARMA':  'SUNPHARMA',
    'ITC':        'ITC',
    'BAJFINANCE': 'BAJFINANCE',
    'MARUTI':     'MARUTI',
    'HINDUNILVR': 'HINDUNILVR',
    'HUL':        'HINDUNILVR',
    'ULTRACEMCO': 'ULTRACEMCO',
    'NESTLEIND':  'NESTLEIND',
    'TITAN':      'TITAN',
    'ASIANPAINT': 'ASIANPAINT',
    'POWERGRID':  'POWERGRID',
    'NTPC':       'NTPC',
    'ONGC':       'ONGC',
    'COALINDIA':  'COALINDIA',
    'BPCL':       'BPCL',
    'GESHIPPING': 'GESHIPPING',
    'GESHIN':     'GESHIPPING',
}

class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            import yfinance as yf

            length = int(self.headers.get('Content-Length', 0))
            body   = json.loads(self.rfile.read(length) or b'{}')

            indian_symbols = body.get('indianSymbols', [])
            intl_symbols   = body.get('intlSymbols',   [])
            exchanges      = body.get('exchanges',      {})

            if not indian_symbols and not intl_symbols:
                return self._json({'error': 'No symbols provided'}, 400)

            result = {}

            # ── USD/INR exchange rate ──────────────────────
            try:
                fx   = yf.Ticker('USDINR=X')
                rate = float(fx.fast_info.last_price or 84)
                result['USD_INR'] = round(rate, 2)
            except Exception:
                result['USD_INR'] = 84

            # ── Indian stocks (NSE / BSE) ──────────────────
            for sym in indian_symbols:
                exchange = exchanges.get(sym, 'NSE')

                # Apply alias if exists
                lookup_sym = NSE_ALIASES.get(sym.upper(), sym)

                # Try both exchanges
                if exchange == 'BSE':
                    attempts = [lookup_sym + '.BO', lookup_sym + '.NS']
                else:
                    attempts = [lookup_sym + '.NS', lookup_sym + '.BO']

                # Also try original sym if alias was used
                if lookup_sym != sym:
                    attempts += [sym + '.NS', sym + '.BO']

                fetched = False
                for ticker_sym in attempts:
                    try:
                        t     = yf.Ticker(ticker_sym)
                        info  = t.fast_info
                        price = float(info.last_price or 0)
                        if price > 0:
                            result[sym] = round(price, 2)
                            try:
                                prev = float(info.previous_close or 0)
                                if prev > 0:
                                    result[sym + '_ch24'] = round((price - prev) / prev * 100, 2)
                            except Exception:
                                pass
                            fetched = True
                            break
                    except Exception:
                        continue

                if not fetched:
                    tried = ', '.join(attempts[:2])
                    result[sym + '_err'] = f'Price not found. Tried: {tried}. Check the exact NSE ticker on NSE India.'

            # ── International stocks (NASDAQ / NYSE) ───────
            for sym in intl_symbols:
                try:
                    t     = yf.Ticker(sym)
                    info  = t.fast_info
                    price = float(info.last_price or 0)
                    if price > 0:
                        result[sym] = round(price, 2)
                        try:
                            prev = float(info.previous_close or 0)
                            if prev > 0:
                                result[sym + '_ch24'] = round((price - prev) / prev * 100, 2)
                        except Exception:
                            pass
                    else:
                        result[sym + '_err'] = 'Price unavailable'
                except Exception as e:
                    result[sym + '_err'] = str(e)

            self._json(result, 200)

        except ImportError:
            self._json({'error': 'yfinance not installed — check requirements.txt'}, 500)
        except json.JSONDecodeError:
            self._json({'error': 'Invalid JSON body'}, 400)
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, x-session-token')

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # suppress access logs
