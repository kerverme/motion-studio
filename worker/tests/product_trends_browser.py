"""Exercise the Studio form and durable research queue against two planners and mock providers."""
from uuid import uuid4
from playwright.sync_api import expect


def check_product_trends(page, base, output):
    page.get_by_text('เทรนด์สินค้า', exact=True).click()
    query = page.locator('#trend-query')
    model = page.locator('#trend-model')
    form = page.locator('form.trend-form')
    button = form.get_by_role('button')
    expect(button).to_be_enabled()
    query.fill('กล่องเกม PS5')
    model.select_option('gpt-6.2-sol')
    with page.expect_response(lambda r: r.url.endswith('/api/product-trends') and r.request.method == 'POST') as submission:
        # Two pointer activations, a form submission and Enter during the same event loop.
        form.evaluate("""f=>{const b=f.querySelector('button');b.click();b.click();f.requestSubmit();
            f.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}""")
    job = submission.value.json()
    expect(button).to_have_text('กำลังค้นหาเทรนด์…')
    expect(button).to_be_disabled()
    expect(button.locator('.trend-spinner')).to_be_visible()
    alias = str(uuid4())
    duplicate = page.request.post(base+'/qa/trend-duplicate', data={'query':'เปิดแท็บใหม่','model':'gpt-6.1-terra','request_id':alias})
    assert duplicate.ok and duplicate.json()['id'] == job['id']
    poll_path = '**/product-trends/jobs/*'
    page.route(poll_path, lambda route: route.fulfill(status=503, json={'error':'fixture outage'}))
    page.reload()
    expect(button).to_be_disabled()
    expect(query).to_have_value('กล่องเกม PS5')
    expect(model).to_have_value('gpt-6.2-sol')
    expect(page.get_by_text('เช็กสถานะสะดุด กำลังตรวจงานเดิมอีกครั้ง')).to_be_visible()
    expect(button).to_be_disabled()
    page.screenshot(path=str(output/'trend-pending.png'))
    page.unroute(poll_path)
    page.request.post(base+'/qa/trend-outcome', data={'status':'completed'})
    expect(page.get_by_role('heading',name='กล่องเกม PS5')).to_be_visible(timeout=18000)
    expect(button).to_be_enabled()
    assert page.request.get(base+'/qa/trend-counts').json()=={'jobs':1,'posts':1,'firecrawl':2}
    # A lost acknowledgement from either tab may be retried even after the fast terminal result.
    replay=page.request.post(base+'/qa/trend-duplicate',data={'query':'เปิดแท็บใหม่','model':'gpt-6.1-terra','request_id':alias})
    assert replay.json()['id']==job['id'] and replay.json()['status']=='done'
    page.request.post(base+'/qa/trend-outcome', data={'status':'failed'})
    query.fill('หูฟัง')
    query.press('Enter')
    expect(button).to_be_disabled()
    page.get_by_text('UGC AI',exact=True).first.click()
    page.get_by_text('เทรนด์สินค้า',exact=True).click()
    expect(query).to_have_value('หูฟัง')
    expect(page.get_by_text('OpenAI อ่านหลักฐานไม่สำเร็จ ลองเลือกโมเดลหรือค้นอีกครั้ง')).to_be_visible(timeout=18000)
    expect(button).to_be_enabled()
    expect(model).to_have_value('gpt-6.2-sol')
    assert page.request.get(base+'/qa/trend-counts').json()=={'jobs':2,'posts':2,'firecrawl':4}

    # Lose the POST acknowledgement after the backend accepted it. Reload must recover the same job.
    page.request.post(base+'/qa/trend-outcome',data={'status':'queued'})
    def lose_ack(route):
        if route.request.method!='POST':
            route.continue_()
            return
        accepted=route.fetch()
        assert accepted.status==202
        route.abort()
    page.route('**/app/api/product-trends',lose_ack)
    query.fill('เมาส์ไร้สาย')
    button.click()
    expect(page.get_by_text('กำลังตรวจว่าระบบรับคำขอเดิมแล้วหรือยัง')).to_be_visible()
    page.unroute('**/app/api/product-trends')
    page.reload()
    expect(button).to_be_disabled()
    page.request.post(base+'/qa/trend-outcome',data={'status':'cancelled'})
    expect(page.get_by_text('OpenAI ยกเลิกงานค้นหาแล้ว')).to_be_visible(timeout=18000)
    expect(button).to_be_enabled()
    assert page.request.get(base+'/qa/trend-counts').json()=={'jobs':3,'posts':3,'firecrawl':6}
