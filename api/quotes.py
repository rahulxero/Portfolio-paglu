from http.server import BaseHTTPRequestHandler
import json

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
                fx    = yf.Ticker('USDINR=X')
                rate  = float(fx.fast_info.last_price or 84)
                result['USD_INR'] = round(rate, 2)
            except Exception:
                result['USD_INR'] = 84

            # ── Indian stocks (NSE / BSE) ──────────────────
            for sym in indian_symbols:
                exchange   = exchanges.get(sym, 'NSE')
                suffix     = '.BO' if exchange == 'BSE' else '.NS'
                try:
                    t     = yf.Ticker(sym + suffix)
                    info  = t.fast_info
                    price = float(info.last_price or 0)

                    # Fallback to other exchange if zero
                    if price <= 0 and suffix == '.NS':
                        t2    = yf.Ticker(sym + '.BO')
                        price = float(t2.fast_info.last_price or 0)
                    if price <= 0 and suffix == '.BO':
                        t2    = yf.Ticker(sym + '.NS')
                        price = float(t2.fast_info.last_price or 0)

                    if price > 0:
                        result[sym] = round(price, 2)
                        prev = float(info.previous_close or 0)
                        if prev > 0:
                            result[sym + '_ch24'] = round((price - prev) / prev * 100, 2)
                except Exception as e:
                    result[sym + '_err'] = str(e)

            # ── International stocks (NASDAQ / NYSE) ───────
            for sym in intl_symbols:
                try:
                    t     = yf.Ticker(sym)
                    info  = t.fast_info
                    price = float(info.last_price or 0)
                    if price > 0:
                        result[sym] = round(price, 2)
                        prev = float(info.previous_close or 0)
                        if prev > 0:
                            result[sym + '_ch24'] = round((price - prev) / prev * 100, 2)
                except Exception as e:
                    result[sym + '_err'] = str(e)

            self._json(result, 200)

        except ImportError:
            self._json({'error': 'yfinance not installed — add yfinance to requirements.txt'}, 500)
        except json.JSONDecodeError:
            self._json({'error': 'Invalid JSON body'}, 400)
        except Exception as e:
            self._json({'error': str(e)}, 500)

    # ── helpers ────────────────────────────────────────────
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
