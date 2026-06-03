from playwright.sync_api import sync_playwright
import json

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    items_data = []
    buyback_requests = []

    def on_response(response):
        if '/api/etf/items' in response.url:
            try:
                d = response.json()
                items_data.extend(d.get('data', []))
            except: pass

    def on_request(request):
        if '/api/etf/buyback' in request.url and request.method == 'POST':
            buyback_requests.append(request.post_data)

    page.on('response', on_response)
    page.on('request', on_request)

    page.goto('https://www.capitalfund.com.tw/etf/transaction/buyback',
              wait_until='networkidle', timeout=30000)
    page.wait_for_timeout(3000)

    # Print all ETF items
    print('=== ETF Items ===')
    for item in items_data:
        sn = item.get('stockNo', '')
        fn = item.get('fundNo', '')
        name = item.get('shortName', '')
        print(f"stockNo={sn!r:10} fundNo={fn!r:6} name={name}")

    print('\n=== Buyback requests ===')
    for r in buyback_requests:
        print(r)

    browser.close()
